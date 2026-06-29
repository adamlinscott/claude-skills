---
name: assumption-inventory
description: Surface and confirm the load-bearing assumptions behind a task before a long or expensive run — goal, root, what may be edited, what is off-limits, what done means, and open questions — separating what can be cited from what is being guessed, so bad direction is caught before time is burned. Use at the start of a multi-step or high-cost task, when resuming ambiguous or handed-off work, or whenever the target is not crisply stated and you are about to commit to a long run.
---

# Assumption Inventory

Before a long run, the cheapest bug to fix is a wrong premise. This skill is a
**preflight**: surface the assumptions the next stretch of work rests on, separate
what you can *cite* from what you are *guessing*, and confirm the load-bearing guesses
before the work starts — not after the diff lands.

The mechanism is one distinction held strictly: a **fact** is something on disk or
stated by the user (it gets a citation); an **assumption** is everything else (it does
not). The danger is an uncited assumption quietly becoming load-bearing — the work
builds on it, and the divergence only surfaces hours later. This skill drags those
assumptions into the open and gates the load-bearing ones on evidence or confirmation.

This is the front end of the triad: `assumption-inventory` (before), `reground`
(mid-drift), `fresh-eyes` (after). Run it in order; do not skip to step 4.

## 1. Decide whether to run

Run this when the work ahead is long, expensive, hard to reverse, or multi-step **and**
the target is not already crisply pinned. Skip it for a one-line change with an explicit
target — the ceremony is not free. When in doubt on a big task, run it.

## 2. Draft the inventory

Fill every slot. For each, tag the basis: `[cited: file:line / user said X]` for a fact,
`[assumption]` for a guess. Do not leave a slot blank — "unknown" is a valid, important
answer.

- **Goal** — what outcome am I trying to produce, in one sentence? Why now?
- **Root / scope** — which repo, directory, or workspace is this rooted in? Is it
  workspace-wide or one repo? What platform(s) must it run on?
- **May edit** — which files / areas am I allowed to change?
- **Must not touch** — what is off-limits (generated files, other repos, prod config,
  contracts other code depends on)?
- **Done means** — what concrete, checkable state counts as complete? How will I know?
- **Open questions** — what do I not know yet that could change the above?

## 3. Stress the assumptions

For each `[assumption]`, ask: *what is the cheapest evidence that would settle this, and
have I looked?* Then look. Read the file, run `pwd` / `git remote -v`, check for a
CLAUDE.md or ADR, grep for the symbol. Cheap checks turn guesses into citations now,
before they cost anything. See [REFERENCE.md](REFERENCE.md) for the catalog of
assumptions that are silently wrong most often (platform, scope, auth, volatile
contracts) — check those by default even when they feel obvious.

## 4. Classify and gate

Sort every surviving `[assumption]` by whether it is **load-bearing** — would the work
be wrong, wasted, or harmful if it turned out false?

- **Load-bearing and unconfirmed** → blocking. List it as an open question and ask the
  user before proceeding. This is the whole point of the skill.
- **Not load-bearing** → state it explicitly as a stated assumption and proceed; the
  user can correct it cheaply because it is visible.

## 5. Confirm, then proceed

Show the user the filled inventory and the blocking questions (template in
[REFERENCE.md](REFERENCE.md)). Wait for answers to the blocking questions. Stated
non-blocking assumptions need no sign-off — they proceed unless corrected. Once the
load-bearing questions are answered, the inventory is the brief for the run; carry it
forward and check work against it.

## Guardrails

- **Never silently upgrade an assumption to a fact.** If you did not cite it, it is still
  a guess, no matter how confident it feels.
- **Default to portable, not this-machine-first.** "Works on my OS / with my logins / in
  this repo" is an assumption, not the goal — surface it, do not bake it in. See
  [REFERENCE.md](REFERENCE.md).
- **Do not over-ask.** Only load-bearing, unconfirmed assumptions block. Burying the user
  in confirmable trivia is its own failure mode — check the cheap ones yourself first.
- **This skill plans, it does not build.** Its output is the confirmed inventory, not a
  started implementation. Begin the work only after step 5.
