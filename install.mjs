#!/usr/bin/env node
// Installer for this skill collection.
//
// It runs in two halves. FIRST it asks — arrow-key checklists for the skills, the beta features,
// any other optional features and other people's collections, then a summary and a final
// Install/Cancel. THEN it acts, running other people's installers last.
// Nothing on disk is touched until that confirmation, so cancelling leaves the machine as it was.
//
// The menus live in ./lib/wizard.mjs. Without a terminal (CI, a pipe) they are skipped entirely
// and every question takes its safe default, so an unattended run never enables anything.
//
// Everything it offers is read from disk rather than hardcoded here, so this file does not need
// editing as the collection changes:
//   • ./skills.txt        — one checkbox per skill, its folders, and a description for a person
//   • ./beta-features.txt — which skills and instructions are still in development
//   • ./instructions/*.md — the optional blocks offered for the global CLAUDE.md
//   • ./extras/*.md       — other people's collections, and the command that installs each
//
// Run `node install.mjs --help` for the options.
//
// Cross-platform: directory symlinks on macOS/Linux, junctions on Windows (junctions need no
// admin rights or Developer Mode).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { multiSelect, chooseAction, clearScreen, canPrompt, closeInput, style } from "./lib/wizard.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoSkillsDir = path.join(repoRoot, "skills");
const repoInstructionsDir = path.join(repoRoot, "instructions");
const repoToolsDir = path.join(repoRoot, "tools");
const betaListFile = path.join(repoRoot, "beta-features.txt");
const skillsListFile = path.join(repoRoot, "skills.txt");
const repoExtrasDir = path.join(repoRoot, "extras");

// How each kind of beta feature is described in the installer's list.
const KIND_LABELS = { skill: "skill", instruction: "global instruction", agent: "agent" };
// Shown in the details panel for a skill folder with no line in skills.txt. Declared up here
// because buildPlan() runs before the rest of the file is evaluated.
const NO_DESCRIPTION = "No description yet — add a line for it in skills.txt.";
const globalSkillsDir = path.join(homedir(), ".claude", "skills");
const globalClaudeMd = path.join(homedir(), ".claude", "CLAUDE.md");
const linkType = process.platform === "win32" ? "junction" : "dir";

// Beta skills that also ship a companion tool in ./tools/<name>. Wiring one up takes steps that
// only make sense for that tool, so each gets an entry. Add one when a new beta tool arrives; a
// beta skill with no entry is simply linked like any other.
const BETA_TOOLS = {
  debrief: { command: "debrief", serveArgs: ["serve"], mcpName: "debrief" },
};

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = [
  "--help",
  "-h",
  "--uninstall",
  "--beta",
  "--no-beta",
  "--add-instructions",
  "--remove-instructions",
  "--skip-instructions",
  "--extras",
  "--accept-defaults",
  "--yes",
  "-y",
];

const argv = process.argv.slice(2);
const flagValue = (name) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const has = (name) => argv.some((a) => a === name || a.startsWith(`${name}=`));

const showHelp = has("--help") || has("-h");
const uninstall = has("--uninstall");
const forceBeta = has("--beta");
const forceNoBeta = has("--no-beta");
const skipInstructions = has("--skip-instructions");
const addInstructions = flagValue("--add-instructions");
const removeInstructions = flagValue("--remove-instructions");
const extrasArg = flagValue("--extras");
const acceptDefaults = has("--accept-defaults") || has("--yes") || has("-y");

const unknownFlags = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a.split("=")[0]));

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
// No process.exit() anywhere: console.log to a pipe is asynchronous, and exiting would discard
// whatever is still buffered. Every path simply falls through to the end of the script.

if (unknownFlags.length) {
  printBanner();
  console.log(`  Sorry — I do not recognise: ${unknownFlags.join(", ")}\n`);
  printHelp();
} else if (showHelp) {
  printBanner();
  printHelp();
} else {
  const plan = await buildPlan();
  if (!plan) {
    console.log("  Nothing was changed.\n");
  } else {
    applySkillLinks(plan);
    applyBetaTools(plan);
    if (plan.instructions) applyInstructionBlocks(plan.instructions);
    await runExtras(plan.extras);
    printFarewell();
  }
}

// ── Presentation ────────────────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(
    style.cyan(String.raw`
    ____  _  _____  _      _      ____
   / ___|| |/ /_ _|| |    | |    / ___|
   \___ \| ' / | | | |    | |    \___ \
    ___) | . \ | | | |___ | |___  ___) |
   |____/|_|\_\___||_____||_____||____/
`),
  );
}

function printWelcome(interactive) {
  const what = uninstall ? "Removes these skills from Claude." : "Makes these skills available to Claude everywhere.";
  // Only promise a confirmation on the path that actually asks for one.
  console.log(`  ${what}${interactive ? style.dim(" Nothing changes until you confirm.") : ""}\n`);
}

