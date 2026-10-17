import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
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

const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
};

test("--stream: keeps running with its stdin closed, as Claude Code starts it, and stops once its parent is gone", async () => {
  const root = tempRoot();
  const project = gitRepo(path.join(root, "repo"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, ".claude") };
  const out = path.join(root, "stream.ndjson");
  // A parent that starts the stream with stdin closed and stdout in a file, then waits to be killed.
  const parentScript = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
    const c = spawn(process.execPath, ${JSON.stringify([path.join(defaultsDir, "cli.mjs"), "--stream", "--project", project])}, { stdio: ["ignore", fs.openSync(${JSON.stringify(out)}, "w"), "inherit"] });
    console.log(c.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ["-e", parentScript], { env, stdio: ["ignore", "pipe", "inherit"] });
  const pid = Number(await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(String(d).trim()))));
  const until = async (ok, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return true;
    return false;
  };
  try {
    assert.ok(await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("\n"), 10000), "the first model was written");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(gone(pid), false, "still streaming after stdin closed");
    const lines = fs.readFileSync(out, "utf8").trim().split("\n");
    assert.equal(lines.length, 1); // nothing changed, so nothing more was written
    assert.equal(JSON.parse(lines[0]).seq, 1);

    parent.kill();
    assert.ok(await until(() => gone(pid), 5000), "stopped once its parent was gone");
  } finally {
    parent.kill();
    if (!gone(pid)) process.kill(pid);
  }
});
