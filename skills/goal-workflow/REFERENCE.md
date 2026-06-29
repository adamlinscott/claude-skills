# Goal Workflow — Reference

Gate message, contract template, loop details, and closeout text for the
[SKILL.md](SKILL.md) workflow.

## Step 0 — gate message (keyword missing)

When `ARGUMENTS` lacks the literal one-word `ultracode` (or contains only the two-word
`ultra code`), STOP and send this, then wait for re-invocation. Modify nothing.

> **Goal Workflow needs ultracode — and you have to type it.**
>
> This skill runs a long autonomous build loop. It only works under ultracode (xhigh
> reasoning + automatic workflow orchestration), and a skill can't enable or detect that
> — only your typed input can. So re-invoke with the keyword:
>
> `/goal-workflow ultracode`
>
> (one word, `ultracode` — not "ultra code". You don't need to restate the goal — I'll
> read it from our conversation and any planning docs from this session. Add words only if
> you want to steer or narrow it.)
>
> Heads up before you do:
> - **This takes a while.** Time scales with how complex the goal is; large goals have
>   run ~1 hour.
> - **It's expensive.** ultracode burns tokens fast. Start it when you mean to commit to
>   a full implementation pass, not for a quick change.
>
> Add `ultracode` and send again, and I'll start.

Why gate on the argument: typing `ultracode` in the invoking message is the one action
that actually switches the session into ultracode, *and* it is the only signal the skill
can observe. Checking the arg therefore confirms both intent and that the mode is on.

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
