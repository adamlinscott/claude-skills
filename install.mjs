#!/usr/bin/env node
// Links every skill in ./skills into the user's global Claude skills directory
// (~/.claude/skills/<name>). Idempotent: re-running fixes missing or wrong links
// and never clobbers a real directory it did not create.
//
//   node install.mjs            # link all skills
//   node install.mjs --uninstall  # remove only the links this repo created
//
// Cross-platform: directory symlinks on macOS/Linux, junctions on Windows
// (junctions need no admin rights or Developer Mode).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const repoSkillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");
const globalSkillsDir = path.join(homedir(), ".claude", "skills");
const linkType = process.platform === "win32" ? "junction" : "dir";
const uninstall = process.argv.includes("--uninstall");

fs.mkdirSync(globalSkillsDir, { recursive: true });

const skills = fs
  .readdirSync(repoSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const skillName of skills) {
  const source = path.join(repoSkillsDir, skillName);
  const linkPath = path.join(globalSkillsDir, skillName);

  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  // Detect a link by trying to read its target. readlink succeeds for both POSIX symlinks AND
  // Windows junctions (which lstat reports as plain directories), and throws for a real directory.
  // This is more reliable than isSymbolicLink(), which is false for junctions.
  let existingTarget = null;
  if (existing) {
    try {
      existingTarget = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    } catch {
      existingTarget = null; // not a link — a real file or directory
    }
  }
  const existingIsLink = existingTarget !== null;
  const linksHere = existingIsLink && existingTarget === path.resolve(source);
  // A link can point here yet be BROKEN (dangling target — e.g. the repo moved, or a half-written
  // link). existsSync follows the link and is false when it cannot resolve, so this separates a
  // healthy link from one that must be torn down and recreated.
  const linkResolves = linksHere && fs.existsSync(linkPath);

  if (uninstall) {
    if (linksHere) {
      fs.rmSync(linkPath, { recursive: true, force: true });
      console.log(`unlinked  ${skillName}`);
    } else if (existing) {
      console.log(`skip      ${skillName} (not a link into this repo — left alone)`);
    }
    continue;
  }

  if (linkResolves) {
    console.log(`ok        ${skillName} (already linked)`);
    continue;
  }
  if (linksHere) {
    // Points here but does not resolve: a broken/dangling link. Tear it down and recreate.
    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(source, linkPath, linkType);
    console.log(`repaired  ${skillName} -> ${source} (was a broken link)`);
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
