// Starts the Claude bot: reads its settings from the environment, opens its
// encrypted store, links it to Peachy on the first run, and listens.
import Anthropic from "@anthropic-ai/sdk";
import { Bot, PeachyBotError } from "@peachysocial/bot";
import { register } from "./src/bot.ts";
import { Claude, EFFORTS, type Effort } from "./src/claude.ts";
import { parseRateLimit, type RateLimit } from "./src/limit.ts";

const env = process.env;

if (!env.PEACHY_BOT_STORE_KEY && !env.PEACHY_BOT_STORE_KEY_FILE) {
  console.error("No store key. Make one with: npx @peachysocial/bot keygen --out .peachy-store-key, then set PEACHY_BOT_STORE_KEY_FILE=.peachy-store-key. See .env.example.");
  process.exit(1);
}
if (!env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. See .env.example.");
  process.exit(1);
}
const effort = (env.CLAUDE_EFFORT || "low") as Effort;
if (!EFFORTS.includes(effort)) {
  console.error(`CLAUDE_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  process.exit(1);
}

let rateLimit: RateLimit | null;
try {
  rateLimit = parseRateLimit(env.CLAUDE_RATE_LIMIT);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const claude = new Claude({
  // Reads ANTHROPIC_API_KEY. A chat answer should come back within a minute,
  // or the asker's phone says the bot didn't answer.
  client: new Anthropic({ timeout: 60_000, maxRetries: 1 }),
  model: env.CLAUDE_MODEL || undefined,
  effort,
  // Counts and cache hits only; never the words.
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});

const bot = new Bot({
  store: env.DATABASE_URL ? Bot.postgres(env.DATABASE_URL) : Bot.sqlite(env.PEACHY_BOT_DB || "./data/bot.db"),
  storeKey: env.PEACHY_BOT_STORE_KEY_FILE ? Bot.keyFile(env.PEACHY_BOT_STORE_KEY_FILE) : env.PEACHY_BOT_STORE_KEY!,
  // Link with `npx @peachysocial/bot connect`. Where you can't type, set
  // PEACHY_CONNECT_CODE once instead; it is used only while the store holds
  // no bot. Remove it after.
  connectCode: env.PEACHY_CONNECT_CODE || undefined,
  // Never write anyone's words to the logs.
  logContent: false,
});

register(bot, claude, {
  allow: (env.PEACHY_BOT_ALLOW ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  // An id, never words: what to put in PEACHY_BOT_ALLOW to pin this person.
  onResolved: (handle, actorId) => console.log(JSON.stringify({ event: "allow.resolved", handle, actorId })),
  rateLimit,
});

bot.on("status", (s) => {
  if (s.kind === "connected" && s.firstTime) console.log(`Linked ✓ as @${s.profile.handle}`);
});

// A bot that stopped on its own (another copy took over, its keys were reset)
// receives nothing more: exit non-zero, so the host restarts it or tells you.
bot.on("error", (err, { fatal }) => {
  console.error(err instanceof PeachyBotError ? err.message : err);
  if (fatal) process.exit(1);
});

try {
  const me = await bot.start();
  console.log(`@${me.handle} is running with ${claude.model} at effort ${claude.effort}.`);
} catch (err) {
  console.error(err instanceof PeachyBotError ? err.message : err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bot.stop().finally(() => process.exit(0));
  });
}
