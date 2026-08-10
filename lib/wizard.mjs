// A tiny terminal UI for the installer: colours, in-place redraw, and two arrow-key menus.
//
// Everything here degrades safely. Colour is dropped when the output is not a terminal (or when
// NO_COLOR is set), screen clearing and cursor hiding are skipped for the same reason, and raw
// mode is only requested when stdin actually supports it — so the menus can still be driven by
// piped key sequences in a test, and never corrupt a redirected log.

import readline from "node:readline";

const useColour =
  (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

const code = (open, close) => (text) => (useColour ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const style = {
  bold: code(1, 22),
  dim: code(2, 22),
  green: code(32, 39),
  cyan: code(36, 39),
  yellow: code(33, 39),
};

/** Wipe the screen (including scrollback) so each step starts clean. No-op when redirected. */
export function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

const hideCursor = () => process.stdout.isTTY && process.stdout.write("\x1b[?25l");
const showCursor = () => process.stdout.isTTY && process.stdout.write("\x1b[?25h");

/** True when we can actually run a menu: stdin must be a terminal we can read keys from. */
export function canPrompt() {
  return Boolean(process.stdin.isTTY);
}

/**
 * Redraws a block of text in place: jumps back over the previous frame and clears to the end of
 * the screen, so only the menu repaints and whatever was printed above it stays put.
 */
function makeRenderer() {
  let height = 0;
  return (text) => {
    const out = text.endsWith("\n") ? text : `${text}\n`;
    const rewind = height > 0 && process.stdout.isTTY ? `\x1b[${height}A\x1b[0J` : "";
    process.stdout.write(rewind + out);
    height = out.split("\n").length - 1;
  };
}

// stdin is armed ONCE for the whole wizard and handed to whichever menu is on screen. Arming it
// per menu was wrong twice over: readline.emitKeypressEvents adds a fresh listener each call, so a
// real terminal would act on every keypress twice, and pausing a pipe between menus threw away
// keys that had already been buffered.
let inputReady = false;
let rawEnabled = false;
let currentHandler = null;
// Keys that arrived while no menu was listening. A pipe delivers every keystroke in a single
// burst, so the whole rest of the script's input is emitted before the next menu can subscribe;
// a fast typist does the same thing to a real terminal between screens. Queue them either way.
const pending = [];

// Named rather than inline so closeInput() can take them off again. The comment above records what
// happened when a listener was added per menu; the same bug returns if we re-arm without removing,
// which now matters because the host setup hands the terminal to `claude auth login` partway
// through and then needs a menu back afterwards.
const onKeypress = (str, key) => deliver(str, key ?? {});
const onEnd = () => deliver(null, { name: "__end" });

function ensureInput() {
  if (inputReady) return;
  inputReady = true;
  readline.emitKeypressEvents(process.stdin);
  if (Boolean(process.stdin.isTTY) && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    rawEnabled = true;
  }
  process.stdin.resume();
  hideCursor();
  process.stdin.on("keypress", onKeypress);
  process.stdin.on("end", onEnd);
}

function deliver(str, key) {
  if (currentHandler) currentHandler(str, key);
  else pending.push([str, key]);
}

/** Attach a menu's handler and immediately feed it anything that arrived early. */
function setHandler(handler) {
  currentHandler = handler;
  while (currentHandler && pending.length) {
    const [str, key] = pending.shift();
    currentHandler(str, key);
  }
}

/**
 * Hand the terminal back. Safe to call more than once, and after nothing was ever opened.
 *
 * The listeners come off, not just the handler. Anything spawned with stdio "inherit" after this
 * reads its own keystrokes — if ours were still attached, the parent would eat them — and a later
 * ensureInput() re-arms from a clean slate rather than stacking a second listener on the first.
 *
 * Anything already queued is deliberately KEPT. Those bytes have long since left the file
 * descriptor, so discarding them hands nothing back to a child process — it only loses keys that a
 * piped run (a test, or CI) delivered in one burst for a menu that has not opened yet.
 */
export function closeInput() {
  currentHandler = null;
  if (!inputReady) return;
  inputReady = false;
  process.stdin.off("keypress", onKeypress);
  process.stdin.off("end", onEnd);
  if (rawEnabled) {
    process.stdin.setRawMode(false);
    rawEnabled = false;
  }
  process.stdin.pause();
  showCursor();
}

// However the process ends, never leave the cursor hidden.
process.on("exit", () => {
  if (rawEnabled) process.stdin.setRawMode(false);
  showCursor();
});

/**
 * Shared key loop. `onKey` decides what a key does and calls `finish(result)` when the menu is
 * over; `render` paints the current state. Resolves with whatever `finish` was given, or null if
 * the user pressed Escape / Ctrl-C, or if input ran out.
 */
function runMenu(render, onKey) {
  ensureInput();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      currentHandler = null;
      resolve(result);
    };

    render(); // paint before draining queued keys, so the first frame is never skipped
    setHandler((str, key = {}) => {
      if (settled) return;
      if (key.name === "__end") return finish(null); // input ran out
      if (key.ctrl && key.name === "c") return finish(null);
      onKey(key, str, finish);
      if (!settled) render();
    });
  });
}

