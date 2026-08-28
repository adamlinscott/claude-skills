#!/usr/bin/env node
// Installer for this skill collection.
//
// It runs in two halves. FIRST it asks, THEN it acts, running other people's installers last.
// Nothing on disk is touched until the final confirmation, so cancelling leaves the machine as it
// was. That promise holds on every path through this file.
//
// The first question is who the setup is for, and it decides the shape of the rest:
//   • "Let me choose" (dev)     — arrow-key checklists for the skills, the beta features, any
//                                 other optional features and other people's collections.
//   • "Set it up for me" (nontech) — NO checklists at all. The selections come from the per-track
//                                 defaults on disk, and the Ready summary is the only place they
//                                 are shown, so it names them individually rather than counting.
// Either way it ends at the same Install/Cancel gate.
//
// A track default may only ever ADD (see unionFloor). Nothing already installed is removed unless
// the user saw it on a checklist and left its box empty, or asked for a removal outright.
//
// The menus live in ./lib/wizard.mjs. Without a terminal (CI, a pipe) they are skipped entirely
// and every question takes its safe default, so an unattended run never enables anything — in
// particular it never enables a beta feature without --beta, whatever the install mode says.
//
// Node 20 or newer. fs.rmSync(recursive, force) is pointed at directory junctions and symlinks
// here, and a Node old enough to descend a reparse point rather than remove it would delete this
// repo's own skills/ contents.
//
// Everything it offers is read from disk rather than hardcoded here, so this file does not need
// editing as the collection changes:
//   • ./skills.txt        — one checkbox per skill, its folders, a description for a person, and
//                           whether each setup defaults it on.
//   • ./beta-features.txt — which skills and instructions are still in development
//   • ./instructions/*.md — the optional blocks offered for the global CLAUDE.md, each carrying
//                           its own dev:/nontech: defaults
//   • ./extras/*.md       — other people's collections, and the command that installs each. Never
//                           a default on any track; always shown with its literal command first.
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
import { multiSelect, chooseAction, clearScreen, canPrompt, closeInput, readKey, style, wrap } from "./lib/wizard.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoSkillsDir = path.join(repoRoot, "skills");
const repoInstructionsDir = path.join(repoRoot, "instructions");
const repoToolsDir = path.join(repoRoot, "tools");
const betaListFile = path.join(repoRoot, "beta-features.txt");
const skillsListFile = path.join(repoRoot, "skills.txt");
const repoExtrasDir = path.join(repoRoot, "extras");

// Problems found while READING the config files: a line naming folders that do not exist, a
// defaults value that is not on/off, an --extras name nobody recognises.
//
// Collected rather than printed at the point of discovery, because discovery happens before the
// first clearScreen() and a console.log there is wiped off the terminal a moment later. They are
// rendered into the Ready summary instead, which is the last thing on screen before anything is
// applied. Never fatal: a typo degrades to a safe default, but it must not do so in silence.
const configWarnings = [];
const warnConfig = (message) => {
  if (!configWarnings.includes(message)) configWarnings.push(message);
};

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

// The two install modes, and the defaults column each one reads.
//
// This is the old Express-versus-Advanced fork every desktop installer has had for thirty years,
// and it works because the audience is named IN the option: people who customise their machine
// pick Advanced because it says it is for them, and everyone else takes the simple one. The
// question is which install you want, NOT who you are and NOT which skills to tick — those were
// both tried and both obscured the choice.
//
// "Simple", not "Quick", and the difference is not cosmetic. Quick promises the same destination
// sooner, which would be a lie: this mode CONSTRAINS the machine. It already rewrites how Claude
// talks in every project on it, and it is where the guard rails and automations land as they
// arrive — plain language enforced globally, and limits on what Claude may do without asking.
// A developer does not want a faster path to that; they want a different path. Say so on screen.
const INSTALL_MODES = {
  simple: "nontech",
  advanced: "dev",
};

