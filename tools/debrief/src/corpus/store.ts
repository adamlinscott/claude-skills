/**
 * Corpus store (T4). Two physical files (eng decision 2, 4):
 *   - the HOT FILE (corpus.json): patterns + answers + aliases + standing-protocol state.
 *     Small, EVIDENCE-FREE by construction (it carries only evidenceIds, never snippets),
 *     so it is the privacy-clean portable/standard shape — sharing it never leaks transcript.
 *   - the EVIDENCE SIDECAR (corpus.evidence.json): bulky snippets keyed by id.
 *
 * Durability rules (eng decision 2 — non-negotiable):
 *   - WRITES are atomic: serialize, write to a unique same-directory temp file, then
 *     fs.rename over the target. rename is atomic on a single filesystem, so a crash mid-
 *     write leaves either the old file intact OR the new one — never a half-written file.
 *   - READS take NO writer lock (so the long-running MCP server reading can never block the
 *     CLI miner writing, and vice versa). A read that loses the race simply sees the
 *     pre-rename or post-rename file — both are complete.
 *   - A MISSING file returns a well-formed empty corpus/sidecar (cold start, not an error).
 *   - An EMPTY / whitespace-only file is treated as missing (a zero-byte file can appear
 *     transiently). Returns the empty shape, never throws.
 *   - CORRUPT JSON is surfaced as a recoverable CorpusReadError, never a raw crash. The
 *     caller (CLI / MCP server) decides whether to back up + reset or abort.
 *   - schemaVersion mismatch is surfaced as a recoverable CorpusReadError (no silent
 *     migration of an unknown shape).
 */

import { writeFile, rename, readFile, mkdir, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AjvNs from "ajv";
import * as AjvFormatsNs from "ajv-formats";
import type { ValidateFunction } from "ajv";

// Ajv v8 + ajv-formats ship as CJS with `export default`; under NodeNext the constructable class /
// callable plugin lives on `.default`. Pull it off the namespace so this works under tsc(NodeNext)
// and tsx alike.
const Ajv = (AjvNs as unknown as { default: typeof import("ajv").default }).default;
const addFormats = (AjvFormatsNs as unknown as { default: typeof import("ajv-formats").default }).default;
import {
  SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  emptyCorpus,
  emptyEvidenceStore,
  type Corpus,
  type EvidenceStore,
} from "./types.js";

/** Recoverable error from a corpus/sidecar read (corrupt JSON or schemaVersion mismatch). */
export class CorpusReadError extends Error {
  constructor(
    message: string,
    /** The file that failed to load. */
    public readonly path: string,
    /** "corrupt" = unparseable/ill-shaped JSON; "schema" = version mismatch. */
    public readonly kind: "corrupt" | "schema",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CorpusReadError";
  }
}

/** True if a file-not-found error. */
function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Read a file's text, returning undefined if it does not exist. Tolerates the live-file
 * race: a partial/truncated trailing line is the caller's concern (JSON.parse will reject
 * it as corrupt, which loadCorpus surfaces as a recoverable CorpusReadError).
 */
async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return undefined;
    throw err;
  }
}

/**
 * Atomic write: serialize `data`, write to a unique same-directory temp file, then rename
 * over `path`. Same-directory is required so the rename stays on one filesystem (atomic).
 * A trailing newline is added for friendlier diffs. NO writer lock is taken — atomicity
 * comes from rename, not from locking, so concurrent readers are never blocked.
 */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

/** Parse JSON, raising a recoverable CorpusReadError (never a raw SyntaxError) on failure. */
function parseOrThrow(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CorpusReadError(`corpus file is not valid JSON: ${path}`, path, "corrupt", {
      cause: err,
    });
  }
}

/**
 * Locate the package-root corpus.schema.json by walking up from this module (works in both the
 * src/ layout under tsx and the built dist/ layout, like prompts.ts does for prompts/). Cached.
 */
let corpusSchemaValidator: ValidateFunction | undefined;
let corpusSchemaValidatorTried = false;

