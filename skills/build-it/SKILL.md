---
name: build-it
description: '[Adam Skills] Build a piece of work, from wherever it is written down — a ticket number or URL, a plan or spec file, the plan agreed in the conversation above, or a description typed straight after the command. Reads whatever source it is given plus the code it names, then asks whatever the source and the code left unanswered — the why above all — before pinning in writing exactly which files will change and which will not. That scope note goes to disk, so it survives compaction and gives a later review something concrete to check against. Then it builds to that scope and stops, handing off rather than chaining. Where the ask turns out to be large and still foggy it says so and points at a planning pass first, rather than building into the fog. No issue tracker is required. Use when something is ready to implement: "/build-it 412", "/build-it add rate limiting to the export endpoint", "build what we just planned", "implement this ticket".'
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# Build It

However the work reached you, it arrived compressed. A ticket records *what* somebody decided and
almost never *why*; a plan written an hour ago leans on a conversation that is about to be
compacted; a one-line request carries the whole reason in the requester's head and none of it on
the page. Building straight from any of those means building from the compression artefact.

This skill decompresses before it writes any code: read whatever the work is written down in, read
the code it names, ask whatever those two left unanswered, and write down what is in scope and
what is not. Then build that, and only that.

The two failure modes it exists for are **building the wrong thing confidently** and **scope
creep**. The first is answered by the interview, the second by the scope note.

**No issue tracker is required.** A ticket is the tidiest input, not the only one.

```
/build-it 412                        # a ticket number
/build-it #412 · /build-it <url>     # the same, or an issue URL
/build-it docs/plan-auth.md          # a plan or spec file
/build-it add rate limiting to the export endpoint   # a description, typed straight in
/build-it                            # takes the plan agreed in the conversation above
/build-it 412 --scope-only           # stop after the scope note; write no code
/build-it 412 --commit               # commit at logical points (default: no commits)
```

## 1. Work out what you are building

Four sources, in this order. Use the first that yields something concrete, and say which one you
took so the user can correct you before any time is spent.

1. **A ticket reference** — a number, `#number`, or a URL. Needs a tracker: find it the way
   `/raise-issue` does, stopping at the first hit — `docs/agents/issue-tracker.md`, then
   `git remote -v` plus the matching CLI, then repo evidence (`.github/ISSUE_TEMPLATE/`,
   `CONTRIBUTING.md`, tracker URLs in docs, configured MCP servers). Check the CLI is
   authenticated **now**, before the interview — discovering `gh` is logged out after ten minutes
   of questions is the avoidable failure. Then read the **whole** thing: body, every comment,
   linked and blocking issues, any attached spec. Comments are where the why usually hides, and
   where a decision has most often been reversed without the body being updated. If the body and a
   later comment disagree, the comment wins and you say so.
2. **A file path** — a plan, spec, ADR, or design note. Read it in full, and read what it links to.
3. **A description typed after the command** — treat the user's words as the brief. There is no
   written record behind it, so the interview in step 3 carries the whole load.
4. **The conversation above** — with no argument, derive the work from what this session has
   already agreed, plus any plan, spec or notes written during it. State the derived goal back in
   one sentence and get a yes before going further. Do not guess a goal into existence to keep
   moving: if the conversation does not add up to something concrete, say what is missing and ask.

**Then check the size of what you just picked up.** This gate exists because sources 3 and 4 have
no author who already did the thinking, so a two-line request can be hiding a fortnight of work.
If the ask is large *and* still foggy — the destination is not clear, or the route to it is not,
or it plainly spans many sessions — do not start building. Say so plainly, in a line or two, and
point at the right first step:

- **Big, and the decisions are not made yet** → `/wayfinder` if installed: it charts the work as
  decision tickets on the tracker and resolves them one at a time. Come back here with a ticket
  number afterwards.
- **Not huge, but under-specified or built on shaky reasoning** → `/grilling` if installed, for a
  proper adversarial pass over the idea before any code.
- **Neither installed** → run a longer version of step 3 yourself and say that is what you are
  doing.

This is a recommendation, not a refusal. If the user says build it anyway, build it — record the
fog in the scope note's *Assumptions* and carry on. A clear ask of any size goes straight through;
size alone is never the trigger, only size together with fog.

If a named ticket cannot be reached, say exactly why and what would fix it, and offer to proceed
from a description instead. Never invent the contents of a ticket you could not open.

## 2. Read the code before asking anything

**First, check you are in the right place.** Cheap, and wrong often enough to be worth the three
commands: `pwd` and `git remote -v` to confirm this repo is the one the ticket belongs to, and a
look at whether you are sitting in a workspace of several repos where the change might span more
than one. Then ask what platforms this has to run on — "whatever I am running on" is an assumption,
not a requirement, and it is the one that quietly produces a Windows-only path or a script that
needs a login only you have. If any of that does not hold, stop and say so before reading further.

