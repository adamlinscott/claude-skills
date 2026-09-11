---
name: brief-me
description: '[Adam''s Skills] Print a plain-English re-entry briefing for a user who has lost the thread of a long-running session — after a distraction, overnight, or over a weekend. Re-explains what the session is, where it got to, what state the work is in right now, what Claude is waiting on from the user, and the single next step. Grounds every claim in git and files on disk before narrating, so it re-explains the session rather than inventing a tidy story of it. Report only: it writes nothing and never resumes work. Invoke with /brief-me.'
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash
---

# Brief Me

The user has come back to this session with weak or no memory of it. Reading the last message
will not fix that: the last message was written for someone who was here five minutes ago. It
leans on pronouns, on shorthand coined mid-session, and on file names introduced hours back.
It continues the thread; it does not introduce it.

Produce **one short briefing that puts them back in the chair.** Then stop.

## 1. Check the state before you narrate

The failure mode of this skill is a fluent, confident, wrong story. Guard against it by
reading the real state first, not your memory of it:

- `git status` and `git diff --stat` against the base branch — what is actually changed, and
  is anything half-applied?
- `git log` for recent commits, and the current branch name.
- Any plan, spec, or todo file written during this session, and the active todo list.
- Whether tests were run, and what they said.

Then hold two categories apart as you write. A claim backed by disk or git is stated flat. A
claim recalled from the conversation and not checkable is marked as recalled, with the check
named. Never assert a piece of work is finished without confirming the file exists.

## 2. The brief

Six headings, in this order. The whole thing fits on one screen.

**In one line** — the entire session in one sentence a stranger could follow.

**What we're doing** — the goal in plain terms, one or two sentences. This thread, not the
codebase.

**Where we got to** — the arc so far. Up to five bullets. Completed work only.

**Right now** — the frozen frame. What is on disk this second. Say loudly if anything is
half-applied or the working tree is incoherent; coming back to a partly-finished multi-file
edit is the case that hurts most. Note when tests last ran and what happened.

**Waiting on you** — split three ways, dropping any that are empty:
- *Decide* — genuine decisions, each with your recommendation.
- *Tell me* — information you cannot find for yourself.
- *Do* — anything only they can perform: a login, a deploy, an approval.

If all three are empty, one line: `Nothing — say go.`

**If you just say go** — the single next concrete step. Not the rest of the plan.

## 2b. One optional footnote

If `/check-skill-updates` is installed, run it after the brief and append its single line if it has
one. Coming back after time away is when an update is most likely to be waiting and least likely to
interrupt anything. Skip it silently if it is not installed, and drop it entirely if the brief had
to report a half-applied edit or an incoherent tree — that is the user's first problem, not this.

## 3. Two more sections, only when they have content

Render these only if there is something real to put in them. Omit them silently otherwise.

**While you were away** — the repo moved under them. New commits on the branch, changes they
did not make, a base branch that advanced, uncommitted files from another session. Write it in
plain terms: "someone changed three files in the project since Friday", not a raw `git log`.

**Thin spots** — where this brief is unreliable. If the session was compacted, say so and say
where the detail runs out. If a claim is recalled rather than verified, name it and say how to
check. Do not narrate over a gap as though it were solid.

## 4. How to write it

Follow the *Sentence-level shaping* rules in the `ttp` skill (`../ttp/SKILL.md`, or
`~/.claude/skills/ttp/SKILL.md` when installed). Do not restate them here. Three rules on top,
specific to re-entry:

- **No unresolved back-references.** No "as we discussed", no "the fix from earlier", no
  pronoun whose referent lives in the transcript. The reader has no transcript.
- **Expand every session-coined term at first use.** Shorthand invented mid-session is the
  highest-risk vocabulary in the brief: familiar to you, invisible to them. Same for acronyms
  and internal nicknames.
- **Plain sentences, real names.** Simplify the sentence, never the identifier. Write
  "`install.mjs`, the installer script" — not "the config file". They have to go and find
  these things.

## 5. Never

- Never open with "Continuing from where we left off." They have no *where*.
- Never re-explain the codebase. Explain this thread.
- Never praise the progress.
- Never hide uncertainty behind confident narration.
- Never resume the work. Print the brief and wait.
- Never ask a question before the brief. Instant re-entry is the whole point.

## 6. Close and stop

End with exactly this pull line:

> Say `more` for the full history, or `go` to continue.

On `more`, expand: the reasoning behind the current approach, what was tried and rejected and
why, and the detail cut from *Where we got to*. Length is fine there; add headers so it can be
skimmed. On `go`, resume normally.

## Edge cases

- **Fresh session, nothing in context.** Say so plainly, give the repo-state-only brief from
  step 1, and do not invent a session that did not happen. If gstack's `/context-restore` is
  installed, point at it — that skill rebuilds context from saved artifacts.
- **Compacted session.** Write the brief from what survives, and declare the compaction under
  *Thin spots*.
- **Short session with nothing to re-enter.** Say that in a line rather than padding six
  headings out of two exchanges.

## Not this skill

`/reground` also stops and takes stock, but with the opposite posture: it distrusts the session
and re-anchors the *agent* to `file:line` evidence. `/brief-me` trusts the session and
re-orients the *human*. If the work itself has gone off the rails, that is `/reground`.

gstack's `/context-restore` rebuilds *Claude's* context in a new session. `/brief-me` rebuilds
the *user's* context in the current one.
