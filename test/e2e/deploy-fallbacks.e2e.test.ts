import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { afterEach, beforeAll, expect, test } from "vitest";
import { deploy, fakeHosts } from "./deploy";
import {
  buildImage,
  daemonStatus,
  sshIdentity,
  startRemote,
  tunnel,
  waitFor,
  type Remote,
} from "./remote";

// How the daemon is kept running on machines without linger, checked by logging out and
// rebooting: each test's deploy SSH session has ended by the time it asserts.

let remote: Remote | null = null;

beforeAll(async () => {
  await buildImage();
});

afterEach(async () => {
  await remote?.stop();
  remote = null;
});

const NO_POLKIT = "dpkg --purge polkitd >/dev/null && systemctl restart dbus systemd-logind";
const KILL_ON_LOGOUT =
  "mkdir -p /etc/systemd/logind.conf.d && printf '[Login]\\nKillUserProcesses=yes\\n' > /etc/systemd/logind.conf.d/kill.conf && systemctl restart systemd-logind";

/** The daemon's status, read on the machine from its own CLI. */
async function localStatus(machine: Remote, home = "~/.paseo"): Promise<Record<string, unknown>> {
  return JSON.parse(
    await machine.asDev(
      `PASEO_REMOTE_DEPLOY_LOGIN=1 ~/.local/share/paseo/bin/paseo daemon status --home ${home} --json`,
    ),
  ) as Record<string, unknown>;
}

async function daemonCgroup(machine: Remote): Promise<string> {
  const { pid } = await localStatus(machine);
  return machine.asDev(`cat /proc/${String(pid)}/cgroup`);
}

test("linger refused, logout harmless: a background daemon with a @reboot line survives logout and reboot", async () => {
  remote = await startRemote({ systemd: true });
  await remote.asRoot(NO_POLKIT);
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, true);
  const { job, asked } = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { "Unknown host key": "yes" } },
  );
  expect(job.status, job.error ?? "").toBe("succeeded");
  // Nothing to decide: the plan keeps the daemon up, so the deploy never asked.
  expect(asked).toEqual(["Unknown host key", "Download and install?"]);
  expect(job.result).toMatchObject({
    service: "background",
    cron: "reboot",
    survivesLogout: true,
    startsAtBoot: true,
  });
  expect(job.steps.find((step) => step.id === "inspect")?.detail).toMatch(/@reboot crontab line/u);
  expect(await remote.asDev("crontab -l")).toMatch(/^@reboot .*daemon' 'start' '--home'/mu);

  // Logged out: the SSH session has ended. logind keeps it as "closing" because the daemon
  // still runs inside it, which is what KillUserProcesses=no allows.
  await waitFor(
    "dev to be logged out",
    async () =>
      (await remote!.asRoot("loginctl show-user dev -p State --value")).trim() === "closing",
  );
  expect(await localStatus(remote)).toMatchObject({ localDaemon: "running" });

  // Rebooted: cron starts it again, outside any login session, with the same password.
  await remote.reboot();
  await waitFor(
    "cron to start the daemon",
    async () => (await localStatus(remote!)).localDaemon === "running",
  );
  expect(await daemonCgroup(remote)).toMatch(/cron\.service/u);
  const target = parseHostTarget(hosts.calls[0]!.connection);
  if (target.kind !== "ssh") throw new Error("expected an ssh connection");
  const forward = await tunnel(remote, sshOptions, target.ssh.daemonPort);
  try {
    expect(
      await daemonStatus(
        `tcp://127.0.0.1:${forward.port}?password=${encodeURIComponent(target.password!)}`,
      ),
    ).toMatchObject({ connectedDaemon: "reachable" });
  } finally {
    forward.close();
  }
});

test("linger refused, logout kills: cron starts the daemon outside the session and keeps it running", async () => {
  remote = await startRemote({ systemd: true });
  await remote.asRoot(`${NO_POLKIT} && ${KILL_ON_LOGOUT}`);
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, true);
  const { job, asked } = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { "Unknown host key": "yes" } },
  );
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual(["Unknown host key", "Download and install?"]);
  expect(job.result).toMatchObject({ service: "cron", cron: "keepalive", survivesLogout: true });
  expect(await remote.asDev("crontab -l")).toMatch(/^\* \* \* \* \* .*daemon' 'start'/mu);
  expect(await daemonCgroup(remote)).toMatch(/cron\.service/u);

  // The deploy's session is over and logind has killed what it left behind; the daemon is not
  // one of those processes.
  await waitFor(
    "dev's sessions to end",
    async () => !(await remote!.asRoot("loginctl list-sessions --no-legend")).includes(" dev "),
  );
  const { pid } = await localStatus(remote);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  expect(await localStatus(remote)).toMatchObject({ localDaemon: "running", pid });
});

