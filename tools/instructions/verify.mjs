#!/usr/bin/env node
/**
 * Proves that editing a CLAUDE.md is safe and idempotent.
 *
 *     node tools/instructions/verify.mjs
 *
 * Touches no real file. Every case runs the pure transform in lib/claude-md.mjs against strings
 * held in memory, so this is safe to run at any time, on any machine, including someone else's.
 *
 * The property under test, stated once: **running the installer twice must leave the file exactly
 * as running it once did.** Everything below is a way of trying to break that — re-runs, changed
 * content, duplicated blocks, hand-edited blocks, CRLF files, and a user's own notes sitting
 * around ours. The last case is the one that actually matters: this code edits a file people have
 * been writing by hand for months.
 */

import { applyBlocks, markerFor, countBlocks } from "../../lib/claude-md.mjs";

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function group(name) {
  console.log(`\n${name}`);
}

const BLOCKS = [
  { name: "alpha", file: "alpha.md", title: "Alpha", body: "Alpha rule one.\nAlpha rule two." },
  { name: "beta", file: "beta.md", title: "Beta", body: "Beta rule." },
];
const ALL = new Set(["alpha", "beta"]);
const ONLY_ALPHA = new Set(["alpha"]);
const NONE = new Set();

const USER_TEXT = `# My notes

I have been keeping this file for months. Do not lose this line.

## A section of my own
- something I care about
`;

const run = (content, desired = ALL, mayRemove = true) => applyBlocks(content, BLOCKS, desired, mayRemove);

// ── The core property ───────────────────────────────────────────────────────────────────────────
group("Idempotency");
{
  const once = run("").next;
  const twice = run(once).next;
  const thrice = run(twice).next;
  check("a second run changes nothing", once === twice);
  check("a third run changes nothing", twice === thrice);
  check("no duplicate blocks after three runs", countBlocks(thrice, "alpha") === 1 && countBlocks(thrice, "beta") === 1);

  const fromUserFile = run(USER_TEXT).next;
  check("idempotent when the file already had content", fromUserFile === run(fromUserFile).next);

  // The failure this whole module exists to prevent: a file that grows a little each time.
  let content = USER_TEXT;
  for (let i = 0; i < 10; i++) content = run(content).next;
  check("stable across ten consecutive runs", content === run(content).next);
  check("ten runs produce exactly one copy of each block", countBlocks(content, "alpha") === 1 && countBlocks(content, "beta") === 1);
}

// ── The user's own content ──────────────────────────────────────────────────────────────────────
group("The user's own content is never touched");
{
  const out = run(USER_TEXT).next;
  check("user heading survives", out.includes("# My notes"));
  check("user line survives verbatim", out.includes("I have been keeping this file for months. Do not lose this line."));
  check("user list item survives", out.includes("- something I care about"));

  const removed = run(out, NONE).next;
  check("removing every block restores the original text", removed.trim() === USER_TEXT.trim(), JSON.stringify(removed));

  // Our block sandwiched between two pieces of the user's writing.
  const sandwich = `Top of my file.\n\n${run("").next}\nBottom of my file.\n`;
  const after = run(sandwich).next;
  check("text above the block survives", after.includes("Top of my file."));
  check("text below the block survives", after.includes("Bottom of my file."));
  check("sandwiched block stays single", countBlocks(after, "alpha") === 1);
}

// ── Content changes between versions ────────────────────────────────────────────────────────────
group("A changed instruction is replaced, not appended");
{
  const before = run("").next;
  const edited = [{ ...BLOCKS[0], body: "Alpha rule one.\nAlpha rule two.\nAlpha rule THREE (new in this version)." }, BLOCKS[1]];
  const after = applyBlocks(before, edited, ALL, true);

  check("reports a refresh", after.actions.some((a) => a.startsWith("refreshed")), after.actions.join(" | "));
  check("new text is present", after.next.includes("Alpha rule THREE"));
  check("old text is gone", !after.next.includes("Alpha rule two.\nAlpha rule one"));
  check("still exactly one alpha block", countBlocks(after.next, "alpha") === 1);
  check("beta reported ready, not refreshed", after.actions.some((a) => a.startsWith("ready      Beta")), after.actions.join(" | "));
}

