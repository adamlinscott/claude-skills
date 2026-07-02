# Goal Workflow — Reference

Gate message, contract template, loop details, and closeout text for the
[SKILL.md](SKILL.md) workflow.

## Step 0 — gate message (`--confirm` missing)

When `ARGUMENTS` lacks the literal flag `--confirm`, STOP and send the message below, then
wait for re-invocation. Modify nothing.

**Keep it to three sections in this order — goal, setup, start.** Fill `<one-sentence goal>`
and `<source>` from steps 1's derivation (state what you'd build *before* asking the user to
commit to it). Then emit **one** `/goal` block (chosen by `--commit`, see below) as a fenced
code block so it copies cleanly. Do not add prose beyond this template — the value is brevity.

> **Ready to build:** *"<one-sentence goal>"* — from `<source>`.
>
> Two manual setup steps first; I can't set or detect either.
>
> **1 · Set up** (both required)
> - Run `/effort ultracode` — xhigh reasoning + workflow orchestration.
> - Press **Shift+Tab** → **auto-accept**, so the loop runs without a prompt each step.
>
> **2 · Start it** (pick one)
> - **A — Managed run.** Re-invoke `/goal-workflow --confirm`. I drive it end to end: terrain
>   → contract → subagent fan-out → `/fresh-eyes` → closeout.
> - **B — Native orchestration.** Paste the command below — *you* run it, so it gets the
>   fullest fan-out via native `/goal` + workflow orchestration.
>
> *Either path: autonomous, slow (~1 hr for large goals), and token-heavy. {VC_NOTE}*

`{VC_NOTE}` states the git posture for this invocation in one clause:
- `--commit` passed → `I'll commit at intervals and push at milestones.`
- `--commit` absent (default) → `No --commit, so git stays entirely with you.`

Then emit **one** of the two `/goal` variants below, chosen by whether `--commit` was passed
to this gate invocation. They differ only in the version-control clause.

**With `--commit`** — auto-commits during the run:

```
/goal Determine the goal from this conversation and any plan, ADR, spec, or documentation
files written this session, then implement it to completion. Orchestrate this as a multi-agent
workflow: author and run a workflow with the Workflow tool that fans the independent parts out
across parallel subagents — do NOT implement it solo in the main loop. First commit and push
any outstanding documentation, then build directly from it. Commit to the current feature
branch at logical intervals and push at milestones. Use the fresh-eyes skill at logical
milestones to verify each task is complete and to surface bugs, oversights, and spec gaps,
then fix what it finds. Keep working until the implementation fully satisfies the plan and all
checks pass.
```

**Without `--commit` (default)** — leaves version control to the user:

```
/goal Determine the goal from this conversation and any plan, ADR, spec, or documentation
files written this session, then implement it to completion, building directly from that
documentation. Orchestrate this as a multi-agent workflow: author and run a workflow with the
Workflow tool that fans the independent parts out across parallel subagents — do NOT implement
it solo in the main loop. Do NOT commit or push anything — leave all version control to me.
Use the fresh-eyes skill at logical milestones to verify each task is complete and to surface
bugs, oversights, and spec gaps, then fix what it finds. Keep working until the implementation
fully satisfies the plan and all checks pass.
```

(The slow/expensive warning is the footer line of the gate message above — don't repeat it
after the code block.)

The `/goal` command is intentionally **generic** — it tells Claude to derive the goal from
context and docs rather than hard-coding one, so the same text works for any session. It is
modelled on the proven manual invocations: build from the written docs, run as a workflow,
verify iteratively with fresh-eyes, and (when `--commit` is on) commit docs first then commit
at intervals.

Why gate on a flag rather than the keyword: the `ultracode` keyword only enables the mode
when the *user* types it as plain input, and it does not reliably fire from a slash-command
argument. Effort, permission mode, and `/goal` are all user-only and unreadable from inside
a run. `--confirm` is therefore an explicit user assertion that the manual setup is done —
the only signal available — so trust it but never self-enable in its place.

## Step 4 — completion-invariant contract template

Write to a file so it survives compaction. Each invariant is binary and checkable —
something `/fresh-eyes` can later confirm or deny, and something a user-run `/goal` condition
can point at. Avoid soft language ("should work", "looks right").

```markdown
# Goal: <one-sentence goal>
Branch: <feature-branch> | Written: before implementation

## Completion invariants
- [ ] <Backend route matches the frontend client method that calls it.>
- [ ] <No enabled checkout path exists without both price and stock.>
- [ ] <Migration upgrades AND downgrades cleanly.>
- [ ] <Feature-flag-off path still works (no regression when disabled).>
- [ ] <Gated on <ENV_VAR>: absent → feature disabled, no crash.>
- [ ] <Existing tests stay green, or each failure is identified as pre-existing.>

## Out of scope (do not build)
- <explicitly deferred items>

## Terrain basis
- <key files/paths + line numbers the invariants depend on, from step 3>
```

Good invariants name a concrete, observable condition and how it is checked. Bad ones
restate the goal ("email feature works"). When in doubt, ask: *could a blind reviewer mark
this true or false by reading the code?* If not, sharpen it.

## Step 5 — orchestration and the loop

**Orchestrate explicitly — do not wait for ultracode.** ultracode authoring a workflow is
model-discretion; it often won't, which is why `/workflows` can stay empty. The mechanism a
skill actually controls is the **Agent tool**: spawn subagents for independent workstreams
(separate modules, services, test suites), let them run in parallel, then integrate their
results. That is the deterministic fan-out; use it rather than hoping for auto-orchestration.

**Cross-turn persistence is user-only.** A skill cannot set `/goal`. If the user wants the
run to auto-continue across turns, hand them a ready-to-paste line pointing at the contract,
e.g. `/goal every invariant in GOAL-INVARIANTS.md holds and the test suite is green` — they
run it; the skill never does. Otherwise the skill loops within its own run: build → check
invariants → continue, until all pass or a blocker needs the user. (For the fullest native
fan-out, the user is better served by **path B** from the step-0 gate, which starts from
`/goal` and runs as a workflow from the outset.)

**Commit cadence (only when `--commit` was passed):** WIP commits to the feature branch at
logical units (a coherent change, a passing module); push only at verified milestones (after
a clean `/fresh-eyes` pass) and at closeout — not on every commit. **Without `--commit`,
make no commits or pushes at all** — build in the working tree and tell the user at closeout
that the changes are uncommitted.

## Step 7 — fix-loop bound

Mirror `/fresh-eyes --iterate`: at most 3 rounds of fix-and-re-verify. Convergence guard —
if the same gap survives two consecutive rounds, stop looping and surface it as an
unresolved concern rather than spending the third round on it. Do not pull out-of-scope
items into the fix pass.

## Step 8 — closeout reminder text

After the final report, always include:

> Done. One thing: you're likely **still in ultracode effort** for the rest of this
> conversation. Unless your next task is another complex build, drop it back down —
> `/effort high` (or lower) — so ordinary turns don't run at xhigh and spend tokens you
> don't need to. Re-enable ultracode whenever you start the next big workflow.
