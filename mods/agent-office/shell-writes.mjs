// Agent Office's shell reader: the files a shell command writes, so a write through Bash or
// PowerShell counts as an edit just as an Edit does. It is a heuristic: it reads redirects and a
// handful of commands that write (below), and skips anything it can't read rather than guess —
// a path with a variable or a glob in it, a `cd` to somewhere it can't place, a script the command
// runs. Writes by programs a command starts stay invisible.
//
// Pure: no Node imports and no `$`. The source and the mod's hook share this file.
//
// What counts as a write:
//   >  >>              to a file (not 2>, >&, &>, /dev/null or $null); heredocs are skipped over
//   tee [-a] f…        sed -i / perl -i … f…
//   cp / mv / install  the last path is the target (a folder target takes each source's name)
//   touch f…
//   Set-Content, Add-Content, Out-File    -Path / -FilePath / -LiteralPath, or the first positional
//   New-Item -ItemType File               -Path (with -Name), or the first positional

import { isAbsolute, isWindowsPath, join, normalize } from "./git.mjs";

/**
 * The absolute paths `command` writes, in the order it writes them, each once. Relative paths
 * resolve against `cwd`, or against where a `cd` in the command moved to; with no cwd they are
 * skipped. Git Bash's /c/… paths become C:/… when the cwd is a Windows path.
 * powershell: read the command as PowerShell (backtick escapes, backslashes literal).
 */
export function shellWrites(command, cwd, { powershell = false } = {}) {
  const win = Boolean(cwd) && isWindowsPath(cwd);
  let dir = cwd ? normalize(cwd) : null;
  const out = [];
  const keep = (w) => {
    const p = place(w, dir, win);
    if (p && !out.includes(p)) out.push(p);
  };
  for (const s of segments(tokens(command, powershell))) {
    for (const w of s.writes) keep(w);
    let words = s.words;
    if (!powershell) while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text)) words = words.slice(1);
    if (!words.length || words[0].unsafe) continue;
    const name = base(words[0].text).toLowerCase().replace(/\.exe$/, "");
    const args = words.slice(1);
    if (name === "cd" || name === "set-location") {
      const { named, positional } = psArgs(args);
      const to = named.path || named.literalpath || positional[0];
      dir = to && to !== true && to.text !== "-" ? place(to, dir, win) : null;
      continue;
    }
    const writer = WRITERS[name];
    if (writer) for (const w of writer(args)) keep(w);
  }
  return out;
}

const WRITERS = {
  tee: (args) => posix(args).positional,
  touch: (args) => posix(args, ["-d", "-t", "-r"]).positional,
  sed: inPlace,
  perl: inPlace,
  cp: (args) => copyTarget(args, ["-S"]),
  mv: (args) => copyTarget(args, ["-S"]),
  install: (args) => copyTarget(args, ["-m", "-o", "-g", "-S"]),
  "set-content": (args) => one(psArgs(args), ["path", "literalpath"]),
  "add-content": (args) => one(psArgs(args), ["path", "literalpath"]),
  "out-file": (args) => one(psArgs(args), ["filepath", "literalpath", "path"]),
  "new-item": newItem,
};

// ── Commands ─────────────────────────────────────────────────────────────────────────────────

// POSIX arguments: flags dropped (with the value of each flag in `valued`), the rest positional.
function posix(args, valued = []) {
  const flags = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      flags.push(t);
      if (valued.includes(t)) i++;
    } else positional.push(args[i]);
  }
  return { flags, positional };
}

// sed -i / perl -i: the files after the script, which is the first positional unless -e or -f
// gave it.
function inPlace(args) {
  let inplace = false;
  let script = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      if (t.startsWith("--in-place")) inplace = true;
      if (/^--(expression|file)(=|$)/.test(t)) {
        script = true;
        if (!t.includes("=")) i++;
      }
    } else if (t.startsWith("-") && t.length > 1) {
      if (/^-[a-zA-Z]*i/.test(t)) inplace = true;
      if (/^-[a-zA-Z]*[ef]$/.test(t)) {
        script = true;
        i++;
      }
    } else positional.push(args[i]);
  }
  return inplace ? positional.slice(script ? 0 : 1) : [];
}

