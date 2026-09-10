# build-it — Reference

Templates and detail for the [SKILL.md](SKILL.md) workflow.

## §1 Reading a ticket properly

What to pull, per tracker. The point is the same everywhere: the body is the summary, the
comments are the record.

| Tracker | Body + comments | Links |
|---|---|---|
| GitHub | `gh issue view <n> --json title,body,labels,state,comments,url` | `gh issue view <n> --json closedByPullRequestsReferences`; sub-issues and `Blocked by` lines in the body |
| GitLab | `glab issue view <n> --comments` | related issues in the output |
| Jira | the configured MCP server, or `docs/agents/issue-tracker.md`'s documented command | `issuelinks` on the issue |
| Local markdown | the file the tracker doc names | links written as relative paths |

Three things to check for explicitly, because each one silently changes what should be built:

- **A comment that reverses the body.** Common, and rarely reflected back into the description.
  The latest decision wins; say in the scope note that you took it.
- **A blocking ticket that is still open.** If the thing this depends on has not landed, that is
  a stop-and-ask, not a detail.
- **A label that carries process meaning in this repo** — `needs-design`, `blocked`, `wontfix`,
  a triage state. Read `docs/agents/issue-tracker.md` for what the labels mean here rather than
  assuming a convention.

## §2 The questions — worked examples

Not a script, and not a fixed set. These show the *shape*: every question names what you already
worked out, so the human is correcting a draft rather than writing one from scratch. How many you
ask depends on how much arrived written down — a good ticket may need none of these, a one-line
request may need all of them and more.

**Why this, and why now**

> The ticket says the export should run in the background. I can see two reasons that would
> make sense from the code — the 30-second gateway timeout in `api/export.ts:88`, or wanting
> exports to be schedulable later. Those build differently: the first needs a job and a
> progress endpoint, the second needs a job *and* a queue the scheduler can put work on.
> Which is it?
>
> Options: `the timeout` / `scheduling later` / `both` / `you decide`

**What done looks like**

> When this is finished, what should you be able to do that you can't do now? I want the
> observable version, not the technical one — "the export finishes without me having to keep
> the tab open", that kind of thing.

**A genuine fork**

> The ticket says "notify the user when it's ready". This repo has two notification paths: the
> in-app toast (`ui/notify.ts`) and the transactional email in `mail/`. The toast only works if
> they still have the tab open, which is the thing we're trying to stop requiring.
>
> Options: `email` / `in-app only` / `both` / `you decide`

**A contested boundary**

> Doing this properly means touching `api/export.ts`, which has the same timeout problem in
> two other endpoints. I plan to fix only the export path and leave the other two alone — but
> if you'd rather I did all three now, say so, because it's cheaper together than separately.
>
> Options: `export only` / `all three` / `all three, separate ticket`

Every one of these carries an exit option, and every one shows the reading you would take if the
answer were "you decide".

## §3 Scope note template

Written before any code, outside the repository — this session's scratchpad directory, or
`~/.claude/build-it/<repo-name>/scope-<id>.md`. Never committed.

```markdown
# Scope — <id> <title>

Source: <ticket #412 and its URL | docs/plan-auth.md | described in conversation, <date>>
Pinned <date>, before implementation.

## Building

<One paragraph, in the project's vocabulary. What changes from the user's point of view,
and the approach taken.>

## Why

<One or two sentences. From the source if it said; from the interview if it did not.
This is the line a future reader will most want and least often finds.>

## Will change

- `path/to/file.ts` — <what changes there> [cited: ticket / file:line]
- `path/to/other.ts` — <what changes there> [assumption]
- `test/path.test.ts` — <coverage added> [cited: test/export.test.ts:1]

## Will not change

- `api/other-endpoint.ts` — has the same timeout bug. Out of scope; worth its own ticket.
- The `Export` component's prop shape — tempting to tidy, but three other callers depend on
  it and none of them are in this change.
- Test restructuring in `test/export.test.ts` — the file is messy; that is not this change.

## Assumptions

- <Statement nobody confirmed.> If it is false, <what breaks>.
- Answered "don't know" in the interview: <question>. Proceeding on <the reading taken>.

## Done when

- [ ] <observable outcome, from the interview>
- [ ] <observable outcome>
```

### Assumptions that feel like facts

Check these by default at step 2, even when they feel settled. Each one looks like established
fact, is actually a guess, and is wrong often enough to be worth three seconds:

