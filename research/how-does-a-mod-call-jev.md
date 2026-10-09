# How does a mod call JEV?

Research for issue #45 (map #41). Sources are TypeSafe AI's own docs (docs.typesafe.ai and the launch post), the Claude Code docs at code.claude.com, the mods type declarations in the anthropics/claude-code repo, and Anthropic's pricing page, all read 2026-10-09. Prior context is Adam's Lorveil office-hours design doc on JEV catalogue enrichment (2026-09-28). Where a source says nothing, this file says so.

## Short answer

A mod can call JEV directly. It sends one `$.http.fetch` POST to `https://api.typesafe.ai/v1/systemone` with an `Authorization: Bearer <key>` header and a JSON body of `state`, `model` and `questions`. `$.http.fetch` takes custom headers and a string body, and it has no host allowlist unless an administrator's policy refuses the call. A short call costs about $0.0000084: input is $0.042 per million tokens and output is free. TypeSafe's launch post gives 70–500 ms end to end. The open problem is the key. The design doc stores it in GCP Secret Manager for Lorveil's servers, and nothing on this machine holds it where a mod could read it. For the Haiku fallback, use `$.model.complete({ model: 'haiku', ... })` or `$.model.classify` rather than `claude -p` through `$.process`. Both are documented, use the session's own credentials, and start no second Claude Code process.

## JEV: endpoint and request shape

