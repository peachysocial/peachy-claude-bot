// The whole bot against @peachysocial/bot/testing, an in-memory Peachy, with a fake
// Anthropic client: the SDK's routing picks the handler, as in production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { FakePeachy } from "@peachysocial/bot/testing";
import type { Message, Person } from "@peachysocial/bot";
import { HELP, SAY, SHORT_ANSWER, ask } from "../src/answers.ts";
import { DEV_STAND_IN, dev, register } from "../src/bot.ts";
import { Claude } from "../src/claude.ts";
import { ChatRateLimiter, DEFAULT_RATE_LIMIT, parseRateLimit } from "../src/limit.ts";
import { fakeClaude, message, text } from "./fakes.ts";

async function start(outcome: Parameters<typeof fakeClaude>[0] = message([text("Sunday works for everyone.")]), reach: "anyone" | readonly Person[] = "anyone") {
  const fake = fakeClaude(outcome);
  const peachy = new FakePeachy({ handle: "askclaude", reach });
  const bot = register(peachy.bot(), new Claude({ client: fake.client }));
  await bot.start();
  const maya = peachy.person("Maya", "maya");
  const theo = peachy.person("Theo", "theo");
  /** Maya mentions the bot in a group that lets it post; resolves with its replies there, as [text, alsoSendToChat]. */
  const inGroup = async (words: string) => {
    const chat = await peachy.addToChat({ by: maya, members: [theo], grants: ["post"] });
    await chat.say(maya, words, { mentionsBot: true });
    return chat.posts.map((p) => (p.kind === "reply" ? [p.text, p.alsoSendToChat] : p.kind));
  };
  return { fake, peachy, bot, maya, theo, inGroup };
}

const userTurn = (fake: ReturnType<typeof fakeClaude>, i = 0) => fake.requests[i]!.messages[0]!.content as string;

/** What the fake reports for a reply in the bot's DM: inline, typing shown first. */
const inline = (text: string) => ({ kind: "reply", text, alsoSendToChat: false, inline: true, typed: true });

test("/ask in a group sends the question, and a short answer is also sent to the chat", async () => {
  const { fake, bot, inGroup } = await start();
  assert.deepEqual(await inGroup("@askclaude /ask which day works?"), [["Sunday works for everyone.", true]]);
  assert.match(userTurn(fake), /<question>which day works\?<\/question>/);
  assert.match(userTurn(fake), /<asker name="Maya" handle="@maya"\/>/);
  assert.match(userTurn(fake), /^<where>chat<\/where>\n/, "asked in a group: the answer is for everyone there");
  await bot.stop();
});

test("a long answer stays in the thread", async () => {
  const long = "Sunday works. ".repeat(30).trim();
  assert.ok(Array.from(long).length > SHORT_ANSWER);
  const { bot, inGroup } = await start(message([text(long)]));
  assert.deepEqual(await inGroup("@askclaude /ask which day works?"), [[long, false]]);
  await bot.stop();
});

test("/ask in the bot's DM tells Claude the answer is for the asker alone", async () => {
  const { fake, peachy, bot, maya } = await start();
  const out = await peachy.dm(maya, "/ask what should I bring?");
  assert.deepEqual(out, inline("Sunday works for everyone."), "inline under their message, typing shown while Claude wrote");
  assert.match(userTurn(fake), /^<where>dm<\/where>\n/);
  assert.match(userTurn(fake), /<question>what should I bring\?<\/question>/);
  await bot.stop();
});

test("a plain DM message, or a mention in a group, is a question, without the bot's @handle", async () => {
  const { fake, peachy, bot, maya, inGroup } = await start();
  assert.equal((await peachy.dm(maya, "what should we cook?")).kind, "reply");
  assert.match(userTurn(fake, 0), /<question>what should we cook\?<\/question>/);
  assert.deepEqual(await inGroup("@AskClaude what about dessert?"), [["Sunday works for everyone.", true]]);
  assert.match(userTurn(fake, 1), /<question>what about dessert\?<\/question>/);
  await bot.stop();
});

test("a group message that doesn't mention the bot never reaches Anthropic, nor a bare /ask where it can't post; a mention is always answered", async () => {
  const { fake, peachy, bot, maya, theo } = await start();
  const chat = await peachy.addToChat({ by: maya, members: [theo], grants: ["post"] });
  await chat.say(theo, "does Sunday work?");
  const quiet = await peachy.addToChat({ by: maya, members: [theo], grants: [] });
  await quiet.say(theo, "/ask does Sunday work?");
  assert.equal(fake.requests.length, 0);
  assert.deepEqual([chat.posts, quiet.posts], [[], []]);
  // A mention gets its answer even where the bot doesn't post on its own.
  await quiet.say(theo, "@askclaude does Sunday work?", { mentionsBot: true });
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(quiet.posts.map((p) => (p.kind === "reply" ? p.text : p.kind)), ["Sunday works for everyone."]);
  assert.equal(peachy.deadLetters.length, 0);
  await bot.stop();
});

