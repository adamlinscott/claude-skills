import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createGit, normalize, pathKey, relativeTo } from "../git.mjs";
import { nodeIo } from "../cli.mjs";
import { tempRoot, gitRepo, gitWorktree } from "./fixture.mjs";

const filesOnly = () => createGit(nodeIo({ run: null }));

test("normalize: Windows and POSIX shapes, dots folded, drive upper-cased", () => {
  assert.equal(normalize("c:\\Users\\a\\.\\b\\..\\repo\\"), "C:/Users/a/repo");
  assert.equal(normalize("/home/a/./b/../repo/"), "/home/a/repo");
  assert.equal(normalize("C:\\"), "C:/");
  assert.equal(pathKey("C:\\Users\\Adam"), pathKey("c:/users/adam"));
  assert.notEqual(pathKey("/home/Adam"), pathKey("/home/adam"));
});

test("relativeTo: Windows paths fold case and slashes; outside paths are null", () => {
  assert.equal(relativeTo("C:/Users/Adam/Repo", "c:\\users\\adam\\repo\\Lib\\Wizard.MJS"), "lib/wizard.mjs");
  assert.equal(relativeTo("C:/Users/Adam/Repo", "C:\\Users\\Adam\\Repo-other\\x.js"), null);
  assert.equal(relativeTo("/home/adam/repo", "/home/adam/repo/Lib/X.mjs"), "Lib/X.mjs");
  assert.equal(relativeTo("/home/adam/repo", "/home/adam/elsewhere/x"), null);
});

test("pointer files: a main checkout is its own common dir; walks up from a subfolder", async () => {
  const root = tempRoot();
  const main = gitRepo(path.join(root, "main"), "main");
  fs.mkdirSync(path.join(main, "src", "deep"), { recursive: true });
  const r = await filesOnly().resolve(path.join(main, "src", "deep"));
  assert.equal(r.toplevel, normalize(main));
  assert.equal(r.commonDir, normalize(path.join(main, ".git")));
  assert.equal(r.branch, "main");
});

test("pointer files: a linked worktree reaches the shared common dir (relative or absolute commondir)", async () => {
  const root = tempRoot();
  const main = gitRepo(path.join(root, "main"));
  const wt = gitWorktree(main, path.join(root, "elsewhere", "wt"), "wt", "feature/x");
  const wt2 = gitWorktree(main, path.join(root, "wt2"), "wt2", "other", { absoluteCommondir: true });
  const git = filesOnly();
  const a = await git.resolve(wt);
  const b = await git.resolve(wt2);
  assert.equal(a.toplevel, normalize(wt));
  assert.equal(a.branch, "feature/x");
  assert.equal(pathKey(a.commonDir), pathKey(path.join(main, ".git")));
  assert.equal(pathKey(b.commonDir), pathKey(path.join(main, ".git")));
  assert.equal(b.branch, "other");
});

test("pointer files: a detached HEAD has no branch; no repository resolves to null", async () => {
  const root = tempRoot();
  const main = gitRepo(path.join(root, "main"));
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal((await filesOnly().resolve(main)).branch, null);
  // The temp folder itself sits in no repository (unless the machine's temp dir is inside one).
  const bare = path.join(root, "plain");
  fs.mkdirSync(bare);
  const r = await filesOnly().resolve(bare);
  if (r) assert.notEqual(pathKey(r.toplevel), pathKey(bare));
});

test("pointer files: a removed worktree inside a checkout does not resolve to that checkout", async () => {
  const root = tempRoot();
  const main = gitRepo(path.join(root, "main"));
  assert.equal(await filesOnly().resolve(path.join(main, ".claude", "worktrees", "agent-gone")), null);
});

test("runner first: its answer is used and cached per folder", async () => {
  const calls = [];
  const run = (argv, { cwd }) => {
    calls.push([argv.join(" "), cwd]);
    if (argv.includes("--show-toplevel")) return { code: 0, stdout: "C:/repo/wt\nC:/repo/main/.git\n" };
    return { code: 0, stdout: "feature/y\n" };
  };
  const git = createGit({ ...nodeIo(), run });
  const r = await git.resolve("C:\\repo\\wt");
  await git.resolve("c:/repo/wt");
  assert.deepEqual(r, { toplevel: "C:/repo/wt", commonDir: "C:/repo/main/.git", branch: "feature/y" });
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /rev-parse --path-format=absolute --show-toplevel --git-common-dir/);
});

test("cache: an answer expires after maxAgeMs; calls at one `now` share one answer per folder", async () => {
  let calls = 0;
  const run = (argv) => {
    calls++;
    return argv.includes("--show-toplevel") ? { code: 0, stdout: "/r\n/r/.git\n" } : { code: 0, stdout: "main\n" };
  };
  const git = createGit({ ...nodeIo(), run });
  const at = (now) => ({ now, maxAgeMs: 60000 });
  await git.resolve("/r", at(0));
  await git.resolve("/r/", at(0));
  assert.equal(calls, 2);
  await git.resolve("/r", at(60000));
  assert.equal(calls, 2);
  await git.resolve("/r", at(60001));
  await git.resolve("/r", at(60001));
  assert.equal(calls, 4);
});

test("runner failure falls back to the pointer files", async () => {
  const root = tempRoot();
  const main = gitRepo(path.join(root, "main"), "trunk");
  const git = createGit({ ...nodeIo(), run: () => ({ code: 128, stdout: "" }) });
  assert.equal((await git.resolve(main)).branch, "trunk");
  const throwing = createGit({ ...nodeIo(), run: () => { throw new Error("git not found"); } });
  assert.equal((await throwing.resolve(main)).branch, "trunk");
});
