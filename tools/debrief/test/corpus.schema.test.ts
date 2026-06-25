import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { emptyCorpus, emptyEvidenceStore, type Corpus, type EvidenceStore } from "../src/corpus/types.ts";
import { mergeCandidates } from "../src/corpus/merge.ts";
import { submitAnswer } from "../src/corpus/access.ts";
import { serializeCorpus } from "../src/corpus/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const now = "2026-06-25T00:00:00.000Z";

async function loadSchema(name: string): Promise<object> {
  return JSON.parse(await readFile(join(root, name), "utf8"));
}

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

test("emptyCorpus() validates against corpus.schema.json", async () => {
  const ajv = makeAjv();
  const validate = ajv.compile(await loadSchema("corpus.schema.json"));
  const ok = validate(emptyCorpus(now));
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test("a populated, serialized corpus validates against corpus.schema.json (catches type/schema drift)", async () => {
  const ajv = makeAjv();
  const validate = ajv.compile(await loadSchema("corpus.schema.json"));

  const corpus: Corpus = emptyCorpus(now);
  corpus.sources = [{ kind: "claude-sessions", ref: "C:/Users/x/.claude/projects" }, { kind: "git" }];
  const evidence: EvidenceStore = emptyEvidenceStore();
  mergeCandidates(corpus, evidence, [
    {
      detector: "after-error",
      normalizedSubject: "rgb value",
      summary: "renamed acronym-style variable names",
      count: 0,
      sessionCount: 0,
      evidence: [
        { id: "s1:0-1", sessionId: "s1", ts: now, turnRange: [0, 1], snippet: "rename rgb to color" },
      ],
    },
  ]);
  submitAnswer(corpus, corpus.clusters[0].clusterId, "descriptive names", { confirmed: true, ts: now });
  corpus.protocols.push({
    protocolId: "p1",
    hypothesis: "prefers descriptive identifiers",
    confidence: 0.7,
    openContradictions: [],
    supportingClusterIds: [corpus.clusters[0].clusterId],
    updatedAt: now,
  });

  const serialized = serializeCorpus(corpus, now);
  const ok = validate(serialized);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test("a merged cluster (merged:true) validates against corpus.schema.json", async () => {
  const ajv = makeAjv();
  const validate = ajv.compile(await loadSchema("corpus.schema.json"));
  const corpus: Corpus = emptyCorpus(now);
  const evidence: EvidenceStore = emptyEvidenceStore();
  mergeCandidates(corpus, evidence, [
    { detector: "after-error", normalizedSubject: "rgb value", summary: "s", count: 0, sessionCount: 0, evidence: [] },
  ]);
  corpus.clusters[0].merged = true;
  const ok = validate(serializeCorpus(corpus, now));
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test("the evidence sidecar validates against corpus.evidence.schema.json", async () => {
  const ajv = makeAjv();
  const validate = ajv.compile(await loadSchema("corpus.evidence.schema.json"));
  const evidence = emptyEvidenceStore();
  evidence.items["s1:0-1"] = { id: "s1:0-1", sessionId: "s1", ts: now, turnRange: [0, 1], snippet: "hi" };
  const ok = validate(evidence);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test("schema REJECTS an unknown schemaVersion (const 1) — proves versioning is enforced", async () => {
  const ajv = makeAjv();
  const validate = ajv.compile(await loadSchema("corpus.schema.json"));
  const bad = { ...emptyCorpus(now), schemaVersion: 2 };
  assert.equal(validate(bad), false);
});