test("linger refused, logout kills, no cron: asks first, then runs a service that stops at logout", async () => {
  remote = await startRemote({ systemd: true });
  await remote.asRoot(`${NO_POLKIT} && ${KILL_ON_LOGOUT} && systemctl disable --now cron`);
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, true);
  const { job, asked } = await deploy(
    { sshPort: remote.port },
    {
      sshOptions,
      hosts: hosts.api,
      answers: { "Unknown host key": "yes", "The daemon will stop when you log out": "continue" },
    },
  );
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual([
    "Unknown host key",
    "Download and install?",
    "The daemon will stop when you log out",
  ]);
  expect(job.result).toMatchObject({
    service: "systemd",
    survivesLogout: false,
    startsAtBoot: false,
  });
  expect(job.warnings.join("\n")).toMatch(/no cron daemon is running/u);

  // What the prompt said: once the last session ends, the user manager and the daemon stop.
  await waitFor(
    "the daemon to stop after logout",
    async () =>
      (await remote!.asRoot("systemctl is-active user@1000.service || true")).trim() === "inactive",
  );
  expect(await localStatus(remote)).toMatchObject({ localDaemon: "stopped" });
});

test("declining that question installs nothing", async () => {
  remote = await startRemote({ systemd: true });
  await remote.asRoot(`${NO_POLKIT} && ${KILL_ON_LOGOUT} && systemctl disable --now cron`);
  const sshOptions = await sshIdentity(remote, true);
  const { job } = await deploy(
    { sshPort: remote.port },
    {
      sshOptions,
      hosts: fakeHosts().api,
      answers: { "Unknown host key": "yes", "The daemon will stop when you log out": "cancel" },
    },
  );
  expect(job.status).toBe("cancelled");
  expect(await remote.asDev("ls -A ~/.local/share/paseo ~/.paseo 2>&1 || true")).toMatch(
    /No such file/u,
  );
});

test("without systemd or a running cron: asks about reboots, then backgrounds the daemon, which outlives the session", async () => {
  remote = await startRemote({ systemd: false });
  const hosts = fakeHosts();
  const sshOptions = await sshIdentity(remote, true);
  const { job, asked } = await deploy(
    {
      sshPort: remote.port,
      paseoHome: "~/work/paseo home",
      installDir: "opt/paseo",
      daemonPort: 7123,
    },
    {
      sshOptions,
      hosts: hosts.api,
      answers: {
        "Unknown host key": "yes",
        "The daemon will not start after a reboot": "continue",
      },
    },
  );
  expect(job.status, job.error ?? "").toBe("succeeded");
  expect(asked).toEqual([
    "Unknown host key",
    "Download and install?",
    "The daemon will not start after a reboot",
  ]);
  expect(job.result).toMatchObject({
    service: "background",
    cron: "none",
    unit: null,
    survivesLogout: true,
    startsAtBoot: false,
    paseoHome: "/home/dev/work/paseo home",
    installDir: "/home/dev/opt/paseo",
  });

  const status = JSON.parse(
    await remote.asDev(
      `PASEO_REMOTE_DEPLOY_LOGIN=1 ~/opt/paseo/bin/paseo daemon status --home ~/'work/paseo home' --json`,
    ),
  ) as Record<string, unknown>;
  expect(status).toMatchObject({ localDaemon: "running", listen: "127.0.0.1:7123" });

  const target = parseHostTarget(hosts.calls[0]!.connection);
  if (target.kind !== "ssh") throw new Error("expected an ssh connection");
  expect(target.ssh.daemonPort).toBe(7123);
  const forward = await tunnel(remote, sshOptions, 7123);
  try {
    expect(
      await daemonStatus(
        `tcp://127.0.0.1:${forward.port}?password=${encodeURIComponent(target.password!)}`,
      ),
    ).toMatchObject({ connectedDaemon: "reachable" });
  } finally {
    forward.close();
  }
});

