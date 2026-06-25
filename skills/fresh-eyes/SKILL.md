---
name: fresh-eyes
description: Fresh-context audit of a finished diff against the conversation's stated intent. A subagent with zero conversation history reviews the diff blind — reporting what it believes the change does, its quality, and any oversights — then the main context reconciles that blind read against what the work was actually meant to do. Use when a chunk of work is complete and you want fresh eyes to confirm nothing was missed, scope is fully covered, and no oversights or bugs slipped through, before moving on or shipping.
---

# fresh-eyes

Audit a finished diff with fresh eyes. The mechanism is **double-blind reconciliation**:
a subagent that never saw the conversation reads the diff blind and reports what it
*thinks* the change does. The main context — which holds the real intent — compares
that blind read against what the work was meant to do. The divergence is the signal.

Not *only* a bug-hunt. The primary lens is completeness and intent — did the change do
what it was meant to, fully. Catching bugs and oversights is a secondary byproduct of
that check, welcome but not the goal. For a dedicated correctness sweep, use
`/code-review` or `/codex review` instead.

## Workflow

Run these steps in order. Do not skip step 1 — it is the integrity gate.

1. **Pre-register intent (BEFORE any review).** Write down, in the conversation, a
   short brief: *what we set out to do, what is in scope, what is out of scope.* This
   must happen before reading the blind report, or the main context will rationalize
   the blind read into false agreement and the signal is lost. Show it to the user.

2. **Capture the change to audit.** Try these sources in order; use the first that
   yields a non-empty change:
   - **Override arg** (if given): a commit range, `--staged`, or an explicit path.
   - **Git, uncommitted:** working changes exist → `git diff HEAD`.
   - **Git, branch vs base:** no uncommitted changes → `git diff <base>...HEAD`, where
     `<base>` is the repo's default branch (resolve via
     `git symbolic-ref refs/remotes/origin/HEAD`, fall back to `main` then `master`, or
     ask the user if none resolve).
   - **Fallback — no git / not a repo / empty diff:** reconstruct the change from THIS
     session. Collect the files you created or edited this session and assemble their
     content (or a synthetic before/after diff) as the material to review. This is the
     common case for changes that were never committed to git. If you cannot reconstruct
     it, ask the user to point at the changed files or paste the diff — do not guess.

   Whatever the source, the output of this step is a concrete diff or set of changed
   files to hand to the blind agent in step 3 — never the conversation itself.

3. **Spawn a fresh-context subagent (the Agent tool, `general-purpose` or `Explore`).**
   Give it ONLY the diff or changed files from step 2 — never conversation history,
   even when the change was reconstructed from this session. Its blind read is the point.
   See [REFERENCE.md](REFERENCE.md) for the exact subagent prompt. It must report:
   - What it believes this change does / fixes / builds.
   - How well it is implemented (clarity, structure, tests).
   - Oversights, bugs, missed edge cases, and shadow paths (nil / empty / error inputs).

   If the subagent fails, times out, or returns nothing usable, retry once. If it still
   fails, tell the user and stop — never fabricate a blind read to fill the gap.

4. **Reconcile.** Compare the blind report against your pre-registered intent.
   Where the agent's understanding diverges from what you meant = dropped scope, or an
   implementation that does not express the intent. That divergence is the headline.

5. **Report** using the template in [REFERENCE.md](REFERENCE.md): Intended → Delivered →
   Divergences → Left to do (in scope) → Leftovers (out of scope) → Oversights/bugs →
   Verdict (`DONE` / `DONE_WITH_CONCERNS` / `GAPS`).

6. **Decide what happens next.**
   - If `--fix` or `--iterate` was passed, proceed into that mode now (see Modes).
   - If neither flag was passed, STOP and ask the user whether to fix the in-scope gaps,
     run the bounded iterate loop, or leave it as a report. Modify nothing until they
     choose — the report alone never edits code.

## Modes

The fix behavior is gated on explicit flags. If neither `--fix` nor `--iterate` is
passed, the skill does NOT modify anything — it reports, then asks (step 6).

- **(no flag) — report only.** Produce the report and stop. Strictly read-only.
- **`--fix`.** After the report, fix the in-scope gaps, then re-audit once.
- **`--iterate`.** Fix-and-re-audit loop, bounded to **3 rounds max**. End with a final
  overview: what was implemented, what remains in scope, what is deferred out of scope.
  See [REFERENCE.md](REFERENCE.md) for the loop.

## Guardrails

- Never feed the intent to the blind agent. A contaminated read is worthless.
- Only `--fix`/`--iterate`, or explicit user approval at step 6, may modify the tree.
  With no flag and no approval, the skill is strictly read-only.
- One blind agent is enough for most diffs. For a large or high-stakes diff, fan out
  2–3 with distinct lenses (does-it-work / completeness / bugs-and-edge-cases) and
  reconcile all of them — see [REFERENCE.md](REFERENCE.md).

## Relationship to other skills

`/review` checks scope but in-context. `/codex review` is fresh but intent-blind.
`fresh-eyes` is the union: fresh context AND intent reconciliation. A sibling
plan-preflight skill (cold read of a plan before implementation) may follow; this
skill stays diff-only.
