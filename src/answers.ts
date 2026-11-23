// What the bot does with each message meant for it. Plain functions over a
// Message and a Claude, so tests drive them with fakes of both.
import type { Claude, Reply } from "./claude.ts";
import type { Question } from "./prompt.ts";
import { limitKey, type ChatRateLimiter } from "./limit.ts";
import type { Message } from "@peachysocial/bot";

/** What a handler needs: Claude, and the per-chat limit (none when CLAUDE_RATE_LIMIT is off). */
export interface Deps {
  readonly claude: Pick<Claude, "reply">;
  readonly limiter?: ChatRateLimiter | null;
}

/** What people see when something goes wrong. Never an error's own text. */
export const SAY = {
  refused: "I can't help with that.",
  busy: "Claude is busy right now. Try again in a minute.",
  unavailable: "Claude is unavailable right now. Try again later.",
  slowDown: "I've had a lot of questions from here in the last few minutes. Try again in a little while.",
  emptyAsk: "Ask me something after /ask, like: /ask what's a good hike near Tahoe?",
} as const;

export const HELP = [
  "I'm Claude, an AI model made by Anthropic. In a group I receive the messages of members who said OK to me, and I answer only the ones that mention me or start with /ask. Your question, your name and @handle, and my earlier answer when you reply to one go to Anthropic's API.",
  "",
  "/ask <question>: ask me anything.",
  "/help: this message.",
  "",
  "Or just message me a question, or mention me in a group. Reply to one of my answers to keep going.",
].join("\n");

/** Answers this short are also sent to the chat; longer ones stay in the thread. */
export const SHORT_ANSWER = 280;

/**
 * Whether a message is meant for the bot: anything in its DM, or a group
 * message that mentions it. Other group messages reach every bot in the
 * group too; this one leaves them be, and they never reach Anthropic.
 */
export function meantForMe(m: Pick<Message, "via" | "mentioned">): boolean {
  return m.via === "dm" || m.mentioned;
}

/**
 * Whether the bot's reply would show where the message was sent: its DM, a
 * mention (a reply to one always goes), or a group that grants `post`.
 */
const mayReply = (m: Message) => m.chat === null || m.mentioned || m.chat.grants.has("post");

/** A reply in the thread only (inline in the bot's DM): help, and anything that went wrong. */
async function inThread(m: Message, text: string): Promise<void> {
  await m.reply(text);
}

/** Turn Claude's reply into the bot's. Failures stay in the thread. */
async function send(m: Message, reply: Reply): Promise<void> {
  switch (reply.kind) {
    case "answer":
      // Also sending to the chat is the bot's call, as it is a person's: a short answer the group can use goes to the chat too.
      await m.reply(reply.text, { alsoSendToChat: Array.from(reply.text).length <= SHORT_ANSWER });
      return;
    case "refused":
      return inThread(m, SAY.refused);
    case "busy":
      return inThread(m, SAY.busy);
    case "unavailable":
      return inThread(m, SAY.unavailable);
  }
}

// The bot's own earlier reply this message replies to: the only context that
// carries from one question to the next.
const earlier = (m: Message) => m.thread.map((t) => t.reply);

/**
 * One question to Claude. Over the limit, the sender is told to wait (in the
 * thread) and nothing goes to Anthropic. While Claude writes the answer, the
 * SDK shows the people in the chat that the bot is typing.
 */
async function askClaude(m: Message, deps: Deps, q: Question): Promise<void> {
  if (deps.limiter && !deps.limiter.take(limitKey(m))) return inThread(m, SAY.slowDown);
  return send(m, await deps.claude.reply(q, m.signal));
}

/** Deps from a bare Claude, for callers (and tests) that need no limit. */
const depsOf = (d: Deps | Pick<Claude, "reply">): Deps => ("claude" in d ? d : { claude: d });

/**
 * `/ask <question>`, and any other message meant for the bot. The bot's own
 * leading @handle is left out of the question. A bare `/ask` in a group that
 * doesn't let the bot post on its own sends nothing to Anthropic: the answer
 * wouldn't show. A mention always gets its answer.
 */
export async function ask(m: Message, deps: Deps | Pick<Claude, "reply">, handle = ""): Promise<void> {
  if (!mayReply(m)) return;
  const text = (m.command ? m.args : withoutHandle(m.text, handle)).trim();
  if (!text) return inThread(m, m.command ? SAY.emptyAsk : HELP);
  return askClaude(m, depsOf(deps), {
    where: m.via,
    asker: m.from,
    text,
    earlier: earlier(m),
  });
}

/** `/help`: a reply in the thread, and nothing goes to Anthropic. */
export async function help(m: Message): Promise<void> {
  if (mayReply(m)) return inThread(m, HELP);
}

/** The words without a leading "@handle" (any case), as people type a mention. */
export function withoutHandle(text: string, handle: string): string {
  if (!handle) return text;
  const at = `@${handle.toLowerCase()}`;
  const t = text.trimStart();
  if (t.toLowerCase().startsWith(at) && !/[a-z0-9_]/i.test(t.charAt(at.length))) return t.slice(at.length);
  return text;
}
