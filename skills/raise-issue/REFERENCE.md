# Raise-issue reference

Tables and templates for [SKILL.md](SKILL.md). Read the section you need; don't load it all.

## 1. Finding the tracker

### The ladder

Stop at the first hit. Each rung is cheap; run them in order rather than in parallel, so the
authoritative answer wins.

| # | Look at | Tells you |
|---|---|---|
| 1 | `docs/agents/issue-tracker.md` | **Authoritative.** Written by `/setup-matt-pocock-skills` or by this skill. Follow its conventions exactly. |
| 2 | `git remote -v` | The host — `github.com`, `gitlab.com`, a self-hosted GitLab, a Bitbucket, or nothing. |
| 3 | `command -v gh` / `gh auth status`, `command -v glab` / `glab auth status` | Whether you can actually post. This is the check that separates state (b) from state (a). |
| 4 | `.github/ISSUE_TEMPLATE/`, `.gitlab/issue_templates/` | A tracker in active use, plus the fields the team expects. Fill them. |
| 5 | `CONTRIBUTING.md`, `README.md` badges, `SUPPORT.md` | Often names a tracker the git remote doesn't — a Jira project, a Linear team, a support inbox. |
| 6 | `.mcp.json`, `~/.claude.json` | A configured Linear / Jira / Shortcut MCP server is a reachable tracker. Prefer it over a CLI. |
| 7 | `.scratch/` present | Local-markdown convention already in use. Treat as a real tracker with file conventions. |
| 8 | Nothing | State (c). The no-tracker path. |

Run rung 3 **before the interview**, not at publish time.

### The three states, per platform

| Platform | Reachable when | Found-but-unreachable looks like | What you say and hand back |
|---|---|---|---|
| **GitHub** | `gh auth status` exits 0 and lists the host | `gh` not on PATH; `gh auth status` exits non-zero; `gh issue create` returns 403; `GraphQL: Could not resolve to a Repository` / "issues are disabled" | Name the repo. Say which of the three it is. Fix: install `gh`, or `gh auth login`, or "ask a repo admin to enable Issues under Settings → General → Features". URL: `https://github.com/<owner>/<repo>/issues/new` |
| **GitLab** | `glab auth status` exits 0 for the host | `glab` missing; not authenticated; 403 on create; Issues disabled for the project | Name the project. Fix: install `glab`, or `glab auth login --hostname <host>`. URL: `https://<host>/<group>/<project>/-/issues/new` |
| **Linear / Jira / Shortcut via MCP** | The server is connected and its create tool is available | Server configured but not connected, or the tool call returns unauthorised | Name the tracker and the workspace. Fix: reconnect the MCP server. URL: the tracker's own new-issue URL if you can construct it, otherwise the tracker home page. |
| **Local markdown (`.scratch/`)** | The directory is writable | Read-only checkout | Say the checkout is read-only and give the path that failed. |
| **Named in docs only** (a Jira URL in `CONTRIBUTING.md`, a support address) | Never reachable from here | — | Treat as state (b) permanently. Print the issue to paste, plus the URL or address. |

A 403 on create is **state (b), not state (c)**. So is "Issues are disabled for this repository".
In both cases the team has a tracker; this person just cannot post to it from here.

### Web-form fallback

When you hand back a URL, hand back the **new-issue** URL, not the tracker home page, and put the
finished issue text directly above it so it can be pasted in one action. GitHub also accepts a
prefilled title: `https://github.com/<owner>/<repo>/issues/new?title=<urlencoded>`. Do not
prefill the body — long URLs get truncated by chat clients and a silently-truncated bug report is
worse than an empty form.

## 2. Writing `docs/agents/issue-tracker.md` yourself

When you inferred the tracker confidently and no config file exists, offer to write one. It makes
the next run instant and it is what `/to-spec`, `/to-tickets` and `/triage` read. Show the draft,
get a yes, then write. Never depend on a third party's setup command to bootstrap your own
detection.

Minimal GitHub form — match the shape `/setup-matt-pocock-skills` writes, so re-running it later
updates rather than conflicts:

```markdown
# Issue tracker: GitHub

Issues for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."` (heredoc for multi-line bodies)
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels`
- **Comment**: `gh issue comment <number> --body "..."`

Inferred from `git remote -v` by `/raise-issue` on <date>. Edit freely.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.
```