async function findSchemaFile(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "corpus.schema.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* not here; go up one level */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Compile (once, cached) the Ajv validator for the published corpus.schema.json. If the schema file
 * cannot be located (e.g. an unusual packaging layout), validation is skipped rather than turning a
 * deployment quirk into a hard read failure — the lighter inline type checks in loadCorpus still run.
 */
async function getCorpusValidator(): Promise<ValidateFunction | undefined> {
  if (corpusSchemaValidatorTried) return corpusSchemaValidator;
  corpusSchemaValidatorTried = true;
  const schemaPath = await findSchemaFile();
  if (!schemaPath) return undefined;
  try {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    corpusSchemaValidator = ajv.compile(schema);
  } catch {
    corpusSchemaValidator = undefined;
  }
  return corpusSchemaValidator;
}

/**
 * Load the hot file.
 *  - missing OR empty/whitespace-only -> a fresh emptyCorpus(now) (cold start, no throw).
 *  - corrupt JSON or non-object -> CorpusReadError(kind:"corrupt").
 *  - schemaVersion !== SCHEMA_VERSION -> CorpusReadError(kind:"schema").
 * Takes NO lock.
 */
export async function loadCorpus(path: string, now: string = new Date().toISOString()): Promise<Corpus> {
  const text = await readTextOrUndefined(path);
  if (text === undefined || text.trim() === "") return emptyCorpus(now);
  const parsed = parseOrThrow(text, path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorpusReadError(`corpus file is not an object: ${path}`, path, "corrupt");
  }
  const c = parsed as Partial<Corpus>;
  if (c.schemaVersion !== SCHEMA_VERSION) {
    throw new CorpusReadError(
      `corpus schemaVersion ${String(c.schemaVersion)} != supported ${SCHEMA_VERSION}: ${path}`,
      path,
      "schema",
    );
  }
  // Coerce to a well-formed corpus, defaulting any absent top-level collection so consumers never
  // hit undefined on a structurally-valid-but-sparse file. The ELEMENT shapes (clusters, answers,
  // protocols, sources) are kept as-is and validated below.
  const coerced: Corpus = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: typeof c.generatedAt === "string" ? c.generatedAt : now,
    sources: Array.isArray(c.sources) ? c.sources : [],
    clusters: Array.isArray(c.clusters) ? c.clusters : [],
    aliases: c.aliases && typeof c.aliases === "object" ? c.aliases : {},
    protocols: Array.isArray(c.protocols) ? c.protocols : [],
    // themes is optional for backward-compat with pre-themes corpora — default to [] when absent.
    themes: Array.isArray(c.themes) ? c.themes : [],
  };

  // Hardening (P3): validate the coerced corpus against the published JSON Schema so a malformed
  // ELEMENT shape (a cluster missing required fields, a wrong-typed count, a bad protocol, etc.) is
  // surfaced as a recoverable corrupt error instead of loading silently and corrupting downstream
  // logic. Top-level collections are already defaulted above, so only genuine element-shape drift
  // trips this. If the schema file can't be located, validation is skipped (see getCorpusValidator).
  const validate = await getCorpusValidator();
  if (validate && !validate(coerced)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
      .slice(0, 5)
      .join("; ");
    throw new CorpusReadError(
      `corpus failed schema validation (malformed element shape): ${path}${detail ? ` — ${detail}` : ""}`,
      path,
      "corrupt",
    );
  }

  return coerced;
}

/**
 * Load the evidence sidecar.
 *  - missing OR empty/whitespace-only -> emptyEvidenceStore() (no throw).
 *  - corrupt JSON or non-object -> CorpusReadError(kind:"corrupt").
 *  - schemaVersion mismatch -> CorpusReadError(kind:"schema").
 * Takes NO lock.
 */
export async function loadEvidence(path: string): Promise<EvidenceStore> {
  const text = await readTextOrUndefined(path);
  if (text === undefined || text.trim() === "") return emptyEvidenceStore();
  const parsed = parseOrThrow(text, path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorpusReadError(`evidence file is not an object: ${path}`, path, "corrupt");
  }
  const e = parsed as Partial<EvidenceStore>;
  if (e.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new CorpusReadError(
      `evidence schemaVersion ${String(e.schemaVersion)} != supported ${EVIDENCE_SCHEMA_VERSION}: ${path}`,
      path,
      "schema",
    );
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    items: e.items && typeof e.items === "object" ? e.items : {},
  };
}

