# fresh-eyes — Reference

Detailed prompts and templates for the [SKILL.md](SKILL.md) workflow.

## Blind subagent prompt (step 3)

Spawn with the Agent tool (`general-purpose`, or `Explore` for read-only). The agent
must have NO knowledge of the conversation or the intended outcome. Hand it only the
change captured in step 2 — paste the diff, tell it the exact `git diff` command to
run, or (in the no-git / session-reconstructed case) give it the list of changed file
paths to read cold. Never pass conversation history. Use this prompt:

> You are reviewing a code change with completely fresh eyes. You have no context about
> why it was made or what it was supposed to accomplish — and that is intentional. Read
> ONLY the diff below. Do not ask for more context; infer everything from the diff.
>
> Your PRIMARY job is to understand the change and judge its completeness: what it does
> and whether it looks fully finished. Spotting bugs is a SECONDARY, welcome byproduct —
> note them, but do not let a bug-hunt crowd out the completeness read.
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
>
> Be concrete: cite file paths and line context. Do not pad. If something is fine, say
> so briefly and move on.

For a large or high-stakes diff, run 2–3 agents with one lens each instead of one
general agent:
- **does-it-work** — trace the happy path and the main failure paths end to end.
- **completeness** — what looks unfinished, untested, or stubbed?
- **bugs-and-edge-cases** — adversarially hunt the shadow paths and boundaries.

Reconcile all of their reports against the pre-registered intent.

## Report template (step 5)

```
## fresh-eyes report

**Intended** (pre-registered, before the blind read)
- In scope: …
- Out of scope: …

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

**Verdict:** DONE | DONE_WITH_CONCERNS | GAPS
- DONE — delivered matches intent, no material gaps or oversights.
- DONE_WITH_CONCERNS — intent met; list the concerns explicitly.
- GAPS — scope is incomplete or the blind read diverged materially from intent.
```

## Iterate loop (`--fix` / `--iterate` mode, or after step-6 approval)

This loop runs ONLY when `--fix`/`--iterate` was passed, or the user approved fixing at
step 6. It is the one path allowed to modify the tree. `--fix` runs a single round;
`--iterate` runs up to 3. After the report:

1. Take the `Left to do — in scope` items and the material oversights.
2. Apply the fixes — main context for trivial mechanical changes, or delegate a
   substantial fix to a fresh agent to keep the implementer unbiased. Do not pull
   out-of-scope leftovers into this pass.
3. Re-run steps 2–5 of the workflow on the new change.
4. Stop when the verdict is `DONE`, after the round limit (`--fix` = 1, `--iterate` = 3),
   or when only `DONE_WITH_CONCERNS` remains — report surviving concerns, do not loop
   further on them.
5. **Final overview:** what was implemented across all rounds, what remains in scope,
   what is deferred out of scope, and any concern that survived the loop.

Convergence guard: if the same gap survives two consecutive rounds, stop looping and
report it as an unresolved concern rather than burning the third round on it.
