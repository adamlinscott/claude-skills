#!/usr/bin/env node
// Which processes would stop this work tree from being deleted, and which of them did this
// session leave behind?
//
// The deterministic half of /are-we-done's clean-up: walking the process tree, finding the Claude
// session, matching command lines and working directories against the tree, and killing whole
// process trees on every platform. The skill owns the judgement — which candidates are still
// genuinely needed.
//
// Prints ONE line of JSON on stdout and nothing else.
//
//   node check.mjs [<work-tree>]                  list (default: git top level of the cwd)
//   node check.mjs [<work-tree>] --kill 12,34     kill those trees (candidates only); adds
//                                                 killed, refused, failed, and remaining
//
// candidates  started by this session's Bash/PowerShell tool shells (subagents' included), or
//             orphans — parent gone — whose command line or cwd is inside the work tree
// foreign     inside the work tree but owned by something else that is still alive (an editor,
//             the user's own terminal). Never killed; named so the user knows what holds the folder.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const win = process.platform === "win32";
const argv = process.argv.slice(2);
const killAt = argv.indexOf("--kill");
const killList = killAt >= 0 ? (argv[killAt + 1] ?? "").split(",").map(Number).filter(Boolean) : null;
const positional = argv.filter((a, i) => !a.startsWith("--") && !(killAt >= 0 && i === killAt + 1));

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

const workTree = path.resolve(
  positional[0] ?? run("git", ["rev-parse", "--show-toplevel"]).trim(),
);

function listProcesses() {
  if (win) {
    const ps =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath," +
      "@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}} | ConvertTo-Json -Compress";
    return JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps])).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name ?? "",
      cmd: p.CommandLine ?? "",
      exe: p.ExecutablePath ?? "",
      created: Number(p.Created) || 0,
      cwd: "",
    }));
  }
  const cwds = new Map();
  try {
    let pid;
    for (const line of run("lsof", ["-a", "-d", "cwd", "-F", "pn"]).split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n") cwds.set(pid, line.slice(1));
    }
  } catch {}
  return run("ps", ["-A", "-o", "pid=,ppid=,args="])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, cmd] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
      let cwd = cwds.get(Number(pid)) ?? "";
      if (!cwd) try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      return { pid: Number(pid), ppid: Number(ppid), name: path.basename((cmd ?? "").split(" ")[0]), cmd: cmd ?? "", exe: "", created: 0, cwd };
    })
    .filter((p) => p.pid);
}

let procs = listProcesses();
let byPid = new Map(procs.map((p) => [p.pid, p]));

// A parent counts only if it was started before the child; otherwise the PID has been reused.
const parentOf = (p) => {
  const parent = byPid.get(p.ppid);
  return parent && parent.pid !== p.pid && (!parent.created || parent.created <= p.created) ? parent : null;
};

const ownChain = new Set();
for (let p = byPid.get(process.pid); p; p = parentOf(p)) ownChain.add(p.pid);

const isClaude = (p) => /^claude(\.exe)?$/i.test(p.name) || /@anthropic-ai[\\/]claude-code/i.test(p.cmd);
let session = null;
for (let p = parentOf(byPid.get(process.pid)); p && !session; p = parentOf(p)) if (isClaude(p)) session = p;

// Matching is on text, so normalise both sides: case, slash direction, and Git Bash's /c/... form.
const norm = (s) => s.toLowerCase().replaceAll("\\", "/");
const treeForms = [norm(workTree)];
if (win) treeForms.push(norm(workTree).replace(/^([a-z]):/, "/$1"));
const inTree = (p) => [p.cmd, p.exe, p.cwd].some((s) => s && treeForms.some((t) => norm(s).includes(t)));

// The tool shells are the session's direct children that run a shell; the rest are MCP servers.
const isToolShell = (p) => /(^|[\\/\s"'])(bash|sh|zsh|powershell|pwsh)(\.exe)?([\s"']|$)/i.test(p.cmd);

function toolShellOf(p) {
  for (let q = p; q; q = parentOf(q)) {
    const parent = parentOf(q);
    if (session && parent?.pid === session.pid) return isToolShell(q) ? q : null;
  }
  return null;
}

function classify() {
  const candidates = [];
  const foreign = [];
  for (const p of procs) {
    if (ownChain.has(p.pid) || p.pid === session?.pid) continue;
    const shell = toolShellOf(p);
    if (shell && ownChain.has(shell.pid)) continue;
    const entry = { pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 300) };
    if (shell) candidates.push({ ...entry, why: "session", shell: shell.pid });
    else if (inTree(p) && !parentOf(p)) candidates.push({ ...entry, why: "orphan" });
    else if (inTree(p)) foreign.push(entry);
  }
  return { candidates, foreign };
}

function killTree(pid) {
  if (win) {
    run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) for (const p of procs) if (p.ppid === tree[i]) tree.push(p.pid);
  for (const p of tree.reverse()) try { process.kill(p, "SIGTERM"); } catch {}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  for (const p of tree) try { process.kill(p, "SIGKILL"); } catch {}
}

const { candidates, foreign } = classify();
const out = { workTree, session: session?.pid ?? null, candidates, foreign };

if (killList) {
  const allowed = new Set(candidates.map((c) => c.pid));
  out.killed = [];
  out.refused = killList.filter((pid) => !allowed.has(pid));
  out.failed = [];
  for (const pid of killList.filter((pid) => allowed.has(pid))) {
    try {
      killTree(pid);
      out.killed.push(pid);
    } catch {
      // Killing a parent's tree may already have taken this one with it.
      if (listProcesses().some((p) => p.pid === pid)) out.failed.push(pid);
      else out.killed.push(pid);
    }
  }
  procs = listProcesses();
  byPid = new Map(procs.map((p) => [p.pid, p]));
  out.remaining = classify().candidates;
}

console.log(JSON.stringify(out));