const pointer = (active) => (active ? style.cyan(">") : " ");
const rowText = (text, active) => (active ? style.bold(text) : text);

function footer(hints) {
  return `\n  ${style.dim(hints.join("   "))}\n`;
}

/** Greedy word wrap. Returns at least one line so an empty string still occupies a row. */
export function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

const termWidth = () => process.stdout.columns || 96;

/**
 * The details panel for whatever the cursor is on. Padding is applied to the raw text and the
 * colour wrapped around it afterwards, because ANSI escapes would otherwise be counted as
 * visible characters and throw the box out of alignment.
 */
function detailBox(title, body, width, maxBodyLines = 14) {
  const inner = width - 4;
  const bar = "─".repeat(width - 2);
  const row = (text) => `│ ${text.padEnd(inner)} │`;
  const lines = [`┌${bar}┐`, `│ ${style.bold(String(title).slice(0, inner).padEnd(inner))} │`];
  if (body) {
    // Blank lines in the source are kept, so a panel can hold more than one paragraph.
    const paragraphs = String(body)
      .split(/\n/)
      .flatMap((para) => (para.trim() ? wrap(para.trim(), inner) : [""]));
    lines.push(row(""));
    for (const l of paragraphs.slice(0, maxBodyLines)) lines.push(style.dim(row(l)));
  }
  lines.push(`└${bar}┘`);
  return lines;
}

/** Visible width, ignoring the ANSI colour escapes, which occupy no columns on screen. */
const visibleWidth = (text) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
const padVisible = (text, width) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/**
 * Lay the list on the left and its details panel on the right. On a narrow terminal there is no
 * room for two columns, so the panel goes underneath instead of being crushed.
 */
function twoColumn(listLines, boxLines, boxWidth) {
  if (termWidth() < boxWidth + 44) return [...listLines.map((l) => `  ${l}`), "", ...boxLines.map((l) => `  ${l}`)];
  const listWidth = Math.max(...listLines.map(visibleWidth));
  const rows = Math.max(boxLines.length, listLines.length);
  const out = [];
  for (let i = 0; i < rows; i++) {
    const left = padVisible(listLines[i] ?? "", listWidth);
    const right = boxLines[i] ?? "";
    out.push(`  ${left}   ${right}`.trimEnd());
  }
  return out;
}

/**
 * Checkbox list with a confirm row at the end.
 *
 *   > [✓] debrief
 *     [ ] something-else
 *
 *       Confirm selection
 *
 * items: [{ value, label, hint }]. Returns a Set of chosen values, or null if cancelled.
 */
export async function multiSelect({ heading, note, items, selected = [], confirmLabel = "Confirm selection" }) {
  const chosen = new Set(selected);
  let cursor = 0;
  const rowCount = items.length + 1; // items, then the confirm row
  const confirmRow = items.length;
  const render = makeRenderer();

  const boxWidth = Math.min(44, Math.max(30, Math.floor(termWidth() * 0.42)));

  const paint = () => {
    const list = [];
    items.forEach((item, i) => {
      const active = i === cursor;
      const tick = chosen.has(item.value) ? style.green("✓") : " ";
      const label = item.hint ? `${item.label} ${style.dim(`— ${item.hint}`)}` : item.label;
      list.push(`${pointer(active)} [${tick}] ${rowText(label, active)}`);
    });
    list.push("");
    list.push(`${pointer(cursor === confirmRow)}     ${rowText(confirmLabel, cursor === confirmRow)}`);

    const hovered = items[cursor];
    const box = detailBox(
      hovered ? hovered.label : confirmLabel,
      hovered ? hovered.details || hovered.hint || "" : `Move on with ${chosen.size} of ${items.length} ticked.`,
      boxWidth,
    );

    const out = [`  ${style.bold(heading)}`];
    // Wrapped, so a long note from a caller can never run off the side of the terminal.
    if (note) for (const line of wrap(note, Math.max(40, termWidth() - 4))) out.push(`  ${style.dim(line)}`);
    out.push("");
    out.push(...twoColumn(list, box, boxWidth));
    out.push(footer(["↑↓ move", "space toggle", "enter confirm", "esc cancel"]));
    render(out.join("\n"));
  };

  const result = await runMenu(paint, (key, str, finish) => {
    const name = key.name ?? str;
    if (name === "up" || name === "k") cursor = (cursor - 1 + rowCount) % rowCount;
    else if (name === "down" || name === "j" || name === "tab") cursor = (cursor + 1) % rowCount;
    else if (name === "escape" || name === "q") finish(null);
    else if (name === "space") {
      if (cursor < confirmRow) toggle();
    } else if (name === "return" || name === "enter") {
      if (cursor === confirmRow) finish(chosen);
      else toggle();
    } else if (name === "a") {
      // Select-all / select-none, since a long list is tedious one at a time.
      if (chosen.size === items.length) chosen.clear();
      else for (const item of items) chosen.add(item.value);
    }
    function toggle() {
      const { value } = items[cursor];
      if (chosen.has(value)) chosen.delete(value);
      else chosen.add(value);
    }
  });

  paint(); // leave the final state on screen
  process.stdout.write("\n");
  return result;
}