Swap `gh` for `glab` and the command names for GitLab; for local markdown, record
`.scratch/<feature-slug>/issues/<NN>-<slug>.md` as the convention.

## 3. Interview question bank

One topic per `AskUserQuestion`. Floor of one question, hard cap of four. Every question carries
a **"file it as it is"** option and, where it could apply, an **"I don't know"** option.

Pick the four that are actually load-bearing for *this* report. The order below is the default
priority; skip anything the person already told you.

| Topic | Ask it like this | Options to offer |
|---|---|---|
| **What happened** | "What did you see happen?" | Free text. Ask only if their opening was a single word or just a screenshot. |
| **What you expected** | "What did you expect to happen instead?" | Free text. Usually the highest-value question in the whole interview — it is the one thing no log contains. |
| **Where** | "Where were you when this happened?" | Offer the two or three real candidates by what they'd see: "the page listing all your invoices", "the screen after you click Export". Plus "somewhere else". |
| **Repeatable** | "Does it happen every time, or was it a one-off?" | Every time / Sometimes / Only saw it once / **I don't know** |
| **How to make it happen** | "If you did it again right now, what would you click?" | Free text, or **"I don't know"** → record as *"Reporter could not reproduce on demand"* |
| **Impact** | "How much is this getting in your way?" | Blocking me completely / Slowing me down, I have a workaround / Annoying but harmless / Not sure yet |
| **When it started** | "Did this used to work?" | Worked before, broke recently / Never worked / **I don't know** — a "worked last week" is a regression and changes how it is triaged |
| **Scope and privacy** | "Anything in here you'd rather not have in a public issue?" | Ask when the report mentions a customer name, an account, an invoice, or a screenshot. Real names and record IDs may need redacting before filing. |

Rules that outrank the bank:

- **"I don't know" is recorded, never re-asked.** Do not rephrase it as a different question and
  try again. It goes into the issue as a stated fact.
- **Screenshots**: describe back what you see — the screen, the visible error, the numbers — and
  ask them to confirm. That description goes in the issue, because an image attached to a
  tracker is not searchable and may not survive a paste into Slack.
- **Never ask a technical question.** Not the browser version, not the environment, not the URL
  path, unless they already volunteered it. If a developer will need it, say so in the issue as a
  known gap rather than putting it to this person.

## 4. Term-map format

Built in step 3. Shown to the person as plain sentences; carried into the issue as a labelled
table.

**To the person, in chat:**

> When you said "the export button", I think you mean the CSV export on the invoices page — the
> one that produces the file you open in Excel. When you said "it spins forever", I found the
> place that produces that spinner and it waits on the report-generation service. Does that sound
> like the right part of the product?

**In the issue, below their verbatim words:**

```markdown
## Where this probably lives

_Machine inference by `/raise-issue`, not the reporter's words. Evidence in the right column._

| Reporter's words | Likely means | Evidence |
|---|---|---|
| "the export button" | the CSV export action on the invoices list | `src/invoices/ExportButton.tsx:42` |
| "spins forever" | the pending state that waits on report generation | `src/reports/useReportJob.ts:88` |
| "March invoice" | a monthly billing period record | `src/billing/period.ts:17` — glossary: `CONTEXT.md:64` |

If this mapping is wrong, the description above it is what counts.
```

Rules:

- One row per term. At most six rows.
- An honest blank beats a stretch: `| "the thing that emails people" | no confident match found | — |`
- Two candidates and no way to tell → ask, describing each by what the person would see.
- Never paste the code at those lines. The reference is evidence for a developer, not an
  explanation for the reporter.

## 5. Self-contained issue template

Used on the non-delegated path. `gh issue create --title "..." --body-file -` with a heredoc.

**Title:** the symptom in the reporter's language, specific enough to recognise in a list.
*"Export on the invoices page spins forever and never produces a file"* — not *"Export bug"*, and
not the module name.

```markdown
## What was reported

> <the reporter's own words, verbatim and unedited — including the messy parts>

Reported by <name> on <date>.

## What they expected instead

<their answer, in their words>

## Where they were

<the screen or flow, in plain terms>

## How to make it happen again

<their steps>

_or:_ Reporter could not reproduce on demand. They saw it <when>, <how many times>.

## Impact

<blocking / slowed down with a workaround / cosmetic>, in their words. <Did it used to work?>

## Where this probably lives

<the term map from §4, with its "machine inference" label and its closing line>

## Screenshots

<the described contents of any screenshot, in text, plus the attachment>

## Not in scope

<anything the reporter explicitly said they did not want included or fixed>

## Related

<links from the §6 duplicate check, with one line each on why they may be related>

---
Filed with `/raise-issue`. All clarification with the reporter is complete — they do not read
code, so please take any technical follow-up to the team rather than back to them.
```

