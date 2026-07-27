/**
 * seatbelt guard tests. Zero dependencies: `node guard.test.mjs`.
 *
 * This is also the skill's verification step. /seatbelt runs this file instead of
 * probing with a live destructive command, because the case a live probe exists to
 * catch is the case where the command SUCCEEDS.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decide,
  tokenize,
  splitSegments,
  extractSubstitutions,
  unwrap,
  globToRegExp,
  ruleMatches,
  validatePolicy,
} from "./guard.mjs";

// --------------------------------------------------------------- fixtures

const root = mkdtempSync(path.join(tmpdir(), "seatbelt-test-"));
mkdirSync(path.join(root, ".claude"), { recursive: true });
writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify({
    scripts: {
      test: "vitest run",
      build: "tsc -p .",
      deploy: "vercel --prod",
      ship: "npm run build && npm run deploy",
    },
  }),
);
writeFileSync(path.join(root, "Makefile"), "deploy:\n\tfly deploy --now\n\nlint:\n\teslint .\n");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const POLICY = {
  version: 1,
  mode: "vibe",
  protectedPaths: [".claude/seatbelt.policy.json", ".claude/settings.local.json", ".claude/assets/guard.mjs"],
  protectedGlobs: [".github/workflows/**"],
  defaultBranchFallbacks: ["main", "master", "trunk", "develop"],
  allowPushToDefaultBranch: false,
  allowHistoryRewrite: false,
  allowForcePush: false,
  denyCommands: [
    { contains: ["vercel", "--prod"], reason: "deploy" },
    { contains: ["fly", "deploy"], reason: "deploy" },
    { contains: ["drop table"], reason: "destructive" },
  ],
  askCommands: [{ regex: "^(npm|pnpm|yarn|bun)\\s+(i|add|install)\\b", reason: "installs a package" }],
  mcpDeny: [{ regex: "^mcp__.*__(merge_pull_request|delete_.*|drop-.*|buy_.*)$" }],
  mcpAsk: [],
  unknownMcp: "ask",
  unresolvedScript: "deny",
  allowCommands: [],
  logPath: null,
};

const FACTS = { branch: "feature/x", defaultBranch: "main", commonDir: path.join(root, ".git"), hooksPath: "" };
const ctx = (over = {}) => ({
  root,
  facts: { ...FACTS, ...(over.facts ?? {}) },
  policy: { ...POLICY, ...(over.policy ?? {}) },
});

const bash = (command, over) => decide({ tool_name: "Bash", tool_input: { command } }, ctx(over)).decision;
const edit = (file_path, over) => decide({ tool_name: "Edit", tool_input: { file_path } }, ctx(over)).decision;

// ------------------------------------------------------------- shell parse

test("tokenize keeps a quoted payload as one token", () => {
  assert.deepEqual(tokenize(`bash -c "git push --force"`), ["bash", "-c", "git push --force"]);
});

test("splitSegments splits on every documented separator but not inside quotes", () => {
  assert.deepEqual(splitSegments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(splitSegments(`echo "a && b"`), [`echo "a && b"`]);
});

test("extractSubstitutions finds $() and backticks", () => {
  assert.deepEqual(extractSubstitutions("git push $(git branch --show-current)"), ["git branch --show-current"]);
  assert.deepEqual(extractSubstitutions("echo `whoami`"), ["whoami"]);
});

test("unwrap strips env assignments and benign wrappers", () => {
  assert.deepEqual(unwrap(tokenize("FOO=1 timeout 60 nice -n 5 git push")), ["git", "push"]);
});

test("globToRegExp handles ** and *", () => {
  assert.ok(globToRegExp(".github/workflows/**").test(".github/workflows/ci.yml"));
  assert.ok(!globToRegExp("*.md").test("docs/a.md"));
});

// --------------------------------------------------------------- wrappers

test("bash -c payload is evaluated, not treated as an opaque token", () => {
  assert.equal(bash(`bash -c "git push --force origin main"`), "deny");
  assert.equal(bash(`sh -c 'git status'`), "allow");
});

test("eval payload is evaluated", () => {
  assert.equal(bash(`eval "git reset --hard HEAD~5"`), "deny");
});

test("a computed command name fails closed rather than guessing", () => {
  assert.equal(bash("$(echo git) push -f origin main"), "deny");
  assert.equal(bash("${GIT} push --force"), "deny");
});

test("a substitution body is evaluated on its own", () => {
  assert.equal(bash("echo $(git push --force origin main)"), "deny");
});

// -------------------------------------------------------- branch-sensitive

test("push to the default branch is denied even when the branch is not in the command", () => {
  assert.equal(bash("git push", { facts: { branch: "main" } }), "deny");
  assert.equal(bash("git push origin HEAD", { facts: { branch: "main" } }), "deny");
});

test("push to a feature branch is allowed", () => {
  assert.equal(bash("git push"), "allow");
  assert.equal(bash("git push -u origin feature/x"), "allow");
});

test("explicit push to main is denied from any branch", () => {
  assert.equal(bash("git push origin main"), "deny");
  assert.equal(bash("git push origin HEAD:refs/heads/main"), "deny");
});

test("force-push is denied even off the default branch", () => {
  assert.equal(bash("git push --force-with-lease origin feature/x"), "deny");
});

test("an unresolvable push target is treated as protected, not as safe", () => {
  // Detached HEAD, fresh clone with no origin/HEAD: we cannot name the target, so we refuse.
  assert.equal(bash("git push", { facts: { branch: "", defaultBranch: "" } }), "deny");
});

test("fallback branch names are protected when origin/HEAD is missing", () => {
  assert.equal(bash("git push origin master", { facts: { defaultBranch: "" } }), "deny");
});

// ---------------------------------------------------------------- git verbs

test("history rewrite and destructive git verbs are denied", () => {
  for (const cmd of [
    "git reset --hard",
    "git clean -fdx",
    "git commit --amend -m x",
    "git rebase -i HEAD~3",
    "git branch -D old",
    "git checkout -f",
    "git filter-branch --all",
  ]) {
    assert.equal(bash(cmd), "deny", cmd);
  }
});

test("git config is denied — it can relocate hooks or alias a denied verb", () => {
  assert.equal(bash("git config core.hooksPath .claude/evil"), "deny");
  assert.equal(bash("git config alias.p 'push --force'"), "deny");
});

test("inline -c config injection is denied", () => {
  assert.equal(bash("git -c core.hooksPath=/tmp/x push origin feature/x"), "deny");
});

test("read-only git is allowed", () => {
  for (const cmd of ["git status", "git log --oneline -5", "git diff main"]) {
    assert.equal(bash(cmd), "allow", cmd);
  }
});

test("developer mode permits history rewrite but still guards the default branch", () => {
  const dev = { policy: { mode: "developer", allowHistoryRewrite: true } };
  assert.equal(bash("git rebase -i HEAD~3", dev), "allow");
  assert.equal(bash("git push --force origin main", dev), "deny");
});

// ------------------------------------------------------- script indirection

test("npm run resolves to the script body, so a deploy cannot hide behind a name", () => {
  assert.equal(bash("npm run deploy"), "deny");
  assert.equal(bash("npm run test"), "allow");
});

test("nested scripts resolve transitively", () => {
  assert.equal(bash("npm run ship"), "deny");
});

test("make targets resolve to their recipe", () => {
  assert.equal(bash("make deploy"), "deny");
  assert.equal(bash("make lint"), "allow");
});

test("an unresolvable script fails closed under the vibe policy", () => {
  assert.equal(bash("npm run does-not-exist"), "deny");
  assert.equal(bash("npm run does-not-exist", { policy: { unresolvedScript: "ask" } }), "ask");
});

// -------------------------------------------------------------- data rules

test("deny and ask rules from policy data are applied", () => {
  assert.equal(bash("vercel --prod"), "deny");
  assert.equal(bash("psql -c 'DROP TABLE users'"), "deny");
  assert.equal(bash("npm install left-pad"), "ask");
});

test("a compound command is denied if ANY segment is denied", () => {
  assert.equal(bash("npm test && vercel --prod"), "deny");
});

test("a local allow override wins", () => {
  assert.equal(bash("vercel --prod", { policy: { allowCommands: ["vercel --prod"] } }), "allow");
});

test("a malformed regex in policy data does not take the guard down", () => {
  assert.equal(bash("git status", { policy: { denyCommands: [{ regex: "([unclosed" }] } }), "allow");
});

test("all four rule shapes match", () => {
  assert.ok(ruleMatches("vercel --prod", "npx vercel --prod --yes"));
  assert.ok(ruleMatches({ contains: ["kubectl", "delete"] }, "kubectl delete pod x"));
  assert.ok(ruleMatches({ startsWith: "terraform apply" }, "terraform apply -auto-approve"));
  assert.ok(ruleMatches({ regex: "^aws\\s+s3\\s+rb" }, "aws s3 rb s3://bucket"));
  assert.ok(!ruleMatches({ contains: [] }, "anything"));
  assert.ok(!ruleMatches({ typo: "vercel" }, "vercel --prod"));
});

test("validatePolicy catches rules that could never match", () => {
  const problems = validatePolicy({
    denyCommands: [{ typo: "vercel" }, { contains: [] }, { regex: "([bad" }, { contains: ["ok"] }],
  });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /can never match/);
  assert.match(problems[2], /invalid regex/);
});

test("the shipped policy files are valid", async () => {
  for (const mode of ["developer", "vibe"]) {
    const p = JSON.parse(readFileSync(new URL(`./policy.${mode}.json`, import.meta.url), "utf8"));
    assert.deepEqual(validatePolicy(p), [], `policy.${mode}.json`);
  }
});

// ------------------------------------------------------------ file writes

test("mechanism files are protected", () => {
  assert.equal(edit(".claude/seatbelt.policy.json"), "deny");
  assert.equal(edit(path.join(root, ".claude/settings.local.json")), "deny");
});

test("the local override file is NOT protected — it is the escape hatch", () => {
  assert.equal(edit(".claude/seatbelt.local.json"), "allow");
});

test("workflow files are protected in vibe mode only", () => {
  assert.equal(edit(".github/workflows/ci.yml"), "deny");
  assert.equal(edit(".github/workflows/ci.yml", { policy: { mode: "developer", protectedGlobs: [] } }), "allow");
});

test("the resolved git hooks directory is protected even in a worktree", () => {
  // In a worktree `.git` is a FILE, so a literal `.git/hooks/**` rule matches nothing.
  const commonDir = path.join(root, "shared-git");
  const over = { facts: { commonDir } };
  assert.equal(edit(path.join(commonDir, "hooks", "pre-commit"), over), "deny");
});

test("Write and NotebookEdit are covered by the hook even though Write() rules never match", () => {
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: ".claude/seatbelt.policy.json" } }, ctx()).decision, "deny");
  assert.equal(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: ".claude/seatbelt.policy.json" } }, ctx()).decision, "deny");
});

test("ordinary source files are editable", () => {
  assert.equal(edit("src/index.ts"), "allow");
});

// ------------------------------------------------------------------- MCP

test("destructive and spend MCP tools are denied", () => {
  for (const tool of [
    "mcp__github__merge_pull_request",
    "mcp__Neon__delete_project",
    "mcp__mongodb__drop-database",
    "mcp__Vercel__buy_domain",
  ]) {
    assert.equal(decide({ tool_name: tool, tool_input: {} }, ctx()).decision, "deny", tool);
  }
});

test("an unknown MCP tool asks rather than allows", () => {
  assert.equal(decide({ tool_name: "mcp__brand_new__do_thing", tool_input: {} }, ctx()).decision, "ask");
});

// ------------------------------------------------------------- fail closed

test("malformed input throws so the caller can fail closed", () => {
  assert.throws(() => decide({ tool_input: { command: "ls" } }, ctx()), /tool_name/);
  assert.throws(() => decide({ tool_name: "Bash", tool_input: null }, ctx()), /command/);
  assert.throws(() => decide({ tool_name: "Bash", tool_input: {} }, ctx()), /command/);
});

test("a very long command string is still evaluated correctly", () => {
  const padded = `${"echo hello && ".repeat(5000)}git push origin main`;
  assert.equal(bash(padded), "deny");
});

test("deeply nested wrappers terminate rather than recursing forever", () => {
  let cmd = "git push origin main";
  for (let i = 0; i < 12; i++) cmd = `bash -c ${JSON.stringify(cmd)}`;
  assert.equal(bash(cmd), "deny");
});

test("unknown tools fall through untouched", () => {
  assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "x" } }, ctx()).decision, "allow");
});