function printHelp() {
  const blocks = loadInstructionBlocks();
  const names = blocks.map((b) => b.name).join(", ") || "none available";
  const extraNames = loadExtras().map((e) => e.name).join(", ") || "none available";
  console.log("  Usage:  node install.mjs [options]");
  console.log("");
  console.log("  With no options it walks you through the setup, then asks you to confirm.");
  console.log("  Every question below can be answered up front instead, which skips the prompt.");
  console.log("");
  console.log("  --help, -h                    Show this and stop. Changes nothing.");
  console.log("");
  console.log("  --beta                        Include the features that are still in development.");
  console.log("  --no-beta                     Leave them out.");
  console.log(`                                Which ones are beta is listed in beta-features.txt.`);
  console.log("");
  console.log("  --add-instructions=<names>    Add these optional instruction blocks to your global");
  console.log("                                CLAUDE.md. Comma-separated, or 'all'.");
  console.log(`                                Available: ${names}`);
  console.log("  --remove-instructions=<names> Remove these blocks. Comma-separated, or 'all'.");
  console.log("  --skip-instructions           Do not ask about them, and leave any already there.");
  console.log("");
  console.log("  --extras=<names>              Also run these other people's installers, once this");
  console.log("                                repo's own skills are in. Comma-separated, 'all', or");
  console.log(`                                'none'. Available: ${extraNames}`);
  console.log("");
  console.log("  --accept-defaults, -y         Do not ask anything. Takes the safe answer to every");
  console.log("                                question: link the stable skills, no beta, and leave");
  console.log("                                your instructions exactly as they are.");
  console.log("");
  console.log("  --uninstall                   Remove what this installer created.");
  console.log("");
  console.log("  Examples:");
  console.log("    node install.mjs                                  the guided setup");
  console.log("    node install.mjs --accept-defaults                just link the stable skills");
  console.log("    node install.mjs --beta --add-instructions=all    everything, no questions");
  console.log("    node install.mjs --uninstall                      undo it");
  console.log("");
}

function printFarewell() {
  console.log(uninstall ? "\n  Done.\n" : "\n  Done. Start a new Claude session to pick them up.\n");
}

// ── Questionnaire ───────────────────────────────────────────────────────────────────────────────

/**
 * Gather every decision up front. Returns a plan, or null if the user aborted.
 * Touches nothing on disk except reads.
 */
