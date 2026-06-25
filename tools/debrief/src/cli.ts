#!/usr/bin/env node
/**
 * debrief CLI entry point.
 * The CLI does deterministic STRUCTURAL work only; intent/question generation is the
 * connected LLM's job (see prompts/ and the design doc CORE PRINCIPLE).
 *
 * Subcommands:
 *   extract <session.jsonl>                 structural candidate stats (no store write)
 *   corpus  <session.jsonl> [corpus.json]   merge structural candidates into the corpus
 *                                           (hot file + evidence sidecar), atomic write
 *   show    [corpus.json]                   print the evidence-free hot file summary
 *   serve   [corpus.json]                   start the MCP stdio server (alias: mcp)
 */
import { candidatesFromFile, type Candidate } from "./extract/candidates.js";
import { makeEvidenceItem, coarseSubject } from "./corpus/identity.js";
import { loadCorpus, loadEvidence, saveCorpus, saveEvidence, CorpusReadError } from "./corpus/store.js";
import { mergeCandidates } from "./corpus/merge.js";
import type { CandidateCluster } from "./corpus/types.js";
import { startServer, evidencePathFor } from "./mcp/server.js";

const [, , cmd, arg1, arg2] = process.argv;

const DEFAULT_CORPUS = "corpus.json";

/**
 * Map structural candidates to candidate clusters. STRUCTURAL ONLY -- it does NOT decide
 * whether a turn is a correction or what it is "about"; that is the connected LLM's job
 * (CORE PRINCIPLE). The bucket key is the structural detector label + the deterministic
 * coarse `normalizeSubject` (eng decision 5): a coarse normalized label (NFKC-fold,
 * lowercase, strip punctuation, collapse whitespace), NOT a per-turn content hash. Using a
 * content hash gave every turn its own singleton bucket, so count/sessionCount were always
 * 1 and clustering never happened. The coarse label lands turns that differ only in
 * case/whitespace/punctuation in ONE cluster, restoring meaningful counts.
 *
 * normalizedSubject is a BOUNDED coarse hot-file LABEL by design (coarseSubject: normalize + cap
 * to the first MAX_SUBJECT_TOKENS tokens), NOT the whole turn and NOT a raw verbatim snippet. The
 * cap is the privacy bound — without it the entire user message (and any typed absolute path, with
 * slashes folded to spaces) would be copied onto the supposedly snippet-free surface. The raw turn
 * text still goes ONLY into the sidecar snippet (makeEvidenceItem below); the hot file gets only the
 * bounded label. Note: the label is derived from prose, so it is NOT counts-only — see coarseSubject.
 * The connected agent later refines / semantically merges subjects via the alias map.
 */
function candidatesToClusters(cands: Candidate[]): CandidateCluster[] {
  const byKey = new Map<string, CandidateCluster>();
  for (const c of cands) {
    const detector = c.precededByError
      ? "after-error"
      : c.precededByToolUse
        ? "turn-after-tool-use"
        : c.precededByAssistant
          ? "turn-after-completion"
          : "unprompted-turn";
    if (!c.turn.text.trim()) continue;
    // Bounded coarse deterministic subject label (capped to MAX_SUBJECT_TOKENS); raw prose stays in
    // the sidecar. The cap stops the whole turn (and typed absolute paths) leaking onto the hot file.
    const normalizedSubject = coarseSubject(c.turn.text);
    const key = detector + " " + normalizedSubject;
    let bucket = byKey.get(key);
    if (!bucket) {
      // Structural summary only -- the raw turn text is NOT placed in the hot file.
      const summary = "structural candidate (" + detector + ")";
      bucket = { detector, normalizedSubject, summary, count: 0, sessionCount: 0, evidence: [] };
      byKey.set(key, bucket);
    }
    bucket.evidence.push(
      makeEvidenceItem({
        sessionId: c.turn.sessionId ?? "unknown-session",
        ts: c.turn.timestamp,
        // cwd / gitBranch are captured onto the SIDECAR evidence item ONLY (they are
        // privacy-sensitive absolute paths / branch names). They never reach the hot file; the
        // hot file's relational facts carry only COUNTS derived from them (T7).
        cwd: c.turn.cwd,
        gitBranch: c.turn.gitBranch,
        snippet: c.turn.text,
      }),
    );
    bucket.count = bucket.evidence.length;
  }
  return [...byKey.values()];
}

