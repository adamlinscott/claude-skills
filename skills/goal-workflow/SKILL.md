---
name: goal-workflow
description: Run a settled implementation goal as a bounded autonomous build loop — lock the goal from the conversation and any docs written this session, front-load every decision, map the terrain, write a completion-invariant contract before any code, then loop (build, commit at intervals, verify at milestones with fresh-eyes against the contract) until the invariants hold, and close out. Gated on the user invoking it with the literal keyword `ultracode`, which both enables xhigh + workflow orchestration and confirms intent. Use when a plan is settled and you want Claude to implement it end-to-end on its own — typically after a planning skill — or whenever the user says goal-workflow.
---

# Goal Workflow

Turn a settled goal into a **bounded implementation loop, then force proof, then fix or
close.** This is the implementation-phase sibling to `assumption-inventory` (before),
`reground` (mid-drift), and `fresh-eyes` (after).

It does not reinvent looping, effort, or verification — it **composes three primitives**
and supplies the connective tissue they lack: native `/goal` is the loop engine,
`/effort ultracode` is the effort+orchestration mode, and `/fresh-eyes` is the
independent verifier. The skill's own job is to lock the goal, front-load decisions, map
terrain, and — the load-bearing step — **write a checkable contract before any code, so
verification anchors to a bar set in writing, not to the implementer's memory of intent.**

Run the steps in order. Step 0 is a hard gate; do not skip it.

## 0. Gate on the `ultracode` keyword (FIRST — before anything else)

A skill cannot enable or even detect ultracode (it is a session setting, exposed in no
env var, file, or status output). The only signal available is the keyword in the user's
own invoking message — which is also what actually turns the mode on. So gate on it.

- Inspect this invocation's `ARGUMENTS` for the literal single token `ultracode`.
- **Present and one word** → ultracode is active for this run. Proceed to step 1.
- **Absent, or only the two-word form `ultra code`** → STOP. Modify nothing. Tell the user:
  - Re-invoke as `/goal-workflow ultracode` (the keyword is the only required argument; the
    goal is read from context in step 1, so it need not be restated).
  - Why: typing `ultracode` is the only way to enable xhigh + workflow orchestration — the
    skill can't do it for you — and it confirms you mean to start a long run.
  - **Warn plainly:** this runs autonomously and can take a long time, scaling with goal
    complexity (runs have gone ~1 hour). It is **expensive and consumes tokens fast.**
  - Then stop and wait for re-invocation. Do not proceed on a missing keyword.

See [REFERENCE.md](REFERENCE.md) for the exact gate message.

## 1. Lock the goal

The goal is **not** passed as an argument — derive it. Read the conversation above plus any
plan / ADR / spec / doc files written this session, and infer what the user wants built.
State the derived goal back in one sentence and confirm it before proceeding. Any extra
words the user added after `ultracode` are steering hints, not the whole goal.

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
file). Each is a binary, verifiable claim — not "we'll test it later." This file is both
the `/fresh-eyes` checklist and the basis for the `/goal` condition, and it survives
context compaction during a long run. See [REFERENCE.md](REFERENCE.md) for the template.

## 5. Run the loop

Set `/goal` to the invariant condition so Claude keeps working across turns until it
holds (fall back to an inline loop if `/goal` is unavailable). Build toward the contract.
**Commit WIP to the feature branch at logical intervals; push at verified milestones**,
not on every commit.

## 6. Verify at milestones with fresh-eyes

At each completed logical unit, invoke `/fresh-eyes` against the contract file. Its blind
subagent is the independence boundary — **the implementer never grades its own work.**
Reconcile the blind read against the written invariants, not against your memory of intent.

## 7. Bounded fix loop

Gaps from verification → fix → re-verify, with a round cap (mirror `/fresh-eyes --iterate`,
3 rounds). If the same gap survives two rounds, stop and surface it rather than looping.

## 8. Closeout

Final `/fresh-eyes` pass against the full contract. Report each invariant as met or unmet,
do the final commit and push, and `/goal clear`. **Then remind the user:** they are likely
still in ultracode effort, and can lower it (`/effort high` or below) for the rest of the
conversation until the next complex run, to avoid spending xhigh tokens on ordinary turns.

## Guardrails

- **Never proceed past step 0 without the typed keyword.** The gate is the only guarantee
  the run is actually under ultracode; a skill cannot self-enable or detect it.
- **The contract precedes the code.** Verification checks the written invariants, never the
  implementer's recollection — that is what keeps the proof honest.
- **fresh-eyes stays a reviewer.** Do not fold its verification into the build mindset; its
  value is the independent read.
- **One interactive gate.** Front-load decisions at step 2. Once the loop starts, run to
  closeout without stopping for input the user could have given up front.
