---
name: reground
description: Halt a drifting agent and re-anchor it to codebase evidence for the current task, clearing speculative context without a full compaction. Use when the agent has gone off course, hallucinated files/APIs/behavior, or started over-building beyond what was asked — or when the user types /reground or says "stop", "re-ground", "re-crown", "I don't see evidence for that", or "you're building something we don't need".
---

# Reground

The current session has drifted: the recent work rests on assumptions the codebase
has not been shown to support, invents systems that may not exist, or builds past
what the task needs. This skill is a hard reset to ground truth. It does not summarize
or compact — it **discards the speculative thread** and rebuilds a small, evidence-backed
footing for the next step. Run the protocol in order. Do not skip ahead to step 5.

## 1. Halt

Stop immediately. Make no further `Edit`, `Write`, or other tool calls that advance the
work until the report in step 5 is produced and the user approves a next step.

Before reporting, make sure the working tree is in a coherent state — **never leave a file
half-written or a multi-file change partly applied.** If a change is mid-flight, the only
edits permitted here are the minimal ones that restore a self-consistent, non-broken state,
or a clean revert of it; make no new feature progress either way. The aim is solid footing
to assess from, not a frozen half-edit.

## 2. Name the drift

State plainly, in one or two sentences, the specific unverified assumption(s) the recent
work depended on — the equivalent of "the last answer assumed X, but the repo shows no
evidence for X." Be concrete: name the assumed file, function, endpoint, schema, or
behavior. If you cannot name what was assumed, that itself is the finding — say so.

## 3. Set the anchor

Decide the focus file set — the minimum slice of the repo the next step actually depends on:

- **If the user passed paths or class/function/object names** (as arguments or in their message), use exactly those.
- **Otherwise, self-derive them** from the stated task: list the files/paths you intend
  to read and *why each one matters*, then read them. Keep the set small and task-scoped;
  do not sweep the whole repo. If the right anchor is genuinely unclear, ask the user for
  the paths rather than guessing.

## 4. Read the anchor, nothing else

Read those files now. Treat **only what is on disk** as true. Do not fill gaps with memory,
convention, or inference about code you have not opened. If something the task seems to need
is absent, that is an "unknown," not a thing to assume into existence.

## 5. Report — use this exact structure

- **Proven** — what the existing code establishes, each claim with a `file:line` citation.
- **Unknown** — what the task needs but the read code does not settle; open questions.
- **Smallest next change** — the single smallest change that follows from the evidence
  above. Not a plan for the whole feature — the next concrete step only.
- **Basis** — the exact files, functions, and endpoints this is grounded in.

From this point, the report is the working ground truth. Disregard any earlier assumption
not restated in it.

**Assess honestly — do not defend the work already done.** Treat what was just written as
suspect by default, held to the same evidentiary standard as everything else. "The
implementation is actually fine / in line with the task" is a claim that needs `file:line`
proof like any other — it is never the default conclusion, and it must **not** be reached
by reframing the user's concern as a mere misunderstanding of some underlying feature. If
the recent change cannot be grounded in the read code, it is part of the drift, not vindicated.

## Hard constraints

- **Do not invent missing systems.** If a service, table, or module is not in the read
  code, it does not exist for the purposes of this step.
- **Do not add fallbacks** or defensive branches for conditions the evidence does not show.
- **No placeholders, stubs, or mock data** unless the user explicitly approves them.
- **Wait for approval** before resuming implementation. The output of this skill is the
  report, not a resumed edit.
