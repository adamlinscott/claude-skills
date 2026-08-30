# are-we-done — reference

The sweep in detail, and the three output templates verbatim.

## The sweep

Deterministic means the same six sources every run, in the same order, whether or not the
session "feels" finished. Skipping a source because it looks unlikely is how a yes becomes wrong.

### 1. Todo list

Read the active todo list. Anything not `completed` is a hit — including items marked
`in_progress` that the conversation later moved past.

### 2. This session's own promises

Re-read the session for commitments and loose ends, not for a summary. The phrasings that matter:

- "I'll do X next" / "then we can" / "the next step is"
- "for now" / "leaving that" / "we can come back to" / "in a follow-up"
- "we should also" / "it might be worth"
- "one option is…" presented as a choice and never chosen
- any question you asked the user that the next message did not answer
- anything a review, subagent, or `/fresh-eyes` report raised that was never dispositioned

Each of these is a hit until you can point at where it was decided.

**When the transcript is not all there.** A long session may have been compacted, and the
promises made earliest are the ones most likely to have been summarised away. If you cannot see
the start of the session, record a hit of its own — `context: session compacted, early promises
not visible` — and say so in the output. A yes then reads *nothing undecided in what I can still
see*, not *nothing undecided*. Finding nothing in a source you can only half-read is not the same
fact as that source being clean, and collapsing the two is exactly the invented closure this
skill exists to prevent.

### 3. Work tree

```
git status --porcelain=v1 -b     # uncommitted, untracked, branch vs upstream
git diff --stat                  # size and shape of what is unstaged
git log --oneline -5             # what actually landed
```

Hits: uncommitted edits from this session, untracked files that look like session output,
`<<<<<<<` conflict markers, an interrupted merge/rebase/cherry-pick (`.git/MERGE_HEAD`,
`rebase-merge/`), or a multi-file change where only some files were updated.

Uncommitted work is not automatically a blocker — plenty of sessions end with an intentionally
dirty tree. It is a hit that needs a decision: commit, keep, or discard.

### 4. Markers introduced by this work

Three legs, all of them, because a session that ends dirty is the normal case and a marker
written ten minutes ago has not been committed yet:

```
git diff -U0                       # unstaged
git diff --cached -U0              # staged
git diff -U0 <range>               # committed this session
```

Pipe each through `grep -nE '^\+.*(TODO|FIXME|XXX|HACK)[:( ]'` — added lines only. The word
boundary and trailing punctuation matter: an unbounded pattern matches any added line that merely
*mentions* the word, so a doc or a skill file that talks about TODO markers reports itself.
Discard any hit that is prose about markers rather than a marker.

**The third leg's range.** It must cover the commits *this session* made, and only those:

1. Commits you made this session are identifiable from the session record → use
   `<first-such-commit>~1..HEAD`.
2. Otherwise fall back to `$BASE...HEAD`, resolving `$BASE` first-match-wins:
   `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), else `main`, else
   `master`. Say in the output that the range may include earlier sessions' commits.
3. `$BASE` does not resolve, **or** the session committed onto the base branch itself (where
   `$BASE...HEAD` is empty): drop the third leg and say so. Never run an unresolved placeholder,
   and never read an empty range as a clean sweep — those are different facts.

A marker the session wrote is an open point; a marker that was already in the file is someone
else's, and out of scope. If in doubt, `git log -S` the line or leave it out — a false hit here
is noise, and noise is what stops this gate being run.

### 4b. The severity floor

Strict is the default: an uncommitted tree and "not verified since the last edit" are `AMBIGUOUS`
and force a no. The floor lifts for one specific ambient state at a time, only on evidence about
how *this* project actually works.

**Evidence that lifts "not verified since the last edit":**

- CI runs the suite on push or merge, and this session pushed or merged — a workflow file plus an
  actual push, not the workflow file alone.
- The user ran the tests themselves this session, or said they test manually before merging.
- A recorded workflow note for this project says so (below).

**Evidence that lifts "uncommitted tree":**

- The user's own pattern, stated or recorded: they commit at the end, or review the diff before
  committing, and a dirty tree at session end is normal for them.
- The session already decided what happens to the tree ("leave it, I'll commit in the morning") —
  that is a `DEFERRED` item, not an ambient state, and needs no floor at all.

**What lifting does and does not do.** A lifted state is still named — the yes sentence says
"tree left dirty; CI covers the suite on push" — it just stops forcing a no. Lifting is per
state: CI evidence says nothing about the tree, and vice versa. Absent evidence, stay strict; an
assumption that CI probably covers it is precisely the invented closure this skill forbids.

**Recording the workflow.** If you observe a stable pattern that is not yet recorded — CI green
on every merge, or a user who always commits last — you may **offer once**, at the very end, to
save it to this project's Claude memory so later sessions inherit the floor. Never write it
silently, and never widen an existing note beyond what you actually saw. Read the memory every
run; write it only when asked. This is the one thing the skill may persist, and it lives outside
the work tree — the repo stays untouched either way.

### 5. Verification state

Establish, from the session record rather than from memory: which of tests / typecheck / lint /
build ran, whether they ran **after the last edit**, and what they returned. Nothing run since
the last change is itself an open point — phrase it as "not verified since the last edit", never
as "passing".

### 6. Referenced work items

Collect every `#123`, `ABC-456`, PR link, or issue URL mentioned this session, then resolve each
to its title:

