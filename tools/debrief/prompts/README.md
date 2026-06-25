# prompts/ — human-owned, edit freely

These files are **the intelligence of debrief, and they are yours to tune.** The tool never
hardcodes intent or question logic; it hands these instructions to the connected LLM and
borrows its reasoning. Editing a file here changes how the tool thinks — no code change, no
rebuild, and (because the MCP server reads them live per call) no server restart.

| File | What it controls | When to edit |
|------|------------------|--------------|
| `classify-intent.md` | How the LLM tags each turn: a primary + optional secondary kind (redirect / observed / continue / query), and names the turn's narrow topic | If tags or topics feel wrong, sharpen this |
| `group-themes.md` | The tidy-up pass: how the LLM fuses true-duplicate topics (conservative) and groups related ones into broad, non-destructive themes for deeper questions | If themes are too fragmented or too lumpy, tune this |
| `depth-instruction.md` | How the LLM turns a theme (or single cluster) + evidence into an open "why" question | If questions feel generic, deepen this |

These are validated against your labeled eval set
(`~/.gstack/projects/adamlinscott-claude-skills/t2-valence-labeling.md`): change a prompt,
re-run the eval, see if agreement with your labels goes up.

Nothing in `src/` decides intent. If you ever find intent logic in code, that's a bug.
