<!-- HUMAN-OWNED PROMPT — edit freely. This is given to the connected LLM to classify each
     candidate turn. The tool does NOT classify intent in code; this file is the classifier.
     Validate changes against the T2 eval set. -->

# Intent classification

You are given a developer's chat turn from a coding session, plus structural context about
what the AI had just done (tools used, whether a tool call errored, the AI's last message).
Classify the turn's **primary intent** into exactly one label. Judge meaning, not keywords.

## Labels

- **R — redirect**: the developer wants the AI to do something differently, undo, or change
  course. ("rename that", "move it to a repos folder", "I prefer X", "don't do it that way")
- **O — observed**: the developer reports that reality contradicts the AI — a bug, a failed
  result, a false claim by the AI, or a stale/incorrect artifact they noticed. This is the
  developer verifying against the running system. ("I'm seeing a 403", "images aren't
  rendering on staging", "you said the key is unset but it's been set for ages")
- **C — continue**: the developer accepts/approves and moves forward, gives a new objective,
  makes a suggestion, or hands off the next task. ("looks good, keep going", "now add tests",
  "commit and push", "let's also build X")
- **Q — query**: a pure information request — the developer is asking a question, not
  correcting anything. The right response is to answer it. ("does the config handle X?",
  "is this available yet?")
- **X — not a real turn**: noise that slipped through (machine text, empty, irrelevant).

## Rules

- One label per turn, on the **primary** intent. Turns often bundle approval + a note + a
  task; pick what the turn is mainly doing.
- "O" is about reality contradicting the AI, even when phrased politely or as a question
  ("Why do you say the key is a placeholder?"). If it's really asking for info with no
  implied contradiction, it's "Q".
- Use the structural context as a hint, not a rule: a turn after a tool error is often "O",
  a turn after a clean completion is often "C" or "R" — but the text decides.

## Output

Return JSON: `{ "label": "R|O|C|Q|X", "confidence": 0.0-1.0, "why": "<one sentence>" }`