test("/help replies in the thread and sends nothing to Anthropic", async () => {
  const { fake, peachy, bot, maya, inGroup } = await start();
  assert.deepEqual(await inGroup("@askclaude /help"), [[HELP, false]]);
  assert.deepEqual(await peachy.dm(maya, "/help"), inline(HELP));
  assert.equal(fake.requests.length, 0);
  await bot.stop();
});

test("a refusal stays in the thread: I can't help with that.", async () => {
  const { bot, inGroup } = await start(message([text("partial")], "refusal"));
  assert.deepEqual(await inGroup("@askclaude /ask something"), [["I can't help with that.", false]]);
  await bot.stop();
});

test("an API error stays in the thread, plainly, with no error text", async () => {
  const headers = new Headers();
  const down = await start(new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key sk-ant-…", headers));
  assert.deepEqual(await down.inGroup("@askclaude hi"), [[SAY.unavailable, false]]);
  await down.bot.stop();
  const busy = await start(new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", headers));
  assert.deepEqual(await busy.peachy.dm(busy.maya, "hi"), inline(SAY.busy));
  await busy.bot.stop();
});

test("an empty /ask explains itself to the asker", async () => {
  const { fake, peachy, bot, maya } = await start();
  assert.deepEqual(await peachy.dm(maya, "/ask"), inline(SAY.emptyAsk));
  assert.equal(fake.requests.length, 0);
  await bot.stop();
});

test("someone outside the listing's reach gets nothing in the DM, and nothing reaches Anthropic", async () => {
  const { fake, peachy, bot, maya, theo } = await start(undefined, [new FakePeachy().person("Maya", "maya")]);
  assert.equal((await peachy.dm(theo, "hi")).kind, "none");
  assert.equal(fake.requests.length, 0);
  assert.equal((await peachy.dm(maya, "hi")).kind, "reply");
  await bot.stop();
});

test("someone outside PEACHY_BOT_ALLOW gets nothing, compared by account", async () => {
  const fake = fakeClaude(message([text("ok")]));
  const peachy = new FakePeachy({ handle: "askclaude" });
  const maya = peachy.person("Maya", "maya");
  const theo = peachy.person("Theo", "theo");
  const bot = register(peachy.bot(), new Claude({ client: fake.client }), { allow: ["@maya"] });
  await bot.start();
  assert.equal((await peachy.dm(theo, "hi")).kind, "none");
  assert.equal(fake.requests.length, 0);
  assert.equal((await peachy.dm(maya, "hi")).kind, "reply");
  // Nor may Theo add it to a group.
  assert.equal((await peachy.addToChat({ by: theo, grants: ["post"] })).gone, true);
  await bot.stop();
});

test("dev(bot), what `npx @peachysocial/bot dev` and conformance load, runs with no API key", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const peachy = new FakePeachy({ handle: "askclaude" });
    const bot = dev(peachy.bot());
    await bot.start();
    const maya = peachy.person("Maya", "maya");
    for (const ask of ["/ask which day?", "which day?"]) {
      const a = await peachy.dm(maya, ask);
      assert.equal(a.kind === "reply" ? a.text : a.kind, DEV_STAND_IN, ask);
    }
    await bot.stop();
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("a reply to an earlier answer carries that answer", async () => {
  const fake = fakeClaude(message([text("Sunday rains.")]));
  const peachy = new FakePeachy({ handle: "askclaude" });
  const bot = register(peachy.bot(), new Claude({ client: fake.client }));
  await bot.start();
  const maya = peachy.person("Maya", "maya");
  const first = await peachy.dm(maya, "is Saturday sunny?");
  await peachy.dm(maya, "and on Sunday?", { replyTo: first });
  assert.match(userTurn(fake, 1), /<your_earlier_answers>[\s\S]*Sunday rains\.[\s\S]*<\/your_earlier_answers>/);
  assert.doesNotMatch(userTurn(fake, 0), /<your_earlier_answers>/);
  await bot.stop();
});

/** A message shaped as the SDK delivers one, for driving `ask` directly. */
function shaped(over: Partial<Message>, sent: { text: string; alsoSendToChat: boolean }[]): Message {
  return {
    id: "m1",
    redelivered: false,
    via: "dm",
    chat: null,
    dm: null,
    from: { actorId: "actor-maya", name: "Maya", handle: "maya" },
    at: new Date(),
    signal: new AbortController().signal,
    text: "and on Sunday?",
    replyTo: "a0",
    attachments: [],
    mentioned: false,
    command: null,
    args: "",
    thread: [{ messageId: "m0", reply: "Saturday is sunny.", at: new Date("2026-11-11T18:00:00Z") }],
    reply: async (t, o) => {
      sent.push({ text: t, alsoSendToChat: o?.alsoSendToChat === true });
      return { id: "a1", at: new Date(), duplicate: false, leftOut: [], alsoSentToChat: o?.alsoSendToChat === true, alsoSendRefused: null };
    },
    react: async () => {},
    startCall: async () => {
      throw new Error("this bot starts no calls");
    },
    ...over,
  };
}

test("failures stay in the thread, and an earlier answer reaches Claude", async () => {
  const answers: { text: string; alsoSendToChat: boolean }[] = [];
  const fake = fakeClaude(message([text("Sunday rains.")]));
  await ask(shaped({}, answers), new Claude({ client: fake.client }));
  assert.match(userTurn(fake), /<your_earlier_answers>[\s\S]*Saturday is sunny\.[\s\S]*<\/your_earlier_answers>/);
  assert.deepEqual(answers, [{ text: "Sunday rains.", alsoSendToChat: true }]);

  answers.length = 0;
  const down = fakeClaude(new Anthropic.APIConnectionError({ message: "socket hang up" }));
  await ask(shaped({}, answers), new Claude({ client: down.client }));
  assert.deepEqual(answers, [{ text: SAY.unavailable, alsoSendToChat: false }]);
});

test("listing.json declares Anthropic, its retention, post, and the same commands the bot registers", async () => {
  const listing = JSON.parse(readFileSync(new URL("../listing.json", import.meta.url), "utf8"));
  assert.equal(listing.destination, "Anthropic (Claude API)");
  assert.match(listing.policyUrl, /^https:\/\/privacy\.claude\.com\//);
  assert.match(listing.retention, /Anthropic/);
  assert.notEqual(listing.handle, "claude", "@claude is held for Anthropic");
  assert.deepEqual(listing.grantsRequested, ["post"], "a group's answers are the bot's own posts");
  assert.equal("kinds" in listing, false);
  const { bot } = await start();
  const registered = bot.commands.map((c) => ({
    name: c.name,
    blanks: c.options.blanks ?? "",
    worksInDm: c.options.worksInDm ?? false,
  }));
  const listed = listing.commands.map((c: Record<string, unknown>) => ({ name: c.name, blanks: c.blanks, worksInDm: c.worksInDm }));
  assert.deepEqual(listed, registered);
  await bot.stop();
});

test("each chat gets its own limit; over it, the reply says to wait and nothing goes to Anthropic", async () => {
  const fake = fakeClaude(message([text("ok")]));
  const peachy = new FakePeachy({ handle: "askclaude" });
  const bot = register(peachy.bot(), new Claude({ client: fake.client }), { rateLimit: { questions: 2, windowMs: 60_000 } });
  await bot.start();
  const maya = peachy.person("Maya", "maya");
  const theo = peachy.person("Theo", "theo");
  // The bot's DM with Maya is one chat.
  assert.equal((await peachy.dm(maya, "one")).kind, "reply");
  assert.equal((await peachy.dm(maya, "two")).kind, "reply");
  assert.deepEqual(await peachy.dm(maya, "three"), inline(SAY.slowDown));
  assert.equal(fake.requests.length, 2);
  // A group is another, whoever asks there.
  const chat = await peachy.addToChat({ by: maya, members: [theo], grants: ["post"] });
  await chat.say(theo, "@askclaude a", { mentionsBot: true });
  await chat.say(maya, "@askclaude b", { mentionsBot: true });
  await chat.say(theo, "@askclaude c", { mentionsBot: true });
  assert.deepEqual(
    chat.posts.map((p) => (p.kind === "reply" ? [p.text, p.alsoSendToChat] : p.kind)),
    [["ok", true], ["ok", true], [SAY.slowDown, false]],
  );
  assert.equal(fake.requests.length, 4);
  await bot.stop();
});

test("CLAUDE_RATE_LIMIT reads <questions>/<minutes>, or off", () => {
  assert.deepEqual(parseRateLimit(undefined), DEFAULT_RATE_LIMIT);
  assert.deepEqual(DEFAULT_RATE_LIMIT, { questions: 10, windowMs: 600_000 });
  assert.deepEqual(parseRateLimit("3/1"), { questions: 3, windowMs: 60_000 });
  assert.equal(parseRateLimit("off"), null);
  assert.throws(() => parseRateLimit("10 per minute"), /CLAUDE_RATE_LIMIT/);
  assert.throws(() => parseRateLimit("0/5"), /CLAUDE_RATE_LIMIT/);
  let now = 0;
  const limiter = new ChatRateLimiter({ questions: 1, windowMs: 1000 }, () => now);
  assert.equal(limiter.take("k"), true);
  assert.equal(limiter.take("k"), false);
  now = 1001;
  assert.equal(limiter.take("k"), true, "the window slides");
});
