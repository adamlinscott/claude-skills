# What `/advisor` does in Claude Code

Research for issue #20 (map #18). Checked 2026-10-05 against the official docs. The changelog's only advisor entry is v2.1.287 (a pairing-check fix).

## Verdict on the tweet

| Claim | Verdict |
| --- | --- |
| Advisor is a Fable model | Partly. Fable is one allowed advisor, not the only one: `fable`, `opus`, `sonnet` or a full model ID, depending on the main model. |
| "Reads everything in the session" | Confirmed. "The advisor receives the full conversation, including every tool call and result." |
| "Stays silent unless something's wrong" | Refuted. It is a tool Claude calls, not a monitor. It runs only when the main model calls it, and the transcript shows an `Advising` line each time. Errors do not trigger it. |
| Speaks at plan time, on repeat failures, before "done" | Confirmed as a tendency, not a rule. Claude "tends to consult before committing to an approach, when an error keeps recurring, and before declaring a task done, but the timing is model-driven rather than rule-based." No setting caps or forces calls. |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` disables it | Confirmed. Set to `1`: `/advisor` unavailable, `advisorModel` ignored, `--advisor` accepted but no effect. |
| Auto-mode permission checks (issue's extra question) | Not found. No advisor mention on the advisor, settings, commands or env-var pages, and a search of the permission-modes and auto-mode pages returned nothing. Unconfirmed. |

## What it is

A server-side tool run on Anthropic's infrastructure, for subscription and API-billed accounts. The main model ("executor") consults a second, typically stronger model, then continues. Claude generally follows the advice but surfaces a conflict if its own evidence contradicts it. Experimental; "behavior, pricing, and availability may change."
Source: https://code.claude.com/docs/en/advisor

## When it runs

Only when Claude decides to call it. You can ask for it in a prompt ("consult the advisor before you continue"). Subagents inherit the advisor and apply the pairing check to their own model. Anthropic's API guide notes the executor "tends to under-call the advisor in some domains, particularly coding" and suggests system-prompt steering for about two to three calls per task.
Sources: https://code.claude.com/docs/en/advisor, https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

## How to enable

- `/advisor [model|off]`: no argument opens a picker; saves to `advisorModel` in user settings. Argument forms in `-p`, SDK, desktop and Remote Control need v2.1.260+.
- `advisorModel` setting (`"fable" | "opus" | "sonnet"` or full ID). Default unset, so off.
- `--advisor <model>`: one session; not listed in `--help`.

Sources: https://code.claude.com/docs/en/advisor, https://code.claude.com/docs/en/settings-reference#advisormodel, https://code.claude.com/docs/en/commands

## Pairing rules

The advisor must rank at or above the main model. Examples: Sonnet 5.5 main accepts Fable, Opus 5+, Sonnet 5.5; Opus 5/5.5 main accepts Fable and Opus 5+; Fable 5.1 main accepts only Fable 5.1. An advisor ranking below the main model is not attached. If the API refuses a pairing, Claude Code silently resends without the advisor. Haiku can call the advisor but cannot be one. Fable needs Fable access, and on some plans a one-time usage-credits consent via `/model fable`.
Source: https://code.claude.com/docs/en/advisor#choose-an-advisor-model

## Cost

- Each call: the advisor model reads the whole transcript at its own rates, on top of main-model usage. Its read is not cached between calls.
- API billing: advisor model's input and output rates. Subscription: counts toward plan limits; a Fable advisor bills to usage credits on plans where Fable does.
- Typical advisor output is 400-700 text tokens (1,400-1,800 including thinking), per the API docs.
- Toggling mid-session does not invalidate the main model's prompt cache.
- Advisor usage appears in `/usage`.

Sources: https://code.claude.com/docs/en/advisor#cost, https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#usage-and-billing

No per-call dollar figure is published; it depends on transcript length and model.

## Requirements and limits

- Anthropic API only: not Bedrock, Google's Agent Platform, Foundry or Claude Platform on AWS. Gateways work only if they forward the request intact.
- Gated by a fetched feature flag. With flag fetching disabled (for example `DISABLE_TELEMETRY`), the advisor stays off.
- The API tool is in beta (`advisor-tool-2026-03-01`).

## What turns it off

- `/advisor off` or "No advisor" in the picker (saved).
- Unset `advisorModel`.
- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`: hard off; `advisorModel` cannot turn it back on.

Sources: https://code.claude.com/docs/en/env-vars, https://code.claude.com/docs/en/advisor#turn-the-advisor-off

## Unconfirmed

- Any advisor role in auto-mode permission checks: no doc found mentions it.
- The tweet itself was not read; claims were checked as quoted in the issue.
- Real-world call frequency in Claude Code: docs say model-driven; no measured numbers.
- The Anthropic post "The advisor strategy" (https://claude.com/blog/the-advisor-strategy), linked from the docs, was not read.
