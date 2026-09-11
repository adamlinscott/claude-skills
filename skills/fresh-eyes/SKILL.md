---
name: fresh-eyes
description: '[Adam''s Skills] Fresh-context audit of a finished diff against the conversation''s stated intent. A subagent with zero conversation history reviews the diff blind — reporting what it believes the change does, its quality, and any oversights — then the main context reconciles that blind read against what the work was actually meant to do, and surfaces any assumption about real-world behaviour that the code cannot settle. Use when a chunk of work is complete and you want fresh eyes to confirm nothing was missed, scope is fully covered, and no oversights or bugs slipped through, before moving on or shipping.'
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

**Why this is not the verification pass you were told to delete.** Current prompting guidance
says to strip explicit verification instructions — "double-check your answer", "add a final
verification step", "use a subagent to verify" — because the model already self-checks and the
instruction compounds into wasted passes. That is correct, and it does not describe this skill.
Those instructions ask the *same* context to look at its own work again, which is the pass that
adds nothing. This skill's value is not the second look; it is that the second reader **has never
seen the conversation**, so it cannot inherit the premise the first reader was working from. That
is a different instrument, and no amount of self-checking substitutes for it. Keep the isolation;
it is the whole mechanism. What the guidance *does* bite on here is quantity — see the fan-out
guardrail below.

**Know what this instrument cannot see.** It measures the gap between two readings, so
it is blind to any error the two share. If the intent itself is wrong, a faithful
implementation of it produces zero divergence — the strongest possible pass. Agreement
is therefore evidence that the code expresses the intent, never evidence that the intent
was right. Steps 1, 3 and 4 exist to attack that blind spot directly; do not water them
down.

## Workflow

Run these steps in order. Do not skip step 1 — it is the integrity gate.

1. **Pre-register intent (BEFORE any review).** Write down, in the conversation, a
   short brief of what we set out to do. This must happen before reading the blind
   report, or the main context will rationalize the blind read into false agreement and
   the signal is lost. Split the brief in two:
   - **Asked** — what the user actually requested. In scope and out of scope.
   - **Derived** — everything else that ended up in scope: proposed by a prior review,
     by a subagent, or by your own inference. Tag each item with where it came from and
     what it rests on — a **domain fact** (someone knew how the world actually behaves)
     or **code shape** (the types, names, or structure suggested it).

   Keeping these apart is the point. A wrong premise almost never enters through the
   *Asked* list; it enters as a code-shape derivation that everyone downstream then
   treats as settled. Show the brief to the user.

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
   - **Assumptions about the world** the change depends on but cannot prove, including
     any behaviour it makes narrower or stricter.

   If the subagent fails, times out, or returns nothing usable, retry once. If it still
   fails, tell the user and stop — never fabricate a blind read to fill the gap.

4. **Reconcile.** Compare the blind report against your pre-registered intent.
   Where the agent's understanding diverges from what you meant = dropped scope, or an
   implementation that does not express the intent. That divergence is the headline.

   Then work the *Derived* list, which divergence alone will never flag. For each item
   tagged **code shape**, do not audit whether it was implemented correctly — re-derive
   it: state what would have to be true about the domain for it to be right, and whether
   anything in the diff actually establishes that. Auditing an implementation against a
   premise only deepens the premise; three careful passes can all agree and all be
   measuring the wrong thing. Anything you cannot establish from the code becomes a
   behavioural assumption in the report.

5. **Report** using the template in [REFERENCE.md](REFERENCE.md): Intended → Delivered →
   Divergences → Left to do (in scope) → Leftovers (out of scope) → Oversights/bugs →
   Assumptions only the user can confirm → Verdict (`DONE` / `DONE_WITH_CONCERNS` /
   `GAPS`).

   **Report everything you found, ranked by severity — do not pre-filter to the serious
   ones.** A blind read's whole value is that it noticed something the author could not,
   and a conservatism filter throws exactly those away: told to be selective, the judgement
   that gets worse is *what counts as serious*, not what gets reported. Rank honestly and
   let the user draw the line.

   **Then keep the report to the length the findings need.** Every section earns its place
   by having content; an empty one is omitted, not filled. A clean audit is a short report,
   and padding a `DONE` verdict out to a full template makes the next one harder to read.

