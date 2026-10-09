# Agent Office: transcript probe

Resolves [Transcript probe: what the logs really record](https://github.com/adamlinscott/claude-skills/issues/42). Measured on 9 October 2026 against Claude Code 2.1.2xx transcripts on Windows, across 236 subagent records and 7 live sessions in 6 git projects.

Every field the discover module needs is on disk and readable from any session. The transcript format is internal and undocumented, so all of this belongs in one parser.

## Where each field lives

| Need | Where | Notes |
| --- | --- | --- |
| Session id | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | The file name, and `sessionId` on every line. |
| Folder | `cwd` on `user`, `assistant`, `attachment` and `system` lines | Take the newest line that has one. Title and bookkeeping lines carry no `cwd`. |
| Branch | `gitBranch` on the same lines | Reliable for the session itself. See the worktree trap below. |
| Session summary | `ai-title` lines, field `aiTitle` | Claude Code writes and rewrites a short title, for example "Reverse harness for sessions". Take the newest. Missing in a session's first minutes and in older sessions. |
| Subagent list | `<sessionId>/subagents/agent-<agentId>.jsonl` | One file per agent, written while it runs. |
| Agent type | `<sessionId>/subagents/agent-<agentId>.meta.json`, field `agentType` | Also `description`, `toolUseId`, `spawnDepth`, `requestShape` (`background`, or absent), `worktreePath`, `worktreeBranch`. Readable across sessions, so other sessions' agents get their real zone. |
| Agent's folder | `cwd` on the subagent's own lines | For a worktree-isolated agent this is the worktree path. |
| Last tool | `assistant` lines, `message.content[]` items of type `tool_use`: `name` and `input` | |
| Edited path | `input.file_path` on `Edit`, `Write` and `NotebookEdit` tool uses | Always absolute. Normalise against the `--show-toplevel` of that line's `cwd`. |
| Link to parent | Subagent lines carry the parent's `sessionId`; `meta.json` carries the parent's `toolUseId` | The parent's matching `tool_use` has `name: "Agent"` and `input.subagent_type`. |

## When an agent is done

| Run mode | Launch record in the parent | Done signal |
| --- | --- | --- |
| Background | `tool_result` whose `toolUseResult` has `isAsync: true`, `status: "async_launched"` | A `queue-operation` line (operation `enqueue`) whose `content` holds `<task-notification>` with `<task-id>` = the agent id and `<status>completed</status>`. The same notification then appears as a `user` line. |
| Foreground | none until it returns | The `tool_result` for that `toolUseId`, with `toolUseResult.status: "completed"`, plus `agentType`, `totalDurationMs`, `totalTokens`. |

Across every transcript on this machine, the launch acknowledgement never says `completed`, so it can't be mistaken for done. Older `meta.json` files have no `requestShape`; fall back to the parent's `isAsync`.

## Traps

- **A worktree agent's `gitBranch` is wrong.** Lines from an agent with `isolation: "worktree"` report the parent session's branch, not the worktree's. Use `worktreeBranch` from `meta.json`, or resolve the branch from the line's `cwd`.
- **Bookkeeping lines have no `cwd`.** `ai-title`, `mode`, `last-prompt`, `queue-operation` and others carry only `sessionId`.
- **Titles arrive late.** A new session has no `ai-title` yet. Fall back to the branch name, then to the cheapest Claude model.
- **Large files.** This session's transcript passed 1,500 lines. Read from a byte offset, never the whole file.

## Grouping by project

`git rev-parse --path-format=absolute --git-common-dir` on each session's `cwd` grouped the 7 live sessions correctly. The main checkout and an Orca worktree of claude-skills landed together, as did two Lorveil sessions in different folders. Orca's `workspace/<name>/repos/<repo>` layout resolves to each inner repo, as it should. Desktop can't run git (`$.process` is terminal-only), so the sandbox probe still has to confirm the same grouping from `.git` pointer files.

## Not exercised

Two separate sessions editing the same file at the same moment was not staged. The parts are proven: edit paths are absolute and each line has its `cwd`. The collision itself gets tested when the collisions ticket is built.
