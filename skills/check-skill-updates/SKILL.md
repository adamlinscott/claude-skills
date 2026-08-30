---
name: check-skill-updates
description: 'Check whether the installed copy of this skills collection is behind its remote, and offer to update it. Runs a script that resolves the clone the skills are linked from, respects a once-a-day rate limit and a remembered refusal, and reports one of: up to date, N commits behind, unsafe to touch, or offline. Only "behind" is ever mentioned to the user; everything else is silent. On a yes it pulls and re-links, changing nothing about which skills are installed. Use when the user asks whether their skills are up to date, or when another skill reaches a natural close and wants to mention a waiting update.'
allowed-tools: Bash, Read
---

# check-skill-updates

Say nothing unless there is something to say. This skill exists to mention a waiting update **once**,
at a moment when the user is not busy — and to be invisible the rest of the time.

## Run it

```
node <repo>/tools/freshness/check.mjs
```

`<repo>` is the clone the skills are linked from. Resolve it from **this file's real path**, not
from the working directory: `~/.claude/skills/check-skill-updates` is a link, so its target's
`../../tools/freshness/check.mjs` is the script. The working directory is whatever the user
happens to be editing, which is usually a different repo entirely.

The script prints one line of JSON and nothing else. Flags: `--force` (the user asked directly,
ignore the rate limit), `--update` (pull and re-link), `--decline` (remember this was turned down).

## What each verdict means

| Verdict | What you say |
|---|---|
| `fresh` | Nothing. Silence is the correct output. |
| `too-soon` | Nothing. Already checked within the day. |
| `offline` | Nothing. A failed fetch is not the user's problem to hear about. |
| `not-installed` | Nothing, unless the user asked directly — then say the clone could not be found. |
| `unsafe` | Nothing, unless the user asked directly — then say the clone is on `<branch>` or has uncommitted changes, so it is not safe to pull for them. |
| `behind` | **One line.** See below. |
| `updated` | One line: what was applied. If `refreshed` is false, say the pull worked but the re-link did not, and name `node <repo>/install.mjs --refresh`. |

When the user invoked this skill directly, report every verdict plainly — being asked a question
is licence to answer it. When another skill called you, only `behind` earns any words at all.

## Mentioning an update

One line, at the very end of whatever the calling skill was already saying, never in the middle:

> Skills update available — 3 commits behind (`feat(are-we-done): add close-out gate`). Update now?

Then honour the answer:

- **Yes** → run with `--update`, then say in one line what was applied. The pull is safe mid-session:
  it changes the text of skills you already have, adds and removes nothing, and anything already
  running finishes on the version it started with.
- **No** → run with `--decline` and drop it. That version is never raised again, however long it
  sits there. Do not re-ask tomorrow; the answer has not expired.
- **No answer** → drop it. An ignored offer is a no.

Never mention an update next to a failure. If the calling skill is reporting blockers, a broken
build, or anything the user has to act on, stay silent — an update offer stapled to bad news
dilutes both, and this is the one thing here that can always wait.

## Who calls this

`/are-we-done` on a clean close, `/ship-it` once the release is out and verified, `/brief-me` when
re-entering a session. All of them skip this silently if it is not installed; none of them treat it
as a prerequisite. The rule they share is that the work has to be finished first — this is a
footnote to a natural close, never an interruption of one.
