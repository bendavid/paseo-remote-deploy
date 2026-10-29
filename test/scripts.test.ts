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
import { CHECK_RELAY, INSPECT, RESOLVE_PASEO, SET_CRONTAB } from "../server/remote-scripts";
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
  expect(defaults.get("daemonRunning")).toBeUndefined();

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

test("INSPECT reports a live daemon and the host that holds the lock", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  mkdirSync(join(home, ".paseo"));
  writeFileSync(
    join(home, ".paseo", "paseo.pid"),
    JSON.stringify({ pid: process.pid, hostname: "other-node", listen: "127.0.0.1:6767" }, null, 2),
  );
  writeFileSync(join(home, ".paseo", "remote-deploy.json"), '{"installDir":"/x","port":7000}\n');
  const values = run(INSPECT, { HOME: home, REQ_INSTALL_DIR: "", REQ_PASEO_HOME: "" });
  expect(values.get("daemonRunning")).toBe("yes");
  expect(values.get("lockHostname")).toBe("other-node");
  expect(values.get("managedHome")).toBe("yes");
  expect(values.get("deployment")).toBe('{"installDir":"/x","port":7000}');
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

test("INSPECT describes a home another setup left behind", () => {
  const home = mkdtempSync(join(tmpdir(), "rd-inspect-"));
  mkdirSync(join(home, ".paseo", "agents", "-home-dev-shop"), { recursive: true });
  writeFileSync(
    join(home, ".paseo", "config.json"),
    JSON.stringify(
      { daemon: { listen: "127.0.0.1:7000", auth: { password: "$2b$12$hash" } } },
      null,
      2,
    ),
  );
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
  expect(values.get("homeConfigured")).toBe("yes");
  expect(values.get("homeListen")).toBe("127.0.0.1:7000");
  expect(values.get("homePassword")).toBe("yes");
  expect(values.get("homeAgents")).toBe("2");
  expect(values.get("lockStartedAt")).toBe("2026-10-20T08:00:00.000Z");
  expect(values.get("lockDesktopManaged")).toBe("yes");
  expect(values.get("daemonRunning")).toBeUndefined();
  expect(values.get("managedHome")).toBeUndefined();
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
