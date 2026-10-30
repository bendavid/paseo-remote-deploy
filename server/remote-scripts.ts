// POSIX sh for the remote machine. Each script runs through `sh -c` with its inputs in environment
// variables, prints results as `@@key=value` lines and fails with `fail "<sentence>"`. Values are
// always single-line. Paths reach these scripts already resolved to absolute paths by INSPECT.

const PRELUDE = String.raw`
say() { printf '@@%s=%s\n' "$1" "$2"; }
fail() { printf '@@error=%s\n' "$1"; exit 1; }
user_bus() {
  if [ -z "$XDG_RUNTIME_DIR" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR
  fi
}
`;

/** The plugin's marker, written into files it owns so it never touches files it didn't write. */
export const OWNER_MARKER = "Written by the Paseo remote-deploy plugin";

// The user's crontab is shared with everything else they schedule: only lines carrying this
// deployment's CRON_TAG are ever added or removed. PASEO_REMOTE_DEPLOY_CRONTAB lets tests
// substitute the crontab command.
const CRONTAB_FUNCTIONS = String.raw`
crontab_cmd=$PASEO_REMOTE_DEPLOY_CRONTAB; [ -n "$crontab_cmd" ] || crontab_cmd=crontab
set_cron_lines() {
  if ! command -v "$crontab_cmd" >/dev/null 2>&1; then
    [ -z "$1" ] && return 0
    fail "crontab is not installed on the remote machine."
  fi
  current=$("$crontab_cmd" -l 2>&1); code=$?
  if [ "$code" -ne 0 ]; then
    if printf '%s' "$current" | grep -qi 'no crontab'; then
      current=""
    elif [ -z "$1" ]; then
      return 0
    else
      fail "crontab -l failed: $(printf '%s' "$current" | head -n 1)"
    fi
  fi
  kept=$(printf '%s
' "$current" | grep -vF "$CRON_TAG")
  if [ -z "$1" ]; then
    [ "$kept" = "$current" ] && return 0
    if [ -z "$kept" ]; then "$crontab_cmd" -r || fail "crontab -r failed."; return 0; fi
  fi
  {
    if [ -n "$kept" ]; then printf '%s
' "$kept"; fi
    if [ -n "$1" ]; then printf '%s
' "$1"; fi
  } | "$crontab_cmd" - || fail "crontab could not be updated."
}
`;

/** The JSON a managed Paseo home keeps about its deployment. */
export const DEPLOYMENT_FILE = "remote-deploy.json";

/**
 * Inputs: REQ_INSTALL_DIR, REQ_PASEO_HOME (empty for defaults). Reports the platform, resolved
 * paths, available tools, systemd, an existing install, and any daemon already using the home.
 */
