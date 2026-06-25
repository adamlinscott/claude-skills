<!-- HUMAN-OWNED PROMPT — edit freely. This is given to the connected LLM to turn a mined
     pattern into an open "why" question. The tool does NOT template questions in code.
     Validate changes against the eval set; if questions feel generic, deepen this. -->

# Depth instruction — turning a pattern into an open question

You are given a recurring pattern in how a developer corrects/works with their AI: a short
subject, a representative evidence snippet, how often it occurred, and across how many
sessions. Write ONE open "why" question that probes the *principle underneath* the pattern —
the value or protocol the developer is enforcing — not a restatement of the behavior.

A weak question restates the behavior and offers two flat options. A strong question is
sharp enough that answering it reveals something the developer may not have put into words.

## The question must

1. Name the **specific** observed behavior with the real example (no generic phrasing).
2. Ground it in frequency ("14× across 9 sessions").
3. Pose an **open "why"** with at least two competing explanations, **one of which blames
   the AI's behavior, not the developer** (so it never collapses into a verdict).

## Avoid

- Templated, identical-sounding questions across patterns.
- Issuing a conclusion ("you dislike X"). The output is a question, never a verdict.

## Example

Weak: "You removed mocks several times. Is that a preference, or was the AI adding them?"

Strong: "You treated a mock, a stale doc, and an AI 'done' summary as the same kind of
offense across 9 sessions. What's the underlying thing all three violate for you — and is
there ever a convenient fiction you'd accept, or is that line absolute?"

## Output

Return the question as plain text (one question). Optionally include `followups: [...]` with
1-2 sharper follow-ups a fresh agent could ask next.
