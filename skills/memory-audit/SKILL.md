---
name: memory-audit
description: Audit Claude's per-user memory for this project and produce a report. Asks at the start whether the user wants a non-technical summary or a full technical audit. Never edits memory — produces a report only. Usage: /memory-audit
allowed-tools: Read, Grep, Glob, Bash, AskUserQuestion
---

You are running a memory audit for the user's per-user Claude memory in this project.

**Hard rule: this skill produces a report only. Do not edit, rename, move, or delete any memory file. If the user wants
to act on findings, that is a separate follow-up turn after they review the report.**

This skill focuses on the internal health of the memory directory itself. For how memory interacts with the wider
repo — conflicts with CLAUDE.md, rules that never reach subagent prompts, broken doc links — see `/context-audit`.

## Step 1 — Ask the user which report style they want

Before reading anything, call `AskUserQuestion` with:

- **question:** "What kind of memory audit would you like?"
- **header:** "Report style"
- **multiSelect:** false
- **options:**
    - **label:** "Non-technical summary"
      **description:** "Plain-English overview for project management or non-engineering review. Each remembered item is
      described in everyday language with a clear recommendation."
    - **label:** "Technical audit"
      **description:** "Full engineering audit: classification, stale-reference checks, orphaned files, and structural
      smells. For engineers maintaining the memory."

Wait for the answer before continuing. The user's choice determines the report format in Step 5.

## Step 2 — Resolve the memory directory

The memory directory lives at `~/.claude/projects/<encoded-cwd>/memory/`, where the encoded form replaces drive colons
and path separators with `-`.

Reliable way to find it: list `~/.claude/projects/` and pick the directory whose decoded name corresponds to the current
working directory. On Windows the path will look like `C:\Users\<user>\.claude\projects\C--Users-<user>-...\memory\`.

If the directory does not exist, stop and tell the user: "No memory has been recorded for this project yet — there is
nothing to audit."

## Step 3 — Read everything

- Read `MEMORY.md`.
- Read every `.md` file in the directory — both those the index points to and any that are not indexed. Do not assess a
  memory you have not read.
- For each memory, note its declared `type` from frontmatter (one of: user / feedback / project / reference).
- List the directory contents and identify:
    - Files in the directory **not indexed** in `MEMORY.md`
    - Index entries pointing to **files that don't exist**

## Step 4 — Verify references against current code

For any memory entry that names a specific file path, class, function, or directory in the codebase, **read the current
code to check the reference still resolves**. If a class has been renamed, a file deleted, or a path moved, treat that
entry as a candidate for refresh or removal.

Do not guess. If the entry says "the `XyzService` does …", actually search the code for `XyzService`.

## Step 5 — Produce the report

### If the user picked "Non-technical summary"

Write for a non-engineer reading this for project-management purposes. No jargon, no file paths, no markdown class names
in backticks.

For each memory, produce a short block in this shape:

#: Memory number
**Memory:** One plain-English sentence describing the rule or fact.
**Why it was added:** The original reason, in everyday language. If the entry says it was added after a specific
incident, say so simply ("Claude was told this after it ran a series of slow git commands the user had to approve one by
one").
**Still useful?:**  One of: *Yes*, *Probably*, *Maybe not*, *No longer*. Add one short sentence explaining your
judgment.
**Recommendation:** One of: *Keep* / *Discuss with the team* / *Remove*.
────────────────────────────────────────

After all entries, write a short overall summary in 3–5 sentences:

- How many memories there are
- Whether the set looks healthy or cluttered
- Any patterns worth raising with the team (for example: a lot of "don't do X" rules, or several overlapping rules
  covering the same situation)

End the report with this exact line on its own:

> *Want the full engineering breakdown — code verification, classification rules, and structural analysis?
Run `/memory-audit` again and choose "Technical audit".*

### If the user picked "Technical audit"

Produce a full audit. For each memory entry, classify it as exactly one of:

- **Keep** — durable, applies broadly across tasks, not derivable from code or docs
- **Move** — real rule but situational; should live in `docs/`, in a `.claude/agents/<name>.md` subagent prompt, or in
  `CLAUDE.md` rather than in always-on memory
- **Refresh** — references files/classes/paths that have rotted; either update the entry or flag the discrepancy
- **Merge** — overlaps another entry and they should be combined
- **Drop** — situational one-off, no general principle, low signal-to-noise

For each entry include:

- Its name and file
- The classification with one-sentence rationale
- For any code reference: whether it still resolves (verified by reading the code)

After the per-entry list, report:

- **Orphans:** files in the memory dir not in `MEMORY.md`, and index entries pointing to missing files
- **Type sanity:** does each entry's body match its declared `type`? A `reference` entry should point to a resource
  that still resolves (verify the URL or path); a `project` entry should use absolute dates, not "last week" / "recently";
  a `feedback` entry should carry both a *why* and a *how to apply*. Flag mismatches.
- **Prohibition ratio:** count of entries whose rule is a "don't / never / avoid / stop" against total entries. If
  above ~60%, call this out as a memory-as-corrections-log smell — memory is meant to shape behavior, not log every past
  mistake.
- **Justification quality:** entries whose "Why" is a single past incident with no general principle — usually
  candidates for *Move* or *Drop*.
- **Topic clustering:** if several entries pile into one narrow workflow (e.g. one investigation), suggest collapsing
  them into a single doc or subagent prompt.

If any of the memories are classified not as "Keep", end the technical report with a prioritised action list: which
entries to address first, and whether the recommended
next step is editing the entry, moving it elsewhere, or dropping it.

## After the report

Stop after delivering the report. Do not begin editing memory. If the user asks you to act on findings, treat each edit
as a separate operation and confirm before writing.