export const INSPECT = String.raw`${PRELUDE}
expand() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "$(printf '%s' "$1" | cut -c3-)" ;;
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$HOME" "$1" ;;
  esac
}
[ -n "$HOME" ] || fail "The remote account has no HOME directory."
os=$(uname -s); arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "Unsupported operating system: $os" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "Unsupported CPU architecture: $arch" ;;
esac
libc=""; glibc=""
if [ "$os" = linux ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then
    libc=musl
  else
    libc=glibc
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  fi
fi
say os "$os"; say arch "$arch"; say libc "$libc"; say glibc "$glibc"
[ "$os" = darwin ] && say macosVersion "$(sw_vers -productVersion 2>/dev/null)"
say home "$HOME"; say user "$(id -un)"; say hostname "$(hostname 2>/dev/null || uname -n)"
for tool in tar gzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed on the remote machine."
done
if command -v curl >/dev/null 2>&1; then say downloader curl
elif command -v wget >/dev/null 2>&1; then say downloader wget
else fail "Neither curl nor wget is installed on the remote machine."
fi
data_home=$XDG_DATA_HOME; [ -n "$data_home" ] || data_home=$HOME/.local/share
req_install=$REQ_INSTALL_DIR; [ -n "$req_install" ] || req_install=$data_home/paseo
req_home=$REQ_PASEO_HOME; [ -n "$req_home" ] || req_home=$HOME/.paseo
install_dir=$(expand "$req_install")
paseo_home=$(expand "$req_home")
say installDir "$install_dir"; say paseoHome "$paseo_home"
if [ "$os" = linux ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  say systemd yes
else
  say systemd no
fi
user=$(id -un)
if [ "$os" = linux ] && command -v loginctl >/dev/null 2>&1; then
  # loginctl show-session without a session prints logind's own settings.
  logind=$(loginctl show-session -p KillUserProcesses -p KillOnlyUsers -p KillExcludeUsers 2>/dev/null)
  if [ -n "$logind" ]; then
    say killUserProcesses "$(printf '%s\n' "$logind" | sed -n 's/^KillUserProcesses=//p')"
    say killOnlyUsers "$(printf '%s\n' "$logind" | sed -n 's/^KillOnlyUsers=//p')"
    say killExcludeUsers "$(printf '%s\n' "$logind" | sed -n 's/^KillExcludeUsers=//p')"
  fi
  linger=$(loginctl show-user "$user" -p Linger --value 2>/dev/null)
  if [ -z "$linger" ] && [ -e "/var/lib/systemd/linger/$user" ]; then linger=yes; fi
  say linger "$linger"
  # Ask polkit whether this login may enable linger, without enabling it. Without polkit,
  # logind lets only root enable linger.
  if command -v pkcheck >/dev/null 2>&1; then
    pkcheck --action-id org.freedesktop.login1.set-self-linger --process $$ >/dev/null 2>&1
    say lingerCheck "pkcheck $?"
  elif command -v busctl >/dev/null 2>&1; then
    if busctl list --no-pager --no-legend 2>/dev/null | grep -q '^org\.freedesktop\.PolicyKit1 '; then
      say lingerCheck "polkit without pkcheck"
    else
      say lingerCheck "no polkit"
    fi
  fi
fi
if command -v crontab >/dev/null 2>&1; then
  out=$(crontab -l 2>&1); code=$?
  if [ "$code" -eq 0 ] || printf '%s' "$out" | grep -qi 'no crontab'; then
    # macOS starts cron on demand, so only Linux needs a running cron daemon.
    if [ "$os" = darwin ] || ps -e -o comm= 2>/dev/null | grep -qxE 'cron|crond'; then
      say cron ok
    else
      say cron stopped
    fi
  else
    say cron denied
    say cronError "$(printf '%s' "$out" | head -n 1)"
  fi
else
  say cron missing
fi
if [ -x "$install_dir/current/bin/node" ]; then
  say currentNode "$(basename "$(readlink "$install_dir/current")")"
  say currentNodeVersion "$("$install_dir/current/bin/node" -v 2>/dev/null)"
  pkg="$install_dir/current/lib/node_modules/@getpaseo/cli/package.json"
  if [ -f "$pkg" ]; then
    say currentPaseoVersion "$("$install_dir/current/bin/node" -p 'require(process.argv[1]).version' "$pkg" 2>/dev/null)"
  fi
fi
[ -f "$install_dir/.remote-deploy" ] && say managedInstall yes
# These JSON files go back whole, for the plugin to parse: JSON strings cannot hold a raw
# line break, so dropping line breaks keeps the same JSON on one output line.
if [ -f "$paseo_home/config.json" ]; then
  say homeConfigured yes
  say config "$(tr -d '\r\n' < "$paseo_home/config.json")"
  say homeAgents "$(find "$paseo_home/agents" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ -f "$paseo_home/${DEPLOYMENT_FILE}" ]; then
  say managedHome yes
  say deployment "$(tr -d '\r\n' < "$paseo_home/${DEPLOYMENT_FILE}")"
fi
if [ -f "$paseo_home/paseo.pid" ]; then
  say lock "$(tr -d '\r\n' < "$paseo_home/paseo.pid")"
fi
`;

/**
 * Inputs: PID (from the lock INSPECT sent back, or empty), WORKTREES_ROOT (a resolved root whose
 * worktrees to count, or empty). The follow-up to INSPECT once the plugin has parsed its files.
 */