test("a home set up outside the plugin is only taken over after asking", async () => {
  remote = await startRemote({ systemd: true });
  const existing = JSON.stringify({ daemon: { listen: "127.0.0.1:7000" } }, null, 2);
  await remote.asDev(
    `mkdir -p ~/.paseo/agents/-home-dev-shop && printf '%s\\n' '${existing}' > ~/.paseo/config.json && echo '{}' > ~/.paseo/agents/-home-dev-shop/a1.json`,
  );
  const sshOptions = await sshIdentity(remote, true);
  const title = "Take over an existing Paseo home?";

  const declined = await deploy(
    { sshPort: remote.port },
    {
      sshOptions,
      hosts: fakeHosts().api,
      answers: { "Unknown host key": "yes", [title]: "cancel" },
    },
  );
  expect(declined.job.status).toBe("cancelled");
  expect(declined.asked).toEqual(["Unknown host key", title]);
  // Nothing was installed and the other setup's config is untouched.
  expect(await remote.asDev("ls -A ~/.local/share/paseo 2>&1 || true")).toMatch(/No such file/u);
  expect(JSON.parse(await remote.asDev("cat ~/.paseo/config.json"))).toEqual(JSON.parse(existing));

  const accepted = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: fakeHosts().api, answers: { [title]: "continue" } },
  );
  expect(accepted.job.status, accepted.job.error ?? "").toBe("succeeded");
  expect(accepted.asked).toEqual([title, "Download and install?"]);
  expect(accepted.job.warnings.join("\n")).toMatch(/set up outside this plugin/u);
  const config = JSON.parse(await remote.asDev("cat ~/.paseo/config.json")) as {
    daemon: { listen: string; auth?: { password?: string } };
  };
  expect(config.daemon.listen).not.toBe("127.0.0.1:7000");
  expect(config.daemon.auth?.password).toMatch(/^\$2[aby]\$12\$/u);
  // The other setup's agent records are kept.
  expect((await remote.asDev("cat ~/.paseo/agents/-home-dev-shop/a1.json")).trim()).toBe("{}");
});

test("a custom relay is checked before installing, written to the config, and cleared again", async () => {
  remote = await startRemote({ systemd: true });
  const sshOptions = await sshIdentity(remote, true);
  const relaySettings = (await import("@getpaseo/protocol/host-target")).parseHostTarget;

  // Nothing listens on port 9: the deploy asks before installing anything.
  const unreachable = await deploy(
    {
      sshPort: remote.port,
      connectVia: "relay",
      relay: { endpoint: "127.0.0.1:9", useTls: false, publicEndpoint: null, publicUseTls: false },
    },
    {
      sshOptions,
      hosts: fakeHosts().api,
      answers: { "Unknown host key": "yes", "The relay is not reachable": "cancel" },
    },
  );
  expect(unreachable.job.status).toBe("cancelled");
  expect(unreachable.asked).toContain("The relay is not reachable");
  expect(await remote.asDev("ls -A ~/.local/share/paseo ~/.paseo 2>&1 || true")).toMatch(
    /No such file/u,
  );

  // Paseo's own relay, entered as a custom address with TLS.
  const hosts = fakeHosts();
  const custom = await deploy(
    {
      sshPort: remote.port,
      connectVia: "relay",
      relay: {
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        publicEndpoint: null,
        publicUseTls: true,
      },
    },
    { sshOptions, hosts: hosts.api, answers: {} },
  );
  expect(custom.job.status, custom.job.error ?? "").toBe("succeeded");
  expect(custom.job.log.join("\n")).toMatch(/The relay answers from both machines/u);
  const config = JSON.parse(await remote.asDev("cat ~/.paseo/config.json")) as {
    daemon: { relay: Record<string, unknown> };
  };
  expect(config.daemon.relay).toMatchObject({
    enabled: true,
    endpoint: "relay.paseo.sh:443",
    useTls: true,
  });
  expect(config.daemon.relay.publicEndpoint).toBeUndefined();
  const saved = hosts.calls[0]!.connection;
  const url = new URL(saved);
  expect(url.host).toBe("relay.paseo.sh:443");
  expect(url.searchParams.get("ssl")).toBe("true");
  expect(relaySettings(saved)).toMatchObject({ kind: "socket", password: expect.any(String) });
  expect(await daemonStatus(saved)).toMatchObject({ connectedDaemon: "reachable" });

  // Redeploying without a relay address returns to Paseo's defaults.
  const reset = await deploy(
    { sshPort: remote.port, connectVia: "relay", relay: null },
    { sshOptions, hosts: hosts.api, answers: { "Restart the running daemon?": "restart" } },
  );
  expect(reset.job.status, reset.job.error ?? "").toBe("succeeded");
  const after = JSON.parse(await remote.asDev("cat ~/.paseo/config.json")) as {
    daemon: { relay: Record<string, unknown> };
  };
  expect(after.daemon.relay).toEqual({ enabled: true });
});

