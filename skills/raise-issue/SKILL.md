---
name: raise-issue
description: Turns "this is broken" into a well-formed issue in the team's tracker, written in the codebase's own vocabulary. Built for someone who uses the product and does not read code — it asks a few plain-English questions, works out for itself which part of the code they are describing, checks whether the same thing has already been reported, and files it, but only after they say yes. Use when the user says something is broken, looks wrong, isn't working, is behaving oddly, seems like a bug, or asks whether they should tell someone about a problem they found; when they say "I found a bug", "the X isn't working", "should someone look at this?"; or when they paste a screenshot of something that looks wrong. Aliased as /report-issue.
allowed-tools: Read, Glob, Grep, Bash, Write, AskUserQuestion
---

# Raise an issue

A good bug report is not a good description. It is a description a developer can act on before
they have found the code themselves. That translation is the whole job here.

The person running this skill uses the product. They do not read code, and they should not have
to. They will say "the dashboard", "the thing that sends the emails", "the export button spins
forever". Your job is to take those words, find what they point at in this repository, confirm
the match in plain English, and hand a complete brief to whoever picks the issue up — so nobody
has to come back and ask this person a technical question.

## Why this skill can be triggered by the model

The omission of `disable-model-invocation` is deliberate, not an oversight.

The people this skill exists for do not know it exists. They will not type `/raise-issue`; they
will say "this looks wrong" and wait. Model invocation is the only mechanism that reaches them.

Being model-invocable is not unusual here — most of this collection is. What is unusual is the
**blast radius**. Every other model-invocable skill in this collection reports, audits, or edits
inside the repo; the worst case is a bad local change the user can undo. This one writes
**outside** it, to a tracker the whole team reads, under the user's own name, where a mistake is
public and cannot be quietly reverted. `/seatbelt` carries a comparable weight and answers it the
other way, with explicit invocation only.

So the containment is not the frontmatter. It is **step 5**: nothing is published, commented on,
handed to another skill, or written outside this conversation until a human has read the finished
text and said yes. Keep that gate where it is, and keep it ahead of publishing. It is the only
thing making auto-invocation safe here, and it is a prose instruction rather than a mechanical
lock — so treat it as load-bearing, not as a formality.

## Quick start

```
/raise-issue                                  # asks what went wrong
/raise-issue the export button spins forever  # starts from a description
/report-issue                                 # the same skill
```

A screenshot pasted into the conversation is a valid starting point. Read it, describe back what
you see in it, and confirm you have understood before going further.

## Ground rules

These outrank convenience at every step.

- **Never show raw code, diffs, stack traces, or log dumps to this person.** File paths and
  line numbers are fine as *evidence in the issue*; they are not an explanation. If you need to
  describe a piece of code, describe what a person would see it do.
- **Never condescend.** No "don't worry about the technical details". Explain plainly, at full
  respect, and assume they will read what you write.
- **A missing tracker is a missing team setup, not their failing.** Same for a logged-out CLI, a
  repo with Issues switched off, or a permission they don't have. Say what is missing and who can
  fix it. Never apologise on their behalf.
- **Never imply they wasted anyone's time.** When the answer is "this is better raised with the
  billing team" or "someone already reported this", that is a good outcome and should read like
  one.
- **No dead ends.** Every branch finishes with the person holding either a filed issue or the
  complete text of one plus a clear next step.
- **Read-only on the codebase.** The only writes are the issue itself, a saved draft, and — if
  they agree — `docs/agents/issue-tracker.md`. All after confirmation.

## Workflow

### 1. Find the issue tracker — three states, not two

Work down the ladder in [REFERENCE.md §1](REFERENCE.md), stopping at the first hit:
`docs/agents/issue-tracker.md`, then `git remote -v` plus the matching CLI, then repo evidence
(`.github/ISSUE_TEMPLATE/`, `CONTRIBUTING.md`, README badges, tracker URLs in docs, configured
MCP servers).

The result is one of **three** states, and conflating the middle one with the last is the single
worst bug this skill can have:

| State | What it means | What you do |
|---|---|---|
| **Reachable** | Tracker found, CLI present and authenticated | Normal path. |
| **Found but unreachable** | Tracker found, but `gh`/`glab` is missing, logged out, or returns 403 / "issues disabled" | Name the tracker. Say exactly why you can't post. Give the literal fix. Hand back the web-form URL so they can file it themselves in a browser. |
| **No tracker** | Nothing found after looking properly | The no-tracker path below. |

Telling a team that lives on GitHub "you don't seem to have an issue tracker" because `gh` was
logged out is a lie told with confidence, at the end of a ten-minute interview. Check
authentication **before** the interview, not at publish time, so the person knows where this is
going while they still have the choice.