async function buildPlan() {
  const skillGroups = loadSkillGroups();
  const blocks = loadInstructionBlocks();
  const installedBlocks = readInstalledBlockNames(blocks);
  const interactive = canPrompt() && !acceptDefaults;
  const groupNamed = (name) => skillGroups.find((g) => g.name === name);

  // Beta covers more than skills, so split the list by kind. Anything named but missing from the
  // repo is dropped, which keeps a stale line in beta-features.txt from breaking the run.
  const betaFeatures = loadBetaFeatures().filter((f) =>
    f.kind === "skill" ? Boolean(groupNamed(f.name)) : blocks.some((b) => b.name === f.name),
  );
  const betaSkills = betaFeatures.filter((f) => f.kind === "skill").map((f) => f.name);
  const betaBlockNames = new Set(betaFeatures.filter((f) => f.kind === "instruction").map((f) => f.name));
  // Everything that is NOT beta is offered in the second question. When nothing is left, that
  // question does not exist and the wizard is one step shorter.
  const optionalBlocks = blocks.filter((b) => !betaBlockNames.has(b.name));

  // The same rows the beta checklist shows, so the summary can account for every one of them.
  const betaItems = betaFeatures.map((f) => ({
    name: f.name,
    label: f.kind === "instruction" ? blocks.find((b) => b.name === f.name).title : f.name,
  }));
  const extras = uninstall ? [] : loadExtras();
  const stableGroups = skillGroups.filter((g) => !betaSkills.includes(g.name));
  const stableSkills = stableGroups.map((g) => g.name);

  // What is already in place, so the checkboxes open showing the current state.
  const activeBeta = betaFeatures
    .filter((f) => (f.kind === "skill" ? isGroupLinked(groupNamed(f.name)) : installedBlocks.has(f.name)))
    .map((f) => f.name);
  const linkedStable = stableGroups.filter(isGroupLinked).map((g) => g.name);

  // A step is skipped when a flag already answers it, or has nothing to show, so the count is honest.
  const askSkills = interactive && stableSkills.length > 0;
  const askBeta = interactive && betaFeatures.length > 0 && !forceBeta && !forceNoBeta;
  const askOptional =
    interactive &&
    optionalBlocks.length > 0 &&
    !skipInstructions &&
    !uninstall &&
    addInstructions === undefined &&
    removeInstructions === undefined;
  const askExtras = interactive && extras.length > 0 && !uninstall && extrasArg === undefined;
  const totalSteps =
    (askSkills ? 1 : 0) + (askBeta ? 1 : 0) + (askOptional ? 1 : 0) + (askExtras ? 1 : 0) + (interactive ? 1 : 0);
  let stepNumber = 0;
  const stepLabel = () => (totalSteps > 1 ? `  (${++stepNumber} of ${totalSteps})` : "");

  const screen = () => {
    clearScreen();
    printBanner();
    printWelcome(interactive);
  };

  // Default: keep whatever is already in place. Only an explicit tick adds something new, and
  // only the interactive checklist — where the current state was on screen — takes one away.
  let selectedBeta = new Set(forceBeta ? betaFeatures.map((f) => f.name) : activeBeta);
  // Skills: everything, unless some are already linked — then the checklist opens on what you
  // actually have, so a choice made last time is not silently undone by re-running.
  let selectedSkills = new Set(uninstall || linkedStable.length ? linkedStable : stableSkills);
  let wantInstructions; // Set of block names, or null to leave the CLAUDE.md step alone entirely
  // Never selected on your behalf: these run someone else's installer.
  let selectedExtras = new Set(resolveExtrasFlag(extras));

  if (interactive) {
    try {
      // — Skills —
      if (askSkills) {
        screen();
        const picked = await multiSelect({
          heading: `Skills${stepLabel()}`,
          note: uninstall ? "Tick the ones to remove." : "Tick the ones you want available in Claude.",
          items: stableGroups.map((g) => ({ value: g.name, label: g.name, details: g.description || NO_DESCRIPTION })),
          selected: [...selectedSkills],
        });
        if (!picked) return null;
        selectedSkills = picked;
      }

      // — Beta features —
      if (askBeta) {
        screen();
        const picked = await multiSelect({
          heading: `Beta features${stepLabel()}`,
          note: uninstall ? "Tick the ones to remove as well." : "Still in development. Off unless you tick them.",
          items: betaFeatures.map((f) => ({
            value: f.name,
            label: f.kind === "instruction" ? blocks.find((b) => b.name === f.name).title : f.name,
            hint: KIND_LABELS[f.kind],
            details:
              f.kind === "instruction"
                ? blocks.find((b) => b.name === f.name).summary
                : groupNamed(f.name).description || NO_DESCRIPTION,
          })),
          selected: activeBeta,
        });
        if (!picked) return null;
        selectedBeta = picked;
      }

      // — Optional (non-beta) features —
      const fromBeta = [...selectedBeta].filter((name) => betaBlockNames.has(name));
      if (skipInstructions || blocks.length === 0) {
        wantInstructions = null;
      } else if (uninstall) {
        wantInstructions = new Set(); // uninstall clears them all; the summary says so
      } else if (addInstructions !== undefined || removeInstructions !== undefined) {
        wantInstructions = new Set([...resolveInstructionFlags(blocks, installedBlocks), ...fromBeta]);
      } else if (askOptional) {
        screen();
        const picked = await multiSelect({
          heading: `Other features${stepLabel()}`,
          note: "Change how Claude writes to you, in every project.",
          items: optionalBlocks.map((b) => ({ value: b.name, label: b.title, details: b.summary })),
          selected: optionalBlocks.filter((b) => installedBlocks.has(b.name)).map((b) => b.name),
        });
        if (!picked) return null;
        wantInstructions = new Set([...picked, ...fromBeta]);
      } else {
        // No optional features to ask about: keep the non-beta blocks as they are.
        wantInstructions = new Set([...optionalBlocks.filter((b) => installedBlocks.has(b.name)).map((b) => b.name), ...fromBeta]);
      }

      // — Other people's collections —
      if (askExtras) {
        screen();
        const picked = await multiSelect({
          heading: `Recommended extras${stepLabel()}`,
          note: "Optional. Each runs its own installer on your machine, after this one.",
          items: extras.map((e) => ({
            value: e.name,
            label: e.title,
            hint: isExtraInstalled(e) ? "looks already installed" : "",
            details: `${e.description}

Runs: ${e.command}`,
          })),
          selected: [],
        });
        if (!picked) return null;
        selectedExtras = new Set(picked);
      }

      // — Confirm —
      screen();
      const go = await chooseAction({
        heading: `Ready${stepLabel()}`,
        body: summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune: true, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras }),
        items: [
          { value: "go", label: uninstall ? "Remove them" : "Install", hint: "apply the changes above" },
          { value: "cancel", label: "Cancel", hint: "change nothing" },
        ],
      });
      if (go !== "go") return null;
    } finally {
      // Hand the terminal back whichever way we leave: confirmed, cancelled, or thrown.
      closeInput();
    }
  } else {
    // Not asking: nothing new is enabled, and nothing already in place is taken away. Stable
    // skills are the exception — installing all of them IS the default answer.
    selectedSkills = new Set(stableSkills);
    if (forceNoBeta) selectedBeta = new Set(activeBeta);
    const fromBeta = [...selectedBeta].filter((name) => betaBlockNames.has(name));
    if (skipInstructions || blocks.length === 0) wantInstructions = null;
    else if (uninstall) wantInstructions = new Set();
    else if (addInstructions !== undefined || removeInstructions !== undefined) {
      wantInstructions = new Set([...resolveInstructionFlags(blocks, installedBlocks), ...fromBeta]);
    } else wantInstructions = new Set([...installedBlocks, ...fromBeta]);

    for (const line of summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune: false, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras })) {
      console.log(`  ${line}`);
    }
    console.log("");
    if (!acceptDefaults && !uninstall) console.log("  (not a terminal — defaults used; see --help)\n");
  }

  // Only the interactive checklist may UNLINK a beta skill that was unticked: it showed the
  // current state, so an empty box means "remove". A flag-driven run never removes silently.
  //
  // newlyEnabledBeta drives the companion-tool setup. Keeping a beta feature that is already in
  // place must NOT re-run npm install / npm link / MCP registration on every install — only
  // turning one on does, or an explicit --beta, which reads as "set the beta features up".
  const newlyEnabledBeta = new Set([...selectedBeta].filter((name) => !activeBeta.includes(name)));
  // Skills and beta skills are both groups, so collapse them into one "what should be linked" set.
  const selectedGroups = new Set([
    ...[...selectedSkills].filter((name) => groupNamed(name)),
    ...[...selectedBeta].filter((name) => betaSkills.includes(name)),
  ]);
  return {
    skillGroups,
    selectedGroups,
    betaSkills,
    selectedBeta,
    newlyEnabledBeta,
    instructions: wantInstructions,
    prune: interactive,
    extras: extras.filter((e) => selectedExtras.has(e.name)),
  };
}

