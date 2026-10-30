import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { parseRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import { afterAll, beforeAll, expect, test } from "vitest";
import { decodeQr } from "../qr-decode";
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
  const { job, asked, pairing } = await deploy(
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

  // Asked for, the pairing link is the saved connection in Paseo's #connect= fragment, which the
  // app reads with its password, and the QR code holds that same link.
  expect(job.result?.pairing).toBe(true);
  expect(pairing).not.toBeNull();
  const link = pairing!.link;
  expect(link.startsWith("https://app.paseo.sh/#connect=")).toBe(true);
  expect(decodeURIComponent(link.slice(link.indexOf("#connect=") + "#connect=".length))).toBe(
    saved.connection,
  );
  expect(parseRelayConnectionUri(link)).toMatchObject({
    offer: { serverId: job.result?.serverId },
    password,
  });
  expect(decodeQr(pairing!.qr.map((row) => [...row].map((cell) => cell === "1")))).toBe(link);
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

  // Without the relay, an SSH deploy has no pairing link: the app has none for SSH connections.
  expect(first.job.result?.pairing).toBe(false);
  expect(first.pairing).toBeNull();
  expect(JSON.parse(await remote.asDev("cat ~/.paseo/config.json")).daemon.relay.enabled).toBe(
    false,
  );

  // A second deploy into the same home updates the registration instead of adding another. With
  // the relay enabled, the host stays an SSH connection, and the pairing link reaches the daemon
  // through the relay with its new password.
  const again = await deploy(
    { sshPort: remote.port, connectVia: "ssh", enableRelay: true },
    { sshOptions, hosts: hosts.api, answers: { "Restart the running daemon?": "restart" } },
  );
  expect(again.job.status, again.job.error ?? "").toBe("succeeded");
  expect(hosts.calls.map((call) => call.kind)).toEqual(["add", "update"]);
  const updated = parseHostTarget(hosts.calls.at(-1)!.connection);
  expect(updated).toMatchObject({ kind: "ssh" });
  expect(JSON.parse(await remote.asDev("cat ~/.paseo/config.json")).daemon.relay.enabled).toBe(
    true,
  );
  expect(again.job.result?.pairing).toBe(true);
  const link = again.pairing!.link;
  const paired = parseRelayConnectionUri(link);
  expect(paired).toMatchObject({
    offer: { serverId: again.job.result?.serverId },
    password: updated.kind === "ssh" ? updated.password : "",
  });
  const relayTarget = decodeURIComponent(
    link.slice(link.indexOf("#connect=") + "#connect=".length),
  );
  expect(await daemonStatus(relayTarget)).toMatchObject({ connectedDaemon: "reachable" });
  expect(decodeQr(again.pairing!.qr.map((row) => [...row].map((cell) => cell === "1")))).toBe(link);
});
