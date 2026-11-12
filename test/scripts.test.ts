import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { readInspection } from "../server/deploy";
import {
  CHECK_RELAY,
  INSPECT,
  INSTALL_NODE,
  PROBE,
  PRUNE_NODE,
  RESOLVE_PASEO,
  SET_CRONTAB,
  STOP_DAEMON,
  TERMINAL_SOCKETS,
} from "../server/remote-scripts";
import { renderUnit } from "../server/remote-files";
import { cronTag, renderCronLines } from "../server/service-plan";

function run(script: string, env: Record<string, string>): Map<string, string> {
  const output = execFileSync("/bin/sh", ["-c", script, "test"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^@@([A-Za-z0-9]+)=(.*)$/u.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

test("INSPECT resolves default and ~ paths against the remote HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  const defaults = run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" });
  expect(defaults.get("installDir")).toBe(`${home}/.local/share/paseo`);
  expect(defaults.get("paseoHome")).toBe(`${home}/.paseo`);
  expect(defaults.get("home")).toBe(home);
  expect(defaults.get("lock")).toBeUndefined();
  expect(defaults.get("config")).toBeUndefined();

  const custom = run(INSPECT, {
    HOME: home,
    XDG_DATA_HOME: `${home}/data`,
    REQ_INSTALL_DIR: "~/apps/paseo",
    REQ_PASEO_HOME: "work/.paseo",
  });
  expect(custom.get("installDir")).toBe(`${home}/apps/paseo`);
  expect(custom.get("paseoHome")).toBe(`${home}/work/.paseo`);
  expect(
    run(INSPECT, {
      HOME: home,
      XDG_DATA_HOME: `${home}/data`,
      REQ_INSTALL_DIR: "",
      REQ_PASEO_HOME: "",
    }).get("installDir"),
  ).toBe(`${home}/data/paseo`);
});

test("INSPECT sends the lock and deployment record back for the plugin to parse", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  mkdirSync(join(home, ".paseo"));
  const lock = { pid: process.pid, hostname: "other-node", listen: "127.0.0.1:6767" };
  writeFileSync(join(home, ".paseo", "paseo.pid"), JSON.stringify(lock, null, 2));
  writeFileSync(join(home, ".paseo", "remote-deploy.json"), '{"installDir":"/x","port":7000}\n');
  const values = run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" });
  expect(JSON.parse(values.get("lock")!)).toEqual(lock);
  expect(values.get("managedHome")).toBe("yes");
  expect(values.get("deployment")).toBe('{"installDir":"/x","port":7000}');
  expect(readInspection(values)).toMatchObject({
    lock: { pid: process.pid, hostname: "other-node", startedAt: null, desktopManaged: false },
    previous: { installDir: "/x", port: 7000 },
    daemonRunning: false,
  });
});

describe("PROBE", () => {
  function worktree(root: string, project: string, slug: string) {
    mkdirSync(join(root, project, slug), { recursive: true });
    writeFileSync(join(root, project, slug, ".git"), "gitdir: /elsewhere\n");
  }

  test("reports whether the lock's process is alive", () => {
    expect(run(PROBE, { PID: String(process.pid), WORKTREES_ROOT: "" }).get("daemonRunning")).toBe(
      "yes",
    );
    expect(run(PROBE, { PID: String(2 ** 22 + 7), WORKTREES_ROOT: "" }).has("daemonRunning")).toBe(
      false,
    );
    expect(run(PROBE, { PID: "", WORKTREES_ROOT: "" }).size).toBe(0);
  });

  test("counts the worktrees in a root: <root>/<project hash>/<slug> with a .git", () => {
    const root = mkdtempSync(join(tmpdir(), "rd-worktrees-"));
    worktree(root, "1vnnm9k3", "tidy-fox");
    worktree(root, "8adkq2mz", "bold-owl");
    mkdirSync(join(root, "8adkq2mz", "leftover"), { recursive: true });
    expect(run(PROBE, { PID: "", WORKTREES_ROOT: root }).get("worktreesInRoot")).toBe("2");
    expect(
      run(PROBE, { PID: "", WORKTREES_ROOT: join(root, "missing") }).get("worktreesInRoot"),
    ).toBe("0");
  });
});

