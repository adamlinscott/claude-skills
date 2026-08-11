// Tests for install.mjs.
//
// The installer writes to ~/.claude/, so every test runs it as a CHILD PROCESS with HOME and
// USERPROFILE pointed at a fresh temp directory. os.homedir() reads USERPROFILE on Windows and
// HOME on POSIX, so both must be set for the suite to be cross-platform.
//
// Menus are driven by piped keystrokes. lib/wizard.mjs was always built for this — it queues
// keys that arrive before a menu subscribes — but canPrompt() gated on isTTY, so nothing could
// reach them. CLAUDE_SKILLS_FORCE_PROMPT=1 opens that gate and is read nowhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "install.mjs");
const repoSkills = path.join(repoRoot, "skills");
const linkType = process.platform === "win32" ? "junction" : "dir";

const ENTER = "\r";

/** A throwaway HOME. Returned paths are the ones the installer will write to. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-skills-test-"));
  return {
    home,
    skillsDir: path.join(home, ".claude", "skills"),
    claudeMd: path.join(home, ".claude", "CLAUDE.md"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function run(args, { home, stdin = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [installer, ...args], {
    cwd: repoRoot,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
  });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

/** Run with the menus live, driven by the given keystrokes. */
function runInteractive(args, opts) {
  return run(args, { ...opts, env: { CLAUDE_SKILLS_FORCE_PROMPT: "1", ...(opts.env || {}) } });
}

/** Folder names currently present in the fake home's skills dir. Empty when it does not exist. */
function readdir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

// ── Cases ──────────────────────────────────────────────────────────────────────────────────────

test("developer track with -y links the dev defaults and writes no instruction block", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const { status } = run(["--for=developer", "-y"], { home: h.home });
  assert.equal(status, 0);

  const got = readdir(h.skillsDir);
  // raise-issue is dev:off — a developer must tick it deliberately.
  assert.ok(!got.includes("raise-issue"), "raise-issue must not install on the developer track");
  assert.ok(got.includes("fresh-eyes"), "stable dev skills should install");
  assert.ok(!existsSync(h.claudeMd), "no instruction block without an explicit yes");
});

test("non-technical track with -y links the nontech preset and nothing else", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const { status } = run(["--for=nontechnical", "-y"], { home: h.home });
  assert.equal(status, 0);

  // Exactly the preset, not merely "contains some of it" — an over-broad track default is as
  // much a bug as a missing one, and only a full equality check catches it.
  assert.deepEqual(readdir(h.skillsDir), [
    "memory-audit",
    "raise-issue",
    "reground",
    "report-issue",
    "to-the-point",
    "ttp",
  ]);
});

test("no extras command is ever executed on a non-interactive run", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const { stdout } = run(["--for=nontechnical", "-y"], { home: h.home });
  // Only EXECUTION is forbidden. The command may still be printed as a suggestion for someone
  // to run later — that is the point of the closing message — so assert on the markers runExtras
  // emits when it actually spawns something, not on the command text itself.
  assert.ok(!/running:/.test(stdout), "an unattended run must never launch a third-party installer");
  assert.ok(!/^\s*installed\s+Matt/im.test(stdout), "no extra should be reported as installed");
  assert.ok(!/Next, inside Claude:/.test(stdout), "that follow-up only prints after a real install");
});

test("REGRESSION: choosing the non-technical track never unlinks an existing install", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // A developer with everything linked, exactly as a real machine would be.
  mkdirSync(h.skillsDir, { recursive: true });
  const preexisting = [
    "assumption-inventory",
    "context-audit",
    "fresh-eyes",
    "goal-workflow",
    "memory-audit",
    "reground",
    "ttp",
    "to-the-point",
  ];
  for (const folder of preexisting) {
    symlinkSync(path.join(repoSkills, folder), path.join(h.skillsDir, folder), linkType);
  }

  const { status, stdout } = runInteractive(["--for=nontechnical"], { home: h.home, stdin: ENTER });
  assert.equal(status, 0, stdout);

  const got = readdir(h.skillsDir);
  for (const folder of preexisting) {
    assert.ok(got.includes(folder), `${folder} was unlinked by the non-technical track — union floor violated`);
  }
  assert.ok(got.includes("raise-issue"), "the track should still ADD its own preset");
  assert.ok(!/removed/.test(stdout), "nothing should be reported as removed");
});

