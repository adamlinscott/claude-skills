# claude-skills

A collection of Claude Code skills, and now agents, installed by link onto developer and non-technical machines so every session on any project gets the same team setup.

## Language

**Role agent**:
A general, project-agnostic subagent this collection ships, with a fixed job, a limited tool set, and a pinned model and effort level owned by the team.
_Avoid_: specialist, subagent (for ours), persona

**Skill binding**:
A skill's explicit declaration that it runs inside a named Role agent, so its model and effort are fixed regardless of the session's own.
_Avoid_: routing rule, delegation hint