export const PROBE = String.raw`${PRELUDE}
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then say daemonRunning yes; fi
# <root>/<project hash>/<slug>/.git
if [ -n "$WORKTREES_ROOT" ]; then
  say worktreesInRoot "$(find "$WORKTREES_ROOT" -mindepth 3 -maxdepth 3 -name .git 2>/dev/null | wc -l | tr -d ' ')"
fi
`;

/**
 * Inputs: RELAY_URL. Checks the remote machine reaches a relay: any HTTP answer will do, since the
 * daemon only needs the connection, which a relay then upgrades to a WebSocket.
 */
export const CHECK_RELAY = String.raw`${PRELUDE}
if command -v curl >/dev/null 2>&1; then
  if out=$(curl -sS -m 10 -o /dev/null "$RELAY_URL" 2>&1); then
    say relayCheck ok
  else
    say relayCheck failed
    say relayError "$(printf '%s' "$out" | head -n 1)"
  fi
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 10 -O /dev/null "$RELAY_URL" >/dev/null 2>&1; code=$?
  # 8: the server answered with an HTTP error, so it was reached.
  if [ "$code" -eq 0 ] || [ "$code" -eq 8 ]; then
    say relayCheck ok
  else
    say relayCheck failed
    say relayError "wget exited with status $code"
  fi
else
  say relayCheck skipped
fi
`;

/** Inputs: INSTALL_DIR, NODE_URL, NODE_SHA256, NODE_DIR. Unpacks Node.js beside other versions. */
export const INSTALL_NODE = String.raw`${PRELUDE}
mkdir -p "$INSTALL_DIR" || fail "Could not create $INSTALL_DIR."
if [ -x "$INSTALL_DIR/$NODE_DIR/bin/node" ]; then
  say reused yes
  say nodeVersion "$("$INSTALL_DIR/$NODE_DIR/bin/node" -v)"
  exit 0
fi
tmp=$(mktemp -d "$INSTALL_DIR/.download.XXXXXX") || fail "Could not create a download directory in $INSTALL_DIR."
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
echo "Downloading $NODE_URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$tmp/node.tar.gz" "$NODE_URL" || fail "Downloading Node.js failed."
else
  wget -q -O "$tmp/node.tar.gz" "$NODE_URL" || fail "Downloading Node.js failed."
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/node.tar.gz" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/node.tar.gz" | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
  actual=$(openssl dgst -sha256 -r "$tmp/node.tar.gz" | awk '{print $1}')
else
  fail "No sha256sum, shasum or openssl to verify the Node.js download."
fi
[ "$actual" = "$NODE_SHA256" ] || fail "The Node.js download does not match its published SHA-256."
echo "Unpacking $NODE_DIR"
tar -xzf "$tmp/node.tar.gz" -C "$tmp" || fail "Unpacking Node.js failed."
"$tmp/$NODE_DIR/bin/node" -v >/dev/null 2>&1 || fail "The downloaded Node.js does not run on this machine."
rm -rf "$INSTALL_DIR/$NODE_DIR"
mv "$tmp/$NODE_DIR" "$INSTALL_DIR/$NODE_DIR" || fail "Could not move Node.js into $INSTALL_DIR."
say nodeVersion "$("$INSTALL_DIR/$NODE_DIR/bin/node" -v)"
`;

/**
 * Inputs: INSTALL_DIR, SPEC (an npm version, range or tag), CURRENT (the installed version).
 * Resolves SPEC to one exact @getpaseo/cli version with the installed npm, and compares it with
 * CURRENT using the semver library npm itself bundles.
 */