// cp / mv / install: the last path. Two or more sources, or a target ending in a slash, is a
// folder: each source lands in it under its own name. -t (target first) and install -d are skipped.
function copyTarget(args, valued) {
  const { flags, positional } = posix(args, valued);
  if (flags.some((f) => f === "-d" || f === "-t" || f.startsWith("--target-directory") || f === "--directory")) return [];
  if (positional.length < 2) return [];
  const target = positional[positional.length - 1];
  const sources = positional.slice(0, -1);
  if (sources.length === 1 && !/[\\/]$/.test(target.text) && target.text !== "." && target.text !== "..") return [target];
  return sources.map((s) => ({ text: target.text + "/" + base(s.text), unsafe: target.unsafe || s.unsafe }));
}

// PowerShell's switches that take no value; any other -Name takes the next word.
const PS_SWITCHES = new Set(["force", "nonewline", "passthru", "append", "noclobber", "whatif", "confirm", "asbytestream", "verbose", "debug"]);

function psArgs(args) {
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(args[i].text);
    if (!m) positional.push(args[i]);
    else if (m[2] !== undefined) named[m[1].toLowerCase()] = { text: m[2], unsafe: args[i].unsafe };
    else if (PS_SWITCHES.has(m[1].toLowerCase())) named[m[1].toLowerCase()] = true;
    else named[m[1].toLowerCase()] = args[++i] || true;
  }
  return { named, positional };
}

function one({ named, positional }, keys) {
  const hit = keys.map((k) => named[k]).find((v) => v && v !== true) || positional[0];
  return hit ? [hit] : [];
}

function newItem(args) {
  const parsed = psArgs(args);
  const type = parsed.named.itemtype || parsed.named.type;
  if (!type || type === true || type.text.toLowerCase() !== "file") return [];
  const [path] = one(parsed, ["path"]);
  const name = parsed.named.name;
  if (!name || name === true) return path ? [path] : [];
  return [path ? { text: path.text + "/" + name.text, unsafe: path.unsafe || name.unsafe } : name];
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────

function place(w, dir, win) {
  if (!w || w.unsafe || !w.text || w.text.startsWith("~") || w.text.startsWith("/dev/") || /^nul$/i.test(w.text)) return null;
  const p = win ? w.text.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => d.toUpperCase() + ":") : w.text;
  if (isAbsolute(p)) return normalize(p);
  return dir ? join(dir, p) : null;
}

const base = (p) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

// ── Reading the command ──────────────────────────────────────────────────────────────────────

// Simple commands as { words, writes }, split on ; && || | & ( ) and newlines. A word after a
// write redirect is a write; after any other redirect (input, stderr, a descriptor) it is dropped.
function segments(toks) {
  const out = [];
  let cur = { words: [], writes: [] };
  let after = null;
  for (const t of toks) {
    if (t.op === ";") {
      out.push(cur);
      cur = { words: [], writes: [] };
      after = null;
    } else if (t.op) after = t.op;
    else {
      if (after === "write") cur.writes.push(t);
      else if (after !== "skip") cur.words.push(t);
      after = null;
    }
  }
  out.push(cur);
  return out.filter((s) => s.words.length || s.writes.length);
}