/**
 * A single line of typed text.
 *
 * Written against the same armed-once stdin as the menus rather than opening a readline interface,
 * because two consumers of stdin in one process is the bug the comments above are about. Nothing
 * here is a password field by accident: pass `mask` deliberately.
 *
 *   validate  (value) => null for "fine", or a string shown under the field
 *   initial   pre-filled, and returned as-is if the user just presses enter
 *
 * Returns the trimmed string, or null if cancelled.
 */
export async function textInput({ heading, note, label, initial = "", placeholder = "", validate, mask = false }) {
  let value = String(initial ?? "");
  let error = null;
  let touched = false;
  const render = makeRenderer();

  const paint = () => {
    const out = [`  ${style.bold(heading)}`];
    if (note) for (const line of wrap(note, Math.max(40, termWidth() - 4))) out.push(`  ${style.dim(line)}`);
    out.push("");
    const shown = mask ? "•".repeat(value.length) : value;
    // The placeholder is dim and only stands in while the field is empty, so it can never be
    // mistaken for a value that was actually typed.
    const body = shown.length ? shown : style.dim(placeholder);
    out.push(`  ${label ? `${label} ` : ""}${body}${style.cyan("▏")}`);
    if (error) out.push(`  ${style.yellow(error)}`);
    out.push(footer(["type to edit", "enter confirm", "ctrl-u clear", "esc cancel"]));
    render(out.join("\n"));
  };

  const result = await runMenu(paint, (key, str, finish) => {
    const name = key.name ?? str;
    if (name === "escape") return finish(null);
    if (name === "return" || name === "enter") {
      touched = true;
      const trimmed = value.trim();
      error = validate ? validate(trimmed) : null;
      if (!error) finish(trimmed);
      return;
    }
    if (name === "backspace") {
      value = value.slice(0, -1);
    } else if (key.ctrl && name === "u") {
      value = "";
    } else if (!key.ctrl && !key.meta && typeof str === "string" && str.length === 1 && str >= " " && str !== "\x7f") {
      value += str;
    } else {
      return; // arrow keys, function keys, anything else: ignore rather than insert junk
    }
    // Clear a complaint as soon as they start fixing it, instead of leaving it under a field that
    // no longer matches what it was complaining about.
    if (touched) error = null;
  });

  paint();
  process.stdout.write("\n");
  return result;
}

/**
 * Single-choice menu, used for the final go/no-go.
 * items: [{ value, label, hint }]. Returns the chosen value, or null if cancelled.
 */
export async function chooseAction({ heading, body = [], items }) {
  let cursor = 0;
  const render = makeRenderer();

  const paint = () => {
    const out = [];
    out.push(`  ${style.bold(heading)}`);
    out.push("");
    for (const line of body) out.push(`  ${line}`);
    if (body.length) out.push("");
    items.forEach((item, i) => {
      const active = i === cursor;
      const label = item.hint ? `${item.label} ${style.dim(`— ${item.hint}`)}` : item.label;
      out.push(`  ${pointer(active)} ${rowText(label, active)}`);
    });
    out.push(footer(["↑↓ move", "enter select", "esc cancel"]));
    render(out.join("\n"));
  };

  const result = await runMenu(paint, (key, str, finish) => {
    const name = key.name ?? str;
    if (name === "up" || name === "k") cursor = (cursor - 1 + items.length) % items.length;
    else if (name === "down" || name === "j" || name === "tab") cursor = (cursor + 1) % items.length;
    else if (name === "escape" || name === "q") finish(null);
    else if (name === "return" || name === "enter") finish(items[cursor].value);
  });

  paint();
  process.stdout.write("\n");
  return result;
}
