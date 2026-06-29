# Goal Workflow — Reference

Gate message, contract template, loop details, and closeout text for the
[SKILL.md](SKILL.md) workflow.

## Step 0 — gate message (`--confirm` missing)

When `ARGUMENTS` lacks the literal flag `--confirm`, STOP and send this, then wait for
re-invocation. Modify nothing.

> **Before Goal Workflow runs, set up two things — I can't do them for you.**
>
> This skill runs a long, autonomous, expensive build loop. It needs ultracode effort and
> autonomous permissions, and a skill can neither set nor detect either one. So do these,
> then re-invoke with `--confirm`:
>
> 1. **Set effort:** run `/effort ultracode` — turns on xhigh reasoning + workflow
>    orchestration. (Passing the word "ultracode" as an argument does *not* do this; only
>    the `/effort` command does.)
> 2. **Go autonomous:** press **Shift+Tab** to cycle to **auto-accept mode**, so I don't
>    stop for permission on every step of the loop.
> 3. **Re-invoke:** `/goal-workflow --confirm` — you don't need to restate the goal; I'll
>    read it from our conversation and any planning docs from this session. Add words only
>    to steer or narrow it.
>
> Heads up before you do:
> - **This takes a while.** Time scales with goal complexity; large goals have run ~1 hour.
> - **It's expensive.** ultracode burns tokens fast. Start it only when you mean to commit
>   to a full implementation pass, not for a quick change.
>
> Once both are set, send `/goal-workflow --confirm` and I'll start.

Why gate on a flag rather than the keyword: the `ultracode` keyword only enables the mode
when the *user* types it as plain input, and it does not reliably fire from a slash-command
argument — so the skill cannot rely on it. Effort and permission mode are also unreadable
from inside a run. `--confirm` is therefore an explicit user assertion that the manual setup
is done; it is the only signal available, so trust it but never self-enable in its place.

## Step 4 — completion-invariant contract template

Write to a file so it survives compaction. Each invariant is binary and checkable —
something `/fresh-eyes` can later confirm or deny, and something the `/goal` condition can
reference. Avoid soft language ("should work", "looks right").

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

## Step 5 — the `/goal` handoff

- Set the condition from the contract, e.g.
  `/goal all invariants in GOAL-INVARIANTS.md hold and the test suite is green`.
- Native `/goal` re-evaluates each turn with a fast model and keeps Claude working until
  the condition holds or `/goal clear` is run.
- If `/goal` is unavailable, loop inline: build → check invariants → continue, until all
  pass or a blocker needs the user.
- Commit cadence: WIP commits to the feature branch at logical units (a coherent change,
  a passing module). Push only at verified milestones (after a clean `/fresh-eyes` pass)
  and at closeout — not on every commit.

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