test("the union floor ADDS the preset to a partial install without disturbing it", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // Deliberately partial, and deliberately NOT a superset of the preset: goal-workflow is
  // nontech:off (must survive) and ttp is nontech:on (already present, must not be duplicated or
  // churned), while raise-issue is nontech:on and absent (must be added). Without a union the
  // preset would replace this set rather than extend it.
  mkdirSync(h.skillsDir, { recursive: true });
  for (const folder of ["goal-workflow", "ttp"]) {
    symlinkSync(path.join(repoSkills, folder), path.join(h.skillsDir, folder), linkType);
  }

  const { stdout } = runInteractive(["--for=nontechnical"], { home: h.home, stdin: ENTER });
  const got = readdir(h.skillsDir);

  assert.ok(got.includes("goal-workflow"), "a skill outside the preset was dropped — not a floor");
  assert.ok(got.includes("ttp"), "a skill inside the preset that was already there was dropped");
  assert.ok(got.includes("raise-issue"), "the preset was not added");
  assert.ok(!/removed/.test(stdout), "nothing may be reported as removed");
});

test("the guided track writes the plain-English instruction; the developer track does not", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  runInteractive(["--for=nontechnical"], { home: h.home, stdin: ENTER });
  assert.ok(existsSync(h.claudeMd), "the guided track must write the global instruction block");
  assert.match(readFileSync(h.claudeMd, "utf8"), /claude-skills:clear-responses/);

  const h2 = makeHome();
  t.after(h2.cleanup);
  // Developer track: walk every checklist to its Confirm row, ticking nothing extra.
  const DOWN = "\x1b[B";
  runInteractive(["--for=developer"], {
    home: h2.home,
    stdin: DOWN.repeat(8) + "\r" + DOWN.repeat(3) + "\r" + DOWN.repeat(2) + "\r" + "\r",
  });
  assert.ok(!existsSync(h2.claudeMd), "a developer must not get a global instruction they never ticked");
});

test("the backup is refreshed on each change, not written once and left to go stale", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  mkdirSync(path.join(h.home, ".claude"), { recursive: true });
  writeFileSync(h.claudeMd, "# first\n");
  run(["--for=developer", "-y", "--add-instructions=clear-responses"], { home: h.home });
  assert.match(readFileSync(`${h.claudeMd}.bak`, "utf8"), /# first/);

  // The user then edits their own file. The next change must back up THAT, not the day-one state.
  writeFileSync(h.claudeMd, "# second, written by hand later\n");
  run(["--for=developer", "-y", "--add-instructions=clear-responses"], { home: h.home });
  const bak = readFileSync(`${h.claudeMd}.bak`, "utf8");
  assert.match(bak, /second, written by hand later/, "the backup is stale — it still holds the first version");
});

test("a run that changes nothing does not touch the backup", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  mkdirSync(path.join(h.home, ".claude"), { recursive: true });
  writeFileSync(h.claudeMd, "# mine\n");
  // No instruction selected, so nothing about the file changes.
  run(["--for=developer", "-y"], { home: h.home });
  assert.ok(!existsSync(`${h.claudeMd}.bak`), "a no-op run must not burn the backup on unchanged content");
});

test("the audience question is skipped entirely under --uninstall", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  mkdirSync(h.skillsDir, { recursive: true });
  symlinkSync(path.join(repoSkills, "fresh-eyes"), path.join(h.skillsDir, "fresh-eyes"), linkType);

  // Drive the removal properly rather than sending bare Enters: in a multiSelect, Enter on an
  // item row TOGGLES it, so the old version aborted on end-of-input and asserted the absence of
  // text in a run that did nothing at all.
  const DOWN = "\x1b[B";
  const keys = DOWN.repeat(8) + "\r" + DOWN.repeat(3) + "\r" + "\r";
  const { stdout, status } = runInteractive(["--uninstall"], { home: h.home, stdin: keys });
  assert.equal(status, 0);

  assert.ok(!/kind of setup do you want/i.test(stdout), "no audience question during a removal");
  assert.match(stdout, /Tick the ones to remove/, "the removal checklist must be what is shown instead");
  assert.deepEqual(readdir(h.skillsDir), [], "the run must actually have removed something");
});

test("REGRESSION: --for cannot turn a removal into a silent remove-everything", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  mkdirSync(h.skillsDir, { recursive: true });
  for (const folder of ["fresh-eyes", "ttp", "reground"]) {
    symlinkSync(path.join(repoSkills, folder), path.join(h.skillsDir, folder), linkType);
  }

  // Skipping the audience QUESTION under --uninstall is not enough — an explicit --for must not
  // suppress the removal checklist either, or one keypress unlinks everything unseen.
  const { stdout } = runInteractive(["--uninstall", "--for=nontechnical"], { home: h.home, stdin: ENTER });
  assert.match(stdout, /Tick the ones to remove/, "the removal checklist must still be shown");
  assert.deepEqual(readdir(h.skillsDir), ["fresh-eyes", "reground", "ttp"], "nothing may be removed on one keypress");
});

