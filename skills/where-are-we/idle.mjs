// How long since the last message before the current prompt, read from the session transcript.
//
//   node idle.mjs [session-id]
//
// Prints one line of JSON: {"lastMessageAt": "<ISO>", "minutesAway": <n>} or {"unknown": "<why>"}.
// Without a session id it takes the most recently written transcript for the working directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
const id = process.argv[2];

function findTranscript() {
  if (/^[0-9a-f-]{36}$/i.test(id ?? "")) {
    for (const dir of fs.readdirSync(projects)) {
      const file = path.join(projects, dir, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  const dir = path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  if (!fs.existsSync(dir)) return null;
  const newest = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return newest ?? null;
}

const isTypedPrompt = (e) =>
  e.type === "user" && !e.isMeta &&
  (typeof e.message?.content === "string" || e.message?.content?.some((c) => c.type === "text"));

function report(result) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

const file = findTranscript();
if (!file) report({ unknown: "no transcript found" });

const entries = fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const messages = entries.filter((e) => (e.type === "user" || e.type === "assistant") && e.timestamp && !e.isMeta);

let current = -1;
for (let i = messages.length - 1; i >= 0; i--) if (isTypedPrompt(messages[i])) { current = i; break; }
if (current < 1) report({ unknown: "no message before this one" });

const last = messages[current - 1].timestamp;
report({ lastMessageAt: last, minutesAway: Math.round((Date.now() - Date.parse(last)) / 60000) });
