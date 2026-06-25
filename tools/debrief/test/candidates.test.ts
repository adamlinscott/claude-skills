import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, type RawEvent } from "../src/extract/candidates.ts";

test("candidate after a tool error carries structural flags (no intent read)", () => {
  const events: RawEvent[] = [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] } },
    { type: "user", uuid: "h1", message: { content: [{ type: "text", text: "that 403 is back on /files" }] } },
  ];
  const c = extractCandidates(events);
  assert.equal(c.length, 1);
  assert.equal(c[0].turn.uuid, "h1");
  assert.equal(c[0].precededByToolUse, true);
  assert.equal(c[0].precededByError, true);
  assert.deepEqual(c[0].ai?.tools, ["Bash"]);
});

test("plain continuation turn: preceded by assistant, no tool, no error", () => {
  const events: RawEvent[] = [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { type: "user", uuid: "h2", message: { content: [{ type: "text", text: "now add tests" }] } },
  ];
  const c = extractCandidates(events);
  assert.equal(c.length, 1);
  assert.equal(c[0].precededByAssistant, true);
  assert.equal(c[0].precededByToolUse, false);
  assert.equal(c[0].precededByError, false);
});

test("tool_result-only user events are not candidates; window resets per human turn", () => {
  const events: RawEvent[] = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    { type: "user", uuid: "h1", message: { content: [{ type: "text", text: "looks good, keep going" }] } },
    { type: "user", uuid: "h2", message: { content: [{ type: "text", text: "actually rename that" }] } },
  ];
  const c = extractCandidates(events);
  assert.equal(c.length, 2);
  // first human turn saw the tool_use; after it, the window resets
  assert.equal(c[0].precededByToolUse, true);
  assert.equal(c[1].precededByAssistant, false); // no assistant between h1 and h2
});