test("REGRESSION: pruning a group never deletes a foreign directory sharing its alias", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // Our link for one folder of the ttp group, and somebody ELSE's real directory at its alias.
  mkdirSync(h.skillsDir, { recursive: true });
  symlinkSync(path.join(repoSkills, "ttp"), path.join(h.skillsDir, "ttp"), linkType);
  mkdirSync(path.join(h.skillsDir, "to-the-point"), { recursive: true });
  writeFileSync(path.join(h.skillsDir, "to-the-point", "SKILL.md"), "# not ours\n");

  // The skills checklist opens on what is linked, so only ttp is ticked. Walk to it, untick it
  // with space, step to Confirm, then clear the beta checklist and the Ready gate.
  // Menu sequence on the developer track: skills → beta → extras → Ready. Each multiSelect needs
  // the cursor walked to its Confirm row (one past the last item); Enter on an item row toggles.
  const DOWN = "\x1b[B";
  const TTP_ROW = 7; // assumption-inventory, context-audit, fresh-eyes, goal-workflow, memory-audit, raise-issue, reground, ttp
  const keys =
    DOWN.repeat(TTP_ROW) + " " + DOWN + "\r" + // skills: untick ttp, confirm
    DOWN.repeat(3) + "\r" + //                    beta: 3 items, confirm
    DOWN.repeat(2) + "\r" + //                    extras: 2 items, confirm
    "\r"; //                                      Ready: Install
  const { stdout } = runInteractive(["--for=developer"], { home: h.home, stdin: keys });

  // Guard against this test going vacuous: if the prune path is not reached, it proves nothing.
  assert.match(stdout, /removed\s+ttp/, "the prune path was never reached — this test is not testing anything");

  const foreign = path.join(h.skillsDir, "to-the-point", "SKILL.md");
  assert.ok(existsSync(foreign), "a directory this installer never created was force-deleted");
  assert.equal(readFileSync(foreign, "utf8"), "# not ours\n");
});

test("an unknown --for value is rejected rather than silently defaulting", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const { stdout } = run(["--for=nontech"], { home: h.home });
  assert.match(stdout, /do not recognise|not a valid/i);
  assert.ok(!existsSync(h.skillsDir), "nothing should be installed after a bad flag");
});

test("a malformed defaults column fails safe to off and never to on", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // DEVELOPER track on purpose. The nontech fallback is already `off`, so junk would be
  // indistinguishable from the feature not existing; only the dev axis (fallback `on`) can show
  // that an unparseable value actively forces off.
  const custom = path.join(h.home, "skills.txt");
  writeFileSync(custom, "fresh-eyes | fresh-eyes | desc | banana,banana\nttp | ttp | desc | on,on\n");
  const { status } = run(["--for=developer", "-y"], {
    home: h.home,
    env: { CLAUDE_SKILLS_LIST_FILE: custom },
  });
  assert.equal(status, 0);
  const got = readdir(h.skillsDir);
  assert.ok(!got.includes("fresh-eyes"), "an unparseable dev default must resolve to off, not to its `on` fallback");
  assert.ok(got.includes("ttp"), "a well-formed neighbour must still install — otherwise this proves nothing");
});

test("an omitted defaults column keeps the historical on,off behaviour", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const custom = path.join(h.home, "skills.txt");
  writeFileSync(custom, "fresh-eyes | fresh-eyes | desc\n");
  run(["--for=developer", "-y"], { home: h.home, env: { CLAUDE_SKILLS_LIST_FILE: custom } });
  assert.ok(readdir(h.skillsDir).includes("fresh-eyes"), "a three-field line must still install for a developer");

  const h2 = makeHome();
  t.after(h2.cleanup);
  run(["--for=nontechnical", "-y"], { home: h2.home, env: { CLAUDE_SKILLS_LIST_FILE: custom } });
  assert.ok(!readdir(h2.skillsDir).includes("fresh-eyes"), "and must stay out of the guided preset");
});

test("an unknown name warns rather than degrading silently", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  const custom = path.join(h.home, "skills.txt");
  writeFileSync(custom, "ghost | no-such-folder | desc | on,on\nttp | ttp | desc | on,on\n");
  const { stdout, status } = run(["--for=developer", "-y"], {
    home: h.home,
    env: { CLAUDE_SKILLS_LIST_FILE: custom },
  });

  assert.equal(status, 0, "a stale line must not break the run");
  assert.match(stdout, /note:.*ghost.*names no folder/i, "a vanished skill must not disappear in silence");
  assert.ok(readdir(h.skillsDir).includes("ttp"), "the rest of the file must still be honoured");
});

