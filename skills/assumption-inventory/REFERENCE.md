# Assumption Inventory — Reference

The catalog, the worked example, and the report template for the
[SKILL.md](SKILL.md) workflow.

## Commonly-wrong assumptions (check these by default)

These are the assumptions that feel obvious and are silently wrong often enough to be
worth a default check at step 3. Each looks like settled fact and is actually a guess.

- **Platform is whatever I am running on.** Windows now does not mean Windows-only —
  the same code may need to run on Mac or Linux tomorrow. Treat single-OS as an
  assumption to confirm, not the goal. Prefer portable paths, shells, and tooling unless
  told otherwise.
- **Scope is this one repo.** An agent rooted in a workspace of many repos should not
  develop a per-repo blind spot. Confirm whether the task is workspace-wide or bounded to
  one repo before scoping edits and reads.
- **My local auth is part of the contract.** Personal cloud logins, an authenticated CLI,
  or machine-specific credentials are *your* environment, not a test dependency the work
  may lean on. Do not make completion require a login only you have.
- **Documented contracts are stable.** ADRs and design docs capture decisions, not
  volatile, in-flux shapes. Do not treat a contract shape pulled from a doc as frozen
  truth, and do not write volatile shapes *into* ADRs as if settled — confirm against the
  live code.
- **"Done" means the code is written.** Done usually means a checkable end state —
  builds, tests pass, the behavior is observable — not merely that an edit was made.
  Pin the checkable definition, not the activity.
- **The goal is the literal request.** A narrowly-worded ask often sits on an unstated
  larger intent. Confirm the outcome behind the instruction when a long run depends on it.

## Worked example

A session resumes with no clear target and the agent is about to investigate
email-sending code. The inventory forces the gap into view *before* the investigation
burns time:

```
## Assumption inventory

- Goal — [assumption] "Look into the email-sending code." No outcome stated.
  Investigate? Fix a bug? Add a feature? UNKNOWN — blocking.
- Root / scope — [cited: pwd → /work/app-api] this repo. [assumption] platform is
  Linux server; needs confirming if a local Mac run is expected.
- May edit — [assumption] src/mail/**. Not stated.
- Must not touch — [assumption] no other repos in the workspace.
- Done means — [assumption] UNKNOWN — depends entirely on the goal.
- Open questions — what is the actual objective? Is there a bug report or a feature
  behind this, or is it exploratory?

Blocking question: what outcome should the email-sending work produce — and how will
we know it is done?
```

The agent stops here and asks, rather than spending an hour investigating a target that
may not be the one the user wanted.

## Report template (step 5)

```
## Assumption inventory

- **Goal** — <one sentence> [cited … | assumption]
- **Root / scope** — <repo / dir / workspace; platform(s)> [cited … | assumption]
- **May edit** — <files / areas> [cited … | assumption]
- **Must not touch** — <off-limits> [cited … | assumption]
- **Done means** — <checkable end state> [cited … | assumption]
- **Open questions** — <what could change the above>

**Blocking — confirm before I proceed** (load-bearing + unconfirmed)
- [ ] …

**Stated assumptions — proceeding unless you correct them** (not load-bearing)
- …
```

Fill every slot. Keep blocking questions to the few that are genuinely load-bearing;
everything cheaply checkable should already be cited or settled before this report.