// ── Hand-edited blocks are reclaimed ────────────────────────────────────────────────────────────
group("A hand-edited block is restored");
{
  const installed = run("").next;
  const tampered = installed.replace("Alpha rule one.", "Alpha rule one, WHICH I EDITED BY HAND.");
  const out = run(tampered);
  check("edit is overwritten", !out.next.includes("WHICH I EDITED BY HAND"));
  check("reported as a refresh", out.actions.some((a) => a.startsWith("refreshed")), out.actions.join(" | "));
}

// ── Duplicates collapse ─────────────────────────────────────────────────────────────────────────
group("Duplicate blocks are collapsed, not preserved");
{
  const one = run("").next;
  const doubled = one + "\n" + one;
  check("the test fixture really does hold two copies", countBlocks(doubled, "alpha") === 2);

  const out = run(doubled);
  check("collapses to one alpha", countBlocks(out.next, "alpha") === 1, `got ${countBlocks(out.next, "alpha")}`);
  check("collapses to one beta", countBlocks(out.next, "beta") === 1);
  check("says it repaired something", out.actions.some((a) => a.includes("duplicate")), out.actions.join(" | "));
  check("result is stable", out.next === run(out.next).next);

  const cleared = run(doubled, NONE).next;
  check("removal clears every copy", countBlocks(cleared, "alpha") === 0 && countBlocks(cleared, "beta") === 0);
}

// ── A truncated block is not silently doubled ───────────────────────────────────────────────────
group("An orphaned marker is reported, not papered over");
{
  const orphan = `${USER_TEXT}\n${markerFor("alpha", "start")}\nhalf a block, end marker lost\n`;
  const out = run(orphan);
  check("warns about the orphan", out.warnings.some((w) => w.includes("alpha")), JSON.stringify(out.warnings));
  check("does not append a second alpha", countBlocks(out.next, "alpha") === 0, "a fresh block was appended next to the orphan");
  check("leaves the user's file otherwise intact", out.next.includes("# My notes"));
  check("beta is still handled normally", countBlocks(out.next, "beta") === 1);
}

// ── Line endings ────────────────────────────────────────────────────────────────────────────────
group("Line endings are preserved");
{
  const crlf = USER_TEXT.replace(/\n/g, "\r\n");
  const out = run(crlf).next;
  check("CRLF file stays CRLF", !/[^\r]\n/.test(out), "an LF crept into a CRLF file");
  check("CRLF file is idempotent", out === run(out).next);

  const lf = run(USER_TEXT).next;
  check("LF file stays LF", !lf.includes("\r\n"));
}

// ── Removal rules ───────────────────────────────────────────────────────────────────────────────
group("Removal respects mayRemove");
{
  const both = run("").next;
  const kept = applyBlocks(both, BLOCKS, ONLY_ALPHA, false);
  check("beta survives when mayRemove is false", countBlocks(kept.next, "beta") === 1);
  const dropped = applyBlocks(both, BLOCKS, ONLY_ALPHA, true);
  check("beta is removed when mayRemove is true", countBlocks(dropped.next, "beta") === 0);
  check("alpha is untouched either way", countBlocks(dropped.next, "alpha") === 1);

  const emptied = run(both, NONE).next;
  check("a file that held only our blocks ends up empty", emptied.trim() === "");
}

// ── Real instruction files ──────────────────────────────────────────────────────────────────────
group("The repo's actual instruction files");
{
  const { loadReal } = await import("./load-real.mjs");
  const real = loadReal();
  if (real.length === 0) {
    console.log("  (none found under ./instructions — skipped)");
  } else {
    const names = new Set(real.map((b) => b.name));
    const once = applyBlocks(USER_TEXT, real, names, true).next;
    const twice = applyBlocks(once, real, names, true).next;
    check(`${real.length} real block(s) install idempotently`, once === twice);
    for (const b of real) check(`${b.name}: exactly one copy`, countBlocks(twice, b.name) === 1);
    check("user content survives the real blocks", twice.includes("# My notes"));
    const gone = applyBlocks(twice, real, new Set(), true).next;
    check("real blocks remove cleanly", gone.trim() === USER_TEXT.trim());
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