const KNOWN_FLAGS = [
  "--help",
  "-h",
  "--simple",
  "--advanced",
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
const wantSimple = has("--simple");
const wantAdvanced = has("--advanced");
// Two plain flags rather than --for=<value>. There is no value to mistype, so the whole class of
// "--for=nontech looked close enough and silently picked the other one" cannot arise.
const modeArg = wantSimple ? "simple" : wantAdvanced ? "advanced" : undefined;

const unknownFlags = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a.split("=")[0]));
// Asking for both is a contradiction, not a preference. Never guess which one was meant.
const conflictingMode = wantSimple && wantAdvanced;

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
// No process.exit() anywhere: console.log to a pipe is asynchronous, and exiting would discard
// whatever is still buffered. Every path simply falls through to the end of the script.

if (unknownFlags.length) {
  printBanner();
  console.log(`  Sorry — I do not recognise: ${unknownFlags.join(", ")}\n`);
  printHelp();
} else if (conflictingMode) {
  printBanner();
  console.log("  Sorry — --simple and --advanced ask for opposite things. Pick one.\n");
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
    if (plan.instructions) applyInstructionBlocks(plan.instructions, plan.mayRemoveInstructions);
    await runExtras(plan.extras, plan.guided);
    printFarewell(plan);
    await offerStar();
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
  console.log("  --simple                      Simple install, for people who do NOT write code.");
  console.log("                                A small set of skills for describing problems and");
  console.log("                                writing them up, no checklists, and it changes how");
  console.log("                                Claude talks in every project on the machine. It");
  console.log("                                constrains what Claude does, on purpose. Do not use");
  console.log("                                this on your own machine if you write code.");
  console.log("  --advanced                    Advanced install, for developers. Every skill, and");
  console.log("                                you pick which ones. This is the default answer.");
  console.log("                                Either way the install can only ADD — neither one");
  console.log("                                removes a skill you already have.");
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
  console.log("                                question: link the skills this setup defaults to, no");
  console.log("                                beta, and add nothing to your instructions that is");
  console.log("                                not already there. Which skills those are depends on");
  console.log("                                --for; without it you get the developer defaults.");
  console.log("");
  console.log("  --uninstall                   Remove what this installer created.");
  console.log("");
  console.log("  Examples:");
  console.log("    node install.mjs                                  asks simple or advanced");
  console.log("    node install.mjs --simple                          the simple install");
  console.log("    node install.mjs --accept-defaults                just link the stable skills");
  console.log("    node install.mjs --beta --add-instructions=all    everything, no questions");
  console.log("    node install.mjs --uninstall                      undo it");
  console.log("");
}

function printFarewell(plan = {}) {
  if (uninstall) {
    console.log("\n  Done.\n");
    return;
  }
  console.log("\n  Done. Start a new Claude session to pick them up.");

  if (!plan.guided) {
    console.log("");
    return;
  }

  // The guided track chose not to ask about these. Saying what was NOT done is the difference
  // between a setup that is finished and one that quietly stops short.
  console.log("");
  if (plan.wantsHandover) {
    console.log(`  ${style.bold("This is not the whole job.")}`);
    console.log("  Signing in to the issue tracker and cloning the product repo still have to");
    console.log(`  happen on this machine. The checklist is in ${style.cyan("SETUP-FOR-A-COLLEAGUE.md")}.`);
    console.log("");
  }
  console.log(`  To report a problem, describe it to Claude, or type ${style.bold("/raise-issue")}.`);
  console.log("");
  // Only what this run actually left out. An extra it just installed is not "left alone", and a
  // beta skill the union floor kept is not either — saying otherwise is how a closing message
  // starts lying to the one reader who cannot check it.
  const installedNames = new Set((plan.extras || []).map((e) => e.name));
  const leftOut = loadExtras().filter((e) => e.nontechFallback && !installedNames.has(e.name));
  const seatbeltLeftOut = (plan.skillGroups || []).some(
    (g) => g.name === "seatbelt" && !plan.selectedGroups?.has(g.name),
  );
  if (!leftOut.length && !seatbeltLeftOut) {
    console.log("");
    return;
  }

  console.log(`  ${style.dim("What this setup deliberately left alone:")}`);
  if (seatbeltLeftOut) {
    console.log(`  ${style.dim("• /seatbelt decides what Claude may do in a repo without asking. It is still")}`);
    console.log(`  ${style.dim("  in development, and it is worth asking a teammate to set it up for you.")}`);
  }
  for (const extra of leftOut) {
    const summary = (extra.summary || "another collection").replace(/\.\s*$/, "");
    console.log(`  ${style.dim(`• ${extra.title} — ${summary}.`)}`);
    console.log(`  ${style.dim(`  Not installed. ${extra.nontechFallback}`)}`);
    console.log(`  ${style.dim(`  Someone can add it with: ${extra.command}`)}`);
  }
  console.log("");
}

