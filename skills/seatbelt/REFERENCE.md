# Seatbelt reference

Templates and exact values for [SKILL.md](SKILL.md). Read the section you need; don't load it all.

## 1. What goes in `.claude/settings.local.json`

Merge into the existing file, never replace it. Preserve keys you did not add.

### Developer mode

```json
{
  "permissions": {
    "defaultMode": "auto",
    "allow": [],
    "deny": [
      "Read(./.env)", "Read(./.env.*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)",
      "Read(**/credentials.json)", "Read(~/.aws/**)", "Read(~/.ssh/**)"
    ]
  },
  "hooks": { "PreToolUse": [ /* see §2 */ ] }
}
```

`allow` is empty on purpose. Everything else lives in the guard policy, where it can be
expressed precisely. `auto` runs a classifier on each call; the deny rules and the guard still
apply on top.

### Vibe mode

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "disableBypassPermissionsMode": "disable",
    "allow": [
      "Edit(./**)", "Read(./**)", "Glob", "Grep", "TodoWrite", "WebFetch", "WebSearch",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)",
      "Bash(git commit:*)", "Bash(git switch:*)", "Bash(git checkout -b:*)",
      "Bash(git branch:*)", "Bash(git push:*)", "Bash(gh pr create:*)", "Bash(gh pr view:*)"
    ],
    "deny": [
      "Edit(./.claude/seatbelt.policy.json)", "Edit(./.claude/seatbelt.manifest.json)",
      "Edit(./.claude/settings.json)", "Edit(./.claude/settings.local.json)",
      "Edit(./.github/workflows/**)",
      "Read(./.env)", "Read(./.env.*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)",
      "Read(**/credentials.json)", "Read(~/.aws/**)", "Read(~/.ssh/**)"
    ]
  },
  "hooks": { "PreToolUse": [ /* see §2 */ ] }
}
```

Add the detected test / build / lint / dev-server commands to `allow` as
`Bash(<exact command>)`. Under `dontAsk` an unlisted command is denied, so the allowlist is
what makes the repo usable — but see §6 before adding anything resolved from a manifest.

### Rules you must never emit

| Never | Use instead | Why |
|---|---|---|
| `Write(path)` | `Edit(path)` | Accepted and never matched. Silent no-op + startup warning. |
| `NotebookEdit(path)` | `Edit(path)` | Same. |
| `Glob(path)` | `Read(path)` | Same. |
| `Bash(command:rm *)` | `Bash(rm *)` | Field syntax is ignored for `command`; startup warning. |
| `Read(C:\Users\me\proj\.env)` | `Read(./.env)` | Windows paths normalize to POSIX; absolute rules miss. |
| `mcp__github` | `mcp__github__.*` | Without `.*` it is an exact string and matches nothing. |

`deny` and `ask` rules are exempt from the workspace-trust dialog; `allow` rules and
`additionalDirectories` are not. A **gitignored** `settings.local.json` is treated as the
user's own file, but a **committed** one goes through the trust check like project settings —
which is why §5 is not optional.

## 2. Hook registration

Exec form. No shell, so no Git Bash dependency on Windows, no quoting hazard in paths with
spaces, and no chance a chatty `~/.bashrc` corrupts the hook's stdout.

```json
{
  "matcher": "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
  "hooks": [
    {
      "type": "command",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/.claude/assets/guard.mjs"],
      "timeout": 10
    }
  ]
}
```

Never use `"matcher": "*"` — the hook then runs on every tool call in every session, including
a long `/build-it` run that issues thousands. Add an `if` filter (permission-rule syntax, e.g.
`"Bash(git *)"`) if you need to narrow further.

Also register a liveness check, so a renamed guard or a missing `node` is loud rather than silent:

```json
{
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/.claude/assets/guard.mjs", "--selftest"], "timeout": 10 } ] }
  ]
}
```

Hooks and permissions hot-reload from the file watcher, so the setup takes effect without a
restart and the verification step in §7 can run in the same session.

## 3. Policy files

| File | Committed | Self-protected | Purpose |
|---|---|---|---|
| `.claude/seatbelt.policy.json` | no | **yes** | The policy. Copied from `assets/policy.<mode>.json`. |
| `.claude/seatbelt.local.json` | no | **no** | Personal overrides. This is the escape hatch. |
| `.claude/seatbelt.manifest.json` | no | yes | What was written, for `--uninstall`. |
| `.claude/assets/guard.mjs` | no | yes | Copied verbatim from `assets/guard.mjs`. |

If both policy files were protected, `--uninstall` and `--allow` would be blocked by the guard
they are trying to change. Protect mechanism; leave the override open.

### Rule shapes

Prefer `contains`. A regex in JSON needs double-escaping (`"\\bvercel\\b"`) and getting it wrong
produces a rule that silently never matches.

```json
"vercel --prod"                          // literal substring, case-insensitive
{ "contains": ["kubectl", "delete"] }    // every fragment present
{ "startsWith": "terraform apply" }      // command begins with this
{ "regex": "^aws\\s+s3\\s+rb" }          // explicit opt-in
```

Optional `"reason"` is either a message key (`merge`, `deploy`, `publish`, `spend`,
`destructive`, `confirm`, `protected`) or literal prose. Run `validatePolicy()` from
`guard.mjs` before writing — it catches rules that can never match.

## 4. `--allow`

Append to `.claude/seatbelt.local.json` only:

```json
{ "allowCommands": ["npm run deploy:staging"] }
```

`allowCommands` is read from the local file exclusively, so a repository can never widen its own
permissions by shipping a policy.

## 5. Gitignore check (do not skip)

```bash
grep -qE '^\.claude/settings\.local\.json$|^\.claude/$' .gitignore
```

If absent, append:

```
.claude/settings.local.json
.claude/seatbelt.local.json
.claude/seatbelt-log.jsonl
```

Then confirm nothing is already tracked: `git ls-files .claude/`. A tracked
`settings.local.json` changes its trust semantics and must be `git rm --cached`'d.

## 6. Resolving detected commands

Before any manifest-derived command enters `allow`, resolve and show the body:

```bash
node -e "console.log(JSON.stringify(require('./package.json').scripts,null,2))"
```

Refuse outright if the script name or body matches deploy, publish, release, migrate, prod,
`rm `, or a pipe into a shell. A `"deploy": "vercel --prod"` must never be laundered into an
allow rule via `Bash(npm run deploy)`. The guard resolves this at decision time too, but the
allowlist should not have contained it in the first place.

## 7. Verification

```bash
node .claude/assets/guard.mjs --selftest    # liveness
node <skill>/assets/guard.test.mjs          # 43 fixtures
```

Never verify by attempting a live destructive command. The case the test exists to catch is the
case where the command succeeds.

## 8. Report

```
Claude runs these freely          Claude asks first        Claude can never do this
────────────────────────────      ──────────────────       ────────────────────────
edit any file in this project     install a package        merge a pull request
read any file in this project     change the database      push to main
run your tests and dev server                              force-push or delete history
commit and push to a branch                                deploy to production
open a pull request                                        read your .env or keys
                                                           spend money