From the [API reference](https://docs.typesafe.ai/api.md):

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`. It is the only endpoint listed.
- **Headers:** `Authorization: Bearer <API_KEY>` and `Content-Type: application/json`.
- **Body:**
  - `state` (required): a string, or an object or array of structured data.
  - `model` (required): `"jev-latest"`.
  - `questions` (required): a map from keys you choose to typed questions. Each question has a `type` and `instructions`:
    - `noul`: a yes/no probability. `criteria` is optional.
    - `choice`: `criteria` is a map of up to 255 options.
    - `score`: `criteria` is an array of 2 to 10 levels.
- **Response:** `{ model, answers: { <key>: {...} }, usage: { input_tokens, output_tokens } }`. The docs' example answer is `{ "type": "noul", "noul": 0.95 }`.
- **Errors:**
  - 401: bad or missing key.
  - 422: validation failed.
  - 429: rate limited.
  - 529: overloaded.
  - The docs advise exponential backoff on these errors.

Minimal request, taken from the API reference:

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": { "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" } }
}
```

From the [models page](https://docs.typesafe.ai/models.md):

- **Model aliases:** `jev-latest` and `jev-preview` both point to `jev-1.13.0`.
- **Context:** 64k tokens per request, and 32k for `state` plus the longest question.
- **Rate limits:** 100K tokens/s and 80 requests/s. The page says these "can change without notice".

The [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev) says JEV is in early access, behind a waitlist. JEV is a classifier and scorer, not a text generator. Its [coding-agents page](https://docs.typesafe.ai/introduction/coding-agents.md) says it is "not a drop-in replacement for the LLM behind Claude Code". It fits a mod's yes/no and pick-one decisions, but it cannot write free text.

## Auth and where Adam's key lives

- **TypeSafe's convention:** keys come from https://console.typesafe.ai/keys. The [quick start](https://docs.typesafe.ai/introduction/quickstart.md) reads the key from the environment variable `TYPESAFE_API_KEY`, which the Python SDK picks up automatically. The docs name no config file.
- **The design doc:** the key goes in GCP Secret Manager as `{env}-jev-api-key`, "never in the database". Lorveil's catalog-worker then receives it as a Worker secret declared in `wrangler.toml`. That is a server-side setup for Lorveil. This research did not query GCP to confirm the secret exists.
- **This machine:** checked by variable name only, without reading any value:
  - `TYPESAFE_API_KEY` is not set in the shell environment or in the Windows user environment.
  - No JEV or TypeSafe name appears in the `env` block of `~/.claude/settings.json`.
  - No such file exists in the home directory.

  So a mod has no local key to read today.

A mod can reach a key in two documented ways:

1. **`$.env.get('TYPESAFE_API_KEY')`.** This reads the environment of the Claude Code process ([mods API](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network)). The name must be a string literal, and `claude plugin validate` lists every name a mod reads.
2. **A `userConfig` field with `"sensitive": true` in the mod's manifest.** The user is prompted once, the input is masked, and the value "is stored in secure storage rather than `settings.json`" ([components, user configuration](https://code.claude.com/docs/en/plugins/components#user-configuration)). The mod receives the value in `register(on, options)` ([reference](https://code.claude.com/docs/en/plugins/mods/reference#files)).

Option 2 needs no shell setup and keeps the key out of any file Adam edits by hand.

## Can a mod make the call?

Yes, through `$.http.fetch(url, init)`. The [type declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts) say:

- **Fields:**
  - `init` takes `method`, `headers` (`Record<string,string>`), `body` (a string), `auth` and `socketPath`.
  - The call resolves to `{ status, ok, headers, text }` once the body has been read.
- **Reach:**
  - It reaches http or https "to whatever the host process can reach, unless the administrator's policy switches refuse it."
  - It has **no host allowlist** by default.
  - The `auth` handle is a different mechanism. It carries the Claude session's own credential, and only to first-party hosts. A JEV call sets its own `Authorization` header and does not use `auth`.
- **Policy:**
  - Every `$.http.fetch` call is also an `http.fetch` event, which an earlier mod can rewrite or refuse ([mods API](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network)).
  - The built-in `sec-default` guard passes `http.fetch` ([sec-default README](https://github.com/anthropics/claude-code/tree/main/mods/sec-default)).
- **Time:** a hook's 10-second execution limit does not count time spent inside a mods API call ([limits](https://code.claude.com/docs/en/plugins/mods/reference#limits)).
- **Silent:** the sources do not say whether `$.http.fetch` has its own timeout, or whether it accepts an `AbortSignal`. `HttpInit` lists no timeout or signal field. A slow JEV response therefore cannot be cut off by an option the docs show.

Sketch, with the key from a sensitive `userConfig` field:

```javascript
const r = await $.http.fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + options.typesafe_api_key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: text, model: 'jev-latest', questions: { q: { type: 'noul', instructions: '...' } } }),
})
const answer = r.ok ? JSON.parse(r.text).answers.q : null
```

`$.process` could also call JEV through `curl`, but it adds nothing over `$.http.fetch`. The type declarations also mark `$.process` as "CLI only", so it would not work in the Desktop app.

## Latency and cost for one short call (~200 input, ~20 output tokens)

| Path | Cost per call | Latency | Source |
| :- | :- | :- | :- |
| JEV via `$.http.fetch` | 200 × $0.042/M ≈ **$0.0000084**. Output is free. | **70–500 ms** end to end | [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [models](https://docs.typesafe.ai/models.md) |
| Haiku 5.5 via `$.model.complete` | 200 × $0.10/M + 20 × $0.50/M ≈ **$0.00003**, plus the CLI identity block, whose token count is not documented | **Not documented** | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `claude -p --model haiku` via `$.process.run` | Haiku rates on a whole Claude Code system prompt and tool list, unless `--bare` or `--system-prompt` cuts that down. The token count is not documented. | Process startup plus model time, **not documented**. The default `$.process.run` timeout is 30 s. | [CLI reference](https://code.claude.com/docs/en/cli-reference), [limits](https://code.claude.com/docs/en/plugins/mods/reference#limits) |

Notes on the table:

- "~200 input tokens" may undercount for JEV. The API reference's own one-question example reports `input_tokens: 296` for a 10-word state, so question text and overhead count as input. Even at 300 tokens a call costs about $0.0000126.
- On a Claude subscription, `$.model.complete` "use[s] the user's plan or API key" ([mods API](https://code.claude.com/docs/en/plugins/mods/api#call-a-model)). It then draws on plan usage rather than billing per token.
- The `haiku` alias resolves to Haiku 5.5 (`claude-haiku-5-5`) on the Anthropic API, from Claude Code v2.1.293. On Bedrock, Vertex and Foundry it resolves to Haiku 4.5 ([model config](https://code.claude.com/docs/en/model-config)).

## Fallback to a Haiku-class model

Prefer the mods API's own model calls over `claude -p`:

- **`$.model.complete({ model: 'haiku', system, prompt, maxTokens, timeoutMs })`.**
  - It makes one completion through the session's own client and credentials, with no tools and no history ([mods API, call a model](https://code.claude.com/docs/en/plugins/mods/api#call-a-model)).
  - The model is "allowlist-checked like a `--model` value", so an organization can block it.
  - The guide's example takes `timeoutMs` and reads `r.isAnswered`, `r.text` and `r.reason`. The GitHub copy of the types declares the return as a plain `string` and lists no `timeoutMs`.
  - The docs say to trust the types Claude Code writes for the installed build when the two disagree, so check those before coding.
- **`$.model.classify(text, labels, { model })`.**
  - It picks one label using a fixed classifier prompt, and resolves `undefined` when the reply names none of the labels.
  - By default it uses "the engine's small fast model".
  - It is the closest match to a JEV `choice` question.
- **`claude -p --model haiku` via `$.process.run`.**
  - This works, but only in the CLI.
  - It starts a full Claude Code process. `--bare` skips hooks, plugins, CLAUDE.md and MCP to start faster ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
  - It has to be wrapped in `try`/`catch`, because `$.process.run` rejects on timeout or when the program fails to start.
  - Use it only if `$.model.*` is unavailable.

A reasonable shape: try JEV when a key is configured. On a missing key, a non-2xx status or an exception, fall back to `$.model.classify` or `$.model.complete` with `haiku`.

## Where the sources are silent

- No timeout or abort option for `$.http.fetch`.
- No published latency for Haiku, or for `$.model.complete` round trips.
- The token size of the CLI identity block that `$.model.complete` prepends.
- JEV data retention, and how well JEV's confidence is calibrated. The design doc's open question 7 already flagged these. The docs read here do not answer them, and a [legal page](https://docs.typesafe.ai/legal.md) exists but was not read for this note.
- Whether early-access JEV keys have lower rate limits than those on the models page.
