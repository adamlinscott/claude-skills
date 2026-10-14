# Agent Office: the office model, version 1

The office model is the tool-independent description of one project's office at one moment. Every view reads it; every source writes it. Terms are defined in [the Agent Office glossary](../../mods/agent-office/CONTEXT.md). Decided on [Office model: the portable data layer under every view (#55)](https://github.com/adamlinscott/claude-skills/issues/55); layer boundary in [ADR 0001](../adr/0001-agent-office-streaming-engine.md).

## Rules

- **State, with times.** The model is the office as it is now. Every fact carries the time it happened, so two models can be compared to get what changed.
- **Viewer-neutral.** Nothing in the model says who is looking. The host tells the layout who the viewer is (a human id and a session id); the layout puts their room first and draws their star.
- **Ids are source-scoped**: `<source>:<the tool's own id>`, as in `claude-code:a4b66df9-…`. Rooms are `room:<session id>` in v1.
- **Facts from sources, meaning above them.** A source reports what it saw and may add meaning it knows better. Where a meaning item is missing, the shared rules work it out. Each meaning item says who produced it.
- **No tool's names in the shape.** Tool-specific detail goes in `agentType`, as the tool wrote it, and in an optional `extra` object per record that views never rely on.
- **Versioned.** `schemaVersion` is a whole number. It goes up only when a field changes meaning or disappears; adding fields doesn't change it. A host that meets a higher version than it knows shows a one-line status instead of a wrong drawing.

## Shape

```text
OfficeModel
  schemaVersion   1
  seq             increases by one with every model the engine emits
  generatedAt     ISO time
  project         { id: git common dir, name }
  sources         [{ id: "claude-code", status: null | one-line problem, errors: { count, first } }]

  humans          [{ id, name }]                      name from git user.name; email stays on the machine
  sessions        [{ id, source, owner: human id, lead: agent id, title,
                     titleFrom: "source" | "branch", branch, checkout,
                     lastActive, status: "active" | "idle", lights: "on" | "off" }]
  rooms           [{ id, sessions: [session id], title }]

  agents          [{ id, source, session, startedBy: agent id | null (a lead),
                     agentType, role, task: short task name | null, status, statusSince, lastActive,
                     doing: { kind: "write" | "read" | "run" | "search" | "talk", file?, since } | null,
                     usage: { model, context, input, cacheWrite, cacheWrite1h, cacheRead, output,
                              over100k: { input, cacheWrite, cacheWrite1h, cacheRead, output }, at } | null,
                     checkout?, branch? }]
  edits           [{ agent, file, at }]               file relative to the repo root, forward slashes
  reads           [{ agent, file, at }]               the same, for files an agent read
  waits           [{ waiter: agent id, on: agent id, since }]
  reports         [{ agent, at, text }]               an agent's last message once it finished

  meaning
    roles         [{ agent, role, by: "source" | "rules" }]          when not given by the source
    conflicts     [{ file, agents: [agent id], by }]                  a file more than one agent edited recently; git history later shows whether it is a real conflict
    findings      [{ report: agent id, by }]                          a report worth an info icon
```

`status` is one of `working`, `idle`, `done`, `stalled`, `stopped`, `failed`. `stalled` means gone quiet, and it may still answer; `stopped` means someone ended it early, and it never answers or leaves a report. Waiting is never a status: an agent with waits can be working or idle.

A session's `title` is the tool's own when it has one (`titleFrom: "source"`), else its branch as a stand-in (`titleFrom: "branch"`). A host may have a title written for a branch stand-in and draw that instead. An agent's `task` is the short task name it was started with; a lead has none.

An agent's `usage` comes from its newest reply: the `model` id it ran on, its `context` size in tokens (the reply's input plus cache-read and cache-written tokens, so a compaction shows as a drop) and that reply's time `at`. `input`, `cacheWrite`, `cacheRead` and `output` are its token counts summed over the part of the transcript the engine has read, each reply counted once; `cacheWrite1h` is the part of `cacheWrite` cached for an hour (the rest is five minutes'), and `over100k` is the same counts again for only the replies whose prompt (input plus both cache counts) was over 100k tokens, for a model priced higher above that. It is null until a reply with usage is read. A view prices the totals at API list prices from the mod's prices.json, which a person's config.json overrides per model under `prices`. The model carries no context window: a view looks one up by model id in config.json's `contextWindows` (`{ "<model id>": { window, compactAt } }` in tokens, `"*"` as a default), or takes it from its own session for the model that session runs.

`edits` and `reads` hold the newest time per agent and file inside `touchedWindowMinutes`. A read is a read tool on a file, or a shell command reading one where the source can tell. Views use reads to tell when an agent has checked a file it was warned about.

A session's `lights` go `off` once it has been quiet for `idleMinutes`. The engine keeps it for up to `lightsOffHours` after its last activity, with the subagents that were in view when it went quiet; their statuses are still worked out at the model's time. Views draw a room whose sessions all have the lights off faded, and don't let anyone interact with it.

A source leaves two kinds of session out of the model altogether: a tool's helper session (for `claude-code`, one read from its start with a single prompt opening with one of config.json's `helperPrompts`, no tool calls and no subagents), and a session whose lights are off that never got a real reply. A helper that goes on to a second prompt or a tool call shows; a session with no reply yet shows while its lights are on, as a new desk.

`role` comes from the role catalogue, an open list (worker, scout, researcher, reviewer, lead, and any added later, such as accountant). An agent type with no catalogue entry gets `other`.

## Layers

| Layer | Runs in | Knows about |
| :- | :- | :- |
| Sources (`claude-code` today) | The engine (node) | One agent tool's records |
| Office model and meaning rules | The engine | The model only |
| Layout | The host, from shared pure modules | The model and the viewer |
| Renderers (Desktop drawing, terminal cells) | The host | A laid-out scene |
| Host (the Claude mod today) | Claude Code | Refresh, input, later actions |

The engine runs for the life of the pane and writes one model per line to its output whenever something changes. The shared modules (model, meaning rules, layout) sit inside the mod's folder so the mod can import them; the engine and any future app import the same files.

## From today's discover snapshot

- `self` and `selfAmbiguous` leave the model; the host supplies the viewer.
- The session no longer stands in for its lead: the lead is an agent with `startedBy: null`.
- `zone` is dropped; `role` replaces it.
- `filesTouched` per session becomes `edits` per agent with times.
- `lastTool` and `lastFile` become `doing`.
- `finalMessage` becomes a `reports` entry.
- Subagents of subagents keep their `startedBy`.
