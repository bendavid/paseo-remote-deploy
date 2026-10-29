import { createHash } from "node:crypto";
import { shellQuote } from "./ssh";
import { OWNER_MARKER } from "./remote-scripts";

/**
 * `<installDir>/bin/paseo`: runs the CLI with the plugin's Node.js. The daemon's agents inherit
 * its environment, so the launcher first re-enters the user's login shell to pick up their PATH,
 * then appends Paseo's Node.js directory. That keeps the user's own `node` first for agents while
 * the daemon's self-update can still find `npm` when the machine has none.
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
    '    bash|zsh|ksh|mksh|dash|sh) exec "$shell" -l -c \'exec "$0" "$@"\' "$0" "$@" ;;',
    "  esac",
    "fi",
    "unset PASEO_REMOTE_DEPLOY_LOGIN",
    'if [ -n "$PATH" ]; then PATH="$PATH:$install_dir/current/bin"; else PATH="$install_dir/current/bin"; fi',
    "export PATH",
    'exec "$install_dir/current/bin/node" "$install_dir/current/lib/node_modules/@getpaseo/cli/bin/paseo" "$@"',
  ].join("\n");
}

/** `paseo-daemon.service` for the default home, else one unit per home. */
export function unitName(paseoHome: string, homeDirectory: string): string {
  if (paseoHome === `${homeDirectory}/.paseo`) return "paseo-daemon.service";
  const hash = createHash("sha256").update(paseoHome).digest("hex").slice(0, 8);
  return `paseo-daemon-${hash}.service`;
}

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
export function renderUnit(input: { installDir: string; paseoHome: string }): string {
  const launcher = `${input.installDir}/bin/paseo`;
  return [
    `# ${OWNER_MARKER}. Redeploying replaces it.`,
    "[Unit]",
    `Description=Paseo daemon (${input.paseoHome.replace(/%/gu, "%%")})`,
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
  installDir: string;
  unit: string | null;
  connectVia: "ssh" | "relay";
  deployedAt: string;
}
