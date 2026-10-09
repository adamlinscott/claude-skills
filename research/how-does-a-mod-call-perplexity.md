# How does a mod call Perplexity?

Research for issue #54 (map #41). Sources are Perplexity's own docs at docs.perplexity.ai and the Claude Code mods API page at code.claude.com, all read 2026-10-09. Where a source says nothing, this file says so.

## Short answer

A mod can call Perplexity with one `$.http.fetch` POST to the **Agent API**, `https://api.perplexity.ai/v1/agent`, with `Authorization: Bearer <key>` and a body of `model`, `instructions`, `input` and `max_output_tokens`, and no `tools`. The cheapest suitable models are `openai/gpt-6-luna` and `anthropic/claude-haiku-5-5`, both $0.10/M input and $0.50/M output. A ~200-token-in, ~15-token-out call costs about **$0.00003**, roughly 3x JEV's ~$0.00001. Leaving `web_search` out of `tools` avoids the per-search fee. Perplexity publishes **no latency figures** for the Agent API. New accounts (Tier 0) are limited to **1 request per second**. `PERPLEXITY_API_KEY` is not set on this machine.

The old Sonar Chat Completions API is the wrong target. Perplexity says its support "ended on September 27, 2026", and Sonar always searches, with a per-request search fee of $5 or more per 1,000 requests.

## Which Perplexity API

Perplexity now has several APIs. Three of them could produce a short label:

