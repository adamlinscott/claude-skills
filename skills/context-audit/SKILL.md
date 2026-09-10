---
name: context-audit
description: '[Adam Skills] Audits a repository''s Claude context-injection setup — CLAUDE.md, CONTEXT.md, docs/, .claude/agents/, and the per-project memory directory. Reports bloat, broken links, orphaned docs, security risks, missing rules in subagent prompts, and conflicts between memory and project instructions. Use when the user asks to audit their Claude setup, asks "what''s wrong with my CLAUDE.md", wants to know if their agents/memory/docs are configured well, or wants to improve Claude''s effectiveness in this repository.'
allowed-tools: Read, Grep, Glob, Bash
---

# Context audit

Audit the context that gets injected into every Claude session in the current repository. The goal: identify everything that could be working against the agent — security risks, conflicts, bloat, orphaned docs, broken links, and rules that exist in memory but never reach subagents.

Read-only. Print one markdown report. Do not modify any files. (The skill is granted no edit tools, so this is enforced, not just asked.)

**Scope note.** This is a whole-setup audit. For a deep, classification-based review of the memory directory on its own (Keep / Move / Refresh / Merge / Drop), defer to `/memory-audit`. Here, assess memory only where it interacts with the rest of the context: conflicts, subagent gaps, and stale references.

## What to read