- **"The platform is whatever I am running on."** Running on Windows does not mean Windows-only.
  Prefer portable paths, shells and tooling unless the brief says otherwise.
- **"The scope is this one repo."** An agent sitting in a workspace of several repos develops a
  per-repo blind spot. Confirm whether the change stops at this repo's edge before scoping.
- **"My local auth is part of the contract."** A personal cloud login or an authenticated CLI is
  your environment, not a dependency the work may lean on. Never make *done* require a login only
  you have.
- **"The documented contract is current."** An ADR or design doc records a decision, not a
  guarantee it survived. Check the shape against live code before building on it.
- **"Done means the code is written."** Done is a checkable end state — it builds, the tests pass,
  the behaviour is observable. Pin that, not the activity.
- **"The goal is the literal request."** A narrowly-worded ask often sits on a larger unstated
  intent. This is what step 3's first question is for, and it matters most when the brief was one
  line typed straight after the command.

### Writing a good *Will not change* line

The list is worthless if it is abstract. Three tests for each entry:

1. **Would someone plausibly have done it?** If nobody would ever have touched it, it does not
   belong on the list. "Will not rewrite the database layer" is padding.
2. **Does it name a real thing?** A path, a symbol, a component. Not "unrelated refactors".
3. **Does it say where it goes instead?** Follow-up ticket, later session, or nowhere. An item
   with no destination gets silently re-litigated next week.

The entries that matter most are the ones that felt genuinely tempting while reading the code.
Those are the ones that would otherwise have ended up in the diff.

## §4 When the scope turns out to be wrong

Mid-build, one of three things happens. Handle them differently:

| What happened | What to do |
|---|---|
| The change is bigger than it looked, but the same shape | Update *Will change*, note it in the report, keep going. No stop needed — the edge held. |
| A blocker sits outside the boundary and nothing works without crossing it | Stop. Show the boundary and what needs crossing, and ask. This is a scope change and it is the user's call. |
| Something on *Will not change* turns out to be load-bearing | Stop. This is the list doing its job — the entry was written for exactly this moment. Ask before crossing it. |

In every case the file is updated to match reality before the report is written. A scope note
that disagrees with the diff is worse than none, because the next reader trusts it.

## §5 Report template

```markdown
## Built — <id> <title>

<One or two sentences: what now works that did not before.>

**Scope note:** `<path outside the repo>` (not committed)

**Done**
- [x] <Will change item> — <where>
- [x] <Will change item> — <where>
- [ ] <anything not done, and why>

**Held the line on**
- <Will not change item that came up during the build and was left alone>

**Worth a follow-up ticket**
- <item> — `/raise-issue` will file it properly

**Still unconfirmed**
- <assumption that survived the build>

**Tree:** <N files changed, uncommitted> | <committed to `branch`, not pushed>

**Next:** `/fresh-eyes` to review it against the scope note, or `/ship-it` if you are happy.
```

Keep it to what a person will read. The scope note holds the detail; this is the covering
message, and a report longer than the change it describes is a report nobody finishes.

## §6 Working without a tracker

A tracker is the tidiest input, not a prerequisite. Steps 2 to 6 are identical whatever the source;
only step 1 and the weight of step 3 change.

| Source | `<id>` for the scope note | What changes |
|---|---|---|
| Ticket number or URL | the ticket number | Nothing. The full path. |
| Plan / spec / ADR file | the file's basename | Read it and everything it links to. Its author already did some of step 3's work — check whether it recorded the *why*, and ask only if it did not. |
| Description typed after the command | 2–4 words, kebab-case, from the request | Nothing was written down, so step 3 carries the whole load. Expect several rounds. Run the size-and-fog check before any of it. |
| The conversation above | 2–4 words from the derived goal | State the goal back and get a yes first. Mine the session for decisions already made — do not re-ask what was settled an hour ago. |

**No tracker configured at all** — say so once, plainly, and carry on. It changes exactly one
thing: where the *Will not change* follow-ups go, which becomes a list in the report rather than
`/raise-issue`. It is a missing team setup, not a reason to refuse, and it is never worth more
than a sentence.

**When the source is the conversation**, two failure modes are specific to it. A session that has
been compacted may have lost the reasoning behind a decision it still remembers making — say so
rather than reconstructing it. And a goal derived from a long discussion is often the *last* thing
discussed rather than the *agreed* thing; state it back explicitly, because that is the cheapest
place to catch it.