| API | Endpoint | Fit for a ~10-word label |
|---|---|---|
| Agent API | `POST https://api.perplexity.ai/v1/agent` (alias `/v1/responses`) | Yes. Generally available, and web search runs only when you list it in `tools`. |
| Orchestrator API | `POST https://api.perplexity.ai/router/v1/chat/completions` | Yes, but it is in **private preview** and access is by email to api@perplexity.ai ([quickstart](https://docs.perplexity.ai/docs/router/quickstart.md)). It does no search and has no per-request fee. |
| Decisions API | `POST https://api.perplexity.ai/v1/decisions` | No. It returns probabilities over yes/no, choice or score questions and never returns free text ([quickstart](https://docs.perplexity.ai/docs/decisions/quickstart.md)). It is Perplexity's counterpart to JEV. |
| Sonar | `POST https://api.perplexity.ai/v1/sonar` | No. Support ended on 2026-09-27, and requests are being reformulated as Agent API requests ([migrate from Sonar](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview.md)). |

The [Agent API quickstart](https://docs.perplexity.ai/docs/agent-api/quickstart.md) does not say whether the API is GA or in preview. It is not marked as a preview the way the Orchestrator is.

## Agent API: request shape

From the [Agent API reference](https://docs.perplexity.ai/api-reference/agent-post.md) and the [quickstart](https://docs.perplexity.ai/docs/agent-api/quickstart.md):

- **Headers:** `Authorization: Bearer <key>` and `Content-Type: application/json`.
- **Body fields a label call needs:**
  - `model`: a `provider/model` ID.
  - `instructions`: the system prompt.
  - `input`: a string, or an array of input items.
  - `max_output_tokens`: optional in general. It is **required for `anthropic/*` models**, which return HTTP 400 without it.
  - `reasoning.effort`: `minimal` to `max`. Set it to `minimal` to keep hidden reasoning tokens down. The docs do not say which models bill reasoning tokens.
  - `max_steps`: defaults to 1 when `model` is given without a preset.
- **Search:** web search is a tool you opt into with `tools: [{ "type": "web_search" }]`. The quickstart's example without tools returns `"tools": []` and performs no search. The reference never says outright that omitting `tools` means no search, so this rests on the example.
- **Response:** the text is in `output[]`, in the item with `type: "message"`, then `content[]`, in the entry with `type: "output_text"`, field `text`. `usage` gives `input_tokens`, `output_tokens` and `total_tokens`, plus `usage.cost` with `input_cost`, `output_cost` and `total_cost` in USD. `tool_calls_cost` appears only when a tool ran.

A mod call:

```javascript
const key = await $.env.get('PERPLEXITY_API_KEY')
const r = await $.http.fetch('https://api.perplexity.ai/v1/agent', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'openai/gpt-6-luna',
    instructions: 'Reply with a label of at most 10 words. No punctuation.',
    input: 'branch: feat/role-agents\nfiles: agents/worker.md, install.mjs\nagents: worker, reviewer',
    max_output_tokens: 30,
    reasoning: { effort: 'minimal' },
  }),
})
const msg = JSON.parse(r.text).output.find(o => o.type === 'message')
const label = msg?.content.find(c => c.type === 'output_text')?.text
```

## Cheapest suitable model

From the Agent API [models page](https://docs.perplexity.ai/docs/agent-api/models.md) and [pricing](https://docs.perplexity.ai/docs/getting-started/pricing.md), in USD per 1M tokens. The listed rates apply under each model's long-context threshold, which a 200-token call never reaches.

| Model | Input | Output | Note |
|---|---|---|---|
| `openai/gpt-6-luna` | 0.10 | 0.50 | Cheapest, tied |
| `anthropic/claude-haiku-5-5` | 0.10 | 0.50 | Cheapest, tied. Needs `max_output_tokens`. |
| `openai/gpt-5.6-luna` | 0.20 | 1.20 | Used by the cheapest preset, "Quick lookup" |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.50 | |
| `perplexity/sonar` | 0.25 | 2.50 | |

On the Orchestrator, the cheapest model is `perplexity/glm-5.3-flash` at $0.15 input and $0.50 output ([models](https://docs.perplexity.ai/docs/router/models.md)).

The docs say nothing about which of these is fastest.

## Cost per call

The pricing page says Agent API "tool costs are separate from model token costs". It lists **no per-request fee** for the Agent API, though it never says outright that there is none. The Orchestrator page states "there are no per-request fees". The search fees that a label call should avoid:

- **Agent API `web_search` tool:** $0.0025 per call, or $0.001 with `search_type: "fast"`.
- **Sonar:** a request fee of $5, $8 or $12 per 1,000 requests by search context size, on top of tokens ($1/M input and output for `sonar`).

The pricing page does not say whether Sonar's search can be turned off. The Sonar migration page does not mention a `disable_search` option.

For ~200 tokens in and ~15 out with no tools:

| Option | Cost per call |
|---|---|
| Agent API, `gpt-6-luna` or `claude-haiku-5-5` | 200 × $0.10/M + 15 × $0.50/M ≈ **$0.0000275** |
| Orchestrator, `glm-5.3-flash` | ≈ $0.0000375 |
| Agent API with one fast `web_search` | ≈ $0.001 |
| Sonar | ≈ $0.0052 or more |

The instructions string counts toward input tokens. Reasoning tokens, if a model bills them, would add to output.

## Latency

- **Agent API:** Perplexity publishes no latency figures. The quickstart, the API reference, the models page and the Sonar benchmarks page give none. The reference calls fast search a "lower-latency" path but gives no number.
- **Orchestrator:** no figures.
- **Decisions API:** "a few hundred input tokens" returned in under 2 seconds in Perplexity's 2026-09-30 tests, with a suggested client timeout of ~30 s.

Real latency for a label call has to be measured.

## Rate limits

From [Rate Limits & Usage Tiers](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.md):

- **Agent API:** limits are per organization and shared across models and keys. Tiers follow lifetime credit purchases, and a tier once reached is kept.

  | Tier | Lifetime purchases | Limit |
  |---|---|---|
  | 0 | $0 | 1 QPS |
  | 1 | $50 | 3 QPS |
  | 2 | $250 | 8 QPS |
  | 3 | $500 | 17 QPS |
  | 4 and 5 | $1,000 and $5,000 | 33 QPS |

  Over the limit returns 429.
- **Orchestrator:** no per-tier numbers. A 429 carries `Retry-After`, and "requests rejected with a `429` are not billed."
- **Decisions API:** 10 requests per second for every organization.

The page recommends exponential backoff with jitter.

## Auth

- **Perplexity's convention:** the Orchestrator and Agent API quickstarts both name `PERPLEXITY_API_KEY`, which the SDKs read automatically.
- **This machine:** checked by name only, without reading any value. `PERPLEXITY_API_KEY` is not set in the shell environment or the Windows user environment, and no `PERPLEXITY` entry is in `~/.claude/settings.json`. A mod has no key to read today.
- **How a mod reads it:** `$.env.get('PERPLEXITY_API_KEY')`. The [mods API page](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network) says to "write the name as a string literal". It does not say whether `$.env.get` sees variables set in the `env` block of `settings.json` or only the process environment. Issue #45's note gives the alternative of a `userConfig` field with `"sensitive": true`.

## Can `$.http.fetch` reach it?

Yes. The [mods API page](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network) says `$.http.fetch(url, init)` works "over `http` or `https`" and resolves to `{ status, ok, headers, text }` once the body is read. Its access is "the same permissions as the user running Claude Code". The page names no host allowlist. Every call is itself an `http.fetch` event, so an earlier mod, such as an organization's policy mod, can observe, rewrite or refuse it. The page shows no timeout option for `$.http.fetch`. For long-running work it points to `next.signal`, an `AbortSignal`, but it does not say that `fetch` accepts a signal.

## Compared with JEV (#45)

| | JEV | Perplexity Agent API |
|---|---|---|
| Output | Probabilities only (yes/no, choice, score) | Free text, so it can write the ~10-word label |
| Cost per ~200-token call | ~$0.0000084 | ~$0.0000275 (~3x) |
| Latency | 70–500 ms (vendor figure) | Not published |
| Rate limit | 80 req/s | 1 QPS at Tier 0, 3 QPS at Tier 1 |
| Key on this machine | Not set | Not set |

JEV is cheaper and has a published latency, but it cannot write a label. It can only pick from labels the mod supplies. Perplexity's Decisions API is the same kind of tool at $0.02/M input with output free, about $0.000004 per call. For free text, the Agent API with no tools is the Perplexity route. It costs the same as `$.model.complete({ model: 'haiku' })` on Haiku 5.5, which #45 put at ~$0.00003 and which needs no extra key.