test("a redeploy upgrades to the latest release, and a lower requested version downgrades only after a warning", async () => {
  remote = await startRemote({ systemd: true });
  const sshOptions = await sshIdentity(remote, true);
  const hosts = fakeHosts();
  const installedVersion = async () =>
    (
      await remote!.asDev(
        "~/.local/share/paseo/current/bin/node -p 'require(process.argv[1]).version' ~/.local/share/paseo/current/lib/node_modules/@getpaseo/cli/package.json",
      )
    ).trim();
  // Whatever latest is today; the remote's npm resolves the same tag.
  const latest = (
    await promisify(execFile)("npm", ["view", "@getpaseo/cli@latest", "version"])
  ).stdout.trim();
  const paseoStep = (job: { steps: { id: string; detail: string | null }[] }) =>
    job.steps.find((step) => step.id === "paseo")?.detail;

  const first = await deploy(
    { sshPort: remote.port, paseoVersion: "0.13.0-beta.1" },
    { sshOptions, hosts: hosts.api, answers: { "Unknown host key": "yes" } },
  );
  expect(first.job.status, first.job.error ?? "").toBe("succeeded");
  expect(paseoStep(first.job)).toBe("Installed Paseo 0.13.0-beta.1.");
  expect(first.job.result?.paseoVersion).toBe("0.13.0-beta.1");

  // Empty version field: the redeploy upgrades to latest and says so before restarting.
  const upgrade = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { "Restart the running daemon?": "restart" } },
  );
  expect(upgrade.job.status, upgrade.job.error ?? "").toBe("succeeded");
  expect(upgrade.messages["Restart the running daemon?"]).toContain(
    `Paseo is upgraded from 0.13.0-beta.1 to ${latest}.`,
  );
  expect(paseoStep(upgrade.job)).toBe(`Upgraded Paseo from 0.13.0-beta.1 to ${latest}.`);
  expect(upgrade.job.result?.paseoVersion).toBe(latest);

  // A lower requested version, with the daemon running: one question covers restart and downgrade.
  const title = "Downgrade and restart the running daemon?";
  const downgrade = await deploy(
    { sshPort: remote.port, paseoVersion: "0.13.0-beta.2" },
    { sshOptions, hosts: hosts.api, answers: { [title]: "restart" } },
  );
  expect(downgrade.job.status, downgrade.job.error ?? "").toBe("succeeded");
  expect(downgrade.messages[title]).toContain(`downgrades Paseo from ${latest} to 0.13.0-beta.2. `);
  expect(downgrade.messages[title]).toMatch(/no migrations/u);
  expect(paseoStep(downgrade.job)).toBe(`Downgraded Paseo from ${latest} to 0.13.0-beta.2.`);
  expect(downgrade.job.result?.paseoVersion).toBe("0.13.0-beta.2");

  // With the daemon stopped, a downgrade still asks; declining leaves the install as it was.
  await remote.asDev("systemctl --user stop paseo-daemon.service");
  const declined = await deploy(
    { sshPort: remote.port, paseoVersion: "0.13.0-beta.1" },
    { sshOptions, hosts: hosts.api, answers: { "Downgrade Paseo?": "cancel" } },
  );
  expect(declined.job.status).toBe("cancelled");
  expect(declined.messages["Downgrade Paseo?"]).toMatch(/0.13.0-beta.2 to 0.13.0-beta.1/u);
  expect(await installedVersion()).toBe("0.13.0-beta.2");
});

