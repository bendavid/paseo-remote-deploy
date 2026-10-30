import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { readInspection } from "../server/deploy";
import { CHECK_RELAY, INSPECT, PROBE, RESOLVE_PASEO, SET_CRONTAB } from "../server/remote-scripts";
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

describe("SET_CRONTAB", () => {
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
