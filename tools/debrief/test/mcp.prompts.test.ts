import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadReturnInstructions, makeInstructionsReader } from "../src/mcp/prompts.ts";

test("loadReturnInstructions reads BOTH prompt files from disk at runtime", async () => {
  const instr = await loadReturnInstructions();
  // depth-instruction.md and classify-intent.md actually loaded (non-empty, recognizable content)
  assert.ok(instr.depthInstruction.length > 0);
  assert.ok(instr.classifyIntent.length > 0);
  assert.match(instr.depthInstruction, /open "?why"? question/i);
  assert.match(instr.classifyIntent, /Intent classification/i);
});

test("makeInstructionsReader caches within the TTL then re-reads from disk (live edits, no restart)", async () => {
  // Within the TTL the same loaded object is reused (no disk read per call); after the TTL the files
  // are re-read so a human's prompt edit takes effect without restarting the long-running server.
  const read = makeInstructionsReader(40);
  const a = await read();
  const b = await read();
  assert.strictEqual(a, b, "within TTL the cached instructions object is reused");
  assert.ok(a.depthInstruction.length > 0);

  await delay(60);
  const c = await read();
  assert.notStrictEqual(a, c, "after the TTL the reader re-reads (fresh object), so edits are picked up");
  // content is stable (we did not edit the files), proving the re-read returns equivalent text
  assert.equal(c.depthInstruction, a.depthInstruction);
});
