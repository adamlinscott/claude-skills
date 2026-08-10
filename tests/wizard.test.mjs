// The wizard, driven by piped key sequences from a child process.
//
// lib/wizard.mjs has always said it supports this ("the menus can still be driven by piped key
// sequences in a test") and nothing has ever done it. These are the first, and they exist mainly to
// hold two specific bugs down: a text field that closes while its value is invalid, and the
// double-keypress that comes back if stdin is re-armed without the old listener coming off.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "wizard-harness.mjs");

const ESC = "\x1b";
const ENTER = "\r";

/** Run the harness in `mode`, feed it `keys`, and return whatever it printed as its result. */
function drive(mode, keys, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness, mode], {
      stdio: ["pipe", "pipe", "pipe"],
      // NO_COLOR keeps the output free of escape sequences so the marker is easy to find.
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; output so far: ${out}${err}`));
    }, timeout);

    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const marker = out.lastIndexOf("__RESULT__");
      if (marker === -1) return reject(new Error(`no result printed. stdout:\n${out}\nstderr:\n${err}`));
      const line = out.slice(marker + "__RESULT__".length).split("\n")[0];
      try {
        resolve({ value: JSON.parse(line), stdout: out });
      } catch (e) {
        reject(new Error(`result was not JSON: ${line}`));
      }
    });

    child.stdin.write(keys);
    child.stdin.end();
  });
}

describe("textInput", () => {
  test("returns what was typed", async () => {
    const { value } = await drive("text", `workspace${ENTER}`);
    assert.equal(value, "workspace");
  });

  test("trims surrounding whitespace", async () => {
    const { value } = await drive("text", `  spaced  ${ENTER}`);
    assert.equal(value, "spaced");
  });

  test("backspace deletes", async () => {
    const { value } = await drive("text", `workspaceXX\x7f\x7f${ENTER}`);
    assert.equal(value, "workspace");
  });

  test("ctrl-u clears the whole field", async () => {
    const { value } = await drive("text", `rubbish\x15fresh${ENTER}`);
    assert.equal(value, "fresh");
  });

  test("escape cancels and returns null", async () => {
    const { value } = await drive("text", `half-typed${ESC}`);
    assert.equal(value, null);
  });

  test("an initial value comes back when enter is pressed straight away", async () => {
    const { value } = await drive("text-initial", ENTER);
    assert.equal(value, "workspace");
  });

  test("a failed validate keeps the field open and shows why", async () => {
    // First enter must be refused ("ab" is too short), so only the second one closes it.
    const { value, stdout } = await drive("text-validate", `ab${ENTER}cde${ENTER}`);
    assert.equal(value, "abcde");
    assert.match(stdout, /too short/);
  });

  test("arrow keys do not end up in the value", async () => {
    const { value } = await drive("text", `ab${ESC}[Acd${ENTER}`);
    assert.equal(value, "abcd");
  });
});

describe("stdin handover", () => {
  test("a text field, then closeInput, then a menu — each key counted once", async () => {
    // The regression guard. If closeInput leaves its listener attached, ensureInput stacks a second
    // one and every keypress fires twice: the down arrow would move two rows and the wrong item
    // would be ticked.
    const { value } = await drive("text-then-menu", `name${ENTER}\x1b[B \x1b[B${ENTER}`);
    assert.equal(value.typed, "name");
    assert.deepEqual(value.picked, ["b"], "one down arrow must move exactly one row");
  });
});

describe("multiSelect", () => {
  test("space ticks the row under the cursor", async () => {
    const { value } = await drive("menu", ` \x1b[B\x1b[B\x1b[B${ENTER}`);
    assert.deepEqual(value, ["a"]);
  });

  test("'a' ticks everything, and again unticks everything", async () => {
    const all = await drive("menu", `a\x1b[B\x1b[B\x1b[B${ENTER}`);
    assert.deepEqual(all.value.sort(), ["a", "b", "c"]);
    const none = await drive("menu", `aa\x1b[B\x1b[B\x1b[B${ENTER}`);
    assert.deepEqual(none.value, []);
  });

  test("escape returns null so the caller can treat it as cancel", async () => {
    const { value } = await drive("menu", ESC);
    assert.equal(value, null);
  });
});

describe("chooseAction", () => {
  test("enter picks the row under the cursor", async () => {
    assert.equal((await drive("confirm", ENTER)).value, "go");
    assert.equal((await drive("confirm", `\x1b[B${ENTER}`)).value, "cancel");
  });

  test("running out of input is a cancel, not a hang", async () => {
    assert.equal((await drive("confirm", "")).value, null);
  });
});
