// The Claude bot's commands and who may reach it.
import Anthropic from "@anthropic-ai/sdk";
import type { Bot } from "@peachysocial/bot";
import { ask, help, meantForMe, type Deps } from "./answers.ts";
import { Claude, type Reply } from "./claude.ts";
import { ChatRateLimiter, DEFAULT_RATE_LIMIT, type RateLimit } from "./limit.ts";

/** What `dev` answers with while ANTHROPIC_API_KEY isn't set. */
export const DEV_STAND_IN = "(Claude would answer here. Set ANTHROPIC_API_KEY in .env to ask it for real.)";

/**
 * The bot for `npx @peachysocial/bot dev` and `npx @peachysocial/bot-conformance`, which call
 * this with the bot alone. With ANTHROPIC_API_KEY set (in .env) it asks
 * Claude for real; without, a stand-in answers, so it runs with no key.
 */
export function dev(bot: Bot): Bot {
  const claude: Pick<Claude, "reply"> = process.env.ANTHROPIC_API_KEY
    ? new Claude({ client: new Anthropic({ timeout: 60_000, maxRetries: 1 }) })
    : { reply: async (): Promise<Reply> => ({ kind: "answer", text: DEV_STAND_IN }) };
  return register(bot, claude, { rateLimit: null });
}

export interface Settings {
  /**
   * People allowed to reach the bot: account ids, or handles (with or
   * without the @). Prefer ids: a handle is looked up again after each start,
   * so one that changed hands would let its new holder in. `onResolved` tells
   * you each handle's id. Empty leaves it to the listing's "Who can use
   * it". Every question costs you API tokens.
   */
  readonly allow?: readonly string[];
  /** Told the account id a handle in `allow` named, so you can list the id instead. */
  readonly onResolved?: (handle: string, actorId: string) => void;
  /**
   * Questions per chat (a group, or the bot's DM with one person) per
   * window. Default 10 per 10 minutes (CLAUDE_RATE_LIMIT); null turns it off.
   */
  readonly rateLimit?: RateLimit | null;
}

export function register(bot: Bot, claude: Pick<Claude, "reply">, settings: Settings = {}): Bot {
  // The listing's reach comes first; this only narrows it, for the bot's DM
  // and for who may add it to a group, before a word reaches these handlers
  // or Anthropic.
  const allow = (settings.allow ?? []).map((h) => h.trim()).filter(Boolean);
  if (allow.length > 0) allowOnly(bot, allow, settings.onResolved);
  const limit = settings.rateLimit === undefined ? DEFAULT_RATE_LIMIT : settings.rateLimit;
  const deps: Deps = { claude, limiter: limit ? new ChatRateLimiter(limit) : null };

  bot.command("ask", { description: "Ask Claude anything", blanks: "<question>", worksInDm: true }, (m) => ask(m, deps));
  bot.command("help", { description: "What this bot does", worksInDm: true }, help);

  // Anything else in the bot's DM, or a group message that mentions it, is a
  // question. A group's other messages reach the bot too: it leaves them be.
  bot.on("message", async (m) => {
    if (meantForMe(m)) await ask(m, deps, (await bot.me()).handle);
  });
  return bot;
}

/** An account id, as Peachy shows it (`npx @peachysocial/bot dev` and the logs print them). */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow who may reach the bot to `entries`: account ids, or handles. An id
 * is fixed. A handle is looked up when the bot first needs it after a start,
 * and `onResolved` is told the account it named, so you can put that id in
 * the list instead: a handle can be given up and taken by someone else, and
 * the next start would look it up again. A lookup that fails is tried again
 * for the next person, not remembered.
 */
export function allowOnly(bot: Bot, entries: readonly string[], onResolved?: (handle: string, actorId: string) => void): void {
  const ids = new Set(entries.filter((e) => ACCOUNT_ID.test(e)).map((e) => e.toLowerCase()));
  const handles = entries.filter((e) => !ACCOUNT_ID.test(e));
  let resolved: Promise<Set<string>> | null = null;
  const resolve = async () => {
    const found = new Set<string>();
    for (const h of handles) {
      const p = await bot.findPerson(h);
      if (p) {
        found.add(p.actorId.toLowerCase());
        onResolved?.(h, p.actorId);
      }
    }
    return found;
  };
  bot.reach({
    also: async (person) => {
      const id = person.actorId.toLowerCase();
      if (ids.has(id)) return true;
      if (handles.length === 0) return false;
      resolved ??= resolve().catch((err: unknown) => {
        resolved = null;
        throw err;
      });
      return (await resolved).has(id);
    },
  });
}
