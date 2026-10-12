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
  sessions        [{ id, source, owner: human id, lead: agent id, title, branch, checkout,
                     lastActive, status: "active" | "idle", lights: "on" | "off" }]
  rooms           [{ id, sessions: [session id], title }]

  agents          [{ id, source, session, startedBy: agent id | null (a lead),
                     agentType, role, status, statusSince, lastActive,
                     doing: { kind: "write" | "read" | "run" | "search" | "talk", file?, since } | null,
                     checkout?, branch? }]
  edits           [{ agent, file, at }]               file relative to the repo root, forward slashes
  waits           [{ waiter: agent id, on: agent id, since }]
  reports         [{ agent, at, text }]               an agent's last message once it finished

  meaning
    roles         [{ agent, role, by: "source" | "rules" }]          when not given by the source
    conflicts     [{ file, agents: [agent id], by }]                  a file more than one agent edited recently; git history later shows whether it is a real conflict
    findings      [{ report: agent id, by }]                          a report worth an info icon
```

`status` is one of `working`, `idle`, `done`, `stalled`, `stopped`, `failed`. `stalled` means gone quiet, and it may still answer; `stopped` means someone ended it early, and it never answers or leaves a report. Waiting is never a status: an agent with waits can be working or idle.

A session's `lights` go `off` once it has been quiet for `idleMinutes`. The engine keeps it for up to `lightsOffHours` after its last activity, with the subagents that were in view when it went quiet; their statuses are still worked out at the model's time. Views draw a room whose sessions all have the lights off faded, and don't let anyone interact with it.

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
