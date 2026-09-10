# fresh-eyes — Reference

Detailed prompts and templates for the [SKILL.md](SKILL.md) workflow.

## Blind subagent prompt (step 3)

Spawn with the Agent tool (`general-purpose`, or `Explore` for read-only). The agent
must have NO knowledge of the conversation or the intended outcome. Hand it only the
change captured in step 2 — paste the diff, tell it the exact `git diff` command to
run, or (in the no-git / session-reconstructed case) give it the list of changed file
paths to read cold. Never pass conversation history or planning docs. Use this prompt:

> You are reviewing a code change with completely fresh eyes. You have no context about
> why it was made or what it was supposed to accomplish — and that is intentional. Read
> ONLY the diff below. Do not ask for more context; infer everything from the diff.
>
> Your PRIMARY job is to understand the change, judge its completeness, and name what it
> takes for granted: what it does, whether it looks fully finished, and what it assumes
> about the world. Spotting bugs is a SECONDARY, welcome byproduct — note them, but do
> not let a bug-hunt crowd out the other two.
>
> Report, in this order:
> 1. **What this change does.** In your own words, what does it build, fix, or change?
>    What problem does it look like it is solving? (Primary — be thorough here.)
> 2. **Completeness.** Does it look fully finished, or are there half-done, stubbed,
>    untested, TODO-shaped, or inconsistent parts? (Primary.)
> 3. **Implementation quality.** Is it clear, well-structured, idiomatic for the
>    surrounding code? Are there tests? Is the diff right-sized?
> 4. **Bugs and risks (secondary).** Missed edge cases and shadow paths for every new
>    data flow: nil/null input, empty/zero-length input, and upstream-error input. Name
>    specific failure modes — what triggers them, what the user would see. Flag any
>    silent-failure or catch-all error handling.
> 5. **Assumptions about the world.** Comments and doc-comments in this diff are the
>    author's assertions, not established facts. Wherever one justifies a design
>    decision or states an invariant, say what would have to be true about the domain
>    for that justification to hold, and whether the code actually proves it. Then:
>    does this change make any existing behaviour narrower, stricter, or more tightly
>    scoped? For each such case, assume the previous breadth was deliberate and say what
>    it might have been protecting.
>
> Be concrete: cite file paths and line context. Do not pad. If something is fine, say
> so briefly and move on.

Item 5 carries most of the weight and is the easiest to lose. Keep it scoped to comments
that *justify* something — descriptive comments need no treatment, and hedging on every
line turns the report to noise. It is also the only item that can catch a premise the
author and every prior reviewer already share, because it asks what the world would have
to look like rather than whether the code matches the stated intent.

**The single general agent above is the default.** Only when a diff is genuinely too
large for one agent to hold in context — hundreds of lines across unrelated modules —
run 2–3 agents with one lens each instead. Reach for this because the material does not
fit, never because the change feels important: three agents over a diff one could have
read produce three overlapping reports, cost three times as much, and make the
reconciliation harder rather than sharper.
- **does-it-work** — trace the happy path and the main failure paths end to end.
- **completeness** — what looks unfinished, untested, or stubbed?
- **bugs-and-edge-cases** — adversarially hunt the shadow paths and boundaries.

Every lens keeps item 5 verbatim, whatever else it drops. It is the only item that does
not overlap with the others, and a fan-out that loses it is weaker than the single
general agent it replaced.

Reconcile all of their reports against the pre-registered intent.

## Report template (step 5)

```
## fresh-eyes report

**Intended** (pre-registered, before the blind read)
- Asked — in scope: …
- Asked — out of scope: …
- Derived — <item> ← <origin>, rests on <domain fact | code shape>

**Delivered** (the blind agent's read of what the diff actually does)
- …

**Divergences** (blind read vs intent — the headline)
- ⚠️ Agent thinks the diff does X; we meant Y → [dropped scope | intent not expressed]
- ✅ Aligned where blind read matches intent

**Left to do — in scope**
- [ ] …

**Leftovers — out of scope** (defer, do not silently expand)
- …

**Oversights / bugs / edge cases**
- <file:line> — <failure mode, trigger, what the user sees>

**Assumptions only you can confirm** (ask these — do not act on them)
- ❓ This change assumes <statement about how the world behaves>. Nothing in the code
  establishes it. If it is false, <what breaks>.
- ❓ This narrows <behaviour> from <before> to <after>. If that breadth was load-bearing
  for <reason>, this is a regression.

**Verdict:** DONE | DONE_WITH_CONCERNS | GAPS
- DONE — delivered matches intent, no material gaps or oversights, and no unconfirmed
  behavioural assumptions. Says the code expresses the intent; says nothing about
  whether the intent was right.
- DONE_WITH_CONCERNS — intent met; list the concerns explicitly. Any unconfirmed
  assumption or reduction in breadth lands here, not in DONE.
- GAPS — scope is incomplete or the blind read diverged materially from intent.
```

## Iterate loop (`--fix` / `--iterate` mode, or after step-6 approval)

This loop runs ONLY when `--fix`/`--iterate` was passed, or the user approved fixing at
step 6. It is the one path allowed to modify the tree. `--fix` runs a single round;
`--iterate` runs up to 2. After the report:

1. Take the `Left to do — in scope` items and the material oversights. Never take items
   from `Assumptions only you can confirm` — carry them forward untouched into every
   subsequent round and into the final overview. Acting on an unconfirmed assumption is
   how a wrong premise gets built deeper instead of caught.
2. Apply the fixes — main context for trivial mechanical changes, or delegate a
   substantial fix to a fresh agent to keep the implementer unbiased. Do not pull
   out-of-scope leftovers into this pass.
3. Re-run steps 2–5 of the workflow on the new change.
4. Stop when the verdict is `DONE`, after the round limit (`--fix` = 1, `--iterate` = 2),
   or when only `DONE_WITH_CONCERNS` remains — report surviving concerns, do not loop
   further on them.
5. **Final overview:** what was implemented across all rounds, what remains in scope,
   what is deferred out of scope, any concern that survived the loop, and every
   behavioural assumption still awaiting confirmation — stated as questions to the user.

Convergence guard: if the same gap survives two consecutive rounds, stop looping and
report it as an unresolved concern rather than spending another blind audit on it.
