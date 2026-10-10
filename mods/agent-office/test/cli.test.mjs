import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultsDir, tempRoot, gitRepo } from "./fixture.mjs";

test("entry: the CLI runs when started through a symlink or junction, and through a differently cased path on Windows", () => {
  const root = tempRoot();
  const project = gitRepo(path.join(root, "repo"));
  const link = path.join(root, "linked-mod");
  fs.symlinkSync(defaultsDir, link, "junction");
  const run = (cli) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, ".claude") };
    return JSON.parse(execFileSync(process.execPath, [cli, "--json", "--project", project], { env, encoding: "utf8" }));
  };
  assert.ok(Array.isArray(run(path.join(link, "cli.mjs")).sessions));
  if (process.platform === "win32") assert.ok(Array.isArray(run(path.join(defaultsDir.toUpperCase(), "cli.mjs")).sessions));
});
