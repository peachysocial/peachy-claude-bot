# Claude bot for Peachy

An example bot that answers questions in [Peachy](https://pchy.app) with
Claude, through Anthropic's API. It is built on the
[Peachy bot template](https://github.com/peachysocial/peachy-bot-template)
and the `@peachysocial/bot` SDK.

**This is an example you run yourself, not a service Peachy runs.** The bot
you deploy sends the questions people send it to Anthropic, under your
Anthropic account and your listing. Peachy doesn't operate it, see its
traffic, or pay for it. You bring your own Anthropic API key: Peachy
provides none, and doesn't run this example against Anthropic; its tests
use a fake Anthropic client. The `@claude` handle is held for Anthropic; choose
your own (`listing.json` uses `yourname_claude`).

## What it does

| Command | What happens |
|---|---|
| `/ask <question>`, or any other message in its DM | Claude replies inline under the message. |
| `@yourbot /ask <question>`, or any mention, in a group that added it | Claude replies, as a person would, in the message's thread (and also in the chat when the answer is short). A reply to a mention always goes; a bare `/ask` needs the group's `post` grant, and without it the bot sends nothing, and nothing goes to Anthropic. |
| `/help` | What the bot does, as a reply. Nothing goes to Anthropic. |

What it sends Anthropic for each question: the question and the asker's
name and @handle, and the bot's own earlier answer when the question
replies to one. In a group, the messages of every member who said OK to
the bot reach it; this bot answers only the ones that mention it, and nothing
else of the chat goes to Anthropic: not its name, not its members, not
other messages.

Whether a reply is also sent to the chat is the bot's call, as it is a
person's. This one sends a short answer (280 characters or fewer) to the
chat too, and keeps longer ones in the thread (`SHORT_ANSWER` in
`src/answers.ts`).

A refusal from Claude is replied "I can't help with that." in the thread.
When the API is busy or failing, the reply says "Claude is busy right now" or
"Claude is unavailable right now". No error text or stack trace ever reaches
a chat.

Each chat may ask 10 questions in 10 minutes (`CLAUDE_RATE_LIMIT`, e.g.
`20/10`, or `off`); past that, the reply says to try again in a little
while, and nothing goes to Anthropic. A group counts as one chat, whoever
asks there, and the bot's DM with each person as another.

## How it calls Claude

`src/claude.ts`:

- **Model** `claude-opus-5-5` unless `CLAUDE_MODEL` says otherwise. Claude
  Opus 5.5 costs $4 per million input tokens and $20 per million output
  tokens (cache writes $5, cache reads $0.20). A typical question here is
  about 1,000 to 3,000 input tokens (the system prompt and the question)
  and a few hundred output tokens, so roughly 1 to 3 cents.
  Output is capped at 2,048 tokens (`max_tokens`), about 4 cents, since an
  answer longer than Peachy's limit would be cut anyway. Check Anthropic's
  pricing page for current prices. For a cheaper bot set
  `CLAUDE_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5`.
- **Effort** `low` (`output_config.effort`), right for short chat replies.
  `CLAUDE_EFFORT` takes `low`, `medium`, `high`, `xhigh` or `max`.
- **Streaming**, collected with `.finalMessage()`. While Claude writes, the
  SDK shows the people in the chat that the bot is typing. The client's
  timeout is 60 seconds.
- **Prompt caching.** The system prompt (`src/prompt.ts`) is frozen and marked
  `cache_control`, so repeated questions read it from Anthropic's cache. The
  asker's name and the question go in the user turn,
  after the cached prefix. Each reply logs `cache_read_input_tokens`. A
  cache entry lives 5 minutes, and writing one costs 1.25x the prompt, so a
  quiet bot pays to write a cache nobody reads: after 10 requests in a row
  with no cache read, the bot stops marking the prompt (it logs
  `claude.cache` with `caching: false`), and tries again after 50 more.
- **Refusals.** Requests opt into server-side fallbacks (`fallbacks:
  "default"`, beta `server-side-fallback-2026-07-01`): a request Claude's
  safeguards decline is retried on the model Anthropic recommends for it.
  The bot checks `stop_reason` for `"refusal"` before it reads any text.
- **Plain text.** Peachy shows replies as written, so the prompt asks for
  plain text and the bot strips stray Markdown. Answers are cut to Peachy's
  limit of 4,000 characters (code points), at a word.

## Run it

You need Node.js 22.13 or newer, a Peachy account and an Anthropic API key
(https://platform.claude.com).

```sh
git clone https://github.com/peachysocial/peachy-claude-bot
cd peachy-claude-bot
npm install
npx @peachysocial/bot keygen --out .peachy-store-key
cp .env.example .env
```

Then put your Anthropic API key in `.env` (`ANTHROPIC_API_KEY=`). `.env`
already points at the store key file; both are in `.gitignore`.

Create the bot in Peachy: **Settings › Organizations and bots › New bot**
(on Mac, **You › Organizations and bots › New bot**).
Leave **Who can use it** on **You and testers** (only you and up to 10
testers can use it), fill it in from `listing.json` (below), check **I agree
to the [Developer Terms](https://pchy.app/developer-terms)**, and tap
**Create**. The bot sends
its commands when it starts. Tap **Connect** for a one-time code, and link:

```sh
npx @peachysocial/bot connect
npm start
```

It prints `Linked ✓ as @yourname_claude`. Open its DM (in your **Bots**
list) and send `what's a good hike near Tahoe?`, or add it to a group,
letting it post, and send `@yourname_claude /ask what's a good hike near Tahoe?`.

`npm test` runs the tests with a fake Anthropic client and
`@peachysocial/bot/testing`: no network, no keys, no cost.

## The listing

`listing.json` is the listing to enter in **New bot**, field by field. People
read it before their first message to the bot, with your name on it, so keep
it true for how you run it:

- **Where messages go:** `Anthropic (Claude API)`.
- **How long it keeps them:** this bot stores no messages and logs no words.
  The SDK's encrypted store keeps the bot's own replies for 14 days so a
  phone that missed one can ask again. Anthropic deletes API inputs and
  outputs within 30 days unless they are flagged under its Usage Policy,
  the law requires longer, or you have a zero data retention agreement with
  Anthropic. If you do, or if you add any logging or storage, change the text.
- **Privacy policy link:** Anthropic's retention page. Link your own policy
  instead if you have one that covers both.
- **What it can do:** post, to reply in a group. Nothing else.
- **Who can use it:** you and your testers while it's a development bot.
  Every question is billed to your Anthropic account, so before you publish
  it, name people in `PEACHY_BOT_ALLOW`, or keep the rate limit and set a
  spend limit in the Claude Console. `PEACHY_BOT_ALLOW` narrows who can use
  it, by account id (a handle there is looked up at each start; the bot logs
  its id to pin); it can't widen what the listing says. The SDK turns everyone
  else away before anything reaches Anthropic.
- **Commands:** `ask`, `help`. The bot
  sends these from `src/bot.ts` each time it starts.

Changing where messages go or how long they're kept asks everyone again
before their next message to the bot.

## Deploy

As in the template: a long-running process with no public URL, exactly one
copy. `fly.toml` (a machine with a volume) and `render.yaml` (a background
worker with Postgres) are ready. Set `PEACHY_BOT_STORE_KEY` and
`ANTHROPIC_API_KEY` as secrets, never in the repository, and for the first
start, the production bot's Connect code as `PEACHY_CONNECT_CODE`. The bot
links itself; remove the code once the logs say `Linked ✓`. On Fly.io:

```sh
fly secrets set PEACHY_BOT_STORE_KEY=… ANTHROPIC_API_KEY=… PEACHY_CONNECT_CODE=…
fly deploy
fly secrets unset PEACHY_CONNECT_CODE
```

Use a separate bot for production; see the template's README for why the
store is the bot's identity, and how to rotate or reset keys.

## License

MIT-0 (MIT No Attribution): copy it into your own bot without keeping a copyright notice. See `LICENSE`.
