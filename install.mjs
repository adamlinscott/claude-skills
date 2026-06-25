#!/usr/bin/env node
// Links every skill in ./skills into the user's global Claude skills directory
// (~/.claude/skills/<name>). Idempotent: re-running fixes missing or wrong links
// and never clobbers a real directory it did not create.
//
//   node install.mjs                 # link all skills (debrief is SKIPPED unless --beta)
//   node install.mjs --uninstall     # remove only the links this repo created
//   node install.mjs --beta          # also set up the debrief tool (link skill, build,
//                                     # npm link the `debrief` command, register the MCP server
//                                     # at USER scope so it's available in every project)
//   node install.mjs --beta --uninstall  # undo the debrief setup too
//
// A NORMAL run is unchanged: it links the stable skills and SKIPS `debrief` entirely.
//
// Cross-platform: directory symlinks on macOS/Linux, junctions on Windows
// (junctions need no admin rights or Developer Mode).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoSkillsDir = path.join(repoRoot, "skills");
const globalSkillsDir = path.join(homedir(), ".claude", "skills");
const linkType = process.platform === "win32" ? "junction" : "dir";
const uninstall = process.argv.includes("--uninstall");
const beta = process.argv.includes("--beta");

// The debrief skill is BETA: a normal install must skip it (leave it unlinked) so the stable
// install is unchanged. --beta opts in and also wires up the tool itself (see setupDebrief below).
const BETA_SKILLS = new Set(["debrief"]);

fs.mkdirSync(globalSkillsDir, { recursive: true });

const skills = fs
  .readdirSync(repoSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const skillName of skills) {
  // Skip beta-only skills on a normal INSTALL so the stable install is byte-for-byte unchanged.
  // A plain `--uninstall` (no --beta) still falls through so it can remove a beta skill LINK left
  // behind by an earlier `--beta` run (the tool teardown — npm link + MCP — still needs --beta).
  if (BETA_SKILLS.has(skillName) && !beta && !uninstall) {
    console.log(`skip      ${skillName} (beta — pass --beta to install)`);
    continue;
  }

  const source = path.join(repoSkillsDir, skillName);
  const linkPath = path.join(globalSkillsDir, skillName);

  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  const existingIsLink = existing?.isSymbolicLink();
  const existingTarget = existingIsLink
    ? path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))
    : null;
  const linksHere = existingTarget === path.resolve(source);

  if (uninstall) {
    if (linksHere) {
      fs.rmSync(linkPath, { recursive: true, force: true });
      console.log(`unlinked  ${skillName}`);
    } else if (existing) {
      console.log(`skip      ${skillName} (not a link into this repo — left alone)`);
    }
    // A plain `--uninstall` removes the skill link above but NOT the tool setup (global `debrief`
    // npm link + MCP registration), which only `--beta --uninstall` tears down. Hint, don't strand.
    if (BETA_SKILLS.has(skillName) && !beta) {
      console.log(`debrief:  also tear down the tool (global \`debrief\` + MCP) with: node install.mjs --beta --uninstall`);
    }
    continue;
  }

  if (linksHere) {
    console.log(`ok        ${skillName} (already linked)`);
    continue;
  }
  if (existing && !existingIsLink) {
    console.log(`SKIP      ${skillName} — a real directory already exists at ${linkPath}; move or delete it, then re-run`);
    continue;
  }
  if (existing) fs.rmSync(linkPath, { recursive: true, force: true }); // stale link elsewhere
  fs.symlinkSync(source, linkPath, linkType);
  console.log(`linked    ${skillName} -> ${source}`);
}

// ── --beta: set up the debrief tool (idempotent, best-effort, well-logged) ──────────────────────
if (beta) {
  if (uninstall) uninstallDebriefTool();
  else setupDebriefTool();
}

/** Run a command, inheriting stdio, and return true on exit 0. Never throws. */
function tryRun(label, command, args, opts = {}) {
  console.log(`debrief:  ${label} (${command} ${args.join(" ")})`);
  const res = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.error) {
    console.log(`debrief:  ${label} failed to start: ${res.error.message}`);
    return false;
  }
  if (res.status !== 0) {
    console.log(`debrief:  ${label} exited with code ${res.status}`);
    return false;
  }
  return true;
}