If you can confidently infer the tracker and there is no `docs/agents/issue-tracker.md`, **offer
to write it yourself** (template in [REFERENCE.md §2](REFERENCE.md)). Do not tell them to go and
run somebody else's setup command first. This skill bootstraps its own detection.

### 2. Interview — always, one to four questions

The interview runs on **every** run, however clear the request looks. The first description is
always under-specified, and the questions are the mechanism that makes the issue worth filing.

Use `AskUserQuestion`, one topic at a time, in plain English, with no tracker or code vocabulary.
Frame every question by what they **saw** and what they **expected** — never by implementation.
Question bank in [REFERENCE.md §3](REFERENCE.md).

Hard rules, all of them:

- **Floor of one question.** Even a perfect-looking report gets one.
- **Hard cap of four** before you draft. Ask what is load-bearing. Do not interrogate.
- **Offer the exit on every question.** Each `AskUserQuestion` carries a "file it as it is" option.
  One keystroke ends the interview and moves to drafting.
- **"I don't know" is a real answer.** Offer it, record it, and never ask it again in another
  form. For reproduction steps it is recorded verbatim in the issue as *"Reporter could not
  reproduce on demand"* — which is information a developer wants, not a gap.
- **Narrate before you go quiet.** Step 3 takes time and silence reads as a crash. Say something
  like: *"Give me a minute — I'm going to search the code for the parts you described, then come
  back with what I think you mean in plain English."*

This is a priority order, **not a checklist** — six candidates for four slots at most, and most
runs should use fewer. Take them in this order and stop as soon as you can draft something a
developer could act on:

1. What happened.
2. What they expected instead.
3. Where they were when it happened.
4. Whether it happens again.
5. How much it is hurting them.
6. What they do and do not want said in the issue.

Anything you can infer from what they already said, or from the screenshot, or from the code in
step 3, you do **not** ask. Items 4 to 6 are usually inferable or genuinely optional; item 4 in
particular is the one people cannot answer and the one that makes them give up, so never press
it twice.

### 3. Ground it in the codebase — bounded

This is the step no tracker can do for itself, and the reason this skill exists.