/** A fake crontab command backed by a file, so the test never touches a real crontab. */
function fakeCrontab(initial: string | null): {
  env: Record<string, string>;
  read(): string | null;
} {
  const dir = mkdtempSync(join(tmpdir(), "rd-cron-"));
  const file = join(dir, "crontab.txt");
  if (initial !== null) writeFileSync(file, initial);
  const command = join(dir, "crontab");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `file='${file}'`,
      'case "$1" in',
      '  -l) [ -f "$file" ] && cat "$file" && exit 0; echo "no crontab for $(id -un)" >&2; exit 1 ;;',
      '  -r) rm -f "$file" ;;',
      '  -) cat > "$file" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    env: { PASEO_REMOTE_DEPLOY_CRONTAB: command },
    read: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
  };
}

describe("SET_CRONTAB", () => {
  const tag = cronTag("paseo-daemon.service");
  const lines = renderCronLines({ schedule: "reboot", installDir: "/i", paseoHome: "/h", tag });

  test("adds this deployment's lines and keeps the user's own", () => {
    const crontab = fakeCrontab("MAILTO=me\n0 3 * * * backup --all # nightly\n");
    run(SET_CRONTAB, { ...crontab.env, CRON_TAG: tag, CRON_LINES: lines });
    expect(crontab.read()).toBe(`MAILTO=me\n0 3 * * * backup --all # nightly\n${lines}\n`);
  });

  test("replaces earlier lines instead of adding duplicates", () => {
    const crontab = fakeCrontab(`0 3 * * * backup\n${lines}\n`);
    const keepalive = renderCronLines({
      schedule: "keepalive",
      installDir: "/i",
      paseoHome: "/h",
      tag,
    });
    run(SET_CRONTAB, { ...crontab.env, CRON_TAG: tag, CRON_LINES: keepalive });
    expect(crontab.read()).toBe(`0 3 * * * backup\n${keepalive}\n`);
  });

  test("removes only this deployment's lines, and another home's stay", () => {
    const other = renderCronLines({
      schedule: "reboot",
      installDir: "/i",
      paseoHome: "/other",
      tag: cronTag("paseo-daemon-1234abcd.service"),
    });
    const crontab = fakeCrontab(`${lines}\n${other}\n`);
    run(SET_CRONTAB, { ...crontab.env, CRON_TAG: tag, CRON_LINES: "" });
    expect(crontab.read()).toBe(`${other}\n`);
  });

  test("leaves no crontab behind when its only lines were this deployment's", () => {
    const crontab = fakeCrontab(`${lines}\n`);
    run(SET_CRONTAB, { ...crontab.env, CRON_TAG: tag, CRON_LINES: "" });
    expect(crontab.read()).toBeNull();
  });

  test("creates a crontab for a user without one, and removing does nothing", () => {
    const empty = fakeCrontab(null);
    run(SET_CRONTAB, { ...empty.env, CRON_TAG: tag, CRON_LINES: "" });
    expect(empty.read()).toBeNull();
    run(SET_CRONTAB, { ...empty.env, CRON_TAG: tag, CRON_LINES: lines });
    expect(empty.read()).toBe(`${lines}\n`);
  });
});

test("INSPECT sends back a home another setup left behind, which the plugin parses", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  mkdirSync(join(home, ".paseo", "agents", "-home-dev-shop"), { recursive: true });
  const config = {
    daemon: { listen: "127.0.0.1:7000", auth: { password: "$2b$12$hash" } },
    worktrees: { root: " ~/trees ", servicePorts: { range: [4000, 4100] } },
    providers: { claude: { enabled: true } },
  };
  writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(home, ".paseo", "agents", "-home-dev-shop", "a1.json"), "{}");
  writeFileSync(join(home, ".paseo", "agents", "-home-dev-shop", "a2.json"), "{}");
  // A stale lock from a desktop-managed daemon whose process is gone.
  writeFileSync(
    join(home, ".paseo", "paseo.pid"),
    JSON.stringify(
      { pid: 2 ** 22 + 7, startedAt: "2026-10-20T08:00:00.000Z", desktopManaged: true },
      null,
      2,
    ),
  );
  const values = run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" });
  expect(JSON.parse(values.get("config")!)).toEqual(config);
  expect(values.get("homeAgents")).toBe("2");
  expect(readInspection(values)).toMatchObject({
    homeConfigured: true,
    homeConfig: { listen: "127.0.0.1:7000", password: true, worktreesRoot: "~/trees" },
    homeAgents: 2,
    lock: { pid: 2 ** 22 + 7, startedAt: "2026-10-20T08:00:00.000Z", desktopManaged: true },
    managedHome: false,
  });
});