/**
 * The plain-English list of what is about to happen.
 *
 * Every beta feature is accounted for on the beta lines — skills AND instructions — so a checklist
 * with two rows can never report on only one of them. The optional lines cover only the non-beta
 * blocks, which keeps each feature in exactly one place.
 */
function summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras }) {
  const verb = uninstall ? "remove" : "install";
  const lines = [];
  const names = (items) => items.map((i) => i.label).join(", ");

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const chosenSkills = stableSkills.filter((n) => selectedSkills.has(n));
  if (uninstall) {
    // Unticked here means "leave it installed" — the opposite of what it means on the way in.
    const left = stableSkills.filter((n) => !selectedSkills.has(n) && linkedStable.includes(n));
    lines.push(`remove ${plural(chosenSkills.length, "skill")}`);
    if (left.length) lines.push(`leave ${plural(left.length, "skill")}: ${left.join(", ")}`);
  } else {
    const newSkills = chosenSkills.filter((n) => !linkedStable.includes(n));
    const keptSkills = chosenSkills.filter((n) => linkedStable.includes(n));
    const droppedSkills = stableSkills.filter((n) => !selectedSkills.has(n) && linkedStable.includes(n) && prune);
    if (newSkills.length) lines.push(`install ${plural(newSkills.length, "skill")}`);
    if (keptSkills.length) lines.push(`keep ${plural(keptSkills.length, "skill")}`);
    if (droppedSkills.length) lines.push(`remove ${plural(droppedSkills.length, "skill")}: ${droppedSkills.join(", ")}`);
    if (!chosenSkills.length && !droppedSkills.length) lines.push("install no skills");
  }

  if (betaItems.length) {
    if (uninstall) {
      const picked = betaItems.filter((i) => selectedBeta.has(i.name));
      const left = betaItems.filter((i) => !selectedBeta.has(i.name));
      if (picked.length) lines.push(`remove beta: ${names(picked)}`);
      if (left.length) lines.push(`leave beta: ${names(left)}`);
    } else {
      const added = betaItems.filter((i) => selectedBeta.has(i.name) && !activeBeta.includes(i.name));
      const kept = betaItems.filter((i) => selectedBeta.has(i.name) && activeBeta.includes(i.name));
      const dropped = betaItems.filter((i) => !selectedBeta.has(i.name) && activeBeta.includes(i.name) && prune);
      const skipped = betaItems.filter((i) => !selectedBeta.has(i.name) && !(activeBeta.includes(i.name) && prune));
      if (added.length) lines.push(`install beta: ${names(added)}`);
      if (kept.length) lines.push(`keep beta: ${names(kept)}`);
      if (dropped.length) lines.push(`remove beta: ${names(dropped)}`);
      if (skipped.length) lines.push(`skip beta: ${names(skipped)}`);
    }
  }

  if (wantInstructions !== null && optionalBlocks.length) {
    const add = optionalBlocks.filter((b) => wantInstructions.has(b.name) && !installedBlocks.has(b.name)).map((b) => b.title);
    const keep = optionalBlocks.filter((b) => wantInstructions.has(b.name) && installedBlocks.has(b.name)).map((b) => b.title);
    const drop = optionalBlocks.filter((b) => !wantInstructions.has(b.name) && installedBlocks.has(b.name)).map((b) => b.title);
    if (add.length) lines.push(`enable: ${add.join(", ")}`);
    if (keep.length) lines.push(`keep: ${keep.join(", ")}`);
    if (drop.length) lines.push(`disable: ${drop.join(", ")}`);
  }

  const chosenExtras = (extras || []).filter((e) => selectedExtras.has(e.name));
  if (chosenExtras.length) lines.push(`then run: ${chosenExtras.map((e) => e.title).join(", ")}`);
  return lines;
}

/** --extras=<names|all|none>. Nothing is selected without one of these, or an explicit tick. */
function resolveExtrasFlag(extras) {
  if (extrasArg === undefined) return [];
  const known = extras.map((e) => e.name);
  const wanted = extrasArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "none");
  if (wanted.includes("all")) return known;
  for (const w of wanted) if (!known.includes(w)) console.log(`  (--extras: nothing called "${w}" — ignored)`);
  return wanted.filter((w) => known.includes(w));
}

