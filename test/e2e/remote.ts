import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const IMAGE = "localhost/paseo-remote-deploy-e2e:bookworm";

/** A disposable remote machine: the Containerfile's image with sshd on a random local port. */
export interface Remote {
  name: string;
  port: number;
  /** Runs a shell command in the container as `dev`, with its user manager reachable. */
  asDev(command: string): Promise<string>;
  /** Runs a shell command in the container as root, to shape the machine for a test. */
  asRoot(command: string): Promise<string>;
  /** Restarts the container, as a reboot; the SSH port can change. */
  reboot(): Promise<void>;
  stop(): Promise<void>;
}

export async function buildImage(): Promise<void> {
  await exec(
    "podman",
    [
      "build",
      "-q",
      "-t",
      IMAGE,
      "-f",
      join(import.meta.dirname, "Containerfile"),
      import.meta.dirname,
    ],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

export async function startRemote(options: { systemd: boolean }): Promise<Remote> {
  const name = `rd-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await exec("podman", [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::22",
    ...(options.systemd ? ["--systemd=always", IMAGE] : [IMAGE, "/usr/sbin/sshd", "-D", "-e"]),
  ]);
  async function waitForSsh(): Promise<number> {
    const { stdout } = await exec("podman", ["port", name, "22/tcp"]);
    const port = Number(stdout.trim().split(":").at(-1));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const banner = await exec("ssh-keyscan", ["-p", String(port), "127.0.0.1"]).catch(() => null);
      if (banner?.stdout.includes("ssh-")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return port;
  }
  const remote: Remote = {
    name,
    port: await waitForSsh(),
    async asDev(command) {
      const result = await exec("podman", [
        "exec",
        "-u",
        "dev",
        "-e",
        "XDG_RUNTIME_DIR=/run/user/1000",
        name,
        "bash",
        "-c",
        command,
      ]);
      return result.stdout;
    },
    async asRoot(command) {
      return (await exec("podman", ["exec", name, "sh", "-c", command])).stdout;
    },
    async reboot() {
      await exec("podman", ["restart", "-t", "5", name]);
      remote.port = await waitForSsh();
    },
    async stop() {
      await exec("podman", ["rm", "-f", "-t", "2", name]).catch(() => undefined);
    },
  };
  return remote;
}

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
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

/** A private known_hosts and, optionally, a key that `dev` accepts. */
export async function sshIdentity(remote: Remote, withKey: boolean): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "rd-e2e-ssh-"));
  const options = [`UserKnownHostsFile=${join(dir, "known_hosts")}`, "IdentityAgent=none"];
  if (!withKey) return [...options, "PubkeyAuthentication=no"];
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "key")]);
  const publicKey = readFileSync(join(dir, "key.pub"), "utf8").trim();
  await remote.asDev(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  );
  return [...options, `IdentityFile=${join(dir, "key")}`, "IdentitiesOnly=yes"];
}

/** Forwards a local port to the remote daemon's loopback port, the way Paseo's SSH link does. */
export async function tunnel(
  remote: Remote,
  options: string[],
  daemonPort: number,
): Promise<{ port: number; close(): void }> {
  const localPort = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    "ssh",
    [
      ...options.flatMap((option) => ["-o", option]),
      "-o",
      "BatchMode=yes",
      "-N",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${daemonPort}`,
      "-p",
      String(remote.port),
      "dev@127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { port: localPort, close: () => child.kill() };
}

/** Asks a daemon for its status with this machine's Paseo CLI, as a client with a password. */
export async function daemonStatus(target: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec("paseo", ["--host", target, "daemon", "status", "--json"], {
    timeout: 60_000,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}