async function main(): Promise<void> {
  switch (cmd) {
    case "extract": {
      if (!arg1) {
        console.error("usage: debrief extract <session.jsonl>");
        process.exitCode = 1;
        return;
      }
      const cands = await candidatesFromFile(arg1);
      const tool = cands.filter((c) => c.precededByToolUse).length;
      const err = cands.filter((c) => c.precededByError).length;
      console.log(`structural candidates: ${cands.length}`);
      console.log(`  preceded by tool_use: ${tool} | preceded by tool error: ${err}`);
      console.log("(intent classification + question generation are the LLM's job — not done here)");
      return;
    }
    case "corpus": {
      if (!arg1) {
        console.error("usage: debrief corpus <session.jsonl> [corpus.json]");
        process.exitCode = 1;
        return;
      }
      const corpusPath = arg2 ?? DEFAULT_CORPUS;
      const evidencePath = evidencePathFor(corpusPath);
      let corpus, evidence;
      try {
        corpus = await loadCorpus(corpusPath);
        evidence = await loadEvidence(evidencePath);
      } catch (err) {
        if (err instanceof CorpusReadError) {
          console.error(`corpus read error (${err.kind}): ${err.message}`);
          console.error("refusing to overwrite a corrupt/unknown corpus — back it up or remove it first.");
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const cands = await candidatesFromFile(arg1);
      const clusters = candidatesToClusters(cands);
      const r = mergeCandidates(corpus, evidence, clusters);
      // Evidence sidecar first, then the hot file: if interrupted between, the hot file's
      // evidenceIds may reference a not-yet-written snippet (tolerated by get_evidence).
      await saveEvidence(evidencePath, evidence);
      await saveCorpus(corpusPath, corpus);
      console.log(`merged ${clusters.length} candidate clusters into ${corpusPath}`);
      console.log(`  clusters touched: ${r.clustersTouched} (created ${r.clustersCreated}), evidence added: ${r.evidenceAdded}`);
      console.log(`  hot file: ${corpusPath} (evidence-free) | sidecar: ${evidencePath}`);
      return;
    }
    case "show": {
      const corpusPath = arg1 ?? DEFAULT_CORPUS;
      try {
        const corpus = await loadCorpus(corpusPath);
        console.log(`corpus ${corpusPath} (schemaVersion ${corpus.schemaVersion}, generated ${corpus.generatedAt})`);
        console.log(`  clusters: ${corpus.clusters.length} | aliases: ${Object.keys(corpus.aliases).length} | protocols: ${corpus.protocols.length}`);
        for (const c of corpus.clusters.slice(0, 20)) {
          console.log(`  - [${c.detector}] ${c.normalizedSubject} (count ${c.count}, sessions ${c.sessionCount}, answers ${c.answers.length})`);
        }
      } catch (err) {
        if (err instanceof CorpusReadError) {
          console.error(`corpus read error (${err.kind}): ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      return;
    }
    case "serve":
    case "mcp": {
      // Start the MCP stdio server. It speaks JSON-RPC on stdout, so nothing else may print there;
      // keep startup chatter on stderr only. The process stays alive on the transport.
      const corpusPath = arg1 ?? DEFAULT_CORPUS;
      console.error(`debrief MCP server starting (corpus: ${corpusPath}, sidecar: ${evidencePathFor(corpusPath)})`);
      await startServer(corpusPath);
      return;
    }
    case "version":
    case undefined:
      console.log("debrief 0.0.0");
      console.log("subcommands: extract <file> | corpus <file> [corpus.json] | show [corpus.json] | serve [corpus.json] (alias: mcp)");
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
