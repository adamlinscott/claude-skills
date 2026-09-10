/**
 * Managed blocks inside a CLAUDE.md.
 *
 * Everything here is a PURE STRING TRANSFORM — no filesystem, no console, no process state. That
 * is the point: this is the code that edits a file the user has been writing by hand for months,
 * so it has to be provable rather than merely careful. `tools/instructions/verify.mjs` exercises
 * it against the cases that matter, and can be run any time without touching a real CLAUDE.md.
 *
 * The contract, in one line: **running it twice must be identical to running it once.**
 *
 * A block is delimited by two HTML comments, invisible in rendered Markdown:
 *
 *     <!-- claude-skills:<name> start -->
 *     …content…
 *     <!-- claude-skills:<name> end -->
 *
 * Anything outside those markers is never touched. Anything inside is owned by this repo and is
 * replaced wholesale on every write, which is what makes the operation idempotent: the installer
 * never diffs or merges, it removes the old region and writes the current one.
 */

export function markerFor(name, edge) {
  return `<!-- claude-skills:${name} ${edge} -->`;
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a managed block INCLUDING the blank lines around it, so removal leaves no gap.
 *
 * `flags` exists so callers can ask for a global match. Every mutating path passes "g" and means
 * it: the single-match version silently preserved a SECOND copy of a block forever, and a second
 * copy is exactly what a half-finished write or a hand-pasted duplicate leaves behind. A cleanup
 * routine that cannot clean up the mess it is most likely to meet is not one.
 */
export function blockPattern(name, flags = "") {
  return new RegExp(
    `(?:\\r?\\n)*${escapeRe(markerFor(name, "start"))}[\\s\\S]*?${escapeRe(markerFor(name, "end"))}(?:\\r?\\n)*`,
    flags,
  );
}

/** Match whatever the file already uses, so a Windows-authored CLAUDE.md stays CRLF throughout. */
export function detectEol(content) {
  return /\r\n/.test(content) ? "\r\n" : "\n";
}

export function renderBlock(block, eol) {
  return [
    markerFor(block.name, "start"),
    `<!-- Managed by claude-skills — source: instructions/${block.file}. Edits inside this block are`,
    `     overwritten on the next \`node install.mjs\`. Remove with \`node install.mjs --uninstall\`. -->`,
    ...block.body.split(/\r?\n/),
    markerFor(block.name, "end"),
  ].join(eol);
}

/** The managed region as it currently stands in `content`, or null. Used to detect drift. */
export function extractBlock(content, name) {
  const m = blockPattern(name).exec(content);
  return m ? m[0].trim() : null;
}

/** How many complete copies of this block the content holds. Should only ever be 0 or 1. */
export function countBlocks(content, name) {
  return (content.match(blockPattern(name, "g")) || []).length;
}

/**
 * Start markers without a matching end, or the reverse.
 *
 * A truncated block does not match `blockPattern` at all, so without this check it is invisible:
 * the installer would decide the block is absent, append a fresh one, and leave the orphaned half
 * sitting in the user's CLAUDE.md as live instruction text forever. Rare, and silent, which is
 * the combination worth a check.
 */
export function orphanedMarkers(content, name) {
  const count = (needle) => (content.match(new RegExp(escapeRe(needle), "g")) || []).length;
  const starts = count(markerFor(name, "start"));
  const ends = count(markerFor(name, "end"));
  return starts === ends ? null : { name, starts, ends };
}

/**
 * Insert or replace a block, collapsing any duplicates in the process.
 *
 * The first existing copy becomes the new content and every later copy is removed, so a file that
 * somehow accumulated two blocks converges to one on the next run rather than keeping both.
 */
export function withBlock(content, block, eol) {
  const rendered = renderBlock(block, eol);
  if (!blockPattern(block.name).test(content)) {
    const base = content.replace(/(?:\r?\n)+$/, "");
    return tidyEnds((base ? base + eol + eol : "") + rendered, eol);
  }
  let seen = 0;
  const next = content.replace(blockPattern(block.name, "g"), () =>
    seen++ === 0 ? `${eol}${eol}${rendered}${eol}${eol}` : `${eol}${eol}`,
  );
  return tidyEnds(next, eol);
}

/** Remove every copy of a block. */
export function withoutBlock(content, name, eol) {
  if (!blockPattern(name).test(content)) return content;
  return tidyEnds(content.replace(blockPattern(name, "g"), `${eol}${eol}`), eol);
}

/** Trim leading/trailing blank lines and end with exactly one newline. Only touches the edges. */
export function tidyEnds(content, eol) {
  const trimmed = content.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
  return trimmed ? trimmed + eol : "";
}

/**
 * The whole transform, as one pure function.
 *
 * @param content    the current CLAUDE.md text ("" if there is no file yet)
 * @param blocks     every block this repo knows about, from ./instructions
 * @param desired    Set of block names that should be present afterwards
 * @param mayRemove  whether an installed-but-unwanted block may be taken away. False when nothing
 *                   on screen showed the user it was there.
 * @returns { next, actions, warnings }
 */
export function applyBlocks(content, blocks, desired, mayRemove = true) {
  const eol = detectEol(content);
  const actions = [];
  const warnings = [];
  let next = content;

  for (const b of blocks) {
    const orphan = orphanedMarkers(next, b.name);
    if (orphan) {
      warnings.push(
        `${b.name}: found ${orphan.starts} start marker(s) and ${orphan.ends} end marker(s) in CLAUDE.md. ` +
          `Leaving it alone — repair or delete the stray marker by hand, then re-run.`,
      );
      continue;
    }

    if (desired.has(b.name)) {
      const before = extractBlock(next, b.name);
      const copies = countBlocks(next, b.name);
      next = withBlock(next, b, eol);
      const after = extractBlock(next, b.name);
      if (before === null) actions.push(`turned on  ${b.title}`);
      else if (copies > 1) actions.push(`repaired   ${b.title} (removed ${copies - 1} duplicate)`);
      else if (before !== after) actions.push(`refreshed  ${b.title}`);
      else actions.push(`ready      ${b.title}`);
    } else if (blockPattern(b.name).test(next) && mayRemove) {
      next = withoutBlock(next, b.name, eol);
      actions.push(`turned off ${b.title}`);
    }
  }

  return { next, actions, warnings };
}
