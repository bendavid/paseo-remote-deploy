Remote Deploy installs a Paseo daemon in your account on another machine over SSH and saves that machine as a connected host of the daemon running the plugin. You don't need root, and the machine doesn't need Node.js.

## What it does

Open **Remote Deploy** in the sidebar, enter an SSH destination (`user@host`, or a `Host` alias from `~/.ssh/config`) and press Deploy. The plugin runs `ssh` on the daemon's machine, so that machine's SSH config, keys and agent apply. Passwords, key passphrases and new host keys are asked in the app.

On the remote machine it:

- downloads the newest Node.js 24 for that platform from nodejs.org and checks its published SHA-256, using the glibc 2.17 build on older x64 Linux systems;
- installs `@getpaseo/cli` into that Node.js directory using npm, so the daemon's own self-update keeps working;
- generates a random daemon password on the remote machine with Paseo's own code, which stores only its hash, and picks a loopback port, 6767 when free. The password comes back over SSH and is never placed in a command line, environment variable or file on the remote;
- starts the daemon so it keeps running after you log out and starts again after a reboot (see below).

Then it saves the host, with its password, on the daemon running the plugin. Connected apps list it as a host of that daemon.

Before anything is downloaded, the plugin lists what it will fetch and from where (Node.js from nodejs.org, Paseo and its dependencies from the npm registry configured for your account on that machine) and asks. Declining leaves the machine as it was. To pick the Node.js release, the daemon running the plugin reads the release lists on nodejs.org, or unofficial-builds.nodejs.org for old glibc systems; the remote machine downloads the archive itself.

## SSH or relay

The host is saved as an SSH connection by default. Paseo keeps that link open with `ssh -o BatchMode=yes`, which cannot ask for a password, so it needs SSH key login. The plugin checks this before installing anything. If key login fails, you can cancel, or install and add the host through Paseo's end-to-end encrypted relay instead. Choosing relay up front skips the check: the remote daemon connects out to the relay and no SSH is needed after setup.

In relay mode you can enter a relay you run yourself, such as [paseo-relay](https://github.com/getpaseo/paseo-relay), as `host:port` with or without TLS, plus an optional different address for clients. Before installing anything, the plugin checks that the remote machine and this daemon can both reach it, and asks if either cannot. Leaving the field empty uses Paseo's relay, and redeploying with it empty switches back. Traffic is end-to-end encrypted either way, so the relay only sees encrypted data.

## Keeping the daemon running

Before installing anything, the plugin checks how the machine treats your processes: whether it runs systemd, whether linger is on or polkit allows you to turn it on (asked with `pkcheck`, without changing anything), whether logind kills your processes at logout (`KillUserProcesses`), and whether you can use cron. Automatic mode then picks the first of these that works:

1. A systemd user service, with `loginctl enable-linger` so it starts at boot and outlives your sessions.
2. A background process, with a `@reboot` line in your crontab to start it after a reboot. Machines without systemd use this too.
3. When logind kills your processes at logout, a crontab line that starts the daemon every minute it is not running, so it never belongs to a login session.
4. Otherwise a systemd user service without linger, which only runs while you are logged in.

If the result would stop at logout or not come back after a reboot, the plugin says why and asks before installing. It only adds or removes crontab lines it marked as its own, and redeploying replaces them.

## Settings

- **Paseo home**: daemon state and config, `~/.paseo` by default. `~` is the remote home directory.
- **Install directory**: Node.js and Paseo, `~/.local/share/paseo` by default. Its `bin/paseo` runs the CLI.
- **Worktree root**: where the daemon creates agents' git worktrees, saved to `worktrees.root` as entered. Paseo reads `~` as the remote home and a relative path as inside the Paseo home. Empty uses Paseo's default, `worktrees` in the Paseo home, so a redeploy with it empty removes an earlier setting. A redeploy asks before changing or removing an earlier setting, even to another spelling of the same directory. Paseo only deletes worktrees under its current root when their workspaces are archived, so a root in another directory leaves existing worktrees in place, and the question says how many.
- **Run the daemon as**: automatic, systemd user service, or background process. An explicit choice is honoured, with its consequences shown before installing.
- **Daemon port** and **Paseo version**: leave empty for the defaults.

Redeploying the same machine and home brings Node.js to the newest 24 release and Paseo to the latest release, or to the version you enter, reinstalling Paseo whenever Node.js changes. It says what changes, asks before restarting a running daemon, gives it a new password and updates the saved host. A lower Paseo version than the installed one is only installed after a warning, because Paseo's data has no migrations. The previous Node.js folder is removed once the daemon runs on the new one.

## Requirements and limits

The plugin needs Paseo 0.13.0 or later on a Linux or macOS daemon with OpenSSH. The remote machine needs Linux with glibc, or macOS 13.5 or later, on x64 or arm64, plus internet access, `curl` or `wget`, and `tar`. Alpine and other musl systems are not supported. The plugin refuses a Paseo home used by a daemon it didn't install, or by a daemon on another machine through a shared home directory. A user service needs linger to outlive your last session, which only an administrator can enable on machines without polkit.