6. **Decide what happens next.**
   - If `--fix` or `--iterate` was passed, proceed into that mode now (see Modes).
   - If neither flag was passed, STOP and ask the user whether to fix the in-scope gaps,
     run the bounded iterate loop, or leave it as a report. Modify nothing until they
     choose — the report alone never edits code.
   - Either way, put the **Assumptions** section in front of the user as a question, not
     as a footnote. One sentence of confirmation from someone who knows the domain is
     the cheapest control this skill has, and the only one that can catch a premise the
     code cannot settle.

## Modes

The fix behavior is gated on explicit flags. If neither `--fix` nor `--iterate` is
passed, the skill does NOT modify anything — it reports, then asks (step 6).

- **(no flag) — report only.** Produce the report and stop. Strictly read-only.
- **`--fix`.** After the report, fix the in-scope gaps, then re-audit once.
- **`--iterate`.** Fix-and-re-audit loop, bounded to **2 rounds max**. End with a final
  overview: what was implemented, what remains in scope, what is deferred out of scope.
  See [REFERENCE.md](REFERENCE.md) for the loop. Two rounds, not three: a gap that
  survived one honest fix-and-re-audit is usually a gap the loop cannot close, and the
  third round almost always spends a full blind audit confirming that. Surfacing it to
  the user is both cheaper and more useful than another pass.

**Non-fixable findings.** Behavioural assumptions and reductions in breadth are never
auto-resolved, in any mode. `--fix` and `--iterate` must surface them and move on, never
act on them, and their presence caps the verdict at `DONE_WITH_CONCERNS`. These modes
exist to run without a human in the loop, which is exactly when a wrong premise
compounds instead of being caught — so the one finding that only a human can settle must
survive the loop intact rather than being tidied away by it.

## Guardrails

- **The blind agent is only as blind as the diff.** Withholding the conversation is not
  enough: comments, KDoc, doc updates, and test names carry the author's own rationale
  straight into the "fresh" read, and the agent will adopt it. Never pass conversation
  history or planning docs — and prompt the agent to treat in-diff justification as a
  claim to be tested, not as context (see [REFERENCE.md](REFERENCE.md)).
- Only `--fix`/`--iterate`, or explicit user approval at step 6, may modify the tree.
  With no flag and no approval, the skill is strictly read-only.
- **One blind agent, by default and nearly always.** The isolation is what does the work
  here, and isolation does not compound: a second and third agent reading the same diff
  mostly re-derive the first one's findings at triple the cost, and the reconciliation
  step then has three near-identical reports to weigh instead of one clear read. Fan out
  to 2–3 lensed agents (does-it-work / completeness / bugs-and-edge-cases) only when the
  diff is genuinely too large for one agent to hold — hundreds of lines across unrelated
  modules — and say why you did. See [REFERENCE.md](REFERENCE.md) for the lenses.

## Relationship to other skills

`/review` checks scope but in-context. `/codex review` is fresh but intent-blind.
`fresh-eyes` is the union: fresh context AND intent reconciliation. A sibling
plan-preflight skill (cold read of a plan before implementation) may follow; this
skill stays diff-only.

`/build-it` is the front half of the same problem. Its scope note — written before any
code, naming what will and will not change, and tagging each claim as cited or assumed —
is the cheap place to catch a load-bearing assumption, and it is also the best thing to
audit this diff against. If a fresh-eyes report keeps landing behavioural assumptions
late, that is a signal to start the next piece of work through `/build-it` rather than to
grow this skill toward it.

(`assumption-inventory` used to hold that role and is now retired into `/build-it`.)
