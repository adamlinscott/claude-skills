# How agent model and effort settings resolve

Research for issue #19 (wayfinder map #18). Sources are the official Claude Code docs, fetched 2026-10-05. Pages were read through a fetch tool that summarises them, so quotes are as returned by that tool; re-check wording before relying on it for anything load-bearing.

Sources:
- Sub-agents: https://code.claude.com/docs/en/sub-agents
- Skills: https://code.claude.com/docs/en/skills
- Model config: https://code.claude.com/docs/en/model-config
- Env vars: https://code.claude.com/docs/en/env-vars
- Settings: https://code.claude.com/docs/en/settings

## 1. Model: what overrides an agent's frontmatter `model`

Documented order when Claude invokes a subagent (sub-agents page, "Model resolution order"):

1. Per-invocation `model` parameter
2. Agent frontmatter `model` (`inherit` selects the main conversation's model)
3. `CLAUDE_CODE_SUBAGENT_MODEL`
4. Main conversation's model

So a pinned frontmatter `model` beats `CLAUDE_CODE_SUBAGENT_MODEL` and the session `/model`. Before v2.1.251 the env var came first and overrode both; the order above applies from v2.1.251.

To force the env var over frontmatter, set both `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+). Forks and skills with `model: inherit` ignore the force setting. The model-config page agrees: the env var applies to agents "not assigned a model another way", and a per-invocation model or definition `model` takes precedence.

Other points:
- A family alias (`opus`) in frontmatter resolves to the main conversation's exact model if it is in that family; an alias in the env var always resolves to the alias's own version.
- Values blocked by the org `availableModels` allowlist fall back (newest allowed version of the family, else the inherited model).
- Subagents inherit the session's extended-thinking setting (v2.1.198+); there is no per-agent thinking setting.
- The env-vars page also mentions a `subagentModel` setting, which the env var overrides. Its position relative to frontmatter is not stated there.

## 2. Effort: what overrides an agent's frontmatter `effort`

Session effort resolution (model-config page, "Effort level precedence order"), first match wins:

1. Explicit choice: `CLAUDE_CODE_EFFORT_LEVEL`, then `--effort`, then `/effort`
2. Settings: per-model `modelSettings`, then top-level `effortLevel`
3. Skill and subagent frontmatter `effort`
4. Model default (`high` on most; `medium` on Opus 5.5 and Sonnet 5.5; `xhigh` on Opus 4.7)

Read literally, frontmatter `effort` sits below the env var, `/effort`, and `effortLevel`, so those would beat an agent's pinned effort. This is the opposite of model, where frontmatter beats the env var and `/model`.

The sub-agents page says the agent's `effort` "overrides the session effort level for that subagent", and the skills page says the same for skills. That conflicts with the literal reading above. See "Unconfirmed".

`CLAUDE_CODE_EFFORT_LEVEL` (env-vars page) takes precedence over `--effort`, `/effort`, `modelSettings` and `effortLevel`, and also accepts `auto` (model default). A `maxEffortLevel` setting caps it.

## 3. Skill with `context: fork` + `agent: <name>`

Documented:
- Claude Code starts a new subagent of the type in `agent` and gives it the skill content as its prompt.
- With `context: fork`, the skill's `model` "sets the forked subagent's model instead" of the session's. The skill's `effort` is documented as "Overrides the session effort level".
- Without fork, the skill's model override lasts only for the current turn.

Not documented: an explicit statement of what wins when both the skill and the named agent set `model` or `effort`. The fetch tool's summary concluded the skill wins, but that is an inference from the first bullet, not a quoted rule. The only quoted sentences say the skill value replaces the session's, and say nothing about the agent file's value.

## 4. Project vs user agent with the same name

Documented priority, highest first (sub-agents page): managed settings, `--agents` CLI flag, project `.claude/agents/`, user `~/.claude/agents/`, plugin `agents/`. The project agent wins over the user agent. Among nested project `.claude/agents/` directories, the one closest to the working directory wins. Two files with the same name inside one scope directory: one is loaded, chosen by filesystem order (not documented precedence); `/doctor` reports duplicates.

## 5. Effort clamping per model

Documented (model-config page):
- Fable 5.1/5, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5: `low`, `medium`, `high`, `xhigh`, `max`
- Opus 4.6, Sonnet 4.6: `low`, `medium`, `high`, `max` (no `xhigh`)
- Haiku is not listed; the page says Haiku does not support effort levels.
- Unsupported level: "Claude Code falls back to the highest supported level at or below the one you set" (for example `xhigh` runs as `high` on Opus 4.6).

So effort is clamped down, not rejected. For Haiku the docs only say it is unsupported; they do not say whether a set value is ignored silently or errors.

## Unconfirmed

1. Fork + agent, both set `model` or `effort`: no explicit rule found. The skill likely wins (inferred), not confirmed. Needs a live test with a skill and agent that pin different values, then checking the model the subagent reports.
2. Agent frontmatter `effort` versus `/effort`, `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel`: the model-config precedence list and the sub-agents/skills "overrides the session" wording disagree. Which governs a subagent is unconfirmed; it may be that the list describes the session level and frontmatter applies on top for the subagent.
3. Position of the `subagentModel` setting relative to frontmatter: not stated.
4. Haiku with an `effort` value set: behaviour (ignored vs error) not documented.
5. Doc text came via a summarising fetch tool, not raw page text; the settings-reference `effortLevel` entry was not read directly.
