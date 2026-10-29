import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { afterAll, beforeAll, expect, test } from "vitest";
import { deploy, fakeHosts } from "./deploy";
import { buildImage, daemonStatus, sshIdentity, startRemote, tunnel, type Remote } from "./remote";

let remote: Remote;

beforeAll(async () => {
  await buildImage();
  remote = await startRemote({ systemd: true });
});

afterAll(async () => {
  await remote?.stop();
});

test("password login, unknown host key and no SSH key: installs, runs under systemd, adds the host through the relay", async () => {
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, false);
  const { job, asked } = await deploy(
    { sshPort: remote.port, label: "e2e" },
    {
      sshOptions,
      hosts: hosts.api,
      answers: {
        "Unknown host key": "yes",
        SSH: "devpass",
        "SSH key login is not set up": "relay",
      },
    },
  );
  if (job.status !== "succeeded") console.log(job.log.join("\n"));
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual([
    "Unknown host key",
    "SSH",
    "SSH key login is not set up",
    "Download and install?",
  ]);
  expect(job.connectVia).toBe("relay");
  expect(job.result).toMatchObject({
    service: "systemd",
    unit: "paseo-daemon.service",
    cron: "none",
    linger: "enabled",
    survivesLogout: true,
    startsAtBoot: true,
    paseoHome: "/home/dev/.paseo",
    installDir: "/home/dev/.local/share/paseo",
  });
  expect(job.result?.nodeVersion).toMatch(/^v24\./u);

  // The unit is enabled and running under dev's user manager, from the private Node.js.
  expect((await remote.asDev("systemctl --user is-active paseo-daemon.service")).trim()).toBe(
    "active",
  );
  expect((await remote.asDev("systemctl --user is-enabled paseo-daemon.service")).trim()).toBe(
    "enabled",
  );
  expect(
    await remote.asDev(
      "readlink -f /proc/$(systemctl --user show -p MainPID --value paseo-daemon.service)/exe",
    ),
  ).toMatch(
    /^\/home\/dev\/\.local\/share\/paseo\/node-v24\.[0-9.]+-linux-(x64|arm64)\/bin\/node$/mu,
  );
  expect(await remote.asDev("loginctl show-user dev --property=Linger --value || true")).toMatch(
    /yes|no|^$/u,
  );

  // The saved relay connection carries the generated password, and the daemon accepts it.
  expect(hosts.calls).toHaveLength(1);
  const saved = hosts.calls[0]!;
  expect(saved.kind).toBe("add");
  const target = parseHostTarget(saved.connection);
  expect(target).toMatchObject({ kind: "socket", password: expect.stringMatching(/^[\w-]{32}$/u) });
  expect(await daemonStatus(saved.connection)).toMatchObject({ connectedDaemon: "reachable" });
  const wrong = new URL(saved.connection);
  wrong.searchParams.set("password", "not-the-password");
  await expect(daemonStatus(wrong.toString())).rejects.toThrow();

  // The remote generated the password; config.json keeps only its hash, and the job never shows it.
  const password = target.kind === "socket" ? target.password! : "";
  const config = await remote.asDev("cat ~/.paseo/config.json");
  expect(config).toMatch(/"password": "\$2[aby]\$12\$/u);
  expect(config).not.toContain(password);
  expect(JSON.stringify(job)).not.toContain(password);
  expect(job.log.join("\n")).not.toContain(password);
});

test("redeploying over SSH with key login restarts the daemon and updates the saved host", async () => {
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, true);
  // Seed the fake registry with the first deploy's registration, as the real one would hold it.
  const first = await deploy(
    { sshPort: remote.port, connectVia: "ssh" },
    {
      sshOptions,
      hosts: hosts.api,
      answers: { "Unknown host key": "yes", "Restart the running daemon?": "restart" },
    },
  );
  if (first.job.status !== "succeeded") console.log(first.job.log.join("\n"));
  expect(first.job.status, first.job.error ?? "").toBe("succeeded");
  expect(first.asked).toContain("Restart the running daemon?");
  expect(first.job.steps.find((step) => step.id === "keyLogin")?.status).toBe("done");
  // Node.js and Paseo were already there: this deploy reused them.
  expect(first.job.steps.find((step) => step.id === "node")?.detail).toMatch(/already installed/u);
  expect(first.job.steps.find((step) => step.id === "paseo")?.detail).toMatch(
    /already the requested version/u,
  );

  const saved = hosts.calls.at(-1)!;
  const target = parseHostTarget(saved.connection);
  expect(target).toMatchObject({
    kind: "ssh",
    ssh: { host: "dev@127.0.0.1", sshPort: remote.port },
  });
  if (target.kind !== "ssh") throw new Error("expected ssh");

  // The SSH tunnel Paseo would open reaches the daemon, which takes this password only.
  const forward = await tunnel(remote, sshOptions, target.ssh.daemonPort);
  try {
    const endpoint = `tcp://127.0.0.1:${forward.port}`;
    expect(
      await daemonStatus(`${endpoint}?password=${encodeURIComponent(target.password!)}`),
    ).toMatchObject({
      connectedDaemon: "reachable",
    });
    await expect(daemonStatus(`${endpoint}?password=wrong`)).rejects.toThrow();
  } finally {
    forward.close();
  }

  // A second deploy into the same home updates the registration instead of adding another.
  const again = await deploy(
    { sshPort: remote.port, connectVia: "ssh" },
    { sshOptions, hosts: hosts.api, answers: { "Restart the running daemon?": "restart" } },
  );
  expect(again.job.status, again.job.error ?? "").toBe("succeeded");
  expect(hosts.calls.map((call) => call.kind)).toEqual(["add", "update"]);
});
