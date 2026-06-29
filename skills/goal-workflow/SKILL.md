---
name: goal-workflow
description: Run a settled implementation goal as a bounded autonomous build loop — lock the goal from the conversation and any docs written this session, front-load every decision, map the terrain, write a completion-invariant contract before any code, then loop (building with explicit Agent-tool fan-out, committing at intervals, verifying at milestones with fresh-eyes against the contract) until the invariants hold, and close out. Gated on a `--confirm` flag asserting the user has manually set ultracode effort and auto-accept mode (a skill can set neither); without the flag it stops, gives the setup steps, and offers two paths — a managed `--confirm` run, or a copy-pasteable `/goal` command that hands the work to native goal + workflow orchestration. Use when a plan is settled and you want Claude to implement it end-to-end on its own — typically after a planning skill — or whenever the user says goal-workflow.
---

# Goal Workflow

Turn a settled goal into a **bounded implementation loop, then force proof, then fix or
close.** This is the implementation-phase sibling to `assumption-inventory` (before),
`reground` (mid-drift), and `fresh-eyes` (after).

The orchestration engine is **explicit subagent fan-out via the Agent tool** — the only
multi-agent mechanism a skill can reliably drive. Native `/goal` and ultracode's automatic
workflow orchestration are **user-only and discretionary** (a skill cannot set `/goal`, and
ultracode decides for itself whether to author a workflow), so this skill does not depend on
them — it offers them as an optional fast path the user can run. `/fresh-eyes` is the
independent verifier. The skill's own job is to lock the goal, front-load decisions, map
terrain, and — the load-bearing step — **write a checkable contract before any code, so
verification anchors to a bar set in writing, not to the implementer's memory of intent.**

Run the steps in order. Step 0 is a hard gate; do not skip it.

## 0. Confirmation gate (FIRST — before anything else)

This skill runs a long, expensive, autonomous loop, and it depends on two session settings
a skill **cannot** set or detect for itself: **ultracode effort** (xhigh + workflow
orchestration) and **auto-accept mode** (so the loop's agents run without a permission
prompt on every action). Passing the keyword `ultracode` as an argument does **not** turn
effort on — only the user can, manually. So gate on an explicit `--confirm` flag that
asserts the user has done the setup.

- Inspect this invocation's `ARGUMENTS` for the literal flag `--confirm`.
- **Present** → the user has confirmed setup. Proceed to step 1.
- **Absent** → STOP. Modify nothing. Output the gate message: the **setup** plus **two ways
  to proceed**, then wait. Do not proceed without `--confirm`.

  **Setup (do both first):**
  1. Run `/effort ultracode` — enables xhigh reasoning + workflow orchestration. The skill
     can't set effort; you must.
  2. Press **Shift+Tab** to cycle to **auto-accept mode**, so agents work autonomously
     without stopping for permission on each step.

  **Then pick one:**
  - **A — Managed run.** Re-invoke `/goal-workflow --confirm`. The skill drives the lifecycle
    itself (terrain → contract → Agent-tool fan-out → fresh-eyes → closeout). Deterministic,
    but bounded to what a skill can orchestrate.
  - **B — Full native orchestration.** Paste the generated `/goal …` command (see
    [REFERENCE.md](REFERENCE.md)). Because *you* run it, it hands the work to native `/goal`
    plus ultracode's workflow orchestration — the fullest fan-out — with the skill's
    best-practice directive (derive the goal from context + docs, run as a workflow, commit
    at intervals, verify with fresh-eyes) baked in.

  **Warn plainly:** either path runs autonomously and can take a long time, scaling with goal
  complexity (runs have gone ~1 hour). It is **expensive and consumes tokens fast.**

See [REFERENCE.md](REFERENCE.md) for the exact gate message and the copy-pasteable `/goal`
command.

## 1. Lock the goal

The goal is **not** passed as an argument — derive it. Read the conversation above plus any
plan / ADR / spec / doc files written this session, and infer what the user wants built.
State the derived goal back in one sentence and confirm it before proceeding. Any extra
words the user added alongside `--confirm` are steering hints, not the whole goal.