Take the nouns the person used and find what they name in this repository. Search the code and
any domain docs — `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, glossaries, README — for exact and
adjacent matches.

Bound the search, and show that it is bounded:

- At most **six terms**, chosen by how load-bearing they are.
- At most **twelve searches** in total.
- A soft budget of about a minute. When it runs out, stop and report what you have.
- Print a one-line progress marker as you go: `Looking up: "export button" (2/6)`.

Build a **term map** — their word, the project's word, and `file:line` evidence. Format in
[REFERENCE.md §4](REFERENCE.md).

**Never silently adopt a term.** Every issue leads with the reporter's own words, quoted
verbatim and unedited. The term map sits *below* that, explicitly labelled as machine inference,
with its evidence, and closes with a line saying that if the mapping is wrong, the human
description above is what counts. A confidently mis-grounded issue costs a developer a day; a
clearly-labelled guess costs nothing.

Where a term has two plausible candidates, ask — describing each by what the person would **see**,
never by its symbol name. Where it has one confident match, take it and show it in the review.
Where it has none, say so in the map. An honest blank is better than a stretch.

### 4. Draft the brief

Assemble everything a downstream skill or a developer would otherwise have to ask for: the
problem in the reporter's words, expected versus actual, reproduction (or the honest note that
they could not reproduce it), the affected area in codebase vocabulary with file evidence,
severity in terms of impact on their work, the scope boundaries they set, and any screenshots.

Template in [REFERENCE.md §5](REFERENCE.md).

### 4b. Should this be an issue at all?

Not everything described is work for a developer. Judge it, and be willing to say so:

- **Not a defect** — the product does what it was designed to do and they expected otherwise.
  Explain what it does and why. Offer to file it as a change request if they still disagree.
- **Not a code problem** — a permission, a data-entry mistake, an account or billing matter, a
  how-do-I question. Name who to talk to instead.
- **Too thin to act on** — after the interview there is still nothing anyone could start from.
  Say that plainly, and say what would make it actionable.

This is **advice, never a refusal**. It appears inside the step-5 confirmation alongside the
drafted issue, so "file it anyway" is one keystroke away. And it is phrased so that being
redirected never reads as having wasted anyone's time.

### 4c. Has this already been reported?

Always runs. Never skipped.

Two people hitting one bug describe it in two unrelated ways — one says "the export button spins
forever", the other says "my March invoice never downloaded" — and neither recognises the other's
report. A text search over issue titles is therefore the weakest possible check, and it is the one
most tools stop at.

**Search primarily by the grounded code area.** Step 3 resolved their description to real files
and symbols; that is a far better duplicate key than their prose, because it normalises two
symptom stories onto one module. Run all three, in this order of weight:

1. **By code area** — open issues naming the same files, symbols, or component. The primary signal.
2. **By symptom text** — their own words, plus any error text they quoted.
3. **By recency** — anything opened in the last few weeks touching that area. A fresh regression
   attracts several reports fast.

Then classify honestly against the table in [REFERENCE.md §6](REFERENCE.md), showing each
candidate as a link plus a one-line plain-English summary. The three outcomes:

- **Same symptom, same area** → offer to add their detail as a **comment** on the existing issue.
  Their specific record, number, and date are genuinely useful there.
- **Different symptom, same area** → file a new issue, **linked** to the existing one, saying
  plainly that the two touch the same part of the code and may or may not share a root cause.
  Never force the choice. Never merge silently.
- **No credible match** → file normally.

The middle case is the one usually got wrong. Whether the root cause is shared is a **diagnosis**,
and diagnosis is the developer's job. Guessing "duplicate" loses a real bug; guessing "unrelated"
costs a developer the link that would have solved both. Linking costs nothing and keeps both.

Every outcome is an offer. "File it as a new issue anyway" is available at each one.

**If the tracker cannot be searched** — no CLI, no auth, state (b) from step 1 — say so in the
confirmation, in those words. Never let silence imply the check passed.

### 5. Confirm — before anything leaves this conversation

**This step comes before publishing, and before any handoff. There is no ordering in which it
comes second.**

Show the finished issue in full, in plain English. Show the step-4b recommendation and the
step-4c duplicate finding alongside it. Say which tracker it will go to, and whether it will be a
new issue or a comment on an existing one. Then ask a straight yes/no.

Nothing is published, commented on, or saved before that yes. Do not infer consent from
enthusiasm, and do not treat "sounds good" earlier in the conversation as an answer to a question
you have not yet asked.

If step 4b recommends against filing, that recommendation is shown here too — and "file it
anyway" is always one of the answers. This step advises; it never refuses.

### 6. Publish — delegate or self-contained

Only after an explicit yes at step 5.

- **`/to-spec` or `/to-tickets` installed, and a tracker configured** → hand them the **approved**
  text. Include the handoff instruction from [REFERENCE.md §7](REFERENCE.md) verbatim: the
  clarification is **done**, the wording is already approved by the reporter, publish it as given,
  and put no further technical questions to this person — they are not the developer and cannot
  answer a question about seams.

  **These are someone else's skills, and nothing here can enforce that instruction.** So the
  approval must already exist before control leaves this skill: step 5 is the gate, and handing
  off is itself a publish. If the delegated skill comes back asking this person a technical
  question, answer it from the brief yourself where the brief settles it, and only go back to
  them for something genuinely new — in plain language, and never about seams or slicing.

- **Otherwise** → the self-contained path. Write the issue from [REFERENCE.md §5](REFERENCE.md)'s
  template and publish with `gh issue create` / `glab issue create`.

### 7. Report back

The link or the file path, and one line on what happens next — who sees it, and roughly when they
would normally look. If you filed it as a comment on an existing issue, say which one and why.

## When publishing is impossible

Tracker unreachable, no tracker at all, or the publish command failed. The deliverable is still
the issue — it just travels by hand.

**Print the finished issue in full, in the chat**, formatted to paste straight into Slack or an
email. That is the deliverable. Then give them:

- The tracker's web-form URL, if there is one, so they can file it in a browser themselves.
- **Who to send it to** — from `CODEOWNERS`, the recent authors of the grounded files, or the
  maintainers named in the README. A name beats a URL.
- The one line to pass to a technical teammate: *"turn on GitHub Issues for this repo"*, or
  `gh auth login`, or `/setup-matt-pocock-skills`.

Offer to save a copy to a file as a **backup**, never as the answer. If you do save it, run
`git check-ignore -v <path>` first and **say out loud** if the path is ignored: a file in
`.scratch/` exists on one laptop and nowhere else, and reporting that as success is a dead end
wearing a tick.

When there is genuinely no tracker, add a short plain-English explanation of what an issue tracker
is, the two or three realistic options for this repo, and the recommendation to ask a technical
teammate to set one up. Tone rule applies: missing team setup, not their failing.

## Constraints

- Read-only on the codebase. The only writes are the issue, an optional draft file, and
  `docs/agents/issue-tracker.md` — each after explicit confirmation.
- No raw code, diffs, or stack traces shown to the reporter, ever.
- The reporter's verbatim words open every issue. Inference is always labelled as inference.
- Every branch ends with a filed issue or the full text of one plus a named next step.

Detection ladder, issue template, question bank, term-map format, duplicate table, handoff text
and error paths: [REFERENCE.md](REFERENCE.md).
