import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { DeployRequest, Job } from "../../shared/rpc";
import { buildImage, IMAGE } from "./remote";

// The whole path through a real Paseo daemon: the plugin installed from a directory, deploys
// started and answered over plugin RPC, and hosts saved with the daemon's own hosts API, which
// then has to reach them over its own SSH link or the relay.

const exec = promisify(execFile);
const ORIGIN_IMAGE = "localhost/paseo-remote-deploy-e2e-origin:0.13.0";
const PLUGIN = join(import.meta.dirname, "..", "..");
const run = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const network = `rd-e2e-net-${run}`;
const origin = `rd-origin-${run}`;
const remotes = { withKey: `rd-remote-key-${run}`, passwordOnly: `rd-remote-pw-${run}` };
let client: DaemonClient;

async function podman(...args: string[]): Promise<string> {
  return (await exec("podman", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function rpc<T>(method: string, input: unknown): Promise<T> {
  return (await client.invokePluginRpc("remote-deploy", method, input)) as T;
}

/** Starts a deploy over RPC and answers its prompts the way the app's modal would. */
async function deployThroughOrigin(
  request: Partial<DeployRequest>,
  answers: Record<string, string>,
) {
  const { jobId } = await rpc<{ jobId: string }>("deploy.start", {
    destination: "dev@remote",
    sshPort: null,
    connectVia: "ssh",
    label: null,
    paseoHome: null,
    installDir: null,
    daemonPort: null,
    paseoVersion: null,
    service: "auto",
    ...request,
  });
  const asked: string[] = [];
  for (;;) {
    const { job } = await rpc<{ job: Job }>("deploy.job", { jobId });
    if (job.finishedAt) return { job, asked };
    if (job.prompt) {
      asked.push(job.prompt.title);
      const value = { "Download and install?": "install", ...answers }[job.prompt.title];
      if (value === undefined)
        throw new Error(`Unexpected prompt ${job.prompt.title}: ${job.prompt.message}`);
      await rpc("deploy.answer", { jobId, promptId: job.prompt.id, value });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

beforeAll(async () => {
  await buildImage();
  await exec("podman", [
    "build",
    "-q",
    "-t",
    ORIGIN_IMAGE,
    "-f",
    join(import.meta.dirname, "Containerfile.origin"),
    import.meta.dirname,
  ]);
  await podman("network", "create", network);
  for (const name of Object.values(remotes)) {
    await podman(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      network,
      "--network-alias",
      name,
      "--systemd=always",
      IMAGE,
    );
  }
  // A copy of the plugin with production dependencies only, as an install from a directory needs.
  const copy = mkdtempSync(join(tmpdir(), "rd-plugin-"));
  await exec("sh", [
    "-c",
    `tar --exclude=node_modules --exclude=.git -C "$1" -cf - . | tar -xf - -C "$2"`,
    "copy",
    PLUGIN,
    copy,
  ]);
  await exec("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: copy,
  });
  await exec("chmod", ["-R", "a+rwX", copy]);
  await podman(
    "run",
    "-d",
    "--name",
    origin,
    "--network",
    network,
    "-p",
    "127.0.0.1::6767",
    "-v",
    `${copy}:/plugins/remote-deploy:Z`,
    ORIGIN_IMAGE,
  );
  const port = Number((await podman("port", origin, "6767/tcp")).trim().split(":").at(-1));
  await waitFor(
    "the origin daemon",
    async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok || null,
  );
  await exec("paseo", [
    "--host",
    `127.0.0.1:${port}`,
    "plugin",
    "install",
    "/plugins/remote-deploy",
    "--json",
  ]);
  // The origin's own key opens the first remote; the second only takes a password.
  const publicKey = (await podman("exec", origin, "cat", "/home/node/.ssh/id_ed25519.pub")).trim();
  await podman(
    "exec",
    "-u",
    "dev",
    remotes.withKey,
    "sh",
    "-c",
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  );
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `rd-e2e-${run}`,
    clientType: "cli",
  });
  await client.connect();
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await exec("podman", ["rm", "-f", "-t", "2", origin, ...Object.values(remotes)]).catch(
    () => undefined,
  );
  await exec("podman", ["network", "rm", "-f", network]).catch(() => undefined);
});

test("an SSH deploy saves a host that the daemon brings online over its own SSH link", async () => {
  const { job, asked } = await deployThroughOrigin(
    { destination: `dev@${remotes.withKey}`, label: "build box" },
    { "Unknown host key": "yes" },
  );
  if (job.status !== "succeeded") console.log(job.log.join("\n"));
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual(["Unknown host key", "Download and install?"]);
  expect(job.result).toMatchObject({ connectVia: "ssh", service: "systemd", hostStatus: "online" });

  const directory = await client.listHosts();
  const host = directory.hosts.find((candidate) => candidate.label === "build box");
  expect(host).toMatchObject({
    status: "online",
    serverId: job.result?.serverId,
    metadata: { "remote-deploy.service": "paseo-daemon.service" },
  });
  // Discovery never returns the credential.
  expect(JSON.stringify(directory)).not.toMatch(/password=/u);
});

test("a password-only machine switches to the relay after the warning and comes online there", async () => {
  const { job, asked } = await deployThroughOrigin(
    { destination: `dev@${remotes.passwordOnly}` },
    { "Unknown host key": "yes", SSH: "devpass", "SSH key login is not set up": "relay" },
  );
  if (job.status !== "succeeded") console.log(job.log.join("\n"));
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual([
    "Unknown host key",
    "SSH",
    "SSH key login is not set up",
    "Download and install?",
  ]);
  expect(job.result).toMatchObject({ connectVia: "relay", hostStatus: "online" });

  const host = (await client.listHosts()).hosts.find(
    (candidate) => candidate.serverId === job.result?.serverId,
  );
  expect(host?.status).toBe("online");
  expect(host?.targetDescription).toMatch(/^relay:\/\//u);
});

test("cancelling at the key-login warning installs nothing", async () => {
  const { job } = await deployThroughOrigin(
    {
      destination: `dev@${remotes.passwordOnly}`,
      paseoHome: "~/cancelled",
      installDir: "~/cancelled-install",
    },
    { SSH: "devpass", "SSH key login is not set up": "cancel" },
  );
  expect(job.status).toBe("cancelled");
  const listing = await podman(
    "exec",
    "-u",
    "dev",
    remotes.passwordOnly,
    "sh",
    "-c",
    "ls -d ~/cancelled ~/cancelled-install 2>&1 || true",
  );
  expect(listing).toMatch(/No such file/u);
  expect(listing).not.toMatch(/^\/home\/dev\/cancelled$/mu);
});
