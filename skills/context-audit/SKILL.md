---
name: context-audit
description: Audits a repository's Claude context-injection setup — CLAUDE.md, CONTEXT.md, docs/, .claude/agents/, and the per-project memory directory. Reports bloat, broken links, orphaned docs, security risks, missing rules in subagent prompts, and conflicts between memory and project instructions. Use when the user asks to audit their Claude setup, asks "what's wrong with my CLAUDE.md", wants to know if their agents/memory/docs are configured well, or wants to improve Claude's effectiveness in this repository.
---

# Context audit

Audit the context that gets injected into every Claude session in the current repository. The goal: identify everything that could be working against the agent — security risks, conflicts, bloat, orphaned docs, broken links, and rules that exist in memory but never reach subagents.

Read-only. Print one markdown report. Do not modify any files.

## What to read

1. **`CLAUDE.md`** at the repo root, plus any nested `CLAUDE.md` files (`Glob "**/CLAUDE.md"`).
2. **`CONTEXT.md`** at the repo root and anywhere it appears.
3. Everything under **`docs/`** (`Glob "docs/**/*.md"`).
4. Every agent file under **`.claude/agents/`** (`Glob ".claude/agents/*.md"`) — note each agent's `description`, `tools` frontmatter, and body.
5. The repo's **`.claude/settings.json`** and **`.claude/settings.local.json`** if present.
6. The repo's **per-project memory directory**. Derive its path:
   - Take the absolute repo path (`pwd`).
   - Replace `:` with nothing, then replace every `/` and `\` with `-`.
   - The directory is `~/.claude/projects/<encoded-path>/memory/` (on Windows: `C:\Users\<user>\.claude\projects\<encoded-path>\memory\`).
   - The index is `MEMORY.md`; sibling `.md` files are individual memories.
   - If the directory does not exist, note that no per-project memory has been set up and continue.

## What to check

### Security
- "Don't ask permission" / "just do it" / "no need to confirm" instructions that bypass the permission system. Flag and recommend using `.claude/settings.json` allowlists instead.
- Hard-coded credentials, API keys, tokens, or secrets in any context file.
- Instructions that authorise irreversible operations (push, force-push, delete, deploy, post-to-external) without confirmation.
- Overly broad tool access in agent frontmatter (`tools: *`, `tools: All tools`) when the agent's role doesn't justify it.
- Agents that can write/edit and also have network egress (`WebFetch`, vendor MCPs) without scoping.

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
- Doc files whose age (file mtime) is more than ~90 days old AND that name specific code symbols — recommend verification against current state.

### Documentation coverage
- Top-level source modules, packages, or services (whatever the repo's layout calls them) without a `README.md` — note as a coverage gap, not a hard issue.
- Topic or domain docs under `docs/` that CLAUDE.md does not reference under any documentation-pointers section — the agent won't know to read them.
- A `CLAUDE.md` that lacks an explicit "read the relevant docs before planning or coding" directive — flag this; without it, agents skip docs even when pointers exist.

## Report format

Print one markdown report to stdout. Group findings by severity (highest first). Within each section, one bullet per finding. Each finding must include: severity tag, the file path (and line number where applicable), a one-line root cause, and a concrete fix.

```
# Context audit — <repo name> (<absolute path>)

Read: CLAUDE.md, CONTEXT.md, N docs files, M agent files, K memory files.

## Security
- **[risk]** `CLAUDE.md:378` — "Don't ask permission" instruction. Bypasses the permission system. Fix: remove; use `.claude/settings.json` tool allowlist instead.

## Conflicts
- **[conflict]** `memory/feedback_X.md` vs `.claude/agents/<coding-agent>.md:120` — memory says A, agent says B. Decide which is correct and align.

## Missing rules in subagents
- **[gap]** `memory/feedback_<rule>.md` — universal rule, not in `<coding-agent>.md`. Every subagent session starts blind to this. Fix: add a rule body to the agent prompt under Coding guidelines.

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
N findings — S security, C conflicts, G subagent gaps, B bloat, L broken/orphan, T stale, D coverage.
Highest priority: <one-line recommendation>.
```

## Output behaviour

- Read-only. Do not edit files. Do not write the report to disk.
- Print the full report to stdout.
- If a section has zero findings, omit it entirely — don't list "Security: none".
- End with a Summary line giving counts and the single highest-priority recommendation.
- Do not propose to "apply the fixes" — the audit is purely diagnostic. The user reads it and decides.