/** True iff the `claude` CLI is on PATH (for best-effort MCP registration). */
function hasClaudeCli() {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !probe.error && probe.status === 0;
}

function setupDebriefTool() {
  const toolDir = path.join(repoRoot, "tools", "debrief");
  if (!fs.existsSync(toolDir)) {
    console.log(`debrief:  tool dir not found at ${toolDir} — skipping tool setup`);
    return;
  }
  console.log("debrief:  --beta tool setup");

  // (b) build: install deps + compile to dist/. Idempotent (npm is).
  tryRun("install deps", "npm", ["install"], { cwd: toolDir });
  const built = tryRun("build", "npm", ["run", "build"], { cwd: toolDir });

  // (c) npm link so a global `debrief` command exists. Idempotent. Skip if the build failed — a
  // global bin pointing at a missing/stale dist/cli.js is a broken command masquerading as success.
  let linked = false;
  if (built) {
    linked = tryRun("npm link (global `debrief` command)", "npm", ["link"], { cwd: toolDir });
  } else {
    console.log("debrief:  build failed — skipping `npm link` (no global `debrief` command created).");
  }

  // (d) best-effort MCP registration at USER scope so the zero-config server is available in EVERY
  // project (the global `debrief serve` re-resolves the per-project corpus from its launch cwd).
  // Default (local) scope would bind it to this repo only. If `claude` is absent, print manual steps.
  if (hasClaudeCli()) {
    // Remove any prior registration first so re-running doesn't error on a duplicate (idempotent).
    spawnSync("claude", ["mcp", "remove", "-s", "user", "debrief"], { stdio: "ignore", shell: process.platform === "win32" });
    const serveArgs = linked
      ? ["mcp", "add", "-s", "user", "debrief", "--", "debrief", "serve"]
      : ["mcp", "add", "-s", "user", "debrief", "--", "node", path.join(toolDir, "dist", "cli.js"), "serve"];
    const ok = tryRun("register MCP server (claude mcp add -s user debrief)", "claude", serveArgs);
    if (!ok) printManualMcpInstructions(toolDir, linked);
  } else {
    console.log("debrief:  `claude` CLI not found — skipping automatic MCP registration.");
    printManualMcpInstructions(toolDir, linked);
  }

  console.log("debrief:  --beta setup complete. Refresh the corpus with `debrief corpus` in any project.");
}

function uninstallDebriefTool() {
  const toolDir = path.join(repoRoot, "tools", "debrief");
  console.log("debrief:  --beta --uninstall tool teardown");

  // Best-effort MCP de-registration (user scope — matches the user-scoped registration in setup).
  if (hasClaudeCli()) {
    tryRun("remove MCP server (claude mcp remove -s user debrief)", "claude", ["mcp", "remove", "-s", "user", "debrief"]);
  } else {
    console.log("debrief:  `claude` CLI not found — remove the MCP server manually if you registered it.");
  }

  // Undo the global npm link.
  if (fs.existsSync(toolDir)) {
    tryRun("npm unlink (remove global `debrief` command)", "npm", ["unlink"], { cwd: toolDir });
  }
}

function printManualMcpInstructions(toolDir, linked) {
  const distCli = path.join(toolDir, "dist", "cli.js");
  console.log("debrief:  to register the MCP server manually (user scope = available in every project), run ONE of:");
  if (linked) console.log("debrief:    claude mcp add -s user debrief -- debrief serve");
  console.log(`debrief:    claude mcp add -s user debrief -- node "${distCli}" serve`);
  console.log("debrief:  …or add this block to your MCP config (.mcp.json / claude_desktop_config.json):");
  console.log(
    JSON.stringify(
      { mcpServers: { debrief: { command: linked ? "debrief" : "node", args: linked ? ["serve"] : [distCli, "serve"] } } },
      null,
      2,
    ),
  );
}