1. **`CLAUDE.md`** at the repo root, plus any nested `CLAUDE.md` files (`Glob "**/CLAUDE.md"`).
2. **`CONTEXT.md`** at the repo root and anywhere it appears.
3. Everything under **`docs/`** (`Glob "docs/**/*.md"`).
4. Every agent file under **`.claude/agents/`** (`Glob ".claude/agents/*.md"`) — note each agent's `description`, `tools` frontmatter, and body.
5. The repo's **`.claude/settings.json`** and **`.claude/settings.local.json`** if present.
6. The repo's **per-project memory directory** (Claude's per-user memory, scoped to this repo). To locate it reliably, list `~/.claude/projects/` and pick the directory whose name is the current repo path with every `:`, `/`, and `\` replaced by `-` (e.g. `C:\Users\me\proj` → `C--Users-me-proj` — note the double dash where `:` meets `\`). Match against the actual listing rather than hand-building the path from a guessed rule.
   - The index is `MEMORY.md`; sibling `.md` files are individual memories. Read all of them, including any not listed in `MEMORY.md`.
   - Note each memory's declared `type` (user / feedback / project / reference) from its frontmatter.
   - If the directory does not exist, note that no per-project memory has been set up and continue.

## What to check

### Security
- "Don't ask permission" / "just do it" / "no need to confirm" instructions that bypass the permission system. Flag and recommend using `.claude/settings.json` allowlists instead.
- Hard-coded credentials, API keys, tokens, or secrets in any context file.
- Instructions that authorise irreversible operations (push, force-push, delete, deploy, post-to-external) without confirmation.
- Overly broad tool access in agent frontmatter (`tools: *`, `tools: All tools`) when the agent's role doesn't justify it.
- Agents that can write/edit and also have network egress (`WebFetch`, vendor MCPs) without scoping.
- In `.claude/settings.json` / `.claude/settings.local.json`: a repo-wide `defaultMode` of `bypassPermissions` (or broad `acceptEdits`), an over-broad permission allowlist (e.g. `Bash(*)`, `Bash(rm *)`, `Bash(curl *)`), or `hooks` that run unreviewed shell commands. Flag each with the specific risk it creates.

### Conflicts
- A memory feedback rule that directly contradicts a rule in CLAUDE.md or an agent prompt.
- Two agents claiming overlapping responsibility without a delegation hint distinguishing them.
- CLAUDE.md and an agent file disagreeing on the same convention (naming, testing, error handling, etc.).
- Memory feedback files whose claims contradict each other.

### Missing rules in subagents (the big one for AI-quality)
Subagents do **not** see the user's memory files — they only see their own system prompt. For each memory feedback item that states a universal coding/style rule (not a personal preference, not agent-behaviour governance), check whether the project's coding agent (whatever the repo names it under `.claude/agents/`, e.g. `coder.md` or `builder.md`) has an equivalent rule in its body. If not, flag as a gap — every fresh subagent invocation will re-violate it.

Distinguish:
- **Universal rules** worth promoting to the subagent (naming conventions, error-handling requirements, no-unilateral-interface-changes, etc.) — flag the gap.
- **Personal style preferences** the user has explicitly classified as their own (preferred idioms, formatting choices, etc.) — do not flag.
- **Agent-behaviour rules** (e.g. "don't run deep git archaeology", "don't pipe tool output through ad-hoc scripts") — memory is the correct home; do not flag.

### Legacy prompting patterns

Instructions age badly. Each Claude generation ships with its own prompting notes, and some of
that advice **inverts** — a line that fixed a real problem two model releases ago now causes the
opposite one. Nobody goes back and deletes those lines, so a mature `CLAUDE.md` accumulates them,
and they are invisible precisely because they used to work.

Flag each of the following, quoting the line and saying what it now causes:

- **Mandated self-verification** — "double-check your answer", "always re-verify before
  responding", "include a final verification step for any non-trivial task", "use a subagent to
  verify your work". Current models self-check; the instruction compounds with that and spends
  extra passes on work that was already correct. Fix: delete rather than reword.
- **Anti-laziness and thoroughness prompting** — "always be thorough", "if in doubt, use
  \<tool\>", "default to using \<tool\>", "read as many files as you can before answering". Written
  when tools under-triggered. They now over-trigger. Fix: narrow to when the tool actually helps
  ("use \<tool\> when it would clarify the problem"), or delete.
- **Shouted emphasis** — `CRITICAL:`, `YOU MUST`, `NEVER EVER`, ALL-CAPS imperatives, and
  emphasis stacked on ordinary instructions. Models are far more responsive to the system prompt
  than the generation these were written for, so the volume now buys over-triggering rather than
  compliance. Fix: normal prose — "Use this when…" instead of "CRITICAL: You MUST use this
  when…".
- **Conservatism filters on review instructions** — "only report high-severity issues", "be
  conservative", "don't flag minor problems". Taken literally, these make the model report *less*
  rather than judge better, and the findings lost are the marginal ones a human would have wanted
  to see. Fix: ask for everything, ranked, and filter in a separate pass.
- **Mandated subagent fan-out** — "always delegate to subagents", "spawn an agent per module",
  "use parallel agents for exploration". Models now delegate readily on their own; the standing
  advice is to damp it. Fix: state when delegation *is* warranted, or delete.
- **Blanket anti-formatting blocks** — long "never use bullet points / headers / bold" sections.
  Written against models that over-formatted. Newer ones under-format, and a block like this
  suppresses structure the content needed. Fix: replace with a rule about when formatting helps.
- **Narration suppression** — "hold all findings for the final response", "do not comment
  between tool calls". These now produce an agent that goes silent for minutes. Fix: say what a
  good update looks like instead.
- **Stale model identifiers**, in context files *and* in code the docs point at — `claude-3-*`,
  `claude-*-4-5`, or any pinned model string that is no longer current. Also flag `budget_tokens`
  and manual extended-thinking config, which is deprecated in favour of effort. Verify against
  the `claude-api` skill or current docs rather than from memory; do not assert an ID is stale
  without checking.
- **Instructions not to think or reason.** Rare, but worth catching: they increase internal-tag
  leakage into visible output rather than reducing reasoning. Fix: delete; control cost with
  effort instead.

**Do not flag a safety gate as over-emphasis.** This is the failure mode of this whole section,
and it is worse than the problem it solves. "Never publish without explicit confirmation", "never
force-push", "always show the user the finished text before filing" are load-bearing controls on
irreversible or externally-visible actions, and their emphasis is doing real work. The test is
what the line protects: emphasis on **an irreversible or outward-facing act** stays; emphasis on
**an ordinary working instruction** is the thing to dial down. When you are unsure which one you
are looking at, leave it and say why.

State plainly at the top of this section which model generation's guidance you are applying, and
that these are calibrations rather than errors — the lines were correct when written.

### Bloat
- CLAUDE.md sections over ~20 lines covering a single domain that most sessions don't touch. Recommend moving the detail to `docs/<domain>/` and replacing with a one-line pointer.
- Repeated explanations of the same concept across CLAUDE.md, agent files, and docs.
- CLAUDE.md over ~400 lines total — every session pays the token cost.
- Agent prompts over ~800 lines that include content most invocations won't use.

### Broken or missing links
- Files referenced from CLAUDE.md or an agent file that do not exist on disk (`Glob` to verify each citation).
- Docs under `docs/` that no CLAUDE.md, agent file, or README references (orphaned).
- Bidirectional back-references between CLAUDE.md and docs ("see CLAUDE.md §X" inside a doc that CLAUDE.md already points to) — pick one direction; the doc should be the source of truth and CLAUDE.md should link to it, not vice versa.

### Stale or inaccurate context
- Memory files that cite specific file paths, classes, or symbols. For each citation, `Glob` or `Grep` to verify it still exists. Flag stale ones.
- Doc files that name specific code symbols and look stale (e.g. file mtime over ~90 days — a weak signal, since clones reset mtimes; prefer `git log -1 --format=%cs -- <file>` where git is available). Recommend verifying against current state rather than asserting staleness.

### Documentation coverage
- Top-level source modules, packages, or services (whatever the repo's layout calls them) without a `README.md` — note as a coverage gap, not a hard issue.
- Topic or domain docs under `docs/` that CLAUDE.md does not reference under any documentation-pointers section — the agent won't know to read them.
- A `CLAUDE.md` that lacks an explicit "read the relevant docs before planning or coding" directive — flag this; without it, agents skip docs even when pointers exist.

## Report format

Print one markdown report to stdout. Use the sections below, ordered roughly by severity (highest first). Within each section, one bullet per finding. Each finding must include: severity tag, the file path (and line number where applicable), a one-line root cause, and a concrete fix.

```
# Context audit — <repo name> (<absolute path>)