/** Start from what is already installed, then apply --add-instructions / --remove-instructions. */
function resolveInstructionFlags(blocks, installedBlocks) {
  const known = blocks.map((b) => b.name);
  const desired = new Set(installedBlocks);
  const expand = (raw, flagName) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.includes("all")) return known;
    for (const p of parts) if (!known.includes(p)) console.log(`  (${flagName}: no instruction called "${p}" — ignored)`);
    return parts.filter((p) => known.includes(p));
  };
  if (removeInstructions !== undefined) for (const n of expand(removeInstructions, "--remove-instructions")) desired.delete(n);
  if (addInstructions !== undefined) for (const n of expand(addInstructions, "--add-instructions")) desired.add(n);
  return desired;
}

function listSkillFolders() {
  return fs
    .readdirSync(repoSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * One checkbox per entry, read from skills.txt: `<name> | <folders> | <description>`.
 *
 * The description deliberately does NOT come from the skill's own SKILL.md — that one is written
 * to help Claude decide when to use the skill, and reads as dense and technical to a person. A
 * folder with no entry still installs, on its own, so a new skill is never silently dropped.
 */
function loadSkillGroups() {
  const folders = listSkillFolders();
  const groups = [];
  const claimed = new Set();

  if (fs.existsSync(skillsListFile)) {
    for (const line of fs.readFileSync(skillsListFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [name, folderList = "", description = ""] = trimmed.split("|").map((part) => part.trim());
      const members = (folderList || name)
        .split(",")
        .map((f) => f.trim())
        .filter((f) => folders.includes(f));
      if (!name || members.length === 0) continue; // a stale line cannot break the run
      members.forEach((f) => claimed.add(f));
      groups.push({ name, folders: members, description });
    }
  }
  for (const folder of folders) {
    if (!claimed.has(folder)) groups.push({ name: folder, folders: [folder], description: "" });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}


/** True if any folder in the group is linked here, so a half-linked group still reads as present. */
function isGroupLinked(group) {
  return group.folders.some((folder) => {
    const linkPath = path.join(globalSkillsDir, folder);
    try {
      return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(path.join(repoSkillsDir, folder));
    } catch {
      return false;
    }
  });
}

/**
 * Beta features, read from beta-features.txt so this script never needs editing.
 * Returns [{ kind, name }] — kind is "skill", "instruction", or anything added to KIND_LABELS.
 */
function loadBetaFeatures() {
  if (!fs.existsSync(betaListFile)) return [];
  return fs
    .readFileSync(betaListFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [kind, name] = line.split(/\s+/);
      return { kind, name };
    })
    .filter((entry) => entry.name && KIND_LABELS[entry.kind]);
}

// ── Other people's collections ──────────────────────────────────────────────────────────────────
// Each ./extras/*.md describes a collection someone else maintains: what it is, the command that
// installs it, what that command needs on PATH, and what you have to run inside Claude afterwards.
// These run LAST, after everything this repo installs, and only when explicitly ticked — the
// command comes from a third party and runs on the person's machine, so it is shown before it runs
// and is never selected by default.

function loadExtras() {
  if (!fs.existsSync(repoExtrasDir)) return [];
  return fs
    .readdirSync(repoExtrasDir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(repoExtrasDir, file), "utf8"));
      const fallback = path.basename(file, ".md");
      return {
        file,
        name: meta.name || fallback,
        title: meta.title || fallback,
        summary: meta.summary || "",
        description: body,
        order: Number(meta.order || 99),
        detect: meta.detect || "",
        url: meta.url || "",
        // `requires: git, bun=https://bun.sh` — the optional =url is where to go to get it.
        requires: (meta.requires || "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
          .map((r) => {
            const [name, url = ""] = r.split("=");
            return { name: name.trim(), url: url.trim() };
          }),
        useBash: (meta.shell || "") === "bash",
        command: meta.command || "",
        next: meta.next || "",
      };
    })
    .filter((e) => e.command)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

// Declarations, not `const` arrows: buildPlan() runs above, before this point in the file is
// evaluated, and only function declarations hoist past it.
function expandHome(p) {
  return p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
}

function isExtraInstalled(extra) {
  return Boolean(extra.detect) && fs.existsSync(expandHome(extra.detect));
}

/**
 * True if `name` is on PATH. Asked of the OS rather than by running the command with --version:
 * that needs shell:true on Windows to resolve .cmd shims, and passing arguments through a shell
 * is both deprecated (DEP0190) and a quoting hazard.
 */
function commandExists(name) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function missingRequirements(extra) {
  const missing = extra.requires.filter((r) => !commandExists(r.name));
  // A POSIX-shell command needs a shell to run it. On Windows that ships with Git.
  if (extra.useBash && !commandExists("bash")) {
    missing.push({ name: "bash", url: process.platform === "win32" ? "https://git-scm.com/downloads" : "" });
  }
  return missing;
}

/**
 * Whenever we cannot finish an install for someone, hand back everything they need to finish it
 * themselves: what is missing and where to get it, the exact command, and the project's own page.
 * URLs are printed bare so a terminal linkifies them.
 */
function printManualFallback(extra, missing = []) {
  if (missing.length) {
    console.log("");
    for (const req of missing) {
      console.log(`    install ${req.name}${req.url ? `:  ${style.cyan(req.url)}` : " and put it on your PATH"}`);
    }
  }
  console.log(`\n    then run this yourself:`);
  console.log(`      ${extra.command}`);
  if (extra.url) console.log(`\n    instructions:  ${style.cyan(extra.url)}`);
}

async function runExtras(extras) {
  if (!extras || extras.length === 0) return;
  const followUps = [];
  const unfinished = [];

  for (const extra of extras) {
    console.log(`\n  ${style.bold(extra.title)}`);
    const missing = missingRequirements(extra);
    if (missing.length) {
      console.log(`  ${style.yellow("skipped  ")} ${missing.map((m) => m.name).join(" and ")} not found on your PATH.`);
      printManualFallback(extra, missing);
      unfinished.push(extra.title);
      continue;
    }

    console.log(`  ${style.dim(`running: ${extra.command}`)}`);
    const res = extra.useBash
      ? spawnSync("bash", ["-lc", extra.command], { stdio: "inherit" })
      : spawnSync(extra.command, { stdio: "inherit", shell: true });

    if (res.error || res.status !== 0) {
      console.log(`  ${style.yellow("failed   ")} ${res.error ? res.error.message : `the installer exited with code ${res.status}`}.`);
      console.log(`  ${style.dim("Nothing else was changed.")}`);
      printManualFallback(extra);
      unfinished.push(extra.title);
      continue;
    }
    console.log(`  ${style.green("installed")} ${extra.title}`);
    if (extra.next) followUps.push([extra.title, extra.next]);
  }

  // The follow-up steps are slash commands typed inside Claude, so they cannot be run from here.
  if (followUps.length) {
    console.log(`\n  ${style.bold("Next, inside Claude:")}`);
    for (const [title, next] of followUps) console.log(`    ${title} — ${next}`);
  }
  if (unfinished.length) {
    console.log(`\n  ${style.yellow(`Not installed: ${unfinished.join(", ")}`)} — see the steps above to finish by hand.`);
  }
}

// ── Skill links ─────────────────────────────────────────────────────────────────────────────────

function applySkillLinks(plan) {
  fs.mkdirSync(globalSkillsDir, { recursive: true });

  for (const group of plan.skillGroups) {
    const isBeta = plan.betaSkills.includes(group.name);
    const wanted = plan.selectedGroups.has(group.name);

    // Left unticked. The interactive checklist showed whether it was already installed, so an
    // empty box there means "take it away"; a flag-driven run never removes silently and just
    // leaves it be.
    if (!wanted && !uninstall) {
      if (plan.prune && isGroupLinked(group)) {
        for (const folder of group.folders) fs.rmSync(path.join(globalSkillsDir, folder), { recursive: true, force: true });
        report(group, "removed", "(unticked)");
      } else {
        report(group, "skipped", isBeta ? "(beta)" : "");
      }
      continue;
    }
    // On UNINSTALL, only take away what was ticked for removal.
    if (!wanted && uninstall) {
      if (isGroupLinked(group)) report(group, "kept", "");
      continue;
    }

    // A group can cover several folders — an alias like /seatbelts is the same choice, so it is
    // reported once, under the worst thing that happened to any of its folders.
    const outcomes = group.folders.map((folder) => (uninstall ? unlinkFolder(folder) : linkFolder(folder)));
    if (outcomes.includes("problem")) continue; // linkFolder already explained which folder and why
    if (uninstall) {
      if (outcomes.includes("removed")) report(group, "removed", "");
      else if (outcomes.includes("foreign")) report(group, "kept", "(not installed by this repo)");
      continue;
    }
    if (outcomes.includes("installed")) report(group, "installed", "");
    else if (outcomes.includes("repaired")) report(group, "repaired", "");
    else report(group, "ready", "");
  }
}

function report(group, state, note) {
  const colour = state === "PROBLEM" ? style.yellow : state === "skipped" || state === "kept" ? style.dim : style.green;
  const alias = group.folders.length > 1 ? style.dim(` +${group.folders.length - 1} alias`) : "";
  console.log(`  ${colour(state.padEnd(9))} ${group.name}${alias}${note ? ` ${style.dim(note)}` : ""}`);
}

/** Link one folder. Returns "ready" | "installed" | "repaired" | "problem". */
function linkFolder(folder) {
  const source = path.join(repoSkillsDir, folder);
  const linkPath = path.join(globalSkillsDir, folder);
  const { existing, existingIsLink, linksHere } = inspectLink(linkPath, source);
  // A link can point here yet be BROKEN (dangling target — e.g. the repo moved, or a half-written
  // link). existsSync follows the link and is false when it cannot resolve, so this separates a
  // healthy link from one that must be torn down and recreated.
  if (linksHere && fs.existsSync(linkPath)) return "ready";
  if (linksHere) {
    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(source, linkPath, linkType);
    return "repaired";
  }
  if (existing && !existingIsLink) {
    console.log(`  ${style.yellow("PROBLEM  ")} ${folder} — something else already lives at ${linkPath}.`);
    console.log(`            Move or delete it, then run this again.`);
    return "problem";
  }
  if (existing) fs.rmSync(linkPath, { recursive: true, force: true }); // stale link elsewhere
  fs.symlinkSync(source, linkPath, linkType);
  return "installed";
}

/** Unlink one folder. Returns "removed" | "foreign" | "absent". */
function unlinkFolder(folder) {
  const linkPath = path.join(globalSkillsDir, folder);
  const { existing, linksHere } = inspectLink(linkPath, path.join(repoSkillsDir, folder));
  if (linksHere) {
    fs.rmSync(linkPath, { recursive: true, force: true });
    return "removed";
  }
  return existing ? "foreign" : "absent";
}

/**
 * Detect a link by trying to read its target. readlink succeeds for both POSIX symlinks AND
 * Windows junctions (which lstat reports as plain directories), and throws for a real directory.
 * This is more reliable than isSymbolicLink(), which is false for junctions.
 */
function inspectLink(linkPath, source) {
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  let target = null;
  if (existing) {
    try {
      target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    } catch {
      target = null; // not a link — a real file or directory
    }
  }
  return { existing, existingIsLink: target !== null, linksHere: target !== null && target === path.resolve(source) };
}

// ── Beta companion tools ────────────────────────────────────────────────────────────────────────

function applyBetaTools(plan) {
  for (const name of plan.betaSkills) {
    if (!plan.selectedBeta.has(name)) continue;
    // Already set up and simply being kept: leave it alone. --beta re-runs it deliberately.
    if (!uninstall && !plan.newlyEnabledBeta.has(name) && !forceBeta) continue;
    const cfg = BETA_TOOLS[name];
    if (!cfg) continue;
    const toolDir = path.join(repoToolsDir, name);
    if (!fs.existsSync(toolDir)) continue;
    if (uninstall) uninstallBetaTool(name, cfg, toolDir);
    else setupBetaTool(name, cfg, toolDir);
  }
}

/** Run a command, inheriting stdio, and return true on exit 0. Never throws. */
function tryRun(name, label, command, args, opts = {}) {
  console.log(`  ${name}: ${label}`);
  const res = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.error) {
    console.log(`  ${name}: ${label} could not start — ${res.error.message}`);
    return false;
  }
  if (res.status !== 0) {
    console.log(`  ${name}: ${label} failed (exit code ${res.status})`);
    return false;
  }
  return true;
}

/** True iff the `claude` CLI is on PATH (for best-effort MCP registration). */
function hasClaudeCli() {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !probe.error && probe.status === 0;
}

function setupBetaTool(name, cfg, toolDir) {
  console.log(`\n  Setting up the ${name} tool.`);

  // Build: install deps + compile to dist/. Idempotent (npm is).
  tryRun(name, "installing dependencies", "npm", ["install"], { cwd: toolDir });
  const built = tryRun(name, "building", "npm", ["run", "build"], { cwd: toolDir });

  // npm link so a global command exists. Idempotent. Skip if the build failed — a global bin
  // pointing at a missing/stale dist is a broken command masquerading as success.
  let linked = false;
  if (built) {
    linked = tryRun(name, `creating the global \`${cfg.command}\` command`, "npm", ["link"], { cwd: toolDir });
  } else {
    console.log(`  ${name}: build failed, so no global \`${cfg.command}\` command was created.`);
  }

  // Best-effort MCP registration at USER scope so the server is available in EVERY project.
  // Default (local) scope would bind it to this repo only. If `claude` is absent, print the steps.
  const distCli = path.join(toolDir, "dist", "cli.js");
  if (hasClaudeCli()) {
    // Remove any prior registration first so re-running doesn't error on a duplicate (idempotent).
    spawnSync("claude", ["mcp", "remove", "-s", "user", cfg.mcpName], { stdio: "ignore", shell: process.platform === "win32" });
    const serveArgs = linked
      ? ["mcp", "add", "-s", "user", cfg.mcpName, "--", cfg.command, ...cfg.serveArgs]
      : ["mcp", "add", "-s", "user", cfg.mcpName, "--", "node", distCli, ...cfg.serveArgs];
    const ok = tryRun(name, "connecting it to Claude", "claude", serveArgs);
    if (!ok) printManualMcpInstructions(name, cfg, distCli, linked);
  } else {
    console.log(`  ${name}: the \`claude\` command was not found, so it could not be connected automatically.`);
    printManualMcpInstructions(name, cfg, distCli, linked);
  }
}

function uninstallBetaTool(name, cfg, toolDir) {
  console.log(`\n  Removing the ${name} tool.`);

  if (hasClaudeCli()) {
    tryRun(name, "disconnecting it from Claude", "claude", ["mcp", "remove", "-s", "user", cfg.mcpName]);
  } else {
    console.log(`  ${name}: the \`claude\` command was not found — disconnect it yourself if you connected it.`);
  }
  if (fs.existsSync(toolDir)) {
    tryRun(name, `removing the global \`${cfg.command}\` command`, "npm", ["unlink"], { cwd: toolDir });
  }
}

function printManualMcpInstructions(name, cfg, distCli, linked) {
  console.log(`  ${name}: to connect it yourself, run one of these:`);
  if (linked) console.log(`  ${name}:   claude mcp add -s user ${cfg.mcpName} -- ${cfg.command} ${cfg.serveArgs.join(" ")}`);
  console.log(`  ${name}:   claude mcp add -s user ${cfg.mcpName} -- node "${distCli}" ${cfg.serveArgs.join(" ")}`);
  console.log(`  ${name}: …or add this to your MCP config (.mcp.json / claude_desktop_config.json):`);
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          [cfg.mcpName]: {
            command: linked ? cfg.command : "node",
            args: linked ? cfg.serveArgs : [distCli, ...cfg.serveArgs],
          },
        },
      },
      null,
      2,
    ),
  );
}

