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
//             (`before: true` marks an orphan older than this session)
// foreign     inside the work tree but owned by something else that is still alive (an editor,
//             the user's own terminal, another Claude session or a viewer attached to one). Only
//             roots are listed, each with a kind (viewer, claude-session, shell, process) and how
//             many of its descendants also hold the tree (under). Never killed; named so the user
//             knows what holds the folder. After --kill it is the list as it stands after the kills.
// self        this Claude session: holdsTree when its working directory, or one of its MCP servers',
//             its console host's or its pty host's, is inside the work tree (it then holds the folder until the session
//             ends); background when its parent is another Claude process (a daemon or pty host), so
//             closing its view with /exit does not end it; root is the PID whose tree ends it all
//             (the pty host of a background session, else the session)
// deletable   true only when the session was found and no candidate (or, after --kill, nothing
//             remaining) holds the tree, and on Windows also no foreign process and not the session
//             itself (macOS and Linux delete a folder that is some process's working directory). The
//             one field that says whether the folder can be deleted right now.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const win = process.platform === "win32";
const argv = process.argv.slice(2);
const killAt = argv.indexOf("--kill");
const killList = killAt >= 0 ? (argv[killAt + 1] ?? "").split(",").map(Number).filter(Boolean) : null;
const positional = argv.filter((a, i) => !a.startsWith("--") && !(killAt >= 0 && i === killAt + 1));

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  });
}

// Git Bash hands over /c/Users/...; path.resolve would turn that into C:\c\Users\...
const given = win ? positional[0]?.replace(/^\/([a-zA-Z])(\/|$)/, "$1:/") : positional[0];
const workTree = path.resolve(given ?? run("git", ["rev-parse", "--show-toplevel"]).trim());

// Windows exposes no API for another process's working directory, so read it from the process's
// PEB: PEB+0x20 -> RTL_USER_PROCESS_PARAMETERS, +0x38 -> CurrentDirectory (a UNICODE_STRING).
// x64 layout only; 32-bit and inaccessible (elevated) processes come back empty.
const WIN_CWD = `
using System; using System.Runtime.InteropServices;
public static class Cwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr[] i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool w);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, long a, int n) { var b = new byte[n]; IntPtr r; return ReadProcessMemory(h, (IntPtr)a, b, n, out r) ? b : null; }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow; if (!IsWow64Process(h, out wow) || wow) return null;
      var pbi = new IntPtr[6]; int r;
      if (NtQueryInformationProcess(h, 0, pbi, IntPtr.Size * 6, out r) != 0) return null;
      var pp = Read(h, (long)pbi[1] + 0x20, 8); if (pp == null) return null;
      var us = Read(h, BitConverter.ToInt64(pp, 0) + 0x38, 16); if (us == null) return null;
      var str = Read(h, BitConverter.ToInt64(us, 8), BitConverter.ToUInt16(us, 0)); if (str == null) return null;
      return System.Text.Encoding.Unicode.GetString(str);
    } finally { CloseHandle(h); }
  }
}`;

function listProcesses() {
  if (win) {
    const cim =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath," +
      "@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}}," +
      "@{n='Cwd';e={if($cwdOk){[Cwd]::Get($_.ProcessId)}}} | ConvertTo-Json -Compress";
    const ps = (script) =>
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    // Managed machines may block compiling or running the reader (Constrained Language Mode, AMSI,
    // EDR); fall back to command lines only rather than failing outright.
    let raw;
    try {
      raw = ps(`$cwdOk = $true; try { Add-Type -TypeDefinition @'${WIN_CWD}\n'@ -ErrorAction Stop } catch { $cwdOk = $false }\n${cim}`);
    } catch {
      raw = ps(`$cwdOk = $false\n${cim}`);
    }
    return JSON.parse(raw).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name ?? "",
      cmd: p.CommandLine ?? "",
      exe: p.ExecutablePath ?? "",
      created: Number(p.Created) || 0,
      cwd: p.Cwd ?? "",
    }));
  }
  // lsof exits non-zero whenever some process is unreadable (any other user's, which is normal on
  // macOS); what it did print is still good.
  let lsof = "";
  try {
    lsof = run("lsof", ["-a", "-d", "cwd", "-F", "pn"]);
  } catch (e) {
    lsof = e.stdout ?? "";
  }
  const cwds = new Map();
  let at;
  for (const line of lsof.split("\n")) {
    if (line[0] === "p") at = Number(line.slice(1));
    else if (line[0] === "n") cwds.set(at, line.slice(1));
  }
  // Under LC_ALL=C, lstart is "Wed Oct 29 10:01:02 2026" on both macOS and Linux. A line without
  // one is kept, just without a start time.
  return run("ps", ["-A", "-o", "pid=,ppid=,lstart=,args="])
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(?:(\w{3} \w{3} +\d+ [\d:]{8} \d{4})\s+)?(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, start, cmd]) => {
      let cwd = cwds.get(Number(pid)) ?? "";
      if (!cwd) try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      return { pid: Number(pid), ppid: Number(ppid), name: path.basename(cmd.split(" ")[0]), cmd, exe: "", created: Date.parse(start) || 0, cwd };
    });
}