```

Vibe mode drops the middle column. Persist the table into the `CLAUDE.md` block so it survives
the session. Close with the honest limit: *this stops Claude over-reaching. It is not a lock
against a person who dismantles their own setup. You can turn it off with `/seatbelt
--uninstall`.*

## 9. `CLAUDE.md` block

Keep under ten lines and point at a detail file, or it trips `/context-audit`'s bloat rule.

```markdown
<!-- seatbelt:start v1 -->
## How we work here (seatbelt: vibe)
Your changes go on a branch, then into a pull request that you merge. I never merge, deploy,
or push to the main branch myself. Before anything permanent I explain it in plain English and
name the reversible alternative. I will not help disable these settings — run `/seatbelt
--uninstall` yourself if you want them gone. Full policy: `.claude/seatbelt.policy.json`.
<!-- seatbelt:end -->
```

## 10. Manifest and uninstall

```json
{
  "schema": 1, "mode": "vibe", "writtenAt": "<ISO>", "guardVersion": "<sha256 of guard.mjs>",
  "settingsFile": ".claude/settings.local.json",
  "addedPermissionRules": { "allow": [], "deny": [] },
  "addedHooks": ["PreToolUse[0]", "SessionStart[0]"],
  "addedFiles": [".claude/assets/guard.mjs", ".claude/seatbelt.policy.json"],
  "gitignoreLinesAdded": [".claude/settings.local.json"],
  "claudeMdDelimiters": ["<!-- seatbelt:start v1 -->", "<!-- seatbelt:end -->"]
}
```

Uninstall removes only what the manifest claims, reports drift where the file changed since,
and never touches a rule it did not add.

## 11. Branch protection — print, never write

The skill does not write remote state. An agent enabling branch protection can strand a solo
developer with no reviewer, changes behaviour for every collaborator, and rulesets vary by plan
tier.

**GitHub:** Settings → Branches → Add branch ruleset → target the default branch → enable
"Require a pull request before merging", "Block force pushes", "Restrict deletions". Print
alongside it: *to undo, delete the ruleset from the same screen.* Note that branch protection on
a private repo requires a paid plan — check with `gh api repos/{owner}/{repo} --jq .private`
before sending someone down a path that ends at an upsell.

**GitLab:** Settings → Repository → Protected branches → set Allowed to push to "No one".

**No remote / other host:** say so plainly. The Claude-layer policy is the whole protection.

## 12. Error paths

| Situation | Behaviour |
|---|---|
| Not a git repo | Write the policy anyway; skip all git-derived rules; say so. |
| No remote | Skip §11 entirely. Don't print a click-path that goes nowhere. |
| `gh` missing or unauthenticated | Vibe's flow ends at `gh pr create`. Fall back to: push the branch, print `https://github.com/<o>/<r>/compare/<branch>?expand=1`. Never require a CLI install to finish. |
| `node` missing | The guard cannot run. Install permissions only, and state plainly which protections are absent. A partial install that looks complete is worse than a refusal. |
| Existing `PreToolUse` hook | Append. Never replace. Record the index in the manifest. |
| Malformed existing settings | Stop. Show the parse error. Do not overwrite a file you cannot read. |
| Existing seatbelt manifest | Report what changed, then reconfigure. Don't re-interview. |
| Invoked from a subdirectory | `settings.local.json` resolves from the git root (worktrees resolve to the main checkout). Write there, and say where. |
| Read-only checkout | Stop with the path that failed. |
| Detached HEAD / no `origin/HEAD` | The guard treats an unresolvable push target as protected. Mention it. |