export const RESOLVE_PASEO = String.raw`${PRELUDE}
prefix="$INSTALL_DIR/current"
PATH="$prefix/bin:$PATH"; export PATH
out=$(npm view "@getpaseo/cli@$SPEC" version --json --no-update-notifier 2>/dev/null) \
  || fail "npm could not look up @getpaseo/cli@$SPEC."
printf '%s' "$out" | "$prefix/bin/node" -e '
const semver = require(process.argv[1]);
const [, , current, spec] = process.argv;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let parsed = [];
  try { parsed = input.trim() ? JSON.parse(input) : []; } catch {}
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => semver.valid(v));
  if (versions.length === 0) {
    console.log("@@error=No @getpaseo/cli version matches " + spec + ".");
    process.exit(1);
  }
  const target = versions.sort(semver.compare).at(-1);
  console.log("@@resolvedVersion=" + target);
  console.log("@@relation=" + (!semver.valid(current) ? "unknown"
    : semver.gt(target, current) ? "newer" : semver.lt(target, current) ? "older" : "same"));
});
' "$prefix/lib/node_modules/npm/node_modules/semver" "$CURRENT" "$SPEC"
`;

/**
 * Inputs: INSTALL_DIR, NODE_DIR, TARGET (an exact version, or a spec on a fresh install), LAUNCHER.
 * Installs @getpaseo/cli into the Node.js directory, which is its own npm prefix, so the daemon's
 * self-update (npm install -g --prefix <that directory>) keeps working. npm replaces an installed
 * version in place, up or down. Then points `current` at the directory.
 */
export const INSTALL_PASEO = String.raw`${PRELUDE}
prefix="$INSTALL_DIR/$NODE_DIR"
cli="$prefix/lib/node_modules/@getpaseo/cli"
PATH="$prefix/bin:$PATH"; export PATH
installed=""
[ -f "$cli/package.json" ] && installed=$(node -p 'require(process.argv[1]).version' "$cli/package.json")
if [ -n "$installed" ] && [ "$installed" = "$TARGET" ]; then
  say reused yes
else
  echo "Installing @getpaseo/cli@$TARGET"
  # --prefix overrides any prefix in the user's ~/.npmrc; the daemon's self-update passes it too.
  npm install -g "@getpaseo/cli@$TARGET" --prefix "$prefix" --no-fund --no-audit --no-update-notifier --loglevel=error \
    || fail "npm could not install @getpaseo/cli@$TARGET."
fi
[ -f "$cli/package.json" ] || fail "npm finished but @getpaseo/cli is missing from $prefix."
ln -sfn "$NODE_DIR" "$INSTALL_DIR/current" || fail "Could not update $INSTALL_DIR/current."
mkdir -p "$INSTALL_DIR/bin"
printf '%s\n' "$LAUNCHER" > "$INSTALL_DIR/bin/paseo.tmp" \
  && chmod 755 "$INSTALL_DIR/bin/paseo.tmp" \
  && mv "$INSTALL_DIR/bin/paseo.tmp" "$INSTALL_DIR/bin/paseo" \
  || fail "Could not write $INSTALL_DIR/bin/paseo."
printf '%s\n' "${OWNER_MARKER}" > "$INSTALL_DIR/.remote-deploy"
say paseoVersion "$(node -p 'require(process.argv[1]).version' "$cli/package.json")"
`;

/**
 * Inputs: INSTALL_DIR, KEEP. Once the daemon runs from KEEP, removes the other Node.js folders
 * this plugin unpacked there. Earlier ones stay until then, so a failed deploy can fall back.
 */
export const PRUNE_NODE = String.raw`${PRELUDE}
[ -f "$INSTALL_DIR/.remote-deploy" ] || exit 0
for dir in "$INSTALL_DIR"/node-v*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  [ "$name" = "$KEEP" ] && continue
  rm -rf "$dir" && echo "Removed the previous Node.js folder $name"
done
`;

/**
 * Inputs: INSTALL_DIR, PASEO_HOME, UNIT, CRON_TAG. Stops a daemon this plugin deployed in
 * PASEO_HOME however it runs. Its cron lines go first, so a keep-alive line cannot restart it
 * while the deploy reconfigures it; the deploy writes them again afterwards.
 */