Then take the nouns in the ticket and find what they name in this repository — files, symbols,
routes, tables, tests, and the conventions around them. Read the neighbours of anything you will
change, and check any contract you plan to rely on against the live code rather than against an
ADR or design doc, which records a decision rather than a guarantee that it is still true.

This is not preparation for building; it is preparation for **asking**. Every question you can
answer from the code is a question you must not spend on the human. Their attention is the scarce
resource here, and there is a hard cap of four questions coming.

## 3. Ask whatever the source and the code left unanswered

Use `AskUserQuestion`. **There is no fixed number of questions.** The right number is however many
it takes to be able to defend the design to a reviewer, and not one more — which depends entirely
on how much arrived written down.

- **A well-written ticket that carries its own rationale**: often none. Say why you skipped ahead
  and go to step 4.
- **A thin ticket, or a plan whose reasoning lived in a conversation you cannot see**: a handful.
- **A one-line description typed straight after the command**: as many as it genuinely takes.
  Nothing was written down, so everything the ticket would have carried has to come from the
  person instead. Two or three rounds here is correct, not a failure.

The discipline is **never ask what you could have read** — not a quota. A cap would only ever bite
in the case where questions are most needed, which is the case with the least written down.

Two checks instead of a cap. If you are still asking after several rounds and the picture is not
converging, that is not a longer interview, it is the size-and-fog signal from step 1 arriving
late — stop and offer `/grilling` or `/wayfinder`. And ask in rounds rather than in one wall:
later questions should be shaped by earlier answers, and a batch of six at once is bewildering
whatever the total ends up being.

Ask in priority order, stopping as soon as you could defend the design to a reviewer:

1. **Why this, and why now.** The single most valuable thing missing from most sources, and the
   one that changes implementations. "Make the export async" built to relieve a timeout is a
   different change from the same sentence built to enable scheduled exports. Ask what problem
   the person hit, or what becomes possible once this lands.
2. **What "done" looks like to them.** Not a test plan — the observable difference. Ambiguity
   here is what produces a technically complete change that nobody wanted.
3. **Genuine forks in the road.** Wherever the brief admits two readings that lead to materially
   different work and the code does not pick one. Offer the options, name the trade-off, and
   recommend one. There may be several; ask about each that actually changes the build.
4. **Boundaries you suspect are contested.** Where the obvious implementation would touch
   something that feels like it belongs to someone else, or where the wording quietly invites a
   refactor. These pre-empt the scope argument in review.
5. **Anything else load-bearing that nothing on the page settles.** Constraints, deadlines,
   compatibility the change has to keep, people whose work it touches. Thin briefs generate most
   of their questions here; a good ticket generates none.

Rules that hold on every run:

- **Offer the exit on every question.** Each one carries a "you decide / just build it" option.
  One keystroke ends the interview.
- **"I don't know" is a real answer.** Record it, act on the most defensible reading, and note
  that reading in the scope note. Never ask the same thing again in different words.
- **Never quote code at them.** File paths as evidence are fine; a diff is not an explanation.
- **Say when you go quiet.** Step 2 takes time and silence reads as a crash. One line before it:
  what you are about to go and read, and that you will be back with questions.

## 4. Pin the scope, in writing

Write the scope note **outside the repository** and show it in the conversation. Template in
[REFERENCE.md](REFERENCE.md). Put it in this session's scratchpad directory if the environment
names one, otherwise `~/.claude/build-it/<repo-name>/scope-<id>.md`, creating the directory if
needed. Say the path once so the user can open it.

**It never goes in the repo and it is never committed.** A scope note records decisions taken at
one moment against one state of the code; committed, it becomes a stale plan sitting in the tree
forever, contradicting the code around it and trusted by whoever finds it next. It is working
context for this build and the review that follows it, not a project artefact. So: never write it
under the working tree, never `git add` it, and never include it in a commit — not with
`--commit`, not when the user asks for a commit later, not as "just this once". If the user
explicitly asks for a copy inside the repo, that is theirs to decide: write it where they say and
tell them once that it will go stale.

It has four parts, and the second is the one that earns the file:

- **Building** — the change, in one paragraph, in the project's own vocabulary.
- **Will change** — the files and areas this will touch. Named, not gestured at.
- **Will not change** — the things a reasonable implementer might have touched and this one will
  not. Adjacent bugs found on the way, the tidy-up the code is asking for, the second caller that
  has the same problem, the test file that could be restructured. **Each with one line on why
  not**, and where it should go instead: a follow-up ticket, a later session, or nowhere.
- **Assumptions** — what this rests on that nobody confirmed, including anything answered "I
  don't know" in step 3, and the reading you took instead.

**Mark where every claim came from.** Each entry gets `[cited: file:line]` when something on disk
or the ticket establishes it, or `[assumption]` when it does not. This is not decoration, and it is
a stricter test than it looks: the question is not "am I unsure about this?" but "can I point at
what makes it true?" Those catch different mistakes. Listing what you are unsure about finds the
known unknowns; citing every claim finds the ones you were confident about and wrong. The second
kind is what produces a build that is coherent, complete, and aimed at the wrong thing.

