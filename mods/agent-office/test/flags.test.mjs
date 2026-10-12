import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictNote, editedFile } from "../flags.mjs";
import { office, NOW } from "./office.mjs";

const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const opts = { now: NOW, window: 30 };

// Two rooms: a's lead with a worker, and b's lead with a reviewer.
function twoRooms() {
  return office([
    { id: "a", sessions: [{ id: "s-a", team: [{ id: "w" }] }] },
    { id: "b", sessions: [{ id: "s-b", team: [{ id: "r", type: "reviewer" }] }] },
  ]);
}

test("a note names each other agent, in any room, that edited the file inside the window", () => {
  const m = twoRooms();
  m.edits.push({ agent: "r", file: "lib/x.mjs", at: ago(12) }, { agent: "w", file: "lib/x.mjs", at: ago(3) });
  const note = conflictNote(m, { agent: "s-a:lead", session: "s-a", path: "C:/w/s-a/lib/x.mjs" }, opts);
  assert.equal(
    note,
    [
      'Possible conflict: lib/x.mjs was also edited 3m ago by worker in "Room a"',
      'Possible conflict: lib/x.mjs was also edited 12m ago by reviewer in "Room b"',
      "Check that your change and theirs fit together before going on.",
    ].join("\n"),
  );
});

test("no note for your own edits, an edit older than the window, or a path outside the checkout", () => {
  const m = twoRooms();
  m.edits.push({ agent: "w", file: "lib/own.mjs", at: ago(1) }, { agent: "r", file: "lib/old.mjs", at: ago(31) }, { agent: "r", file: "lib/x.mjs", at: ago(1) });
  assert.equal(conflictNote(m, { agent: "w", session: "s-a", path: "C:/w/s-a/lib/own.mjs" }, opts), null);
  assert.equal(conflictNote(m, { agent: "w", session: "s-a", path: "C:/w/s-a/lib/old.mjs" }, opts), null);
  assert.equal(conflictNote(m, { agent: "w", session: "s-a", path: "C:/elsewhere/lib/x.mjs" }, opts), null);
});

test("a subagent in its own worktree: the file is relative to its worktree, not its session's checkout", () => {
  const m = twoRooms();
  Object.assign(m.agents.find((a) => a.id === "w"), { checkout: "C:/w/s-a-wt", branch: "wt" });
  m.edits.push({ agent: "s-b:lead", file: "lib/x.mjs", at: ago(5) });
  assert.equal(editedFile(m, { agent: "w", session: "s-a", path: "C:/w/s-a-wt/lib/x.mjs" }), "lib/x.mjs");
  assert.match(conflictNote(m, { agent: "w", session: "s-a", path: "C:/w/s-a-wt/lib/x.mjs" }, opts), /by lead in "Room b"/);
  // A caller the model doesn't hold yet falls back to its session's checkout.
  assert.equal(editedFile(m, { agent: "new", session: "s-a", path: "C:/w/s-a/lib/x.mjs" }), "lib/x.mjs");
});

test("Windows paths: backslashes and any case name the same file as the model's", () => {
  const m = twoRooms();
  m.edits.push({ agent: "r", file: "lib/wizard.mjs", at: ago(2) });
  assert.equal(editedFile(m, { agent: "s-a:lead", session: "s-a", path: "c:\\W\\S-A\\Lib\\Wizard.mjs" }), "lib/wizard.mjs");
  assert.match(conflictNote(m, { agent: "s-a:lead", session: "s-a", path: "c:\\W\\S-A\\Lib\\Wizard.mjs" }, opts), /^Possible conflict: lib\/wizard\.mjs was also edited 2m ago by reviewer/);
});
