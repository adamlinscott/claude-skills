---
name: are-we-done
description: 'Deterministic close-out gate for a session or work tree. Sweeps a fixed set of sources — the todo list, this session''s own promises, git state, TODO/FIXME markers the diff introduced, test and build state, and any issue or ticket referenced — and checks that every open point has been explicitly decided: done, won''t do, deferred, or handed to another session. Strict by default, with a severity floor that lifts only on evidence of how the project actually works (CI on every push, a user who commits last). A clean sweep returns one line and one sentence, nothing more. An unclean one either asks about the genuinely ambiguous points or names the blockers to fix now, with every issue number carrying its title. Read-only: it decides nothing and fixes nothing. Use when work looks finished and you want to confirm the session can actually close — "are we done?", before ending a session, before shipping, or before handing off.'
allowed-tools: Read, Grep, Glob, Bash, AskUserQuestion
---

# are-we-done

Answer one question — *can this session close?* — and answer it the same way every time.

Done does **not** mean everything is finished. It means **nothing is still undecided**: every
open point has been settled as done, won't do, deferred, or another session's work. An item
parked with a reason is closed. An item nobody ruled on is not, however small.

Read-only. This skill never edits, commits, or fixes, and never decides on the user's behalf.

## 1. Sweep (all six, in order, every run)

Run the full sweep before judging anything — see [REFERENCE.md](REFERENCE.md) for the exact
commands and what counts as a hit.

1. **Todo list** — any item not `completed`.
2. **This session's own promises** — "I'll do X next", "leaving Y for now", "we should also Z",
   plus any question you put to the user that never got an answer. **If the session was compacted
   or you cannot see its start, that is itself a hit** — an empty result from a transcript you
   can only half-read is not a clean leg, and reporting it as one is inventing closure.
3. **Work tree** — `git status`: uncommitted edits, untracked files, conflict markers,
   a half-applied multi-file change, an in-progress merge or rebase.
4. **Markers introduced by this work** — `TODO`/`FIXME`/`XXX`/`HACK` added by this session, in
   unstaged, staged *and* committed changes; a committed-only sweep misses exactly the markers
   written last. An empty commit range is a range that did not resolve, not a clean sweep.
   Pre-existing markers elsewhere in the repo are not this session's business.
5. **Verification state** — did tests, typecheck, lint, or build run *after the last edit*, and
   what did they say? Never assume; if nothing ran since the last change, that is an open point.
6. **Referenced work items** — every issue, ticket, or PR number named this session, resolved to
   its **title** (`gh issue view <n> --json title`, or the tracker's equivalent). A bare number
   never appears in the output. Unresolvable → use the title as stated this session, marked
   `(unverified)`; a missing `gh` is an environment gap, not an undecided point.

## 2. Classify

Put every hit in exactly one bucket. No item stays unbucketed.

| Bucket | Test |
|---|---|
| `DONE` | Finished and verified in this session. |
| `WON'T DO` | Ruled out on the record, with a reason. |
| `DEFERRED` | Parked deliberately — to a later session, an issue, or a follow-up. |
| `BLOCKER` | A bug, breakage, or unmet requirement inside the scope just worked on. |
| `AMBIGUOUS` | Nobody ruled on it, and skipping it is defensible. |

"On the record" means the user or you said it in this session. Silence is not a decision — an
item nobody mentioned again is `AMBIGUOUS`, not `DONE`.

## 3. Verdict — one rule, one floor

**Yes** iff every item is `DONE`, `WON'T DO`, or `DEFERRED` — and there are zero `BLOCKER` and
zero `AMBIGUOUS`. Otherwise **no**. Do not soften a `no` because the remainder is small.

**The severity floor is strict by default.** An uncommitted tree and "not verified since the last
edit" are `AMBIGUOUS` and force a no — unless this project's own workflow already answers them. A
team whose CI runs the suite on every push has not left testing undecided by not running it
locally, and asking every session is how the gate gets ignored. Lift the floor for one ambient
state at a time, on evidence only, never on assumption ([REFERENCE.md](REFERENCE.md) lists what
counts). A lifted state is still named in the output; it just stops forcing a no.

## 4. Output — one of exactly three shapes

Templates in [REFERENCE.md](REFERENCE.md). Never invent a fourth shape and never add a section
to one. Only one pairing is allowed, and it is spelled out in C below.

**A — Yes.** Two lines of text: a verdict line, a blank line, then one sentence naming what was
completed *and anything parked*. Say "nothing undecided", never "nothing outstanding" — deferred
work is outstanding; the point is that someone ruled on it. No summary of the work, no caveats,
no next steps, no bullets, no emoji. Brevity is the deliverable here.

One exception, only when something was deferred: a paste-ready `Parked:` block may follow, so the
parking outlives the session that decided it. Still read-only — you print it, the user places it,
and `/raise-issue` files any of it that deserves a tracked issue.

**B — Ambiguous items exist (no blockers).** Ask, via the **AskUserQuestion** tool — one question
per ambiguous item, max four, each offering the real options (do it now / defer / won't do).
Open with the tool call; do not narrate the questions in prose first. Then stop and wait; the
answers are the user's, and carrying them out is a separate ask.

**C — Blockers exist.** A short, flat list — blockers first, then anything ambiguous underneath.
One line each: what is broken, where (`file:line`), and what it blocks. Every referenced item as
`#123 — Exact issue title`. No preamble, no reassurance, no restating the session. If blockers
and ambiguous items both exist, the blocker list comes first and the shape-B questions follow it
in the same turn — that list is the only text allowed to precede them, and undecided items appear
as questions only, never also as bullets in the list.

## Guardrails

- **Do not fix anything.** Naming a blocker is the whole job; the user decides what happens next.
- **Do not invent closure.** If the sweep cannot establish something (a test that never ran, an
  issue title that will not resolve), that is an open point, not an assumption.
- **A single unresolved point makes the answer no.** This gate exists to be strict; a
  yes that is nearly true is the failure mode it is built to prevent.

## Relationship to other skills

`/fresh-eyes` asks *is the work correct?* — a blind read of the diff against the intent.
`are-we-done` asks *is the conversation closed?* — a sweep for undecided points. Run
`/fresh-eyes` first if you want the diff audited; findings it leaves open show up here as
`AMBIGUOUS` or `BLOCKER`. `/brief-me` is the mirror image at the other end: it reopens a session,
this one closes it. `/ship-it` is the next step when the answer is yes and the work is meant to
go out — this gate says the session can close, not that anything has shipped. `/ship-it` calls this
sweep at the end, once the release is out and verified — never before landing, because shipping
work that is still in testing is a deliberate use of it, and a gate that argued with that would
just be in the way. Run after, the sweep says what is left; it never holds or reverses a ship.