test("a config.json the plugin cannot parse is reported as such", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  mkdirSync(join(home, ".paseo"));
  writeFileSync(join(home, ".paseo", "config.json"), "{ not json");
  const unreadable = readInspection(
    run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" }),
  );
  expect(unreadable).toMatchObject({ homeConfigured: true, homeConfig: null });
  writeFileSync(join(home, ".paseo", "config.json"), '{"daemon":{"listen":6767}}');
  expect(
    readInspection(run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" }))
      .homeConfig,
  ).toBeNull();
});

test("CHECK_RELAY reports a reachable relay and why an unreachable one failed", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => response.writeHead(426).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    // execFileSync would block the server answering in this same process, so run it async.
    const { execFile } = await import("node:child_process");
    const runAsync = (env: Record<string, string>) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          "/bin/sh",
          ["-c", CHECK_RELAY, "test"],
          { env: { PATH: process.env.PATH ?? "", ...env } },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
    expect(await runAsync({ RELAY_URL: `http://127.0.0.1:${port}/` })).toContain("@@relayCheck=ok");
    const failed = await runAsync({ RELAY_URL: "http://127.0.0.1:9/" });
    expect(failed).toContain("@@relayCheck=failed");
    expect(failed).toMatch(/@@relayError=.+/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("RESOLVE_PASEO", () => {
  /**
   * An install directory whose `node` is this Node.js, with npm's real semver library, and whose
   * `npm view` answers from a fixture instead of the registry.
   */
  function fakeInstall(viewOutput: string): string {
    // Official Node.js archives bundle semver inside npm; any copy will do for the test.
    const semver = dirname(createRequire(import.meta.url).resolve("semver/package.json"));
    const dir = mkdtempSync(join(tmpdir(), "rd-resolve-"));
    mkdirSync(join(dir, "current", "bin"), { recursive: true });
    mkdirSync(join(dir, "current", "lib", "node_modules", "npm", "node_modules"), {
      recursive: true,
    });
    symlinkSync(process.execPath, join(dir, "current", "bin", "node"));
    symlinkSync(
      semver,
      join(dir, "current", "lib", "node_modules", "npm", "node_modules", "semver"),
    );
    writeFileSync(join(dir, "view.json"), viewOutput);
    writeFileSync(
      join(dir, "current", "bin", "npm"),
      `#!/bin/sh\ncat '${join(dir, "view.json")}'\n`,
      {
        mode: 0o755,
      },
    );
    return dir;
  }

  test.each([
    ['"0.13.0"', "latest", "0.13.0-beta.2", "0.13.0", "newer"],
    ['"0.13.0"', "latest", "0.13.0", "0.13.0", "same"],
    ['"0.13.0-beta.1"', "0.13.0-beta.1", "0.13.0", "0.13.0-beta.1", "older"],
    // A range lists every match; the highest wins, by semver rather than by string.
    ['["0.9.0", "0.12.0", "0.10.0"]', ">=0.9", "0.11.4", "0.12.0", "newer"],
  ])("%s for %s against %s resolves to %s (%s)", (view, spec, current, resolved, relation) => {
    const dir = fakeInstall(view);
    const values = run(RESOLVE_PASEO, { INSTALL_DIR: dir, SPEC: spec, CURRENT: current });
    expect(values.get("resolvedVersion")).toBe(resolved);
    expect(values.get("relation")).toBe(relation);
  });

  test("fails with a sentence when nothing matches", () => {
    const dir = fakeInstall("");
    expect(() =>
      run(RESOLVE_PASEO, { INSTALL_DIR: dir, SPEC: "9.9.9", CURRENT: "0.13.0" }),
    ).toThrow();
  });
});

describe("deployment units", () => {
  const MACHINE = "0123456789abcdef0123456789abcdef";

  function unitDir(home: string): string {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A fake systemctl that logs its arguments, so tests never reach the real user manager. */
  function fakeSystemctl(): { path: string; calls(): string[] } {
    const dir = mkdtempSync(join(tmpdir(), "rd-systemctl-"));
    const log = join(dir, "calls.txt");
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, {
      mode: 0o755,
    });
    return {
      path: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    };
  }

  test("INSPECT sends back this plugin's units whole, and the machine ID", () => {
    const home = mkdtempSync(join(tmpdir(), "rd-units-"));
    const dir = unitDir(home);
    const unit = renderUnit({
      installDir: "/i",
      paseoHome: `${home}/my paseo`,
      machineId: MACHINE,
    });
    writeFileSync(join(dir, "paseo-remote-deploy-0123456789abcdef.service"), `${unit}\n`);
    writeFileSync(join(dir, "paseo-daemon.service"), "[Service]\nExecStart=/x daemon run\n");
    writeFileSync(join(dir, "other.service"), `${unit}\n`);
    const values = run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" });
    const inspection = readInspection(values);
    // The unit without the plugin's marker and the one under another name are not reported.
    expect(inspection.units).toEqual([
      {
        name: "paseo-remote-deploy-0123456789abcdef.service",
        home: `${home}/my paseo`,
        machineId: MACHINE,
      },
    ]);
    if (existsSync("/etc/machine-id")) {
      expect(inspection.machineId).toBe(readFileSync("/etc/machine-id", "utf8").trim());
    }
  });

  test("PROBE resolves another spelling of a home to the same real path", () => {
    const home = mkdtempSync(join(tmpdir(), "rd-real-"));
    mkdirSync(join(home, "paseo"));
    symlinkSync(join(home, "paseo"), join(home, "link"));
    const values = run(PROBE, {
      PID: "",
      WORKTREES_ROOT: "",
      PASEO_HOME: join(home, "paseo"),
      UNIT_HOMES: [join(home, "link"), join(home, "missing")].join("\n"),
    });
    expect(values.get("realHome0")).toBe(values.get("realPaseoHome"));
    expect(values.get("realHome1")).toBe("");
  });

  test("STOP_DAEMON retires the units it is given, with their crontab lines", () => {
    const home = mkdtempSync(join(tmpdir(), "rd-retire-"));
    const dir = unitDir(home);
    const old = "paseo-daemon.service";
    const mine = "paseo-remote-deploy-0123456789abcdef.service";
    writeFileSync(
      join(dir, old),
      `${renderUnit({ installDir: "/i", paseoHome: "/h", machineId: null })}\n`,
    );
    writeFileSync(join(dir, "foreign.service"), "[Service]\nExecStart=/bin/true\n");
    const oldLines = renderCronLines({
      schedule: "reboot",
      installDir: "/i",
      paseoHome: "/h",
      tag: cronTag(old),
    });
    const crontab = fakeCrontab(`0 3 * * * backup\n${oldLines}\n`);
    const systemctl = fakeSystemctl();
    const values = run(STOP_DAEMON, {
      ...crontab.env,
      HOME: home,
      PATH: systemctl.path,
      INSTALL_DIR: join(home, "no-install"),
      PASEO_HOME: "/h",
      UNIT: mine,
      CRON_TAG: cronTag(mine),
      RETIRE: `${old} foreign.service not-a-unit`,
    });
    expect(values.get("retired")?.trim().split(" ")).toEqual([old, "foreign.service"]);
    expect(existsSync(join(dir, old))).toBe(false);
    // Disabled, but a unit the plugin did not write is never deleted.
    expect(existsSync(join(dir, "foreign.service"))).toBe(true);
    expect(crontab.read()).toBe("0 3 * * * backup\n");
    expect(systemctl.calls()).toEqual(
      expect.arrayContaining([`--user disable --now ${old}`, "--user daemon-reload"]),
    );
  });
});

describe("TERMINAL_SOCKETS", () => {
  /** A Paseo home and an install directory whose node is the one running these tests. */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "rd-sock-"));
    mkdirSync(join(root, "install", "current", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(root, "install", "current", "bin", "node"));
    const home = join(root, "home");
    mkdirSync(home);
    const sock = join(home, "terminal-worker", "sock");
    const env = { INSTALL_DIR: join(root, "install"), PASEO_HOME: home };
    return { home, sock, env };
  }

  test("binds a real test socket where the filesystem allows it, and leaves the directory alone", () => {
    const { sock, env } = setup();
    mkdirSync(sock, { recursive: true, mode: 0o700 });
    const values = run(TERMINAL_SOCKETS, env);
    expect(values.get("terminalSockets")).toBe("ok");
    expect(values.has("terminalSocketWorkaround")).toBe(false);
    expect(statSync(sock).isDirectory()).toBe(true);
    // The probe cleans up after itself.
    expect(readdirSync(join(sock, ".."))).toEqual(["sock"]);
  });

  test("where sockets cannot be bound, an empty file replaces the empty directory", () => {
    for (const code of ["EPERM", "EACCES", "EOPNOTSUPP", "ENOTSUP"]) {
      const { sock, env } = setup();
      mkdirSync(sock, { recursive: true, mode: 0o700 });
      const values = run(TERMINAL_SOCKETS, { ...env, PASEO_REMOTE_DEPLOY_SOCKET_TEST: code });
      expect(values.get("terminalSockets")).toBe(code);
      expect(values.get("terminalSocketWorkaround")).toBe("applied");
      expect(statSync(sock).isFile()).toBe(true);
      expect(statSync(sock).size).toBe(0);
    }
    // A fresh home gets the file too, and a second deploy keeps it.
    const { sock, env } = setup();
    const forced = { ...env, PASEO_REMOTE_DEPLOY_SOCKET_TEST: "EPERM" };
    expect(run(TERMINAL_SOCKETS, forced).get("terminalSocketWorkaround")).toBe("applied");
    expect(run(TERMINAL_SOCKETS, forced).get("terminalSocketWorkaround")).toBe("applied");
    expect(statSync(sock).isFile()).toBe(true);
  });

  test("once sockets work, the empty file goes; a file with content is never removed", () => {
    const { sock, env } = setup();
    run(TERMINAL_SOCKETS, { ...env, PASEO_REMOTE_DEPLOY_SOCKET_TEST: "EPERM" });
    const values = run(TERMINAL_SOCKETS, env);
    expect(values.get("terminalSocketWorkaround")).toBe("removed");
    expect(existsSync(sock)).toBe(false);
    writeFileSync(sock, "not ours");
    expect(run(TERMINAL_SOCKETS, env).has("terminalSocketWorkaround")).toBe(false);
    expect(readFileSync(sock, "utf8")).toBe("not ours");
  });

  test("a socket directory with files in it fails the step instead of being removed", () => {
    const { sock, env } = setup();
    mkdirSync(sock, { recursive: true });
    writeFileSync(join(sock, "keep"), "");
    expect(() =>
      run(TERMINAL_SOCKETS, { ...env, PASEO_REMOTE_DEPLOY_SOCKET_TEST: "EPERM" }),
    ).toThrow();
    expect(existsSync(join(sock, "keep"))).toBe(true);
  });

  test("other errors change nothing and are reported", () => {
    const { sock, env } = setup();
    const values = run(TERMINAL_SOCKETS, {
      ...env,
      PASEO_REMOTE_DEPLOY_SOCKET_TEST: "ENAMETOOLONG",
    });
    expect(values.get("terminalSockets")).toBe("unknown");
    expect(values.get("terminalSocketError")).toBe("error ENAMETOOLONG");
    expect(existsSync(sock)).toBe(false);
  });
});

