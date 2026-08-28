---
name: ship-it-now
description: '[skips confirmation] The unattended form of /ship-it. Gets this conversation''s work merged and deployed to every environment the repo has, production included — and does NOT stop to confirm when the release also carries unreleased work by other developers or other agent sessions. Identical to /ship-it in every other respect: same grounding in branches, PRs and environments, same verification, same merge-conflict policy. Takes no arguments by default; an optional scope override such as "only staging" limits which environments it deploys to. Invoke with /ship-it-now when you already know what is on the target branch and do not want to be asked.'
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# Ship It Now

Same skill as `/ship-it`, with the ride-along confirmation gate turned off.

**Read `../ship-it/SKILL.md`, relative to this file, and follow it in full** — with exactly
these two changes:

1. **Section 4 does not gate.** Do not call AskUserQuestion about other people's changes and do
   not wait for an answer. Still *print* the short summary of whose work is riding along, before
   the deploy, so it is on the record — then continue straight through to production.

2. **Say so up front.** The first line of your output names what this is: shipping to production
   without confirmation. The user typed `-now`; they should still see what that bought them.

Everything else is unchanged, and deliberately so. Grounding in section 1 still happens in full —
skipping confirmation is not permission to skip *knowing*. The merge-conflict policy in section 6
still stops for a genuine divergence of intent; that gate protects the code, not the user's
attention, and `-now` does not lift it. Verification in section 5 is still required: an unattended
ship is exactly the case where nobody else is watching whether it landed.

If `../ship-it/SKILL.md` is not readable from here, stop and tell the user to install `/ship-it`
alongside this one. Do not improvise the workflow from this file: everything that makes shipping
unattended safe — the grounding, the verification, the conflict policy — lives over there.
