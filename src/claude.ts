// One question to Claude, one reply back. The Anthropic client is passed in,
// so tests run with a fake and no network.
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TEXT } from "@peachysocial/bot";
import { SYSTEM_PROMPT, userTurn, type Question } from "./prompt.ts";

/** The model unless CLAUDE_MODEL says otherwise. */
export const DEFAULT_MODEL = "claude-opus-5-5";
/** Chat replies are short and quick: low effort unless CLAUDE_EFFORT says otherwise. */
export const DEFAULT_EFFORT: Effort = "low";
/** Server-side fallbacks: a declined request is retried on the model Anthropic recommends for it. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** The longest reply Peachy takes, in code points: the SDK's `MAX_TEXT` (4,000). */
export const MAX_ANSWER = MAX_TEXT;
/**
 * Prompt caching pays only when a question follows another within the
 * cache's 5 minutes: each write costs 1.25x the prompt, each read 0.1x. A
 * quiet bot writes and never reads, so after this many requests in a row
 * without a cache read it stops marking the prompt...
 */
export const CACHE_MISSES_BEFORE_OFF = 10;
/** ...and marks it again after this many more, in case the bot got busier. */
export const CACHE_RETRY_AFTER = 50;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The part of the Anthropic client this file uses. */
export type ClaudeClient = { readonly beta: { readonly messages: Pick<Anthropic.Beta.Messages, "stream"> } };

/** What Claude came back with, as the bot answers it. */
export type Reply =
  | { readonly kind: "answer"; readonly text: string }
  /** Claude (and its fallback) declined. Say "I can't help with that." */
  | { readonly kind: "refused" }
  /** Too many requests, or Anthropic is overloaded. Worth trying again soon. */
  | { readonly kind: "busy" }
  /** Anything else went wrong: a bad key, the network, an empty reply. */
  | { readonly kind: "unavailable" };

/** What the bot logs about a request. Never the words. */
export interface ClaudeLog {
  (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface ClaudeOptions {
  readonly client: ClaudeClient;
  readonly model?: string;
  readonly effort?: Effort;
  readonly maxTokens?: number;
  readonly log?: ClaudeLog;
}

export class Claude {
  readonly model: string;
  readonly effort: Effort;
  readonly #client: ClaudeClient;
  readonly #maxTokens: number;
  readonly #log: ClaudeLog;
  #cacheOn = true;
  /** Requests in a row with no cache read, while the prompt is marked. */
  #misses = 0;
  /** Requests since the marker was dropped. */
  #sinceOff = 0;

  constructor(options: ClaudeOptions) {
    this.#client = options.client;
    this.model = options.model || DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    // Peachy's 4,000-character limit is about 1,000 tokens, so 2,048 leaves
    // room and caps what one question can cost in output (about 4 cents on
    // Opus 5.5).
    this.#maxTokens = options.maxTokens ?? 2048;
    this.#log = options.log ?? (() => {});
  }

  /** Whether the next request marks the system prompt for caching. */
  get caching(): boolean {
    return this.#cacheOn;
  }

  /** The request for one question. Exposed so tests can check what is sent. */
  request(q: Question): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: this.#maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: this.effort },
      // Frozen: identical bytes on every request, so it can be cached.
      system: [
        this.#cacheOn
          ? { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
          : { type: "text", text: SYSTEM_PROMPT },
      ],
      // Everything about this question, after the cached prefix.
      messages: [{ role: "user", content: userTurn(q) }],
    };
  }

  /** Keep the cache marker only while it gets read (see CACHE_MISSES_BEFORE_OFF). */
  #countCache(read: number): void {
    if (!this.#cacheOn) {
      if (++this.#sinceOff >= CACHE_RETRY_AFTER) {
        this.#cacheOn = true;
        this.#misses = 0;
        this.#log("claude.cache", { caching: true, reason: "retrying" });
      }
      return;
    }
    if (read > 0) {
      this.#misses = 0;
      return;
    }
    if (++this.#misses >= CACHE_MISSES_BEFORE_OFF) {
      this.#cacheOn = false;
      this.#sinceOff = 0;
      this.#log("claude.cache", { caching: false, reason: `no cache read in ${CACHE_MISSES_BEFORE_OFF} requests` });
    }
  }

  /** `signal`: the message's, so a handler that ran out of time (handlerTimeoutMs) stops paying for the request. */
  async reply(q: Question, signal?: AbortSignal): Promise<Reply> {
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await this.#client.beta.messages.stream(this.request(q), signal ? { signal } : undefined).finalMessage();
    } catch (err) {
      return this.#failed(err);
    }
    const usage = message.usage;
    const cached = this.#cacheOn;
    this.#countCache(usage.cache_read_input_tokens ?? 0);
    this.#log("claude.reply", {
      model: message.model,
      stop_reason: message.stop_reason,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      // Zero on every request means the system prompt isn't being cached.
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      caching: cached,
    });
    // Check the stop reason before reading content: after a refusal it is
    // empty or a partial to throw away.
    if (message.stop_reason === "refusal") return { kind: "refused" };
    const text = plainText(
      message.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(""),
    );
    if (!text) return { kind: "unavailable" };
    // Thinking counts toward max_tokens, so a long answer can stop mid-sentence:
    // say so with "…" rather than post it as if it were whole.
    if (message.stop_reason === "max_tokens") {
      this.#log("claude.cut", { reason: "max_tokens", max_tokens: this.#maxTokens });
      return { kind: "answer", text: clip(`${text.trimEnd()}…`) };
    }
    return { kind: "answer", text: clip(text) };
  }

  #failed(err: unknown): Reply {
    // Most specific first. Only the class and status are logged.
    if (err instanceof Anthropic.RateLimitError) {
      this.#log("claude.error", { error: "rate_limited", status: 429 });
      return { kind: "busy" };
    }
    if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503)) {
      this.#log("claude.error", { error: "overloaded", status: err.status ?? null });
      return { kind: "busy" };
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      this.#log("claude.error", { error: "check ANTHROPIC_API_KEY", status: err.status ?? null });
      return { kind: "unavailable" };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      this.#log("claude.error", { error: "connection", status: null });
      return { kind: "unavailable" };
    }
    if (err instanceof Anthropic.APIError) {
      this.#log("claude.error", { error: err.constructor.name, status: err.status ?? null });
      return { kind: "unavailable" };
    }
    this.#log("claude.error", { error: err instanceof Error ? err.name : "unknown", status: null });
    return { kind: "unavailable" };
  }
}

/**
 * Peachy shows text as written, so turn the Markdown Claude may still write
 * into plain text: no heading marks, bold, code fences or table rules.
 */
export function plainText(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fit Peachy's answer cap (in code points), cutting at a word where one is near. */
export function clip(text: string, max = MAX_ANSWER): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const cut = points.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max - 200 ? cut.slice(0, space) : cut).join("")}…`;
}
