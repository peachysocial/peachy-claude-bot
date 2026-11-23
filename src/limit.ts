// How often one chat may ask. Every question costs you API tokens, and a
// group that loops the bot (or one person pasting fast) shouldn't run up the
// bill or starve everyone else.
//
// Questions are limited per chat: per group, and per person in the bot's own
// DM with them.
import type { Message } from "@peachysocial/bot";

export interface RateLimit {
  /** Questions allowed per window. */
  readonly questions: number;
  /** The window, in milliseconds. */
  readonly windowMs: number;
}

/** 10 questions per chat per 10 minutes unless CLAUDE_RATE_LIMIT says otherwise. */
export const DEFAULT_RATE_LIMIT: RateLimit = { questions: 10, windowMs: 10 * 60_000 };

/** Parse CLAUDE_RATE_LIMIT, "<questions>/<minutes>" (e.g. "10/10"). "off" turns it off. */
export function parseRateLimit(value: string | undefined): RateLimit | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return DEFAULT_RATE_LIMIT;
  if (v === "off") return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) {
    throw new Error('CLAUDE_RATE_LIMIT must be "<questions>/<minutes>", like "10/10", or "off"');
  }
  return { questions: Number(m[1]), windowMs: Number(m[2]) * 60_000 };
}

/** The key a message is limited under: its group, or the bot's DM with its sender. */
export function limitKey(m: Pick<Message, "chat" | "from">): string {
  return m.chat ? `chat:${m.chat.id}` : `dm:${m.from.actorId}`;
}

/**
 * A sliding window per key, in memory. A restart forgets it, which only ever
 * lets a few more questions through; nothing here needs the store.
 */
export class ChatRateLimiter {
  readonly #limit: RateLimit;
  readonly #now: () => number;
  readonly #seen = new Map<string, number[]>();

  constructor(limit: RateLimit, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Count a question under `key`. False when the key is over its limit (and the question isn't counted). */
  take(key: string): boolean {
    const now = this.#now();
    const since = now - this.#limit.windowMs;
    const times = (this.#seen.get(key) ?? []).filter((t) => t > since);
    if (times.length >= this.#limit.questions) {
      this.#seen.set(key, times);
      return false;
    }
    times.push(now);
    this.#seen.set(key, times);
    // Keep the map from growing without bound: drop keys gone quiet.
    if (this.#seen.size > 10_000) {
      for (const [k, ts] of this.#seen) if (ts.every((t) => t <= since)) this.#seen.delete(k);
    }
    return true;
  }
}