export const STOP_DAEMON = String.raw`${PRELUDE}${CRONTAB_FUNCTIONS}
set_cron_lines ""
user_bus
if [ -n "$UNIT" ] && command -v systemctl >/dev/null 2>&1 \
  && systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
  systemctl --user stop "$UNIT" || fail "systemctl --user stop $UNIT failed."
  say stopped systemd
fi
if [ -x "$INSTALL_DIR/bin/paseo" ]; then
  PASEO_REMOTE_DEPLOY_LOGIN=1 "$INSTALL_DIR/bin/paseo" daemon stop --home "$PASEO_HOME" >/dev/null 2>&1 || true
fi
`;

/**
 * Inputs: INSTALL_DIR, PASEO_HOME, RELAY_ENABLED, RELAY_* (see below), REQ_PORT (empty to keep the
 * configured port or pick one), WORKTREES_ROOT_ACTION (set, unset or empty to leave it) and
 * WORKTREES_ROOT, DEPLOYMENT (the JSON for ${DEPLOYMENT_FILE}, without the port).
 * Reports the port and a newly generated daemon password.
 */
export const CONFIGURE = String.raw`${PRELUDE}
paseo() { PASEO_REMOTE_DEPLOY_LOGIN=1 "$INSTALL_DIR/bin/paseo" "$@"; }
node="$INSTALL_DIR/current/bin/node"
mkdir -p "$PASEO_HOME" && chmod 700 "$PASEO_HOME" || fail "Could not create $PASEO_HOME."
port="$REQ_PORT"
if [ -z "$port" ] && [ -f "$PASEO_HOME/${DEPLOYMENT_FILE}" ]; then
  port=$("$node" -e 'try { const p = require(process.argv[1]).port; if (p) console.log(p) } catch {}' "$PASEO_HOME/${DEPLOYMENT_FILE}")
fi
# Loopback is shared with every account on the machine: take 6767 only when it is free.
port=$("$node" -e '
const net = require("node:net");
const wanted = Number(process.argv[1]) || 0;
const pinned = process.argv[2] === "pinned";
const listen = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(null));
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port;
    server.close(() => resolve(actual));
  });
});
(async () => {
  if (wanted) {
    const free = await listen(wanted);
    if (free) return console.log(free);
    if (pinned) { console.error("port " + wanted + " is in use"); process.exit(1); }
  }
  console.log((await listen(6767)) || (await listen(0)));
})();
' "$port" "$([ -n "$REQ_PORT" ] && echo pinned)") || fail "Port $REQ_PORT is already in use on the remote machine."
paseo daemon config set daemon.listen "127.0.0.1:$port" --home "$PASEO_HOME" >/dev/null \
  || fail "Could not set daemon.listen."
paseo daemon config set daemon.relay.enabled "$RELAY_ENABLED" --home "$PASEO_HOME" >/dev/null \
  || fail "Could not set daemon.relay.enabled."
# A relay other than Paseo's, or none of these fields so a redeploy returns to Paseo's relay.
if [ -n "$RELAY_ENDPOINT" ]; then
  paseo daemon config set daemon.relay.endpoint "$RELAY_ENDPOINT" --string --home "$PASEO_HOME" >/dev/null \
    && paseo daemon config set daemon.relay.useTls "$RELAY_USE_TLS" --home "$PASEO_HOME" >/dev/null \
    || fail "Could not set the relay address."
  if [ -n "$RELAY_PUBLIC_ENDPOINT" ]; then
    paseo daemon config set daemon.relay.publicEndpoint "$RELAY_PUBLIC_ENDPOINT" --string --home "$PASEO_HOME" >/dev/null \
      && paseo daemon config set daemon.relay.publicUseTls "$RELAY_PUBLIC_USE_TLS" --home "$PASEO_HOME" >/dev/null \
      || fail "Could not set the public relay address."
  else
    paseo daemon config unset daemon.relay.publicEndpoint --home "$PASEO_HOME" >/dev/null
    paseo daemon config unset daemon.relay.publicUseTls --home "$PASEO_HOME" >/dev/null
  fi
else
  for field in endpoint useTls publicEndpoint publicUseTls; do
    paseo daemon config unset "daemon.relay.$field" --home "$PASEO_HOME" >/dev/null \
      || fail "Could not clear daemon.relay.$field."
  done
fi
# As entered: Paseo resolves ~ and relative paths itself, and creates the directory when needed.
case "$WORKTREES_ROOT_ACTION" in
  set)
    paseo daemon config set worktrees.root "$WORKTREES_ROOT" --string --home "$PASEO_HOME" >/dev/null \
      || fail "Could not set worktrees.root." ;;
  unset)
    paseo daemon config unset worktrees.root --home "$PASEO_HOME" >/dev/null \
      || fail "Could not remove worktrees.root." ;;
esac
# What paseo daemon set-password does, without its terminal prompt, using Paseo's own exports:
# a new random password, hashed by Paseo and saved to config.json (mode 0600). The password only
# exists in this process and its output, which goes back over SSH; never in argv, env or a file.
(cd "$INSTALL_DIR/current/lib/node_modules/@getpaseo/cli" && "$node" --input-type=module -e '
const { randomBytes } = await import("node:crypto");
const { hashDaemonPassword } = await import("@getpaseo/server/auth");
const { readPersistedConfig, savePersistedConfig } = await import("@getpaseo/server/configuration");
const home = process.argv[1];
const password = randomBytes(24).toString("base64url");
const config = readPersistedConfig(home);
savePersistedConfig(home, {
  ...config,
  daemon: { ...config.daemon, auth: { ...config.daemon?.auth, password: hashDaemonPassword(password) } },
});
process.stdout.write("@@password=" + password + "\n");
' "$PASEO_HOME") || fail "Could not set the daemon password."
printf '%s\n' "$DEPLOYMENT" | "$node" -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const deployment = { ...JSON.parse(input), port: Number(process.argv[1]) };
  require("node:fs").writeFileSync(process.argv[2], JSON.stringify(deployment) + "\n", { mode: 0o600 });
});
' "$port" "$PASEO_HOME/${DEPLOYMENT_FILE}" || fail "Could not write $PASEO_HOME/${DEPLOYMENT_FILE}."
say port "$port"
`;