// ── Managed instruction blocks ──────────────────────────────────────────────────────────────────
// Each ./instructions/<name>.md is an OPTIONAL section of the user's global ~/.claude/CLAUDE.md.
// The file's body is written verbatim between HTML-comment markers, which makes the operation
// idempotent (re-running replaces the marked region) and surgical (nothing outside it is read,
// rewritten, or reordered). Nothing is ever enabled without an explicit yes.

function markerFor(name, edge) {
  return `<!-- claude-skills:${name} ${edge} -->`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a managed block INCLUDING the blank lines around it, so removal leaves no gap. */
function blockPattern(name) {
  return new RegExp(
    `(?:\\r?\\n)*${escapeRe(markerFor(name, "start"))}[\\s\\S]*?${escapeRe(markerFor(name, "end"))}(?:\\r?\\n)*`,
  );
}

/** Minimal `key: value` frontmatter split. Returns the body verbatim (frontmatter stripped). */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function loadInstructionBlocks() {
  if (!fs.existsSync(repoInstructionsDir)) return [];
  return fs
    .readdirSync(repoInstructionsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(repoInstructionsDir, file), "utf8"));
      const fallback = path.basename(file, ".md");
      return { file, name: meta.name || fallback, title: meta.title || fallback, summary: meta.summary || "", body };
    })
    .filter((b) => b.body.length > 0);
}

