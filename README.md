# Remote Deploy for Paseo

A [Paseo](https://paseo.sh) plugin that installs a Paseo daemon in your account on another machine
over SSH, without root, and saves that machine as a connected host of the daemon running the
plugin. Apps connected to that daemon then list the machine as a host.

- runs `ssh` on the daemon's machine, so its `~/.ssh/config`, keys and agent apply; passwords, key
  passphrases and unknown host keys are asked in the app;
- downloads the newest Node.js 24 for the remote platform from nodejs.org and checks its published
  SHA-256 (the glibc 2.17 build from unofficial-builds.nodejs.org on older x64 Linux), then
  installs `@getpaseo/cli` into that Node.js directory with its own npm, so the daemon's
  self-update keeps working;
- asks before downloading anything, and lists what it fetches and from where;
- generates the daemon password on the remote machine with Paseo's own code, which stores only its
  hash; the password comes back over SSH and is saved with the host;
- keeps the daemon running after logout and reboot: a systemd user service with linger, a
  background process with a `@reboot` crontab line, or a crontab keep-alive, depending on what the
  machine allows, and asks before installing when none of them would;
- adds the host over SSH (needs key login) or through Paseo's end-to-end encrypted relay, or a
  relay you run; SSH deploys can turn the relay on as well. With the relay on, a button shows a
  QR code and link that pair another device with the password included;
- on a redeploy, moves Paseo to the latest release (or the version you enter) and Node.js to the
  newest 24 release, and warns before any downgrade.

## Install

From a checkout (the plugin has no runtime dependencies):

```sh
paseo plugin install "$PWD"
```

From Git:

```sh
paseo plugin add git:bendavid/paseo-remote-deploy
```

Open **Remote Deploy** in the sidebar footer or from the Command Center.

## What it changes on the remote machine

| Path or setting                                                          | Purpose                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `~/.local/share/paseo/node-v24.*`                                        | Node.js, which is also the npm prefix Paseo is installed into and self-updates in                      |
| `~/.local/share/paseo/current`, `bin/paseo`                              | The Node.js in use, and a launcher that runs the CLI with it through your login shell                  |
| `~/.paseo/config.json`, `remote-deploy.json`                             | Listen address, password hash, relay and worktree root settings; the plugin's record of the deployment |
| `~/.config/systemd/user/paseo-daemon*.service`, `loginctl enable-linger` | The user service, when systemd is used                                                                 |
| Crontab lines tagged `#[paseo-remote-deploy:…]`                          | `@reboot` start or keep-alive, when cron is used; other lines are never touched                        |

Both directories, and the worktree root, can be changed in the form. The plugin refuses a Paseo home used by a daemon it
did not install, and asks before taking over one that another setup configured.

## Develop

```sh
npm install
npm run typecheck
npm test               # unit tests
npm run test:e2e       # end-to-end tests: podman containers as remote machines (needs rootless podman)
npm run format
paseo plugin install "$PWD"
paseo plugin reload remote-deploy   # after changes
```

The end-to-end tests build two images from `test/e2e/`: a Debian machine with systemd, sshd, cron
and a password-only account, and an origin daemon running Paseo from npm with this plugin
installed. They deploy for real (downloads from nodejs.org and npm, the Paseo relay), log out,
reboot containers, and check the saved connections with the `paseo` CLI on the machine running the
tests.

## License

MIT. See [LICENSE](LICENSE).
