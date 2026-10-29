#!/bin/sh
set -e
home=/home/node/.paseo
paseo daemon config set daemon.listen 0.0.0.0:6767 --home "$home" >/dev/null
paseo daemon config set daemon.relay.enabled false --home "$home" >/dev/null
paseo daemon config set features.webUi.enabled true --home "$home" >/dev/null
paseo daemon config set pluginsEnabled true --home "$home" >/dev/null
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
exec paseo daemon run --home "$home"
