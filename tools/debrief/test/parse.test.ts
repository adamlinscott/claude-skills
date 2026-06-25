import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContent, isHumanTextTurn, isInjectedNoise, extractHumanTurns, type RawEvent } from "../src/extract/parse.ts";

// Fixtures mirror the VERIFIED shapes from the spike against a real CC 2.1.181 session.

test("normalizeContent handles array content with text + tool_result", () => {
  const info = normalizeContent([
    { type: "text", text: "move them to a repos folder" },
    { type: "tool_result", tool_use_id: "x", content: "ok", is_error: false },
  ]);
  assert.equal(info.text, "move them to a repos folder");
  assert.equal(info.hasText, true);
  assert.equal(info.hasToolResult, true);
});

test("normalizeContent handles string content (lighter sessions)", () => {
  const info = normalizeContent("just a string");
  assert.equal(info.text, "just a string");
  assert.equal(info.hasText, true);
  assert.equal(info.hasToolResult, false);
});

test("tool_result-only user turn is NOT a human turn", () => {
  const ev: RawEvent = { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "x", content: "stdout", is_error: false },
  ] } };
  assert.equal(isHumanTextTurn(ev), false);
});

test("injected caveat (isMeta true) is NOT a human turn", () => {
  const ev: RawEvent = { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>...</local-command-caveat>" } };
  assert.equal(isHumanTextTurn(ev), false);
});

test("slash-command machinery is NOT a human turn", () => {
  const ev: RawEvent = { type: "user", message: { role: "user", content: "<command-name>/mcp</command-name>" } };
  assert.equal(isHumanTextTurn(ev), false);
});

test("real array-text turn with absent origin + undefined isMeta IS a human turn", () => {
  // This is the exact shape that the bootstrap-derived gate wrongly rejected.
  const ev: RawEvent = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "I'm wondering if it would be cleaner to have the repos alpha and micro" }] },
  };
  assert.equal(isHumanTextTurn(ev), true);
});

test("injected compaction summary is NOT a human turn (T2 spike finding)", () => {
  const txt = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.";
  assert.equal(isInjectedNoise(txt), true);
  const ev: RawEvent = { type: "user", message: { role: "user", content: [{ type: "text", text: txt }] } };
  assert.equal(isHumanTextTurn(ev), false);
});

test("interrupt marker is NOT a human turn", () => {
  const ev: RawEvent = { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
  assert.equal(isHumanTextTurn(ev), false);
});

test("extractHumanTurns keeps only the 3 real turns from a mixed stream", () => {
  const events: RawEvent[] = [
    { type: "file-history-snapshot" },
    { type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } },
    { type: "user", uuid: "a", message: { content: [{ type: "text", text: "following the guidelines of another agent I'm creating this repo" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    { type: "user", uuid: "b", message: { content: [{ type: "text", text: "I'm wondering if it would be cleaner to have the repos alpha and micro" }] } },
    { type: "user", uuid: "c", message: { content: [{ type: "text", text: "Good arguments. I agree with them all. Let's move them to a repos folder" }] } },
  ];
  const turns = extractHumanTurns(events);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.uuid), ["a", "b", "c"]);
});