// Words ({ text, unsafe }, quotes stripped) and operators ({ op: ";" | "write" | "skip" }). A word
// is unsafe when a variable, a command substitution or a glob outside quotes is in it.
function tokens(src, ps) {
  const out = [];
  const heredocs = [];
  let word = null;
  let i = 0;
  const add = (s, unsafe = false) => {
    word = word || { text: "", unsafe: false };
    word.text += s;
    if (unsafe) word.unsafe = true;
  };
  const flush = () => {
    if (word) out.push(word);
    word = null;
  };
  const op = (o) => {
    flush();
    out.push({ op: o });
  };
  const escape = ps ? "`" : "\\";

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") {
      op(";");
      i = skipHeredocs(src, i + 1, heredocs);
      heredocs.length = 0;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      flush();
      i++;
    } else if (ch === "#" && !word) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === escape) {
      if (src[i + 1] !== "\n") add(src[i + 1] || "");
      i += 2;
    } else if (ps && ch === "@" && !word && (src[i + 1] === "'" || src[i + 1] === '"') && /^\r?\n/.test(src.slice(i + 2))) {
      // A PowerShell here-string: its body is one word, up to a line starting with '@ or "@.
      const q = src[i + 1];
      const end = src.indexOf("\n" + q + "@", i + 2);
      const stop = end < 0 ? src.length : end;
      add(src.slice(i + 2, stop), q === '"' && src.slice(i + 2, stop).includes("$"));
      i = end < 0 ? src.length : end + 3;
    } else if (ch === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        const k = src.indexOf("'", j);
        if (k < 0) {
          text += src.slice(j);
          j = src.length;
          break;
        }
        text += src.slice(j, k);
        j = k + 1;
        if (!(ps && src[j] === "'")) break;
        text += "'"; // PowerShell doubles a quote inside single quotes
        j++;
      }
      add(text);
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === escape && j + 1 < src.length) {
          const n = src[j + 1];
          // Bash's backslash escapes only these inside double quotes; PowerShell's backtick any.
          if (ps || "$`\"\\\n".includes(n)) {
            if (n !== "\n") add(n);
            j += 2;
            continue;
          }
        }
        if (src[j] === "$" || (!ps && src[j] === "`")) add(src[j], true);
        else add(src[j]);
        j++;
      }
      add("");
      i = j + 1;
    } else if (ch === "$" || ch === "*" || ch === "?" || (!ps && ch === "`")) {
      add(ch, true);
      i++;
    } else if (ch === ";" || ch === "(" || ch === ")") {
      op(";");
      i++;
    } else if (ch === "|") {
      op(";");
      i += src[i + 1] === "|" ? 2 : 1;
    } else if (ch === "&") {
      if (src[i + 1] === ">") {
        op("skip"); // &> and &>>: stdout and stderr together
        i += src[i + 2] === ">" ? 3 : 2;
      } else {
        op(";");
        i += src[i + 1] === "&" ? 2 : 1;
      }
    } else if (ch === ">") {
      // A descriptor written straight before it (2>, PowerShell's *>) is not stdout.
      const fd = word && (/^\d+$/.test(word.text) || (ps && word.text === "*")) ? word.text : "1";
      if (fd !== "1" || (word && word.text === "1")) word = null;
      flush();
      i++;
      if (src[i] === ">") i++;
      if (src[i] === "&") {
        op("skip"); // >&2, 2>&1: a descriptor, not a file
        i++;
      } else {
        if (src[i] === "|") i++;
        op(fd === "1" ? "write" : "skip");
      }
    } else if (ch === "<") {
      flush();
      if (!ps && src[i + 1] === "<" && src[i + 2] !== "<") {
        i += 2;
        const strip = src[i] === "-";
        if (strip) i++;
        const d = readDelimiter(src, i);
        heredocs.push({ delim: d.text, strip });
        i = d.end;
      } else {
        op("skip");
        i += src[i + 1] === "<" ? 3 : 1;
      }
    } else {
      add(ch);
      i++;
    }
  }
  flush();
  return out;
}

// A heredoc's delimiter word, quotes stripped: → { text, end }.
function readDelimiter(src, i) {
  while (src[i] === " " || src[i] === "\t") i++;
  let text = "";
  while (i < src.length && !/[\s;|&<>()]/.test(src[i])) {
    if (src[i] === "'" || src[i] === '"') {
      const k = src.indexOf(src[i], i + 1);
      const end = k < 0 ? src.length : k;
      text += src.slice(i + 1, end);
      i = end + 1;
    } else {
      if (src[i] !== "\\") text += src[i];
      i++;
    }
  }
  return { text, end: i };
}

// Past the bodies of the heredocs opened on the line that just ended, from `i`.
function skipHeredocs(src, i, heredocs) {
  for (const h of heredocs) {
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const lineEnd = nl < 0 ? src.length : nl;
      let line = src.slice(i, lineEnd).replace(/\r$/, "");
      if (h.strip) line = line.replace(/^\t+/, "");
      i = nl < 0 ? src.length : nl + 1;
      if (line === h.delim) break;
    }
  }
  return i;
}