**Clarity gate.** Before continuing, judge one thing only: *is there a clear, concrete goal
here that can actually be implemented?* This is narrow on purpose — it is **not** a check on
whether the goal is good, well-scoped, difficult, or worth running this expensive tool on.
Whether the goal merits this firepower is the user's call, never the tool's. The gate asks
solely whether something implementable is even on the table.

- **A clear goal is present** → state it, confirm, proceed to step 2.
- **No clear goal** (the context and docs don't add up to a concrete thing to build — the
  intent is vague, contradictory, or absent) → STOP. Modify nothing. Say what you found and
  what's missing, and ask the user to state the goal plainly, then re-invoke. Do not guess a
  goal into existence to keep going.

(This is distinct from `/assumption-inventory` and `/fresh-eyes`, which weigh assumptions
and verify outcomes. For a deeper assumptions pass, the user may run `/assumption-inventory`
first — offer it, never auto-run it.)

## 2. Front-load every decision, then warn

Surface now — at the start, while the user is still here — every choice the run depends
on: env vars, settings, credentials, and any ambiguity that could send it the wrong way.
Restate the time and token-cost warning. This is the **last interactive checkpoint**
before the loop goes heads-down; get everything decided here.

## 3. Terrain check (read-only)

Before building, map what the goal touches: repo conventions, route shape, schema shape,
tests, and docs — with exact file paths, line numbers, and missing pieces. Skip only if a
prior planning step already produced this map; say so if you skip.

## 4. Write the completion-invariant contract (BEFORE any code)

Write concrete, checkable invariants to a file (e.g. `GOAL-INVARIANTS.md` or the plan
file). Each is a binary, verifiable claim — not "we'll test it later." This file is the
`/fresh-eyes` checklist, it survives context compaction during a long run, and it is what
an optional user-run `/goal` condition points at. See [REFERENCE.md](REFERENCE.md) for the
template.

## 5. Run the loop

Drive the build yourself; do not wait for ultracode to author a workflow — it may not.
**Fan out explicitly with the Agent tool** for independent workstreams (separate modules,
test suites, services), then integrate — this is the orchestration the skill actually
controls. Build toward the contract, iterating until every invariant holds. **Commit WIP to
the feature branch at logical intervals; push at verified milestones**, not on every commit.

For cross-turn persistence (so the run auto-continues across turns), the skill can hand the
user a ready-to-paste `/goal …` command pointing at the contract file — but `/goal` is
**user-only**, so the skill writes it and the user runs it; the skill never sets it itself.
See [REFERENCE.md](REFERENCE.md).

## 6. Verify at milestones with fresh-eyes

At each completed logical unit, invoke `/fresh-eyes` against the contract file. Its blind
subagent is the independence boundary — **the implementer never grades its own work.**
Reconcile the blind read against the written invariants, not against your memory of intent.

## 7. Bounded fix loop

Gaps from verification → fix → re-verify, with a round cap (mirror `/fresh-eyes --iterate`,
3 rounds). If the same gap survives two rounds, stop and surface it rather than looping.

## 8. Closeout

Final `/fresh-eyes` pass against the full contract. Report each invariant as met or unmet,
do the final commit and push, and remind the user to run `/goal clear` if they set a goal.
**Then remind the user to undo the setup from step 0:** they are likely still in ultracode
effort and auto-accept mode. Suggest
lowering effort (`/effort high` or below) and pressing **Shift+Tab** to leave auto-accept,
so ordinary turns don't run at xhigh or act without prompting until the next big run.

## Guardrails

- **Never proceed past step 0 without `--confirm`.** A skill cannot set or detect effort or
  permission mode, so the flag is the only assertion the user has actually enabled ultracode
  and auto-accept. Trust it, but never substitute for it by self-enabling.
- **The contract precedes the code.** Verification checks the written invariants, never the
  implementer's recollection — that is what keeps the proof honest.
- **fresh-eyes stays a reviewer.** Do not fold its verification into the build mindset; its
  value is the independent read.
- **One interactive gate.** Front-load decisions at step 2. Once the loop starts, run to
  closeout without stopping for input the user could have given up front.