Sections with nothing in them are **deleted, not left with a placeholder**. An issue full of
"N/A" reads as an issue nobody cared about.

## 6. Duplicate classification

| Finding | Signal | What you offer | What you must not do |
|---|---|---|---|
| **Same symptom, same area** | Term map lands on the same files/symbols **and** the symptom description matches | Add this person's detail as a **comment** on the existing issue — their record, number and date are a second reproduction and genuinely useful | Don't close their report as a duplicate without offering the comment; don't discard their specifics |
| **Different symptom, same area** | Term map matches, symptoms don't | File a **new, linked** issue. State plainly that the two touch the same part of the code and may or may not share a root cause | **Never merge silently.** Whether the cause is shared is a diagnosis, and diagnosis is the developer's job |
| **Same words, different area** | Symptom text matches, term map doesn't | File normally. Mention the text match in "Related" only if it is genuinely suggestive | Don't treat a word match as a duplicate — "export" appears in twenty issues |
| **No credible match** | Nothing on any of the three searches | File normally | Don't pad "Related" to look thorough |
| **Cannot search** | State (b) from §1, or the tracker has no search you can reach | Say so, in those words, in the step-5 confirmation | **Never imply the check passed.** Silence here reads as "no duplicates found" |

Search commands, when the CLI is reachable:

```bash
gh issue list --state open --limit 50 --search "<symptom words>" --json number,title,body,updatedAt
gh issue list --state all --limit 30 --search "<module or symbol from the term map>"
gh issue list --state open --limit 30 --json number,title,updatedAt --jq 'sort_by(.updatedAt)|reverse'
```

`glab issue list --search "..."` for GitLab. For local markdown, grep `.scratch/**/issues/`.

Every outcome is an **offer**. "File it as a new issue anyway" is available at each one, and the
person always decides.

## 7. Handoff to `/to-spec` and `/to-tickets`

Use `/to-spec` for one coherent piece of work, `/to-tickets` when it clearly splits into several
slices. Both assume a configured tracker and both are written for a developer — which is exactly
why the handoff has to close the question loop before they start.

Pass the finished brief plus this instruction, near enough verbatim:

> This brief came from `/raise-issue`. The reporter is a non-technical colleague and the
> clarification interview is **complete**. Do not interview them, and do not put a technical
> question to them — not about seams, not about vertical slices, not about scope. Everything they
> can answer is already in the brief. Where something is genuinely missing, record it in the issue
> as an open question for the implementing developer. The reporter's verbatim description must
> survive into the published issue unedited; the term map below it is machine inference and must
> stay labelled as such.

There is no way to *enforce* this — `/to-spec` is someone else's skill. So watch the handoff: if
it starts asking the reporter technical questions, answer from the brief yourself where you can,
and take the rest as an open question in the issue rather than passing it on.

## 8. Error paths

| Situation | Behaviour |
|---|---|
| Not a git repo | Skip rungs 2–3. Rely on docs evidence. Very likely state (c). |
| No remote | Same. Don't print a click-path that goes nowhere. |
| `gh` present, logged into the wrong host | Treat as state (b). Name the host it is logged into — that is usually the whole diagnosis. |
| Repo found, Issues disabled | State (b). Fix is a repo admin, not this person. |
| `gh issue create` fails after confirmation | Don't retry silently. Print the finished issue in full to paste, plus the web-form URL. The person's yes was to filing it, not to a failed command. |
| Screenshot only, no words | Describe what you see, confirm it, then run the interview normally. A confirmed description is a valid report. |
| The report describes a security problem | Stop before publishing. A public issue is the wrong surface. Point at `SECURITY.md` or the private reporting route, and say why. |
| Report names a customer, account, or record | Ask before it goes into a public tracker. Offer to redact and keep the identifier out of the body. |
| Draft saved to a gitignored path | Run `git check-ignore -v <path>` and say out loud that the file exists only on this machine. |
| Read-only checkout | Say which write failed. The printed issue is still the deliverable. |
| Person abandons mid-interview | Print what you have as a draft they can come back to. Never leave the work only in scrollback. |
