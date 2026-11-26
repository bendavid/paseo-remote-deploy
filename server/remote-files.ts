import { randomBytes } from "node:crypto";
import { shellQuote } from "./ssh";
import { OWNER_MARKER } from "./remote-scripts";

/**
 * `<installDir>/bin/paseo`: runs the CLI with the plugin's Node.js. The daemon's agents inherit
 * its environment, so the launcher first re-enters the user's login shell, with the PATH of an
 * interactive login shell when one prints it within 10 seconds, then puts Paseo's Node.js
 * directory first. Everything the daemon starts by name runs on it:
 * `paseo` and `npm` are `#!/usr/bin/env node` scripts, so behind an older system `node` the CLI
 * that plugins call and the daemon's self-update would fail. Agents and terminals get that
 * Node.js first too, unless their shell's startup files reorder PATH.
 *
 * PASEO_REMOTE_DEPLOY_LOGIN=1 skips the login shell, for the plugin's own scripted calls.
 */
export function renderLauncher(installDir: string): string {
  const dir = shellQuote(installDir);
  return [
    "#!/bin/sh",
    `# ${OWNER_MARKER}. Redeploying replaces it.`,
    `install_dir=${dir}`,
    'if [ -z "$PASEO_REMOTE_DEPLOY_LOGIN" ]; then',
    "  PASEO_REMOTE_DEPLOY_LOGIN=1; export PASEO_REMOTE_DEPLOY_LOGIN",
    // The account's shell, not $SHELL: cron sets SHELL=/bin/sh.
    '  shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    '  [ -n "$shell" ] || shell=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n "s/^UserShell: //p")',
    '  [ -n "$shell" ] || shell=$SHELL',
    '  case "$(basename "$shell" 2>/dev/null)" in',
    // Shells that take `-l -c script arg0 args`; fish and csh read positional arguments differently.
    "    bash|zsh|ksh|mksh|dash|sh)",
    // A terminal's caller already has its interactive PATH, and a backgrounded interactive shell
    // there could stop on the terminal, so only a caller without one asks for it.
    "      if [ ! -t 0 ] && probe=$(mktemp 2>/dev/null); then",
    // Installers such as Claude Code's often add to PATH only in ~/.zshrc or ~/.bashrc, which a
    // non-interactive login shell skips. The output goes to a file, not a pipe, so a process the
    // startup files leave running cannot hold the launcher, and a shell that hangs is killed.
    '        "$shell" -i -l -c \'printf "\\n__PASEO_PATH__=%s\\n" "$PATH"\' </dev/null >"$probe" 2>/dev/null &',
    "        pid=$!",
    '        ( sleep 10; kill -9 "$pid" ) </dev/null >/dev/null 2>&1 &',
    "        killer=$!",
    '        wait "$pid" 2>/dev/null',
    '        kill "$killer" 2>/dev/null',
    "        PASEO_REMOTE_DEPLOY_PATH=$(sed -n 's/^__PASEO_PATH__=//p' \"$probe\" | tail -n 1)",
    '        rm -f "$probe"',
    "        export PASEO_REMOTE_DEPLOY_PATH",
    "      fi",
    '      exec "$shell" -l -c \'exec "$0" "$@"\' "$0" "$@" ;;',
    "  esac",
    "fi",
    'if [ -n "$PASEO_REMOTE_DEPLOY_PATH" ]; then PATH=$PASEO_REMOTE_DEPLOY_PATH; fi',
    "unset PASEO_REMOTE_DEPLOY_LOGIN PASEO_REMOTE_DEPLOY_PATH",
    'if [ -n "$PATH" ]; then PATH="$install_dir/current/bin:$PATH"; else PATH="$install_dir/current/bin"; fi',
    "export PATH",
    'exec "$install_dir/current/bin/node" "$install_dir/current/lib/node_modules/@getpaseo/cli/bin/paseo" "$@"',
  ].join("\n");
}

/** 64 random bits naming one deployment: its unit, its crontab lines. Kept in remote-deploy.json. */
export function newDeploymentId(): string {
  return randomBytes(8).toString("hex");
}

export const DEPLOYMENT_ID = /^[0-9a-f]{16}$/u;

export function deploymentUnit(id: string): string {
  return `paseo-remote-deploy-${id}.service`;
}

/** A machine ID as /etc/machine-id holds it, which is what ConditionHost= compares. */
export const MACHINE_ID = /^[0-9a-f]{32}$/u;

/** Quotes one ExecStart argument: systemd expands `$` and `%`, and splits on whitespace. */
export function systemdArgument(value: string): string {
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, "$$$$")
    .replace(/%/gu, "%%");
  return /[\s"'\\;]/u.test(value) ? `"${escaped}"` : escaped;
}

/**
 * `daemon run` keeps the daemon in the foreground, so systemd supervises it directly; the
 * daemon's own supervisor still restarts its worker after a self-update. A user unit cannot
 * order itself after the system's network-online.target, so it has no network dependency.
 */
export function renderUnit(input: {
  installDir: string;
  paseoHome: string;
  /**
   * The machine the daemon belongs to, when its ID persists across boots. A home directory shared
   * between machines shares this unit, and the condition keeps the others from starting it.
   */
  machineId: string | null;
}): string {
  const launcher = `${input.installDir}/bin/paseo`;
  return [
    `# ${OWNER_MARKER}. Redeploying replaces it.`,
    "[Unit]",
    `Description=Paseo daemon (${input.paseoHome.replace(/%/gu, "%%")})`,
    ...(input.machineId ? [`ConditionHost=${input.machineId}`] : []),
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[launcher, "daemon", "run", "--home", input.paseoHome].map(systemdArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n");
}

/** What a managed Paseo home records in remote-deploy.json; CONFIGURE adds the port. */
export interface DeploymentRecord {
  /** Absent in records from before deployment IDs, which named units after the home's path. */
  id: string;
  installDir: string;
  unit: string | null;
  connectVia: "ssh" | "relay";
  deployedAt: string;
  /** The machine that deployed this home, to notice a home shared with another machine. */
  machineId: string | null;
  hostname: string;
}

/** What a unit this plugin wrote says about the deployment it runs. */
export interface UnitFacts {
  name: string;
  /** The --home argument of its ExecStart, or null when it cannot be read. */
  home: string | null;
  /** Its ConditionHost= value: the machine ID it is pinned to, or null for none. */
  machineId: string | null;
}

/** Reads a unit file renderUnit wrote, now or in an earlier version of the plugin. */
export function readUnit(name: string, content: string): UnitFacts {
  let home: string | null = null;
  let machineId: string | null = null;
  for (const line of content.split("\n")) {
    const condition = /^ConditionHost=(.*)$/u.exec(line.trim());
    if (condition) machineId = condition[1]!.trim() || null;
    const exec = /^ExecStart=(.*)$/u.exec(line.trim());
    if (exec) {
      const args = splitExecStart(exec[1]!);
      const flag = args.indexOf("--home");
      if (flag >= 0 && flag + 1 < args.length) home = args[flag + 1]!;
    }
  }
  return { name, home, machineId };
}

/** The inverse of systemdArgument: splits on whitespace, honouring quotes, `\` and `$$`/`%%`. */
export function splitExecStart(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted && char === "\\" && i + 1 < value.length) {
      current += value[++i];
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/u.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args.map((arg) => arg.replace(/\$\$/gu, "$").replace(/%%/gu, "%"));
}
