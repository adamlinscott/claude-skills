---
name: to-the-point
description: '[Adam''s Skills] Alias for the ttp skill. Shape user-facing output to be brief and direct — lead with the substance, keep the default answer short, and expand only when the user asks for detail. Leaves the user in control: Claude settles small, reversible, or already-decided points and proceeds, but routes high-impact calls (ADR-worthy, production, project shape, which features get built, infrastructure) to the user with enough context to decide. Only shapes prose written for the user to read; Claude''s own reasoning, tool use, code, and planning are untouched. Triggers on the user naming it, with or without a slash: "ttp", "/ttp", "to the point", "/to-the-point", "be to the point" — a bare "ttp" on its own line is a request to turn this on. Do not load it for a general "be brief"; the user has to name it. Stays on until "stop ttp", "ttp off", or "normal mode".'
---

# To the Point (alias)

This is an alias so that both `/ttp` and `/to-the-point` work — and so that either name,
typed bare with no slash, still reaches the skill.

Read `skills/ttp/SKILL.md` — resolve it relative to this file's parent directory
(`../ttp/SKILL.md`), or at `~/.claude/skills/ttp/SKILL.md` when installed — and follow it in full.
Pass through any flags the user gave.

Do not duplicate the rules here. One source of truth: a divergent copy drifts, and then the two
names behave differently.