function readInstalledBlockNames(blocks) {
  if (!fs.existsSync(globalClaudeMd)) return new Set();
  const content = fs.readFileSync(globalClaudeMd, "utf8");
  return new Set(blocks.filter((b) => blockPattern(b.name).test(content)).map((b) => b.name));
}

function renderBlock(block, eol) {
  return [
    markerFor(block.name, "start"),
    `<!-- Managed by claude-skills — source: instructions/${block.file}. Edits inside this block are`,
    `     overwritten on the next \`node install.mjs\`. Remove with \`node install.mjs --uninstall\`. -->`,
    ...block.body.split(/\r?\n/),
    markerFor(block.name, "end"),
  ].join(eol);
}

/** The managed region as it currently stands in `content`, or null. Used to detect drift. */
function extractBlock(content, name) {
  const m = blockPattern(name).exec(content);
  return m ? m[0].trim() : null;
}

function withBlock(content, block, eol) {
  const rendered = renderBlock(block, eol);
  if (blockPattern(block.name).test(content)) {
    return tidyEnds(content.replace(blockPattern(block.name), `${eol}${eol}${rendered}${eol}${eol}`), eol);
  }
  const base = content.replace(/(?:\r?\n)+$/, "");
  return tidyEnds((base ? base + eol + eol : "") + rendered, eol);
}