let procs = listProcesses();
let byPid = new Map(procs.map((p) => [p.pid, p]));

const firstToken = (cmd) => cmd.match(/^\s*(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean) ?? "";
const program = (p) => path.basename(firstToken(p.cmd)).replace(/^-/, "");

// Native installs run as claude / claude.exe, or a binary under .../claude/versions/; npm installs as
// node or bun running .../bin/claude or the @anthropic-ai/claude-code package. Case-sensitive on
// purpose: the Claude desktop app is Claude.exe / Claude, and is not a session.
const isClaude = (p) => {
  const [first = "", second = ""] = p.cmd.replaceAll('"', "").split(/\s+/);
  return (
    /^claude(\.exe)?$/.test(p.name) ||
    /[\\/]claude[\\/]versions[\\/]/.test(first) ||
    (/^(node|bun)(\.exe)?$/i.test(path.basename(first)) && /(^|[\\/])claude(\.js|\.exe)?$/.test(second)) ||
    /@anthropic-ai[\\/]claude-code/.test(p.cmd)
  );
};

// A parent counts only if it was started before the child; otherwise the PID has been reused. On
// macOS and Linux an orphan is re-parented to PID 1, which is no owner either — unless PID 1 is
// Claude itself, as in a container.
const parentOf = (p) => {
  const parent = byPid.get(p.ppid);
  if (!parent || parent.pid === p.pid || (!win && parent.pid === 1 && !isClaude(parent))) return null;
  return !parent.created || parent.created <= p.created ? parent : null;
};

const ownChain = new Set();
for (let p = byPid.get(process.pid); p; p = parentOf(p)) ownChain.add(p.pid);

// The nearest claude ancestor: the CLI actually running this tool call, even under a pty host or
// another session.
let session = null;
for (let p = parentOf(byPid.get(process.pid)); p && !session; p = parentOf(p)) if (isClaude(p)) session = p;

// The tool shell running this check, and so the start of the current command. Orphans younger than
// it are this command's own pipeline (Git Bash leaves pipeline members parentless).
const ownShell = [...ownChain].map((pid) => byPid.get(pid)).find((p) => session && parentOf(p)?.pid === session.pid);

// Matching is on text, so normalise both sides: case, slash direction, and Git Bash's /c/... form.
const norm = (s) => s.toLowerCase().replaceAll("\\", "/");
const treeForms = [norm(workTree)];
try { treeForms.push(norm(fs.realpathSync(workTree))); } catch {}
if (win) treeForms.push(norm(workTree).replace(/^([a-z]):/, "/$1"));
// The path must end at a separator, quote, space or the end, so .../chinook does not match .../chinook-old.
const treeRes = treeForms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[/\"'\\s]|$)"));
const inTree = (p) => [p.cmd, p.exe, p.cwd].some((s) => s && treeRes.some((re) => re.test(norm(s))));

// The tool shells are the session's direct children whose program is a shell, or a cmd.exe wrapping
// one (how the Windows PowerShell tool runs); the rest, cmd.exe-wrapped npx included, are MCP servers.
const runsShell = (p) => /^(bash|sh|zsh|fish|powershell|pwsh)(\.exe)?$/i.test(program(p));
const isToolShell = (p) =>
  runsShell(p) || (/^cmd\.exe$/i.test(program(p)) && procs.some((c) => c.ppid === p.pid && runsShell(c)));

function toolShellOf(p) {
  for (let q = p; q; q = parentOf(q)) {
    const parent = parentOf(q);
    if (session && parent?.pid === session.pid) return isToolShell(q) ? q : null;
  }
  return null;
}

const descendsFrom = (p, pids) => {
  for (let q = parentOf(p); q; q = parentOf(q)) if (pids.has(q.pid)) return true;
  return false;
};

// A background session's console host is its sibling, started by the same daemon at the same moment;
// it belongs to the session, not to anyone else. created is in 100 ns ticks on Windows, ms elsewhere.
const isSessionConsole = (p) =>
  !!session && /^conhost\.exe$/i.test(p.name) && p.ppid === session.ppid &&
  Math.abs(p.created - session.created) < (win ? 2e7 : 2000);

