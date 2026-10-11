# Agent Office

A live view of every agent working in one project, drawn as an office floor plan. It watches agents through the records their tools already keep; it never runs or controls them.

## Language

### The office

**Office**:
Everything happening in one project at one moment: its rooms, the people in them, and what they are doing.
_Avoid_: dashboard, harness, workspace

**Office model**:
The tool-independent description of an office at one moment, in which every fact carries the time it happened.
_Avoid_: snapshot format, schema (for the idea itself)

**Room**:
One piece of work, holding one or more sessions. A room exists in its own right; sessions join and leave it.
_Avoid_: worktree, branch (a room may span several)

**Session**:
One conversation between a human and their lead agent, as one agent tool records it.
_Avoid_: room (a session is in a room), chat, thread

### People

**Person**:
Anyone in the office: a human or an agent.
_Avoid_: user, member

**Human**:
A person who owns sessions. In v1 there is one: you.
_Avoid_: user, operator, player

**Agent**:
A person that is an AI model at work, either a lead or a subagent.
_Avoid_: bot, worker (a worker is one role)

**Lead**:
The agent a human talks to directly in a session.
_Avoid_: main agent, parent session

**Subagent**:
An agent started by another agent to do part of its work. It may start subagents of its own.
_Avoid_: child, helper

**Started by**:
The link from an agent to the agent that started it.
_Avoid_: parent, spawned by

**Owner**:
The human a session belongs to.
_Avoid_: author, creator

**Role**:
The job an agent does in the office, such as worker, reviewer or, later, accountant. Roles are an open list the office reads from its role catalogue, not a fixed set.
_Avoid_: agent type (that is the tool's own label), Role agent (that is one this collection ships), zone

**Agent type**:
The label an agent's own tool gives it, kept as the tool wrote it. A role is worked out from it where the source doesn't say.
_Avoid_: role, kind

### What people are doing

**Status**:
What an agent is doing itself right now: working, idle, done, stalled or failed. Waiting on others is not a status.
_Avoid_: state, phase

**Wait**:
The fact that one agent is owed an answer by another, since a given time. An agent can hold several waits and still be idle, free to take other work.
_Avoid_: dependency, block, link

**Edit**:
The fact that an agent changed a file, at a given time.
_Avoid_: touch, write (a write is what an agent is doing now)

**Report**:
An agent's last message once it has finished.
_Avoid_: final message, result, output

**Finding**:
A report worth other people reading, marked with an info icon.
_Avoid_: card, board item, note

**Possible conflict**:
A file an agent is writing that someone else edited recently.
_Avoid_: collision, clash

### Looking at the office

**Viewer**:
The human looking at the office, and the session they are looking from. The office is the same for every viewer; only what comes first and where the star goes differ.
_Avoid_: self, current user

### Where facts come from

**Source**:
An adapter that turns one agent tool's records into the office model, reporting facts and, where it can, their meaning.
_Avoid_: provider, connector, integration

**Fact**:
Something a source saw happen, such as an edit, a wait or a final message, with its time.
_Avoid_: event (for a recorded fact), raw data

**Meaning**:
A judgement drawn from facts, such as a possible conflict or a finding worth reading. A source may supply it; where it doesn't, shared rules work it out.
_Avoid_: insight, derived data
