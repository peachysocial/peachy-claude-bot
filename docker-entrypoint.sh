#!/bin/sh
# Hosts mount a new volume owned by root. Give the state directory to the
# `node` user with mode 0700, then run the bot as that user. Started as any
# other user (docker run --user node), it runs the bot as is.
set -eu

state_dir=$(dirname "${PEACHY_BOT_DB:-/data/bot.db}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$state_dir"
  # Recursive: a store first written by root (fly ssh console without -u node) must stay the bot's.
  chown -R node:node "$state_dir"
  chmod 0700 "$state_dir"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