function classify() {
  const candidates = [];
  const foreign = [];
  for (const p of procs) {
    if (ownChain.has(p.pid) || p.pid === session?.pid || isSessionConsole(p)) continue;
    const shell = toolShellOf(p);
    if (shell && ownChain.has(shell.pid)) continue;
    const entry = { pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 300) };
    if (shell) candidates.push({ ...entry, why: "session", shell: shell.pid });
    else if (inTree(p) && !parentOf(p)) {
      if (ownShell && p.created >= ownShell.created) continue;
      candidates.push({ ...entry, why: "orphan", ...(session && p.created < session.created && { before: true }) });
    }
    else if (inTree(p)) foreign.push(entry);
  }
  // The session's MCP servers end with it (self reports them), an orphan's children go with its tree,
  // and a foreign process's children are named through it: only roots are listed, each with its kind.
  const owners = new Set([session?.pid, ...candidates.filter((c) => c.why === "orphan").map((c) => c.pid)]);
  const unowned = foreign.filter((f) => !descendsFrom(byPid.get(f.pid), owners));
  const foreignPids = new Set(unowned.map((f) => f.pid));
  const roots = unowned
    .filter((f) => !descendsFrom(byPid.get(f.pid), foreignPids))
    .map((f) => ({ ...f, kind: kindOf(byPid.get(f.pid)), under: unowned.filter((g) => descendsFrom(byPid.get(g.pid), new Set([f.pid]))).length }));
  return { candidates, foreign: roots };
}

// What a foreign root is, so the output can name it: a viewer attached to a background session,
// another Claude session, a shell (a terminal), or anything else.
function kindOf(p) {
  // `claude attach <id>`, or `node .../claude attach <id>` for an npm install.
  if (isClaude(p) && /^\s*(?:(?:"[^"]*"|\S+)\s+)?(?:"[^"]*"|\S*claude(?:\.exe|\.js)?)"?\s+attach(\s|$)/.test(p.cmd)) return "viewer";
  if (isClaude(p)) return "claude-session";
  if (runsShell(p)) return "shell";
  return "process";
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

// The session and what it runs outside its tool shells (MCP servers, a console host) end only when
// the session does, so classify() leaves them out; they still hold the folder while it runs.
// A background session runs under its own pty host (claude --bg-pty-host), which starts in the same
// folder and outlives the session's view; it is the root to end, not the session process.
function selfOf() {
  if (!session) return null;
  const parent = parentOf(session);
  const background = !!parent && isClaude(parent);
  const host = background && /--bg-pty-host\b/.test(parent.cmd) ? parent : null;
  const own = procs.filter((p) => p.pid === session.pid || p.pid === host?.pid || isSessionConsole(p) || (descendsFrom(p, new Set([session.pid])) && !toolShellOf(p)));
  const holders = own.filter(inTree).map((p) => ({ pid: p.pid, name: p.name }));
  return { pid: session.pid, root: host?.pid ?? session.pid, holdsTree: holders.length > 0, holders, background };
}

// Windows refuses to delete a folder any process uses as its working directory or has a file open
// in; macOS and Linux delete it regardless, so there only leftover candidates count. Without the
// session found, nothing can be vouched for.
const deletableNow = (cands, fgn, self) =>
  !!session && cands.length === 0 && (!win || (fgn.length === 0 && !self?.holdsTree));

const out = { workTree, session: session?.pid ?? null, self: selfOf(), candidates, foreign };
out.deletable = deletableNow(candidates, foreign, out.self);
if (!session) {
  out.warning =
    "No Claude session found above this process, so only orphans are reported. If the check ran " +
    "inside a pipeline, run it again on its own: Git Bash can leave pipeline members parentless.";
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

if (killList) {
  const allowed = new Set(candidates.map((c) => c.pid));
  out.killed = [];
  out.refused = killList.filter((pid) => !allowed.has(pid));
  out.failed = [];
  for (const pid of killList.filter((pid) => allowed.has(pid))) {
    try {
      killTree(pid);
    } catch {
      // taskkill fails when killing an earlier tree already took this one with it.
    }
    (alive(pid) ? out.failed : out.killed).push(pid);
  }
  procs = listProcesses();
  byPid = new Map(procs.map((p) => [p.pid, p]));
  const after = classify();
  out.remaining = after.candidates;
  out.foreign = after.foreign;
  out.self = selfOf();
  out.deletable = deletableNow(after.candidates, after.foreign, out.self);
}

console.log(JSON.stringify(out));
