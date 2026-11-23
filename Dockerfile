# syntax=docker/dockerfile:1
# The bot's image: Node 22 (22.13 or newer, for its built-in SQLite), the code,
# and nothing secret. The store key and Connect code come from the host's
# secrets at run time; the bot's state lives on a volume at /data (or in
# Postgres when DATABASE_URL is set).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

COPY . .

# The state directory belongs to the unprivileged `node` user and no one else.
ENV PEACHY_BOT_DB=/data/bot.db
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]

# The entrypoint makes sure a freshly mounted volume is the node user's, with
# mode 0700, then drops to that user before the bot starts. The bot never runs
# as root.
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "main.ts"]