describe("Node.js folders", () => {
  const NODE_DIR = "node-v99.0.0-linux-x64";

  /** A Node.js release with a stand-in node, served from a file:// URL that curl accepts. */
  function fakeRelease(): { url: string; sha256: string } {
    const dir = mkdtempSync(join(tmpdir(), "rd-release-"));
    mkdirSync(join(dir, NODE_DIR, "bin"), { recursive: true });
    writeFileSync(join(dir, NODE_DIR, "bin", "node"), "#!/bin/sh\necho v99.0.0\n", { mode: 0o755 });
    execFileSync("tar", ["-czf", join(dir, "node.tar.gz"), "-C", dir, NODE_DIR]);
    const sha256 = createHash("sha256")
      .update(readFileSync(join(dir, "node.tar.gz")))
      .digest("hex");
    return { url: `file://${join(dir, "node.tar.gz")}`, sha256 };
  }

  function installEnv(installDir: string) {
    const release = fakeRelease();
    return {
      INSTALL_DIR: installDir,
      NODE_URL: release.url,
      NODE_SHA256: release.sha256,
      NODE_DIR,
    };
  }

  test("INSTALL_NODE replaces a folder an unfinished deploy left, instead of reusing it", () => {
    const install = mkdtempSync(join(tmpdir(), "rd-install-"));
    // As a cancelled deploy leaves it: a working node and a half-installed Paseo.
    mkdirSync(join(install, NODE_DIR, "bin"), { recursive: true });
    writeFileSync(join(install, NODE_DIR, "bin", "node"), "#!/bin/sh\necho v99.0.0\n", {
      mode: 0o755,
    });
    mkdirSync(join(install, NODE_DIR, "lib", "node_modules", "@getpaseo", "cli"), {
      recursive: true,
    });
    writeFileSync(
      join(install, NODE_DIR, "lib", "node_modules", "@getpaseo", "cli", "package.json"),
      "{}",
    );
    const values = run(INSTALL_NODE, installEnv(install));
    expect(values.get("replacedLeftover")).toBe("yes");
    expect(values.has("reused")).toBe(false);
    expect(values.get("nodeVersion")).toBe("v99.0.0");
    expect(existsSync(join(install, NODE_DIR, "lib"))).toBe(false);
  });

  test("INSTALL_NODE reuses the folder in use", () => {
    const install = mkdtempSync(join(tmpdir(), "rd-install-"));
    mkdirSync(join(install, NODE_DIR, "bin"), { recursive: true });
    writeFileSync(join(install, NODE_DIR, "bin", "node"), "#!/bin/sh\necho v99.0.0\n", {
      mode: 0o755,
    });
    writeFileSync(join(install, NODE_DIR, "keep"), "");
    symlinkSync(NODE_DIR, join(install, "current"));
    const values = run(INSTALL_NODE, installEnv(install));
    expect(values.get("reused")).toBe("yes");
    expect(existsSync(join(install, NODE_DIR, "keep"))).toBe(true);
  });

  test("PRUNE_NODE reports a folder it cannot remove instead of failing", () => {
    const install = mkdtempSync(join(tmpdir(), "rd-prune-"));
    writeFileSync(join(install, ".remote-deploy"), "");
    for (const name of [NODE_DIR, "node-v1.0.0-linux-x64", "node-v2.0.0-linux-x64"]) {
      mkdirSync(join(install, name, "bin"), { recursive: true });
    }
    // A read-only directory with a file in it cannot be emptied.
    const stuck = join(install, "node-v2.0.0-linux-x64", "bin");
    writeFileSync(join(stuck, "node"), "");
    chmodSync(stuck, 0o555);
    try {
      const values = run(PRUNE_NODE, { INSTALL_DIR: install, KEEP: NODE_DIR });
      expect(values.get("pruneFailed")?.trim()).toBe("node-v2.0.0-linux-x64");
      expect(existsSync(join(install, "node-v1.0.0-linux-x64"))).toBe(false);
      expect(existsSync(join(install, NODE_DIR))).toBe(true);
    } finally {
      chmodSync(stuck, 0o755);
    }
  });
});
