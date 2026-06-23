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