test("beta wins: a name in beta-features.txt is not installed by a track default", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // seatbelt and debrief are beta. Force them on for BOTH tracks and confirm the flag-driven run
  // still refuses — nothing still in development turns itself on with nobody watching.
  const custom = path.join(h.home, "skills.txt");
  writeFileSync(
    custom,
    "seatbelt | seatbelt, seatbelts | desc | on,on\ndebrief | debrief | desc | on,on\nttp | ttp | desc | on,on\n",
  );
  for (const track of ["developer", "nontechnical"]) {
    const home = makeHome();
    t.after(home.cleanup);
    run([`--for=${track}`, "-y"], { home: home.home, env: { CLAUDE_SKILLS_LIST_FILE: custom } });
    const got = readdir(home.skillsDir);
    assert.ok(!got.includes("seatbelt"), `${track}: beta must win over a track default`);
    assert.ok(!got.includes("debrief"), `${track}: beta must win over a track default`);
    assert.ok(got.includes("ttp"), `${track}: a non-beta neighbour must still install`);
  }
});

test("running twice is idempotent and leaves CLAUDE.md byte-identical", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  run(["--for=nontechnical", "-y", "--add-instructions=clear-responses"], { home: h.home });
  const first = readFileSync(h.claudeMd, "utf8");
  const firstLinks = readdir(h.skillsDir);

  const { stdout } = run(["--for=nontechnical", "-y", "--add-instructions=clear-responses"], { home: h.home });
  assert.equal(readFileSync(h.claudeMd, "utf8"), first, "second run rewrote CLAUDE.md");
  assert.deepEqual(readdir(h.skillsDir), firstLinks);
  assert.match(stdout, /ready|keep/i);
});

test("CLAUDE.md is backed up before it is first modified", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  mkdirSync(path.join(h.home, ".claude"), { recursive: true });
  const original = "# my notes\n\nsomething I wrote myself\n";
  writeFileSync(h.claudeMd, original);

  run(["--for=developer", "-y", "--add-instructions=clear-responses"], { home: h.home });

  assert.ok(existsSync(`${h.claudeMd}.bak`), "no backup was written");
  assert.equal(readFileSync(`${h.claudeMd}.bak`, "utf8"), original, "backup does not hold the original");
  assert.match(readFileSync(h.claudeMd, "utf8"), /something I wrote myself/, "user content was lost");
});

// Named for what it actually pins. A moved clone DOES read as a first run — isGroupLinked
// compares the readlink target against this repo, so a link into the old location no longer
// matches. What must never happen is the stale entry being torn down instead of repaired.
test("a moved clone has its stale links repaired, never silently dropped", (t) => {
  const h = makeHome();
  t.after(h.cleanup);

  // A link pointing at a path that no longer exists — what a moved or renamed clone leaves behind.
  mkdirSync(h.skillsDir, { recursive: true });
  const ghostSource = path.join(h.home, "somewhere-else", "fresh-eyes");
  mkdirSync(ghostSource, { recursive: true });
  symlinkSync(ghostSource, path.join(h.skillsDir, "fresh-eyes"), linkType);
  rmSync(path.join(h.home, "somewhere-else"), { recursive: true, force: true });

  // DEVELOPER track, where prune.skills is genuinely live. On the guided track nothing can be
  // pruned regardless, so running this there would assert nothing at all.
  //
  // Note what this actually pins: a dangling link makes isGroupLinked false, so the clone DOES
  // read as a first run. What must not happen is the stale entry being torn down. Untick nothing
  // and walk straight to Confirm: fresh-eyes stays ticked, so it takes the repair path.
  const DOWN = "\x1b[B";
  const keys = DOWN.repeat(8) + "\r" + DOWN.repeat(3) + "\r" + DOWN.repeat(2) + "\r" + "\r";
  const { status, stdout } = runInteractive(["--for=developer"], { home: h.home, stdin: keys });
  assert.equal(status, 0, stdout);

  // lstat, not existsSync: existsSync FOLLOWS the link, and this one deliberately dangled, so it
  // reports false for a junction that is still very much there.
  assert.ok(lstatSync(path.join(h.skillsDir, "fresh-eyes"), { throwIfNoEntry: false }),
    "the entry vanished — a stale link must be repaired, never silently dropped");
  assert.match(stdout, /(installed|repaired|ready)\s+fresh-eyes/, "fresh-eyes was never processed — this test is not testing anything");
  assert.ok(!/removed\s+fresh-eyes/.test(stdout), "a dangling link must not be reported as removed");
});