/**
 * Inputs: ENABLE_LINGER (yes|no). Tries linger when asked, so the user manager starts at boot and
 * outlives the last session, then waits for the user manager, which can take a moment to start
 * after linger is enabled.
 */
export const PREPARE_SYSTEMD = String.raw`${PRELUDE}
uid=$(id -u); user=$(id -un)
linger=$(loginctl show-user "$user" --property=Linger --value 2>/dev/null)
if [ "$linger" = yes ]; then
  say linger already
elif [ "$ENABLE_LINGER" != yes ]; then
  say linger skipped
elif out=$(loginctl enable-linger --no-ask-password "$user" 2>&1); then
  say linger enabled
else
  say linger failed
  say lingerError "$(printf '%s' "$out" | head -n 1)"
fi
i=0
while :; do
  user_bus
  if systemctl --user show-environment >/dev/null 2>&1; then say userManager yes; exit 0; fi
  i=$((i + 1)); [ "$i" -ge 10 ] && break
  sleep 1
done
say userManager no
say systemdError "$(systemctl --user show-environment 2>&1 | head -n 1)"
`;

/** Inputs: UNIT, UNIT_CONTENT. Installs, enables and (re)starts the daemon's user unit. */
export const START_SYSTEMD = String.raw`${PRELUDE}
user_bus
config_home=$XDG_CONFIG_HOME; [ -n "$config_home" ] || config_home=$HOME/.config
unit_dir="$config_home/systemd/user"
unit_file="$unit_dir/$UNIT"
mkdir -p "$unit_dir" || fail "Could not create $unit_dir."
if [ -f "$unit_file" ] && ! grep -q "${OWNER_MARKER}" "$unit_file"; then
  fail "$unit_file already exists and was not written by this plugin."
fi
printf '%s\n' "$UNIT_CONTENT" > "$unit_file.tmp" && mv "$unit_file.tmp" "$unit_file" \
  || fail "Could not write $unit_file."
systemctl --user daemon-reload || fail "systemctl --user daemon-reload failed."
systemctl --user enable "$UNIT" >/dev/null 2>&1 || fail "systemctl --user enable $UNIT failed."
if ! systemctl --user restart "$UNIT"; then
  systemctl --user status "$UNIT" --no-pager 2>&1 | tail -n 15
  fail "systemctl --user restart $UNIT failed."
fi
`;