Anything still `[assumption]` when the note is written either goes in the Assumptions section or
gets settled first — and settling is usually one grep. Never upgrade a guess to a fact because it
feels obvious; if you did not cite it, it is still a guess.

Then confirm it. One question: build this, or adjust the scope first.

The *Will not change* list is the entire point of writing this down. Scope does not creep by
someone deciding to expand it; it creeps because nobody ever wrote down where the edge was, so
each individual step past it looked like ordinary diligence. A written edge turns each of those
steps back into a visible decision.

It goes to disk rather than staying in the conversation for two reasons: a long build gets
compacted, and this survives it; and a later review — `/fresh-eyes`, `/code-review`, a human —
gets a concrete bar to check against instead of the implementer's memory of intent.

**`--scope-only` stops here.** The scope note is the deliverable; write no code.

## 5. Build it

Implement what the scope note says, following the repository's own conventions — its test
framework, its patterns, its error handling. Where the repo practises TDD and `/tdd` is
installed, use it at the seams you agreed.

Run the project's checks as you go the way a careful developer would: typecheck and the relevant
test file often, the full suite once at the end. This is ordinary working discipline, not a
verification ceremony — do not add extra passes over work that already passed, and do not delegate
a subagent to re-check what you just did.

Delegate only where the work genuinely splits into independent tracks that are each large enough
to be worth their own context. Most tickets are not that, and a fan-out on a single-module change
costs time rather than saving it.

**Git posture.** By default this skill makes **no commits** — it builds in the working tree and
leaves version control to the user. With `--commit`, commit at logical points on a feature branch,
branching first if the current branch is the default one. Commit code only: the scope note lives
outside the tree and stays out of every commit. It never pushes, and never opens a PR; that is
`/ship-it`.

**If the scope note turns out to be wrong** — the real change is bigger than it looked, or a
blocker sits outside the boundary — stop and say so. Update the note, show what changed, and get a
yes. Do not quietly widen the scope you just wrote down; that is the specific failure this whole
skill is arranged to prevent.

## 6. Report and hand off

Close with a short report: what was built, each *Will change* item marked done or not, anything
from *Will not change* that is now worth a follow-up ticket, any assumption that is still
unconfirmed, and the state of the tree (committed or not).

Then **stop and name the next step** rather than running it:

- `/fresh-eyes` — an independent read of the diff against the scope note.
- `/are-we-done` — the close-out sweep, if the session is ending here.
- `/ship-it` — if it is verified and meant to go out.
- `/raise-issue` — for anything on the *Will not change* list that deserves tracking.

Chaining these automatically is the wrong default. Each is a real decision with a real cost, the
user is right here, and a skill that runs three more skills on its own is how a ticket turns into
an afternoon nobody agreed to.

## Guardrails

- **Ask as much as the gap needs, and nothing you could have read.** There is no question quota;
  there is a rule about what earns a question. This skill's value is the human's attention, spent
  only on what genuinely lives in their head — a thin brief earns many questions, a good ticket
  earns none, and both are the skill working correctly.
- **A tracker is optional; a source is not.** Never fabricate ticket content, and never build from
  a goal you inferred but did not state back and have confirmed.
- **Size plus fog means plan first, not build harder.** Offering `/wayfinder` or `/grilling` is
  cheaper than discovering mid-build that the destination was never agreed.
- **The scope note is written before the code, not after.** Written afterwards it is a summary of
  what happened, which is exactly the thing it exists to prevent.
- **The scope note never enters the repository.** It is written outside the working tree and never
  committed. Plans committed to a repo go stale silently and mislead the next reader.
- **Report in plain English.** The person who filed the ticket may not read code. File paths are
  evidence; they are not an explanation.

## Relationship to other skills

This replaces two retired skills, and carries forward the part of each that was worth keeping.

From `/goal-workflow`: **write the scope down before any code**. The rest of it — a gate on
maximum effort, mandated subagent fan-out, verification at every milestone — is redundant or
counterproductive on current models, which is why it went.

From `/assumption-inventory`: the **root and platform check** in step 2, and the **cite-or-flag
discipline** in step 4. Its six slots are now step 4's four headings, so running both duplicated
most of a pass. Work that never came from a ticket is not lost with it — a plan file, a spec, or a
plain description all enter this skill at step 1, and the interview simply does more of the work
when there is no written record to mine ([REFERENCE.md §6](REFERENCE.md)).

Upstream, this pairs with whatever produces the ticket — `/raise-issue` here, or Matt Pocock's
`/wayfinder` and `/to-tickets`. Where his `/implement` starts from a spec or a set of tickets and
goes straight to building, this one starts from a single ticket number and spends its first
minutes on the two things a ticket does not carry: the why, and the edge.

`/reground` is what to run if the build drifts anyway.
