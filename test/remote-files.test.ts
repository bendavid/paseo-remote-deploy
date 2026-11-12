import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEPLOYMENT_ID,
  deploymentUnit,
  newDeploymentId,
  readUnit,
  renderLauncher,
  renderUnit,
  splitExecStart,
  systemdArgument,
} from "../server/remote-files";

/** An install directory whose "node" prints its arguments and PATH instead of running Paseo. */
function fakeInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), "rd test '"));
  mkdirSync(join(dir, "current", "bin"), { recursive: true });
  writeFileSync(
    join(dir, "current", "bin", "node"),
    '#!/bin/sh\nprintf "%s|" "$@"\nprintf "PATH=%s\\n" "$PATH"\n',
  );
  chmodSync(join(dir, "current", "bin", "node"), 0o755);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "paseo"), renderLauncher(dir));
  chmodSync(join(dir, "bin", "paseo"), 0o755);
  return dir;
}

describe("renderLauncher", () => {
  test("runs the CLI with its own node and puts that node first on PATH", () => {
    const dir = fakeInstall();
    const output = execFileSync(join(dir, "bin", "paseo"), ["daemon", "run", "--home", "/h o/me"], {
      env: { PATH: "/usr/bin:/bin", PASEO_REMOTE_DEPLOY_LOGIN: "1" },
      encoding: "utf8",
    });
    expect(output).toBe(
      `${dir}/current/lib/node_modules/@getpaseo/cli/bin/paseo|daemon|run|--home|/h o/me|PATH=${dir}/current/bin:/usr/bin:/bin\n`,
    );
  });

  test("re-enters the login shell first so agents see the user's PATH, after its own node", () => {
    const dir = fakeInstall();
    const home = mkdtempSync(join(tmpdir(), "rd-home-"));
    // The launcher uses the account's shell from the password database, as cron sets SHELL=/bin/sh.
    for (const profile of [".profile", ".bash_profile", ".zprofile"]) {
      writeFileSync(join(home, profile), 'PATH="/opt/from-profile:$PATH"; export PATH\n');
    }
    const output = execFileSync(join(dir, "bin", "paseo"), ["--version"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
      encoding: "utf8",
    });
    expect(output).toMatch(
      new RegExp(
        `\\|PATH=${dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/current/bin:/opt/from-profile:`,
        "u",
      ),
    );
    // The marker that stops the second pass does not leak into the daemon's environment.
    const env = execFileSync(join(dir, "bin", "paseo"), [], {
      env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
      encoding: "utf8",
    });
    expect(env).not.toContain("PASEO_REMOTE_DEPLOY_LOGIN");
  });
});

describe("systemd unit", () => {
  test("is named after a random deployment ID", () => {
    const id = newDeploymentId();
    expect(id).toMatch(DEPLOYMENT_ID);
    expect(newDeploymentId()).not.toBe(id);
    expect(deploymentUnit(id)).toBe(`paseo-remote-deploy-${id}.service`);
  });

  test("escapes ExecStart arguments", () => {
    expect(systemdArgument("/home/dev/.paseo")).toBe("/home/dev/.paseo");
    expect(systemdArgument("/home/my dir")).toBe('"/home/my dir"');
    expect(systemdArgument("/a$b%c")).toBe("/a$$b%%c");
  });

  test("runs the launcher in the foreground, pinned to a machine when given one", () => {
    const unit = renderUnit({
      installDir: "/home/dev/.local/share/paseo",
      paseoHome: "/home/dev/.paseo",
      machineId: "0123456789abcdef0123456789abcdef",
    });
    expect(unit).toContain(
      "ExecStart=/home/dev/.local/share/paseo/bin/paseo daemon run --home /home/dev/.paseo",
    );
    expect(unit).toMatch(/\[Unit\]\n.*\nConditionHost=0123456789abcdef0123456789abcdef\n/u);
    expect(unit).toContain("Written by the Paseo remote-deploy plugin");
    expect(unit).toContain("WantedBy=default.target");
    const unpinned = renderUnit({
      installDir: "/i",
      paseoHome: "/h",
      machineId: null,
    });
    expect(unpinned).not.toContain("ConditionHost");
  });

  test("reads back the home and machine from a unit it wrote", () => {
    for (const home of ["/home/dev/.paseo", "/pool/my paseo", '/a$b%c"d\\e', "/tab\there"]) {
      const content = renderUnit({
        installDir: "/opt/paseo install",
        paseoHome: home,
        machineId: "0123456789abcdef0123456789abcdef",
      });
      expect(readUnit("paseo-remote-deploy-x.service", content)).toEqual({
        name: "paseo-remote-deploy-x.service",
        home,
        machineId: "0123456789abcdef0123456789abcdef",
      });
    }
    // Units from before ConditionHost.
    expect(
      readUnit(
        "paseo-daemon.service",
        "[Service]\nExecStart=/i/bin/paseo daemon run --home /home/dev/.paseo\n",
      ),
    ).toEqual({ name: "paseo-daemon.service", home: "/home/dev/.paseo", machineId: null });
    expect(splitExecStart('a "b c" d')).toEqual(["a", "b c", "d"]);
  });
});
