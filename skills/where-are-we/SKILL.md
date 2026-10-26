---
name: where-are-we
description: '[Adam''s Skills] Quick status of the current session: what is done and what is left. Checks how long it has been since the last message before this one. If the user has been active within the last half hour, it answers with just the two lists. If they have been away longer, or the gap cannot be measured, it opens with a short paragraph on what the task actually is. Grounds the lists in git and files on disk, not memory. Report only: it changes nothing and does not resume work. Triggers on /where-are-we, or on the phrase "where are we" anywhere in the user''s message, with or without a question mark.'
allowed-tools: Read, Grep, Glob, Bash
---

# Where Are We

The user wants to know how far the work in this session has got. How much they need depends on
how long they have been gone, so measure that first.

**Tune here:** the user counts as *still active* if the last message before this one was under
**30 minutes** ago.

## 1. Measure the gap

```
node <skill-dir>/idle.mjs ${CLAUDE_SESSION_ID}
```

`<skill-dir>` is the folder this file is in. Resolve it from **this file's real path**:
`~/.claude/skills/where-are-we` is usually a link, and the script sits beside its target. It
prints one line of JSON:

- `{"lastMessageAt": ..., "minutesAway": n}` — the gap between now and the last message before
  the user's current one.
- `{"unknown": "<why>"}` — no transcript, or no earlier message. Treat as away.

Under the threshold: **active**. At or over it, or unknown: **away**. If in doubt, choose away.

## 2. Check the state before you write

Read the real state, not your memory of it: `git status`, `git diff --stat` against the base
branch, recent `git log`, the active todo list, and any plan or spec file written this session.
Do not call a piece of work done without confirming it is on disk. If a claim comes only from the
conversation and cannot be checked, mark it *(recalled)*.

## 3. The answer

**Active** — two short lists, nothing else:

**Done** — completed work, up to five bullets.

**Left** — what remains, in the order it will be done, up to five bullets. If something is
waiting on the user, say so on that bullet. If nothing is left, say `Nothing left.`

**Away** — the same two lists, preceded by one short paragraph (two to four sentences) saying
what the task is: what is being built or fixed, and why. Write it for someone who has forgotten
the session: no "as we discussed", no session-coined shorthand left unexplained, real file names.

When away, two more things, only when they have content:

- **Changed while you were away** — one or two plain sentences if the repo moved under them: new
  commits on the branch, a base branch that advanced, files they did not change. Goes after the
  paragraph, before the lists.
- **Update footnote** — if `/check-skill-updates` is installed, run it after the lists and append
  its one line if it has one. Skip it if *Left* opens with a half-applied edit.

Follow the *Sentence-level shaping* rules in the `ttp` skill (`../ttp/SKILL.md`, or
`~/.claude/skills/ttp/SKILL.md` when installed) for both.

## 4. Stop

No closing question, no offer to continue. If the user's message asked for something else as
well, answer that after the status.

## Edge cases

- **Nothing has happened yet in this session.** Say so in one line, and give the repo state from
  step 2 only if there is uncommitted work.
- **Half-applied edit or incoherent working tree.** Put it first under *Left*, plainly.
- **Compacted session.** Write from what survives, and say in one line where the detail runs out.

## Not this skill

`/reground` also takes stock, but it distrusts the session and re-anchors the *agent* to code
evidence. `/where-are-we` trusts the session and re-orients the *user*. If the work itself has
gone off the rails, that is `/reground`.