Read: CLAUDE.md, CONTEXT.md, N docs files, M agent files, K memory files.

## Security
- **[risk]** `CLAUDE.md:378` — "Don't ask permission" instruction. Bypasses the permission system. Fix: remove; use `.claude/settings.json` tool allowlist instead.

## Conflicts
- **[conflict]** `memory/feedback_X.md` vs `.claude/agents/<coding-agent>.md:120` — memory says A, agent says B. Decide which is correct and align.

## Missing rules in subagents
- **[gap]** `memory/feedback_<rule>.md` — universal rule, not in `<coding-agent>.md`. Every subagent session starts blind to this. Fix: add a rule body to the agent prompt under Coding guidelines.

## Legacy prompting patterns
Calibrated against <model generation> guidance. These were correct when written.
- **[legacy]** `CLAUDE.md:112` — "always double-check your work before responding". Current models self-verify; this adds passes over work already correct. Fix: delete.
- **[legacy]** `.claude/agents/<agent>.md:8` — "CRITICAL: You MUST use the search tool". Over-triggers now. Fix: "Use the search tool when…".

## Bloat
- **[bloat]** `CLAUDE.md:320-336` — 17-line section relevant to ~5% of sessions. Fix: move to `docs/<topic>/<detail>.md` and replace with a one-line pointer.

## Broken or missing links
- **[broken]** `CLAUDE.md:30` references `<module>/README.md` — file does not exist.
- **[orphan]** `docs/<topic>/<doc>.md` exists but no CLAUDE.md or agent references it.

## Stale or inaccurate context
- **[stale]** `memory/feedback_Y.md:14` cites `OldSymbolName` — no longer exists; replaced by `new-symbol`.

## Documentation coverage
- **[gap]** `<module>/` has no `README.md` and no `docs/<topic>/` reference in CLAUDE.md.

## Summary
N findings — S security, C conflicts, G subagent gaps, P legacy prompting, B bloat, L broken/orphan, T stale, D coverage.
Highest priority: <one-line recommendation>.
```

## Output behaviour

- Read-only. Do not edit files. Do not write the report to disk.
- Print the full report to stdout.
- If a section has zero findings, omit it entirely — don't list "Security: none".
- End with a Summary line giving counts and the single highest-priority recommendation.
- Do not propose to "apply the fixes" — the audit is purely diagnostic. The user reads it and decides.

**Report everything you find, ranked — do not apply a severity filter.** A setup audit is read
once, by someone deciding what to change; the marginal findings are exactly the ones they can
weigh and you cannot. Rank honestly by severity and let them draw the line. Suppressing the small
stuff does not make the report sharper, it makes it shorter and less useful.

**One finding, one bullet.** Each is a path, a one-line cause, and a concrete fix — three lines
at most, and usually one. Do not expand a finding into a paragraph explaining the principle
behind it, do not restate the same finding under two sections, and do not add a closing
commentary after the Summary. This report scales with the number of problems found, and a clean
setup should produce a short page. A long report about a healthy repo is a failure of the audit,
not a thorough one.