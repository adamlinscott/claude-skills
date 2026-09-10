/**
 * Reads the repo's actual ./instructions/*.md files, so verify.mjs can test against the real
 * blocks rather than only against fixtures.
 *
 * This deliberately duplicates the small frontmatter parse from install.mjs rather than importing
 * it: install.mjs runs its whole wizard on import, so it cannot be imported for its parts. The
 * duplication is four lines of regex, and the alternative — restructuring the installer's entry
 * point — is a bigger change than this test is worth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const instructionsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "instructions");

export function loadReal() {
  if (!fs.existsSync(instructionsDir)) return [];
  return fs
    .readdirSync(instructionsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(instructionsDir, file), "utf8");
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      const meta = {};
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
          if (kv) meta[kv[1]] = kv[2].trim();
        }
      }
      const fallback = path.basename(file, ".md");
      return {
        file,
        name: meta.name || fallback,
        title: meta.title || fallback,
        body: (m ? raw.slice(m[0].length) : raw).trim(),
      };
    })
    .filter((b) => b.body.length > 0);
}