function withoutBlock(content, name, eol) {
  if (!blockPattern(name).test(content)) return content;
  return tidyEnds(content.replace(blockPattern(name), `${eol}${eol}`), eol);
}

/** Trim leading/trailing blank lines and end with exactly one newline. Only touches the edges. */
function tidyEnds(content, eol) {
  const trimmed = content.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
  return trimmed ? trimmed + eol : "";
}

function applyInstructionBlocks(desired) {
  const blocks = loadInstructionBlocks();
  if (blocks.length === 0) return;

  const existed = fs.existsSync(globalClaudeMd);
  const content = existed ? fs.readFileSync(globalClaudeMd, "utf8") : "";
  // Match whatever the file already uses so a Windows-authored CLAUDE.md stays CRLF throughout.
  const eol = /\r\n/.test(content) ? "\r\n" : "\n";
  const installed = new Set(blocks.filter((b) => blockPattern(b.name).test(content)).map((b) => b.name));

  let next = content;
  const actions = [];
  for (const b of blocks) {
    if (desired.has(b.name)) {
      const before = extractBlock(next, b.name);
      next = withBlock(next, b, eol);
      const after = extractBlock(next, b.name);
      if (before === null) actions.push(`turned on  ${b.title}`);
      else if (before !== after) actions.push(`refreshed  ${b.title}`);
      else actions.push(`ready      ${b.title}`);
    } else if (installed.has(b.name)) {
      next = withoutBlock(next, b.name, eol);
      actions.push(`turned off ${b.title}`);
    }
  }
  for (const a of actions) console.log(`  ${a}`);
  if (next === content) return;

  if (next.trim() === "") {
    // The file held nothing but our blocks — leave no empty husk behind.
    if (existed) fs.rmSync(globalClaudeMd, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(globalClaudeMd), { recursive: true });
  fs.writeFileSync(globalClaudeMd, next);
}