```
gh issue view 123 --json title
gh pr view 45 --json title
```

Output format, always: `#123 — Exact issue title`. Never a bare number.

When resolution fails — no `gh`, no network, a tracker with no CLI (Jira, Linear) — fall back in
this order. Both rungs quote a title someone actually stated; neither infers one from the
surrounding code or conversation:

1. The title as it was stated **in this session**, marked: `#123 — Add CSV export (unverified)`.
2. Nothing to fall back on: `#123 — title unresolved`.

An unresolved title does **not** by itself make the answer no. A missing `gh` is an environment
gap, not an undecided point, and a gate that answers no because of the tooling on the machine
stops being run. It changes the verdict only when the item's own disposition turns on what that
issue says — then it is `AMBIGUOUS` and belongs in a question, phrased as "I could not read
#123; is it the one covering X?".

## Output templates

### Shape A — yes

```
Done — nothing undecided.

<One sentence naming what was completed, and what was parked.>
```

Two lines of text, one blank line between them. That is the whole output. Resist every urge to
add a third line: no bullet list of what was done, no "let me know if", no next steps, no caveat.
The brevity is the signal that the sweep came back clean.

**The deferral block.** When anything was parked, the two lines may be followed by a block the
user can lift straight out — nothing else. One line per deferred item: what it is, why it was
parked, and where it was parked to if that is known.

```
Parked:
- Swap the in-memory store for Redis — deferred to #88 — Swap the in-memory store.
- Retry budget on the webhook sender — no owner yet, raised twice this session.
```

If a parked item deserves a tracked issue and does not have one, say so in one line and name
`/raise-issue` as the way to file it — it turns the description into an issue in the team's own
vocabulary. Do not file it yourself: this skill writes nothing to a tracker, and a deferral the
user has not seen is not one they agreed to.

**"Nothing undecided", never "nothing outstanding".** A `DEFERRED` item is outstanding by any
ordinary reading; what the sweep established is that someone ruled on it. So the sentence carries
both halves in one breath — *Rate limiter shipped and tested; the Redis backend is parked to
#88 — Swap the in-memory store.* Anything parked gets named there or it is invisible, since
there is no third line to put it on.

No emoji, no status glyph. The verdict word carries it, and this collection's `/ttp` may well be
on in the same session.

### Shape B — ambiguous only

Go straight to the **AskUserQuestion** tool. One question per ambiguous item, at most four
(if more than four, ask about the four with the largest consequence and note the rest in one
line afterwards). Each question:

- `header`: 1–3 words naming the item.
- `question`: what is undecided and why it is undecided, in one sentence.
- Options: the real ones — **Do it now** / **Defer** / **Won't do** — kept to a few words each,
  with the consequence in the option's description rather than its label. Recommended option
  first, marked `(Recommended)`.

Nothing before the tool call except shape C, when there is a shape C. On its own, shape B opens
with the tool call and no preamble — do not narrate the questions in prose first. Mixed with
blockers, the blocker list comes first and the questions follow it in the same turn; that list
is the only text allowed to precede them.

After the answers come back, state the resulting disposition in one line per item and stop;
acting on them is a separate request.

### Shape C — blockers

```
Not done. <N> blocker(s):

- <What is broken> — `path/to/file.ts:42`. Blocks <what>.
- <What is broken> — relates to #123 — Exact issue title.
```

Flat, short, no softening. Lead with the defect, not with context.

Blockers only ever appear here, undecided items only ever appear as shape-B questions — never
both places. When a run has both, this list comes first and the questions follow it in the same
turn; do not restate the undecided items as bullets above the cards.

Do not append a plan, an offer to fix, or a summary of the session. The list is the message.