/**
 * Persist the hot file atomically. Stamps generatedAt. The serialized shape carries NO
 * snippets by construction (Cluster has evidenceIds, not snippets); serializeCorpus() is the
 * single choke point so the privacy invariant is enforceable in one place.
 */
export async function saveCorpus(
  path: string,
  corpus: Corpus,
  now: string = new Date().toISOString(),
): Promise<void> {
  await atomicWriteJson(path, serializeCorpus(corpus, now));
}

/** Persist the evidence sidecar atomically. */
export async function saveEvidence(path: string, evidence: EvidenceStore): Promise<void> {
  await atomicWriteJson(path, evidence);
}

/**
 * The single serialization choke point for the hot file. Returns a plain object that, by
 * construction, contains only evidence-FREE fields — it strips any stray `snippet`/`evidence`
 * keys that a malformed Cluster might carry, so the portable hot file can never leak a raw
 * transcript snippet even if an upstream bug attached one to a cluster. Answer/summary text
 * remain the caller's responsibility to keep snippet-free (documented in SPEC.md).
 */
export function serializeCorpus(corpus: Corpus, now: string = corpus.generatedAt): Corpus {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    sources: corpus.sources.map((s) => ({ ...s })),
    clusters: corpus.clusters.map((c) => ({
      clusterId: c.clusterId,
      detector: c.detector,
      normalizedSubject: c.normalizedSubject,
      summary: c.summary,
      ...(c.primaryKind !== undefined ? { primaryKind: c.primaryKind } : {}),
      ...(c.secondaryKind !== undefined ? { secondaryKind: c.secondaryKind } : {}),
      count: c.count,
      sessionCount: c.sessionCount,
      // Deep-copy the evidenceIds + answers so the serialized object never shares array/object
      // references with the live corpus (a mutation of one must not silently mutate the other).
      evidenceIds: c.evidenceIds.slice(),
      ...(c.question !== undefined ? { question: c.question } : {}),
      ...(c.merged === true ? { merged: true } : {}),
      // Pending-question state survives the save/load round-trip (cross-session re-surfacing).
      // Deep-copied so the serialized object shares no reference with the live cluster.
      ...(c.pending !== undefined ? { pending: { ...c.pending } } : {}),
      ...(c.firstSeen !== undefined ? { firstSeen: c.firstSeen } : {}),
      ...(c.lastActivityAt !== undefined ? { lastActivityAt: c.lastActivityAt } : {}),
      // Relational FACTS (T7): COUNTS + TIMESTAMPS only — PRIVACY-CLEAN by construction (no raw
      // cwd/gitBranch paths). Deep-copied so the serialized object shares no reference with the
      // live cluster. Omitted on clusters with no relational facts (pre-relational / empty).
      ...(c.relational !== undefined ? { relational: { ...c.relational } } : {}),
      answers: c.answers.map((a) => ({ ...a })),
    })),
    aliases: { ...corpus.aliases },
    protocols: corpus.protocols.map((p) => ({
      ...p,
      openContradictions: p.openContradictions.slice(),
      supportingClusterIds: p.supportingClusterIds.slice(),
    })),
    // Themes (Tier 2) are EVIDENCE-FREE by construction: we project ONLY the allowed fields
    // (memberClusterIds + answers + pending + timestamps), deep-copied so the serialized object
    // shares no reference with the live theme — the same privacy/aliasing discipline as clusters.
    themes: corpus.themes.map((t) => ({
      themeId: t.themeId,
      name: t.name,
      memberClusterIds: t.memberClusterIds.slice(),
      answers: t.answers.map((a) => ({ ...a })),
      ...(t.pending !== undefined ? { pending: { ...t.pending } } : {}),
      firstSeen: t.firstSeen,
      lastActivityAt: t.lastActivityAt,
    })),
  };
}