// ── A star, if it was any use ───────────────────────────────────────────────────────────────────

// Two lines at the very bottom, after the install has already finished and nothing depends on the
// answer. One key either way, and any key that is not yes means no — it must never read as another
// step of the setup, or as something that has to be dismissed correctly.
//
// Skipped entirely unless it can actually be acted on: no terminal, --accept-defaults (they asked
// to be asked nothing), an uninstall, or no gh on the machine. An ask that ends in "now go and do
// it yourself in a browser" is worse than not asking.
const STAR_REPO_FALLBACK = "adamlinscott/claude-skills";

/** owner/name for the repo this installer came from, read from the plugin manifest. */
function starRepo() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));
    const url = typeof meta.repository === "string" ? meta.repository : meta.repository?.url || "";
    const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match) return match[1];
  } catch {
    // A missing or malformed manifest is not worth a word on screen at this point.
  }
  return STAR_REPO_FALLBACK;
}

async function offerStar() {
  if (uninstall || acceptDefaults || !canPrompt() || !commandExists("gh")) return;
  const repo = starRepo();

  console.log(`  ${style.dim("If these turn out to be useful, a star helps other people find them.")}`);
  console.log(`  ${style.dim("Enter or Space to star · any other key to finish")}`);

  const key = await readKey();
  closeInput();
  const yes = key && (key.name === "return" || key.name === "enter" || key.name === "space" || key.str === " ");
  console.log("");
  if (!yes) return;

  // --silent: the API returns the starred repo as JSON, and nobody wants it on their screen.
  const res = spawnSync("gh", ["api", "--silent", "--method", "PUT", `user/starred/${repo}`], { stdio: "ignore" });
  if (!res.error && res.status === 0) console.log(`  ${style.green("Starred.")} Thank you.
`);
  else console.log(`  ${style.dim(`Could not star it from here — https://github.com/${repo}`)}
`);
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

  const screen = () => {
    clearScreen();
    printBanner();
    printWelcome(interactive);
  };

  // — Who is this for? —
  // Asked before anything else, and NOT under --uninstall: there every checkbox means the
  // opposite, so an install mode has no coherent meaning and the question would be a pointless
  // one asked of a nervous person mid-removal.
  const askMode = interactive && !uninstall && modeArg === undefined;
  let mode = modeArg;
  if (askMode) {
    screen();
    const simpleCount = stableGroups.filter((g) => g.defaults.nontech).length;
    const omitted = stableGroups
      .filter((g) => g.defaults.dev && !g.defaults.nontech)
      .map((g) => `/${g.name}`);
    const picked = await chooseAction({
      heading: "Choose an install",
      body: [
        ...wrap(
          `Simple sets this machine up for someone who does not read code: ${simpleCount} skills for describing problems and writing them up, and it changes how Claude talks in EVERY project here. Advanced installs all ${stableSkills.length}, including ${omitted.join(", ")}, and lets you pick.`,
          84,
        ).map((l) => style.dim(l)),
        "",
        // The warning belongs on this screen, not the next one. By the Ready summary the choice
        // already feels made, and this is the one option a developer should never take.
        style.yellow("If you write code, do not choose Simple. It is not a smaller Advanced —"),
        style.yellow("it constrains what Claude does on this machine, on purpose."),
        "",
        style.dim("Nothing is installed until you confirm on the next screen."),
      ],
      items: [
        { value: "simple", label: "Simple install", hint: "for people who do not write code" },
        { value: "advanced", label: "Advanced install", hint: "for developers — every skill, and you pick" },
      ],
      // Open on Advanced. The label is what does the real work — anyone who customises their
      // machine reads "for developers" and takes it — but on a FRESH machine the union floor has
      // nothing to protect, so a stray Enter on Simple is the one mistake with no safety net.
      initial: "advanced",
    });
    // Escape, q, Ctrl-C and end-of-input all arrive as null. Every one of them means cancel;
    // falling through to a mode here would let a stray keypress silently pick one.
    if (!picked) {
      closeInput();
      return null;
    }
    mode = picked;
  }
  const track = INSTALL_MODES[mode ?? "advanced"] ?? "dev";
  // A mode NEVER applies to a removal. Skipping the question under --uninstall is not enough on
  // its own: an explicit --simple would still leave guided true, suppress the removal checklist,
  // and unlink everything on one keypress with nothing itemised on screen. Under --uninstall
  // every checkbox means the opposite, so the only safe reading is "ignore the mode, show the
  // list".
  const guided = track === "nontech" && !uninstall;
  // The handover checklist is pointed at whenever Simple runs, whoever is at the keyboard. It
  // covers signing in to the tracker and cloning the product repo, which are needed either way,
  // so asking "is this your machine or theirs?" would buy one paragraph and cost a whole screen.
  const wantsHandover = guided;

  // A step is skipped when a flag already answers it, when the guided track decided it, or when
  // it has nothing to show. Computed AFTER the audience answer so the count stays honest —
  // it depends on which track we are on.
  const askSkills = interactive && !guided && stableSkills.length > 0;
  const askBeta = interactive && !guided && betaFeatures.length > 0 && !forceBeta && !forceNoBeta;
  const askOptional =
    interactive &&
    !guided &&
    optionalBlocks.length > 0 &&
    !skipInstructions &&
    !uninstall &&
    addInstructions === undefined &&
    removeInstructions === undefined;
  // Not on the guided track. "Nothing to choose" has to mean it, and a checklist whose Enter key
  // TOGGLES the hovered row is the last thing to put in front of someone who was promised no
  // choices — one stray keypress ticks a third party's installer. They are named in the closing
  // message instead, as an optional next step.
  const askExtras = interactive && !guided && extras.length > 0 && !uninstall && extrasArg === undefined;
  // The install-mode question is NOT counted. It renders before this number can be known — it is
  // the thing that decides it — so it cannot label itself, and counting it would produce a screen
  // with no counter followed by "(2 of 2)". It is the fork, not a step.
  const totalSteps =
    (askSkills ? 1 : 0) +
    (askBeta ? 1 : 0) +
    (askOptional ? 1 : 0) +
    (askExtras ? 1 : 0) +
    (interactive ? 1 : 0);
  let stepNumber = 0;
  const stepLabel = () => (totalSteps > 1 ? `  (${++stepNumber} of ${totalSteps})` : "");

  /**
   * A track preset may only ever ADD.
   *
   * This is the rule that stops the guided track being a destructive operation wearing a
   * friendly hat. applySkillLinks removes anything unticked when prune is on, and prune used to
   * mean "interactive" — safe only because a checklist had shown the current state. The guided
   * track is interactive and shows no checklist, so without this a full install plus "set it up
   * for me" would unlink everything outside the preset, with no undo.
   */
  const unionFloor = (already, defaults) => new Set([...already, ...defaults]);

  /**
   * Whether an unticked item may be REMOVED, tracked per kind rather than as one flag.
   *
   * It used to be a single `prune: interactive`. The honest predicate is "the user saw this item
   * on a checklist and left its box empty" — which is per question, not per run. On the guided
   * track no checklist is shown, so nothing may be pruned; on the developer track the checklists
   * that actually ran may prune, and the ones a flag answered may not.
   */
  const prune = { skills: askSkills, beta: askBeta, instructions: askOptional };

  // What this track would switch on, before anything already installed is folded in.
  const trackSkills = stableGroups.filter((g) => g.defaults[track]).map((g) => g.name);
  const trackBlocks = blocks.filter((b) => b.defaults[track]).map((b) => b.name);
  // Beta stays off on a flag-driven run whatever the track says — an unattended run never
  // enables something still in development. Interactively it is named and labelled in the
  // summary before it goes anywhere, so a guided preset may include it.
  const trackBeta = interactive ? betaFeatures.filter((f) => nameHasTrackDefault(f, track, skillGroups, blocks)).map((f) => f.name) : [];

  // Default: keep whatever is already in place. Only an explicit tick adds something new, and
  // only the interactive checklist — where the current state was on screen — takes one away.
  let selectedBeta = new Set(forceBeta ? betaFeatures.map((f) => f.name) : activeBeta);
  // Skills: on a first run take the track's defaults; once something is linked, open on what you
  // actually have, so a choice made last time is not silently undone by re-running.
  let selectedSkills = new Set(uninstall || linkedStable.length ? linkedStable : trackSkills);
  let wantInstructions; // Set of block names, or null to leave the CLAUDE.md step alone entirely
  // Never selected on your behalf: these run someone else's installer. No track defaults one.
  let selectedExtras = new Set(resolveExtrasFlag(extras));

  // The guided track answers every checklist from the preset instead of asking. Union floor
  // throughout: it can only add to what is already there.
  if (guided && !uninstall) {
    selectedSkills = unionFloor(linkedStable, trackSkills);
    selectedBeta = unionFloor(activeBeta, trackBeta);
  }

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
      } else if (guided) {
        // Union floor again: whatever is installed, plus whatever this track switches on.
        wantInstructions = unionFloor([...installedBlocks], [...trackBlocks, ...fromBeta]);
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
        body: summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras, blocks, guided }),
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
    // Not asking: nothing new is enabled, and nothing already in place is taken away. The
    // track's defaults ARE the default answer, so -y and the interactive first run agree on what
    // "default" means. Union floor, so an unattended run can still only add.
    selectedSkills = unionFloor(linkedStable, trackSkills);
    if (forceNoBeta) selectedBeta = new Set(activeBeta);
    const fromBeta = [...selectedBeta].filter((name) => betaBlockNames.has(name));
    if (skipInstructions || blocks.length === 0) wantInstructions = null;
    else if (uninstall) wantInstructions = new Set();
    else if (addInstructions !== undefined || removeInstructions !== undefined) {
      wantInstructions = new Set([...resolveInstructionFlags(blocks, installedBlocks), ...fromBeta]);
    } else if (guided) {
      // The guided track applies its preset here too, so `--for=X -y` and the interactive run of
      // the same track agree. They differ in exactly one way, and only for BETA blocks: an
      // unattended run never switches on something still in development without --beta. That is
      // the existing invariant for every other beta feature, and it is not worth breaking here.
      wantInstructions = unionFloor([...installedBlocks], [...trackBlocks.filter((n) => !betaBlockNames.has(n)), ...fromBeta]);
    } else wantInstructions = new Set([...installedBlocks, ...fromBeta]);

    for (const line of summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras, blocks, guided })) {
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
    // A block may be taken away only when the user saw it — on the "Other features" checklist,
    // or because they named it themselves with --remove-instructions, or because this is an
    // uninstall. The guided track shows no such checklist, so it can only ever add.
    mayRemoveInstructions: prune.instructions || uninstall || removeInstructions !== undefined,
    prune,
    guided,
    wantsHandover,
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
function summaryLines({ stableSkills, linkedStable, selectedSkills, betaItems, activeBeta, selectedBeta, prune, optionalBlocks, installedBlocks, wantInstructions, extras, selectedExtras, blocks = [], guided = false }) {
  const verb = uninstall ? "remove" : "install";
  const lines = [];
  const names = (items) => items.map((i) => i.label).join(", ");

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const chosenSkills = stableSkills.filter((n) => selectedSkills.has(n));
  // On the guided track this summary is the ONLY place the skills are ever shown — there was no
  // checklist. "install 4 skills" is not informed consent for the one reader who has no other way
  // to find out what they are, so name them. The developer track just saw a list and does not
  // need it repeated.
  const nameThem = (names) => (guided && names.length ? `: ${names.join(", ")}` : "");
  if (uninstall) {
    // Unticked here means "leave it installed" — the opposite of what it means on the way in.
    const left = stableSkills.filter((n) => !selectedSkills.has(n) && linkedStable.includes(n));
    lines.push(`remove ${plural(chosenSkills.length, "skill")}`);
    if (left.length) lines.push(`leave ${plural(left.length, "skill")}: ${left.join(", ")}`);
  } else {
    const newSkills = chosenSkills.filter((n) => !linkedStable.includes(n));
    const keptSkills = chosenSkills.filter((n) => linkedStable.includes(n));
    const droppedSkills = stableSkills.filter((n) => !selectedSkills.has(n) && linkedStable.includes(n) && prune.skills);
    if (newSkills.length) lines.push(`install ${plural(newSkills.length, "skill")}${nameThem(newSkills)}`);
    if (keptSkills.length) lines.push(`keep ${plural(keptSkills.length, "skill")}${nameThem(keptSkills)}`);
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
      const dropped = betaItems.filter((i) => !selectedBeta.has(i.name) && activeBeta.includes(i.name) && prune.beta);
      const skipped = betaItems.filter((i) => !selectedBeta.has(i.name) && !(activeBeta.includes(i.name) && prune.beta));
      if (added.length) lines.push(`install beta: ${names(added)}`);
      if (kept.length) lines.push(`keep beta: ${names(kept)}`);
      if (dropped.length) lines.push(`remove beta: ${names(dropped)}`);
      if (skipped.length) lines.push(`skip beta: ${names(skipped)}`);
    }
    // "beta" is jargon, and the guided reader has no checklist hint to read it against. Sits
    // directly under the beta lines it explains.
    if (guided && betaItems.some((i) => selectedBeta.has(i.name))) {
      lines.push(`  beta means still being worked on — it may change or be rough at the edges`);
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

  // A managed block goes into the GLOBAL CLAUDE.md, which "enable: Clear responses" does not
  // convey at all. On the guided track especially, the person confirming has no other way to
  // learn that this changes Claude in every project on the machine.
  if (wantInstructions !== null && wantInstructions.size) {
    const enabling = blocks.filter((b) => wantInstructions.has(b.name) && !installedBlocks.has(b.name));
    if (enabling.length) {
      lines.push(`  ${enabling.map((b) => b.title).join(", ")} changes how Claude writes in EVERY project`);
      lines.push(`  on this machine. Undo with: node install.mjs --uninstall`);
    }
  }

  // Each extra runs a THIRD PARTY's installer. The title alone is not informed consent, and the
  // guided track never sees the details panel where the command used to live, so the literal
  // command goes in the summary itself.
  const chosenExtras = (extras || []).filter((e) => selectedExtras.has(e.name));
  for (const e of chosenExtras) {
    lines.push(`then run ${e.title}, which is not mine and runs:`);
    lines.push(`  ${e.command}`);
  }

  // Printing these where they are discovered does not work: that happens before the first
  // clearScreen(), which wipes them a moment later.
  for (const w of configWarnings) lines.push(style.yellow(`note: ${w}`));

  // Dead last, immediately above Install/Cancel. This is the final chance to catch a developer
  // who skimmed the first screen, and it is the one option they should never end up taking.
  if (guided) {
    lines.push("");
    lines.push(style.yellow("This is the Simple install, for someone who does not write code."));
    lines.push(style.yellow("If you write code, cancel and choose Advanced instead."));
  }
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
  for (const w of wanted) if (!known.includes(w)) warnConfig(`--extras: nothing called "${w}" — ignored`);
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
      const [name, folderList = "", description = "", defaults = ""] = trimmed.split("|").map((part) => part.trim());
      const members = (folderList || name)
        .split(",")
        .map((f) => f.trim())
        .filter((f) => folders.includes(f));
      if (!name || members.length === 0) {
        // A stale line cannot break the run — but it must not vanish without a word either, or a
        // renamed folder silently drops a skill out of every setup and nobody notices for months.
        if (name) warnConfig(`skills.txt: "${name}" names no folder that exists under ./skills — ignored`);
        continue;
      }
      members.forEach((f) => claimed.add(f));
      groups.push({
        name,
        folders: members,
        description,
        defaults: parseDefaults(defaults, { dev: true, nontech: false }, `skills.txt: ${name}`),
      });
    }
  }
  for (const folder of folders) {
    // A folder with no line still installs on the developer track, exactly as before.
    if (!claimed.has(folder)) groups.push({ name: folder, folders: [folder], description: "", defaults: { dev: true, nontech: false } });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The fourth column of a skills.txt line: `<dev>,<nontech>` as `on`/`off`.
 *
 * An EMPTY field means "not specified" and takes the fallback, so `| ,on` sets only the nontech
 * axis and leaves dev at its default. A field that is present but is not `on` resolves to OFF —
 * a typo must not quietly enable something on someone's machine, and the failure that matters is
 * the silent yes, not the silent no.
 */
function parseDefaults(raw, fallback, where = "") {
  if (!raw) return { ...fallback };
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  return {
    dev: readOnOff(parts[0], fallback.dev, where, "dev"),
    nontech: readOnOff(parts[1], fallback.nontech, where, "nontech"),
  };
}

/**
 * One on/off value. Empty means "not specified" and takes the fallback; anything else that is not
 * `on` resolves to OFF and says so, rather than looking like a deliberate choice.
 */
function readOnOff(value, whenMissing, where, axis) {
  if (value === undefined || String(value).trim() === "") return whenMissing;
  const normalised = String(value).trim().toLowerCase();
  if (normalised === "on") return true;
  if (normalised !== "off" && where) {
    warnConfig(`${where}: "${value}" is not on or off — treating ${axis} as off`);
  }
  return false;
}

/**
 * Does this beta feature carry a track default? Beta covers both skills and instructions, so the
 * answer lives in a different list depending on its kind.
 */
function nameHasTrackDefault(feature, track, skillGroups, blocks) {
  const source =
    feature.kind === "skill"
      ? skillGroups.find((g) => g.name === feature.name)
      : blocks.find((b) => b.name === feature.name);
  return Boolean(source?.defaults?.[track]);
}

/** `dev:` / `nontech:` frontmatter, for instructions and extras. Same fail-safe-to-off rule. */
function frontmatterDefaults(meta, fallback, where = "") {
  return {
    dev: readOnOff(meta.dev, fallback.dev, where, "dev"),
    nontech: readOnOff(meta.nontech, fallback.nontech, where, "nontech"),
  };
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
        // What to say to a non-technical person when this one does not install. States the
        // CONSEQUENCE, not just the command — a bare "run this yourself" is a dead end for them.
        // Doubles as the signal that an extra is relevant to that audience at all: one without
        // this key is developer tooling and is never named in the guided closing message.
        nontechFallback: meta.nontech_fallback || "",
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

/**
 * The same failure, said to someone who cannot act on "put it on your PATH".
 *
 * A developer reads printManualFallback and knows what to do. For the guided track the useful
 * information is the CONSEQUENCE — what still works, what is now worse — and who to ask. The
 * wording comes from the extra's own frontmatter so this stays data rather than code.
 */
function printNontechFallback(extra) {
  const consequence = extra.nontechFallback || "Everything else is ready. This part is optional.";
  console.log("");
  console.log(`    ${consequence}`);
  console.log(`    ${style.dim("To add it, someone can run:")}`);
  console.log(`      ${extra.command}`);
  if (extra.url) console.log(`    ${style.dim("More:")}  ${style.cyan(extra.url)}`);
}

async function runExtras(extras, guided = false) {
  if (!extras || extras.length === 0) return;
  const followUps = [];
  const unfinished = [];

  for (const extra of extras) {
    console.log(`\n  ${style.bold(extra.title)}`);
    const missing = missingRequirements(extra);
    if (missing.length) {
      console.log(`  ${style.yellow("skipped  ")} ${missing.map((m) => m.name).join(" and ")} not found on your PATH.`);
      if (guided) printNontechFallback(extra);
      else printManualFallback(extra, missing);
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
      if (guided) printNontechFallback(extra);
      else printManualFallback(extra);
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
      // Per-kind: a beta skill may only be pruned if the BETA checklist ran, a stable one only
      // if the skills checklist ran. On the guided track neither did, so neither can be removed.
      const mayPrune = isBeta ? plan.prune.beta : plan.prune.skills;
      if (mayPrune && isGroupLinked(group)) {
        // unlinkFolder, NOT a bare rmSync over group.folders. isGroupLinked is `.some()`, so one
        // of our links makes the whole group read as present — but the other folders in it may be
        // a real directory somebody else put there. A blind recursive force-delete would take
        // that with it, under a group name that never mentions the folder it just destroyed:
        // unticking `ttp` would delete a foreign `to-the-point/` and report only "removed ttp".
        // unlinkFolder already refuses anything that is not our own link; the prune path was the
        // one place bypassing that guard.
        const outcomes = group.folders.map(unlinkFolder);
        const kept = outcomes.filter((o) => o === "foreign").length;
        report(group, "removed", kept ? `(unticked; left ${kept} not installed by this repo)` : "(unticked)");
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
      return {
        file,
        name: meta.name || fallback,
        title: meta.title || fallback,
        summary: meta.summary || "",
        // An instruction block writes to the GLOBAL CLAUDE.md, so it is off for both tracks
        // unless it says otherwise. `default:` was the old spelling and was never read.
        defaults: frontmatterDefaults(meta, { dev: false, nontech: false }, `instructions/${file}`),
        body,
      };
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

/**
 * @param desired    block names that should be present afterwards
 * @param mayRemove  whether a block that is installed but not desired may be taken away. False
 *                   when nothing on screen showed the user it was there — the same predicate the
 *                   skills path uses, rather than removing on a set difference the user never saw.
 */
function applyInstructionBlocks(desired, mayRemove = true) {
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
    } else if (installed.has(b.name) && mayRemove) {
      next = withoutBlock(next, b.name, eol);
      actions.push(`turned off ${b.title}`);
    }
  }
  for (const a of actions) console.log(`  ${a}`);
  if (next === content) return; // nothing to do, so nothing to back up

  // Back up ONLY now, when the content is genuinely about to change, and overwrite each time so
  // the .bak always holds the state immediately before the current write.
  //
  // The earlier version wrote it once ever, before knowing whether anything would change. On a
  // normal timeline — install, live with the machine for months, re-run — that burned the single
  // slot on installer-generated boilerplate from day one, and the backup was guaranteed stale by
  // the time the marker-collision it guards against could strike. A stale backup is worse than
  // none: it looks like a safety net.
  if (existed && content.trim()) {
    try {
      fs.writeFileSync(`${globalClaudeMd}.bak`, content);
    } catch (err) {
      // Never silently. If the backup is the safety story, the user has to know it failed before
      // the destructive write lands, not after.
      console.log(`  ${style.yellow("WARNING  ")} could not back up ${globalClaudeMd} — ${err.message}`);
      console.log(`            Continuing, because you asked for this change.`);
    }
  }

  if (next.trim() === "") {
    // The file held nothing but our blocks — leave no empty husk behind.
    if (existed) fs.rmSync(globalClaudeMd, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(globalClaudeMd), { recursive: true });
  fs.writeFileSync(globalClaudeMd, next);
}
