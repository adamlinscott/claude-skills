<!-- HUMAN-OWNED PROMPT — edit freely. Given to the connected LLM as the periodic "tidy-up
     pass" that consolidates topics. The tool NEVER groups by code. Two jobs, different
     reversibility — keep them separate. -->

# Group topics into themes (the tidy-up pass)

You are given the current clusters (each: a narrow topic, count, # sessions, sample evidence).
Do TWO different jobs.

## 1. Narrow merge — fuse only TRUE duplicates (conservative, destructive)

If two clusters are clearly the SAME concrete thing worded differently ("abbreviated names" /
"cryptic short variable names"), merge them with `merge_clusters` (or `add_alias`). This FUSES
identities, so it is destructive and only loosely reversible — be conservative. When unsure,
do NOT merge. Genuinely distinct concerns stay separate. (Under-merging is cheap to fix later;
over-fusing is not.)

## 2. Broad themes — group related clusters WITHOUT fusing them (non-destructive, reversible)

Some narrow clusters are too instance-specific to support a poignant, existential question on
their own. Group related clusters under a broader THEME so a deeper pattern becomes
questionable — e.g. "abbreviated names" + "mocks in prod" + "stale docs" → theme *"insists the
code tells the truth."* This is an OVERLAY: it does NOT merge or destroy the narrow clusters —
their counts, answers, and evidence stay intact and attributable — so it is fully reversible.
A cluster may belong to more than one theme.

**When to broaden:** only when a narrow cluster can't carry an abstract "why" on its own, OR
when grouping siblings reveals a pattern worth questioning. Don't broaden for its own sake.

> NOTE: the broad-theme capability (a `themes` layer + a `group_theme` tool) is a planned code
> addition. Until it ships, do job 1 only; leave broad grouping to a human.

## Output

`{ "merge": [[fromClusterId, intoClusterId], ...],
   "themes": [{ "name": "<short theme>", "clusterIds": ["...", "..."] }, ...] }`
