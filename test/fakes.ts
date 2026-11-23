// A stand-in for the Anthropic client: it records each request and answers
// with a canned message or error. No network, no API key.
import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient } from "../src/claude.ts";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export interface FakeClaude {
  readonly client: ClaudeClient;
  readonly requests: Params[];
}

/** A reply as the API would return it after streaming. */
export function message(content: Message["content"], stop_reason: Message["stop_reason"] = "end_turn", cacheRead = 0): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
  } as unknown as Message;
}

export const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.Messages.BetaTextBlock;

/** A client whose every stream ends in `outcome` (a message, or an error it throws). */
export function fakeClaude(outcome: Message | Error | ((p: Params) => Message | Error)): FakeClaude {
  const requests: Params[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Params) {
          requests.push(structuredClone(params));
          const o = typeof outcome === "function" ? outcome(params) : outcome;
          return {
            finalMessage: async () => {
              if (o instanceof Error) throw o;
              return o;
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as ClaudeClient, requests };
}