/**
 * Inputs: INSTALL_DIR, PASEO_HOME, UNIT, START_NOW (yes|no). Retires an earlier deploy's unit for
 * this home, which would start a second daemon at login or boot, then starts the daemon detached
 * with `paseo daemon start` unless cron is going to start it.
 */
export const START_DETACHED = String.raw`${PRELUDE}
config_home=$XDG_CONFIG_HOME; [ -n "$config_home" ] || config_home=$HOME/.config
old_unit="$config_home/systemd/user/$UNIT"
if [ -f "$old_unit" ] && grep -q "${OWNER_MARKER}" "$old_unit"; then
  if command -v systemctl >/dev/null 2>&1; then
    user_bus
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  fi
  rm -f "$old_unit"
  say removedUnit "$UNIT"
fi
if [ "$START_NOW" = yes ]; then
  # Without the login flag the launcher re-enters the login shell, so agents get the user's PATH.
  "$INSTALL_DIR/bin/paseo" daemon start --home "$PASEO_HOME" </dev/null >/dev/null 2>&1 \
    || fail "paseo daemon start failed. See $PASEO_HOME/daemon.log on the remote machine."
fi
`;

/** Inputs: CRON_TAG, CRON_LINES (empty to remove this deployment's lines). */
export const SET_CRONTAB = String.raw`${PRELUDE}${CRONTAB_FUNCTIONS}
set_cron_lines "$CRON_LINES"
`;

/**
 * Inputs: INSTALL_DIR, PASEO_HOME, RELAY ("true" to also print the relay pairing URI).
 * Waits for the daemon to listen, which takes up to a minute longer when cron starts it, then
 * reports its identity.
 */
export const AWAIT_DAEMON = String.raw`${PRELUDE}
paseo() { PASEO_REMOTE_DEPLOY_LOGIN=1 "$INSTALL_DIR/bin/paseo" "$@"; }
node="$INSTALL_DIR/current/bin/node"
field() { "$node" -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const start = input.indexOf("{");
    const value = JSON.parse(input.slice(start))[process.argv[1]];
    if (value !== undefined && value !== null) console.log(String(value));
  } catch {}
});
' "$1"; }
i=0
while :; do
  status=$(paseo daemon status --home "$PASEO_HOME" --json 2>/dev/null)
  state=$(printf '%s' "$status" | field localDaemon)
  [ "$state" = running ] && break
  i=$((i + 1))
  [ "$i" -ge 90 ] && { tail -n 20 "$PASEO_HOME/daemon.log" 2>/dev/null; fail "The daemon did not start within 3 minutes."; }
  sleep 2
done
say listen "$(printf '%s' "$status" | field listen)"
say serverId "$(printf '%s' "$status" | field serverId)"
say daemonVersion "$(printf '%s' "$status" | field daemonVersion)"
pid=$(printf '%s' "$status" | field pid)
say pid "$pid"
# A daemon inside a login session's scope is stopped with that session when KillUserProcesses applies.
if [ -n "$pid" ] && [ -r "/proc/$pid/cgroup" ]; then say cgroup "$(tr '\n' ' ' < "/proc/$pid/cgroup")"; fi
if [ "$RELAY" = true ]; then
  pair=$(paseo daemon pair --json --home "$PASEO_HOME" 2>&1) || fail "paseo daemon pair failed: $(printf '%s' "$pair" | tail -n 1)"
  uri=$(printf '%s' "$pair" | field connectionUri)
  [ -n "$uri" ] || fail "The daemon has no relay pairing offer."
  say connectionUri "$uri"
  # Its pairing link, for the app address it points phones at.
  say pairingUrl "$(printf '%s' "$pair" | field url)"
fi
`;