test("a redeploy moves Node.js to the pinned major and reinstalls Paseo; a lower major downgrades after a warning", async () => {
  remote = await startRemote({ systemd: true });
  const sshOptions = await sshIdentity(remote, true);
  const hosts = fakeHosts();
  const nodeFolders = async () =>
    (await remote!.asDev("ls -d ~/.local/share/paseo/node-v* | xargs -n1 basename"))
      .trim()
      .split("\n");
  const daemonExe = async () =>
    (
      await remote!.asDev(
        "readlink -f /proc/$(systemctl --user show -p MainPID --value paseo-daemon.service)/exe",
      )
    ).trim();
  const step = (job: { steps: { id: string; detail: string | null }[] }, id: string) =>
    job.steps.find((candidate) => candidate.id === id)?.detail ?? "";

  const onOld = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { "Unknown host key": "yes" }, nodeMajor: 22 },
  );
  expect(onOld.job.status, onOld.job.error ?? "").toBe("succeeded");
  expect(onOld.job.result?.nodeVersion).toMatch(/^v22\./u);
  const paseoVersion = onOld.job.result?.paseoVersion;

  // The plugin pins 24: the redeploy says so, unpacks it, reinstalls the same Paseo and drops 22.
  const upgrade = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { "Restart the running daemon?": "restart" } },
  );
  expect(upgrade.job.status, upgrade.job.error ?? "").toBe("succeeded");
  expect(upgrade.messages["Restart the running daemon?"]).toMatch(
    /Node\.js is upgraded from v22\.[0-9.]+ to v24\.[0-9.]+, and Paseo reinstalled for it\./u,
  );
  expect(step(upgrade.job, "node")).toMatch(/^Upgraded Node\.js from v22\.[0-9.]+ to v24\./u);
  expect(step(upgrade.job, "paseo")).toBe(
    `Reinstalled Paseo ${paseoVersion} for Node.js ${upgrade.job.result?.nodeVersion}.`,
  );
  expect(upgrade.job.result).toMatchObject({
    paseoVersion,
    nodeVersion: expect.stringMatching(/^v24\./u),
  });
  expect(await nodeFolders()).toEqual([expect.stringMatching(/^node-v24\./u)]);
  expect(await daemonExe()).toMatch(/\/node-v24\.[0-9.]+-linux-(x64|arm64)\/bin\/node$/u);

  // Pinning 22 again is a downgrade: one question covers it and the restart.
  const title = "Downgrade and restart the running daemon?";
  const downgrade = await deploy(
    { sshPort: remote.port },
    { sshOptions, hosts: hosts.api, answers: { [title]: "restart" }, nodeMajor: 22 },
  );
  expect(downgrade.job.status, downgrade.job.error ?? "").toBe("succeeded");
  expect(downgrade.messages[title]).toMatch(/This downgrades Node\.js from v24\.[0-9.]+ to v22\./u);
  expect(downgrade.job.result?.nodeVersion).toMatch(/^v22\./u);
  expect(await nodeFolders()).toEqual([expect.stringMatching(/^node-v22\./u)]);
  expect(await daemonExe()).toMatch(/\/node-v22\.[0-9.]+-linux-(x64|arm64)\/bin\/node$/u);
});

test("declining the download question leaves the machine untouched", async () => {
  remote = await startRemote({ systemd: true });
  const sshOptions = await sshIdentity(remote, true);
  const { job, messages } = await deploy(
    { sshPort: remote.port },
    {
      sshOptions,
      hosts: fakeHosts().api,
      answers: { "Unknown host key": "yes", "Download and install?": "cancel" },
    },
  );
  expect(job.status).toBe("cancelled");
  const message = messages["Download and install?"] ?? "";
  expect(message).toMatch(/downloads and installs into \/home\/dev\/\.local\/share\/paseo on /u);
  expect(message).toMatch(
    /Node\.js v24\.[0-9.]+ from nodejs\.org, checked against its published SHA-256/u,
  );
  expect(message).toMatch(/@getpaseo\/cli@latest and its dependencies from the npm registry/u);
  expect(await remote.asDev("ls -A ~/.local/share/paseo ~/.paseo 2>&1 || true")).toMatch(
    /No such file/u,
  );
});
