#!/usr/bin/env node
/**
 * debrief CLI entry point.
 *
 * The CLI does deterministic STRUCTURAL work only; intent/question generation is the connected
 * LLM's job (see prompts/ and the design doc CORE PRINCIPLE).
 *
 * Two layers:
 *  - INGEST + SERVE: extract / corpus / show / serve.
 *  - SKILL-FRIENDLY READ/WRITE wrappers around the SAME pure handlers the MCP server uses (no logic
 *    duplication): patterns / evidence / ask / answer / themes / grouping-task / group / ungroup /
 *    merge / add-alias / set-kind / pending / skip / record-protocol / export-rules. Each prints
 *    JSON to stdout so a skill can parse it from bash.
 *
 * ZERO-CONFIG: every command that needs a corpus resolves it with NO path required —
 *   default  = the CURRENT PROJECT's corpus (~/.debrief/projects/<slug>/corpus.json),
 *   --global = the cross-project roll-up   (~/.debrief/global/corpus.json).
 * An explicit positional path (back-compat) or `--corpus <path>` always overrides.
 */
import { candidatesFromFile, type Candidate } from "./extract/candidates.js";
import { makeEvidenceItem, coarseSubject } from "./corpus/identity.js";
import {
  loadCorpus,
  loadEvidence,
  saveCorpus,
  saveEvidence,
  CorpusReadError,
} from "./corpus/store.js";
import { mergeCandidates } from "./corpus/merge.js";
import type { CandidateCluster, Corpus } from "./corpus/types.js";
import { startServer, evidencePathFor } from "./mcp/server.js";
import { loadReturnInstructions, loadGroupThemesInstruction } from "./mcp/prompts.js";
import {
  getPatterns,
  getEvidence,
  getThemeEvidence,
  answerOpenQuestion,
  submitAnswer,
  mergeClusters,
  addAlias,
  groupTheme,
  ungroupTheme,
  setClusterKind,
  skipQuestion,
  recordProtocol,
  exportRulesFile,
  getThemes,
  getPendingQuestions,
  getGroupingTask,
  type AnswerMode,
  type AnsweredByFilter,
} from "./mcp/handlers.js";
import type { Kind } from "./corpus/types.js";
import { discoverSessions, resolveCorpusPath } from "./discover.js";

const [, , cmd, ...rest] = process.argv;

// ── tiny flag parser ──────────────────────────────────────────────────────────────────────────
// VALUE flags consume the next token; BOOL flags stand alone; everything else is positional.
const VALUE_FLAGS = new Set([
  "--corpus",
  "--mode",
  "--source",
  "--confidence",
  "--secondary",
  "--limit",
  "--detector",
  "--min-count",
  "--answered-by",
]);
const BOOL_FLAGS = new Set(["--global", "--confirmed", "--answered", "--unanswered"]);

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // End-of-options sentinel: everything after a bare `--` is a positional, so verbatim user
      // text (answer/group name/record-protocol) that begins with `--` is passed through safely.
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (VALUE_FLAGS.has(a)) {
      flags[a.slice(2)] = args[++i] ?? "";
    } else if (BOOL_FLAGS.has(a)) {
      flags[a.slice(2)] = true;
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true; // unknown long flag → boolean
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function str(flags: Parsed["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Resolve the corpus path with zero-config defaults; an explicit positional/flag overrides.
 * `read` = true resolves WITHOUT creating the per-project dir (a pure read shouldn't mint state).
 */
async function resolveCorpus(
  flags: Parsed["flags"],
  explicit?: string,
  read = false,
): Promise<string> {
  if (explicit) return explicit;
  // A `--corpus` with no following path (e.g. trailing `--corpus`) parses to "" — treat that as a
  // mistake and fail loudly rather than silently falling through to the zero-config corpus.
  if ("corpus" in flags && str(flags, "corpus") === "") {
    throw new Error("--corpus needs a path (omit --corpus entirely to use the zero-config corpus)");
  }
  const override = str(flags, "corpus");
  if (override) return override;
  return resolveCorpusPath({ global: flags.global === true, ...(read ? { create: false } : {}) });
}

/** Load the corpus at the resolved path, returning the path + evidence sidecar path too. */
async function loadAtResolved(
  flags: Parsed["flags"],
  explicit?: string,
  read = false,
): Promise<{ corpusPath: string; evidencePath: string; corpus: Corpus }> {
  const corpusPath = await resolveCorpus(flags, explicit, read);
  const evidencePath = evidencePathFor(corpusPath);
  const corpus = await loadCorpus(corpusPath);
  return { corpusPath, evidencePath, corpus };
}

/** Is `id` a clusterId or a themeId in this corpus? (clusterId wins if somehow both.) */
function idKind(corpus: Corpus, id: string): "cluster" | "theme" | "unknown" {
  if (corpus.clusters.some((c) => c.clusterId === id)) return "cluster";
  if (corpus.themes.some((t) => t.themeId === id)) return "theme";
  return "unknown";
}

/**
 * Map structural candidates to candidate clusters. STRUCTURAL ONLY -- it does NOT decide
 * whether a turn is a correction or what it is "about"; that is the connected LLM's job
 * (CORE PRINCIPLE). The bucket key is the structural detector label + the deterministic
 * coarse `normalizeSubject` (eng decision 5): a coarse normalized label (NFKC-fold,
 * lowercase, strip punctuation, collapse whitespace), NOT a per-turn content hash.
 *
 * normalizedSubject is a BOUNDED coarse hot-file LABEL by design (coarseSubject: normalize + cap
 * to the first MAX_SUBJECT_TOKENS tokens), NOT the whole turn and NOT a raw verbatim snippet. The
 * cap is the privacy bound. The raw turn text still goes ONLY into the sidecar snippet
 * (makeEvidenceItem below); the hot file gets only the bounded label. The connected agent later
 * refines / semantically merges subjects via the alias map.
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
    const normalizedSubject = coarseSubject(c.turn.text);
    const key = detector + " " + normalizedSubject;
    let bucket = byKey.get(key);
    if (!bucket) {
      const summary = "structural candidate (" + detector + ")";
      bucket = { detector, normalizedSubject, summary, count: 0, sessionCount: 0, evidence: [] };
      byKey.set(key, bucket);
    }
    bucket.evidence.push(
      makeEvidenceItem({
        sessionId: c.turn.sessionId ?? "unknown-session",
        ts: c.turn.timestamp,
        cwd: c.turn.cwd,
        gitBranch: c.turn.gitBranch,
        snippet: c.turn.text,
      }),
    );
    bucket.count = bucket.evidence.length;
  }
  return [...byKey.values()];
}

/** Merge one session file into an already-loaded corpus/evidence pair. Returns the merge stats. */
async function mergeSessionInto(
  corpus: Corpus,
  evidence: Awaited<ReturnType<typeof loadEvidence>>,
  sessionPath: string,
): Promise<{ clusters: number; clustersTouched: number; clustersCreated: number; evidenceAdded: number }> {
  const cands = await candidatesFromFile(sessionPath);
  const clusters = candidatesToClusters(cands);
  const r = mergeCandidates(corpus, evidence, clusters);
  return {
    clusters: clusters.length,
    clustersTouched: r.clustersTouched,
    clustersCreated: r.clustersCreated,
    evidenceAdded: r.evidenceAdded,
  };
}

async function main(): Promise<void> {
  switch (cmd) {
    case "extract": {
      const { positionals } = parseArgs(rest);
      const file = positionals[0];
      if (!file) {
        console.error("usage: debrief extract <session.jsonl>");
        process.exitCode = 1;
        return;
      }
      const cands = await candidatesFromFile(file);
      const tool = cands.filter((c) => c.precededByToolUse).length;
      const err = cands.filter((c) => c.precededByError).length;
      console.log(`structural candidates: ${cands.length}`);
      console.log(`  preceded by tool_use: ${tool} | preceded by tool error: ${err}`);
      console.log("(intent classification + question generation are the LLM's job — not done here)");
      return;
    }

    case "corpus": {
      const { positionals, flags } = parseArgs(rest);
      // BACK-COMPAT single-session form: `debrief corpus <session.jsonl> [corpus.json]`.
      if (positionals.length >= 1) {
        const sessionPath = positionals[0];
        const corpusPath = await resolveCorpus(flags, positionals[1]);
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
        const s = await mergeSessionInto(corpus, evidence, sessionPath);
        await saveEvidence(evidencePath, evidence);
        await saveCorpus(corpusPath, corpus);
        console.log(`merged ${s.clusters} candidate clusters into ${corpusPath}`);
        console.log(`  clusters touched: ${s.clustersTouched} (created ${s.clustersCreated}), evidence added: ${s.evidenceAdded}`);
        console.log(`  hot file: ${corpusPath} (evidence-free) | sidecar: ${evidencePath}`);
        return;
      }

      // ZERO-CONFIG discovery: no session arg → discover this project's sessions (or --global) and
      // merge ALL of them into the resolved corpus.
      const corpusPath = await resolveCorpus(flags);
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
      const scope = flags.global === true ? "global (all projects)" : "current project";
      const sessions = await discoverSessions({ global: flags.global === true });
      console.log(`discovered ${sessions.length} session(s) for ${scope}`);
      let totalClusters = 0, totalEvidence = 0, totalCreated = 0;
      for (const sessionPath of sessions) {
        const s = await mergeSessionInto(corpus, evidence, sessionPath);
        totalClusters += s.clusters;
        totalEvidence += s.evidenceAdded;
        totalCreated += s.clustersCreated;
      }
      await saveEvidence(evidencePath, evidence);
      await saveCorpus(corpusPath, corpus);
      console.log(`merged ${totalClusters} candidate clusters (created ${totalCreated}, evidence added ${totalEvidence})`);
      console.log(`  hot file: ${corpusPath} (evidence-free) | sidecar: ${evidencePath}`);
      return;
    }

    case "show": {
      const { positionals, flags } = parseArgs(rest);
      const corpusPath = await resolveCorpus(flags, positionals[0], true);
      const corpus = await loadCorpus(corpusPath);
      console.log(`corpus ${corpusPath} (schemaVersion ${corpus.schemaVersion}, generated ${corpus.generatedAt})`);
      console.log(`  clusters: ${corpus.clusters.length} | themes: ${corpus.themes.length} | aliases: ${Object.keys(corpus.aliases).length} | protocols: ${corpus.protocols.length}`);
      for (const c of corpus.clusters.slice(0, 20)) {
        console.log(`  - [${c.detector}] ${c.normalizedSubject} (count ${c.count}, sessions ${c.sessionCount}, answers ${c.answers.length})`);
      }
      return;
    }

    case "serve":
    case "mcp": {
      // Start the MCP stdio server. It speaks JSON-RPC on stdout, so nothing else may print there;
      // keep startup chatter on stderr only. The process stays alive on the transport.
      const { positionals, flags } = parseArgs(rest);
      const corpusPath = await resolveCorpus(flags, positionals[0]);
      console.error(`debrief MCP server starting (corpus: ${corpusPath}, sidecar: ${evidencePathFor(corpusPath)})`);
      await startServer(corpusPath);
      return;
    }

    // ── SKILL-FRIENDLY handler wrappers (JSON to stdout) ──────────────────────────────────────

    case "patterns": {
      const { flags } = parseArgs(rest);
      const { corpus } = await loadAtResolved(flags, undefined, true);
      const limit = str(flags, "limit");
      const minCount = str(flags, "min-count");
      const answeredBy = str(flags, "answered-by");
      printJson(
        getPatterns(corpus, {
          ...(str(flags, "detector") !== undefined ? { detector: str(flags, "detector") } : {}),
          ...(flags.answered === true ? { answered: true } : {}),
          ...(flags.unanswered === true ? { answered: false } : {}),
          ...(answeredBy !== undefined ? { answeredBy: answeredBy as AnsweredByFilter } : {}),
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
          ...(minCount !== undefined ? { minCount: Number(minCount) } : {}),
        }),
      );
      return;
    }

    case "themes": {
      const { flags } = parseArgs(rest);
      const { corpus } = await loadAtResolved(flags, undefined, true);
      const limit = str(flags, "limit");
      printJson(getThemes(corpus, { ...(limit !== undefined ? { limit: Number(limit) } : {}) }));
      return;
    }

    case "evidence": {
      const { positionals, flags } = parseArgs(rest);
      const id = positionals[0];
      if (!id) {
        console.error("usage: debrief evidence <clusterId|themeId>");
        process.exitCode = 1;
        return;
      }
      const { corpus, evidencePath } = await loadAtResolved(flags, undefined, true);
      const evidence = await loadEvidence(evidencePath);
      const kind = idKind(corpus, id);
      const bundle =
        kind === "theme"
          ? getThemeEvidence(corpus, evidence, id)
          : getEvidence(corpus, evidence, id);
      if (!bundle) {
        console.error(`no cluster or theme ${id}`);
        process.exitCode = 1;
        return;
      }
      printJson(bundle);
      return;
    }

    case "ask": {
      const { positionals, flags } = parseArgs(rest);
      const id = positionals[0];
      if (!id) {
        console.error("usage: debrief ask <clusterId|themeId> [--mode self|user]");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath, evidencePath } = await loadAtResolved(flags);
      const evidence = await loadEvidence(evidencePath);
      const instructions = await loadReturnInstructions();
      const mode = (str(flags, "mode") as AnswerMode | undefined) ?? "none";
      const kind = idKind(corpus, id);
      const args = kind === "theme" ? { themeId: id, mode } : { clusterId: id, mode };
      const res = answerOpenQuestion(corpus, evidence, instructions, args);
      if (!res) {
        console.error(`no cluster or theme ${id}`);
        process.exitCode = 1;
        return;
      }
      if (mode === "user") await saveCorpus(corpusPath, corpus); // forward marks the target pending
      printJson(res);
      return;
    }

    case "answer": {
      const { positionals, flags } = parseArgs(rest);
      const id = positionals[0];
      const text = positionals[1];
      if (!id || text === undefined) {
        console.error('usage: debrief answer <clusterId|themeId> "<text>" [--source user --confirmed]');
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const kind = idKind(corpus, id);
      const source = str(flags, "source") === "user" ? "user" : str(flags, "source") === "inferred" ? "inferred" : undefined;
      const res = submitAnswer(corpus, {
        ...(kind === "theme" ? { themeId: id } : { clusterId: id }),
        text,
        ...(source !== undefined ? { source } : {}),
        ...(flags.confirmed === true ? { confirmed: true } : {}),
      });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "grouping-task": {
      const { flags } = parseArgs(rest);
      const { corpus } = await loadAtResolved(flags, undefined, true);
      const groupThemesInstruction = await loadGroupThemesInstruction();
      const limit = str(flags, "limit");
      printJson(
        getGroupingTask(corpus, groupThemesInstruction, {
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
        }),
      );
      return;
    }

    case "group": {
      const { positionals, flags } = parseArgs(rest);
      const name = positionals[0];
      const clusterIds = positionals.slice(1);
      if (!name || clusterIds.length === 0) {
        console.error("usage: debrief group <name> <clusterId...>");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const res = groupTheme(corpus, { name, clusterIds });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "ungroup": {
      const { positionals, flags } = parseArgs(rest);
      const themeId = positionals[0];
      const clusterIds = positionals.slice(1);
      if (!themeId || clusterIds.length === 0) {
        console.error("usage: debrief ungroup <themeId> <clusterId...>");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const res = ungroupTheme(corpus, { themeId, clusterIds });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "merge": {
      const { positionals, flags } = parseArgs(rest);
      const fromClusterId = positionals[0];
      const intoClusterId = positionals[1];
      if (!fromClusterId || !intoClusterId) {
        console.error("usage: debrief merge <fromClusterId> <intoClusterId>");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath, evidencePath } = await loadAtResolved(flags);
      const evidence = await loadEvidence(evidencePath);
      const res = mergeClusters(corpus, evidence, { fromClusterId, intoClusterId });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "add-alias": {
      const { positionals, flags } = parseArgs(rest);
      const normalizedSubject = positionals[0];
      const clusterId = positionals[1];
      if (!normalizedSubject || !clusterId) {
        console.error("usage: debrief add-alias <normalizedSubject> <clusterId>");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const res = addAlias(corpus, { normalizedSubject, clusterId });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "set-kind": {
      const { positionals, flags } = parseArgs(rest);
      const clusterId = positionals[0];
      const primary = positionals[1] as Kind | undefined;
      const secondary = positionals[2] as Kind | undefined;
      if (!clusterId || !primary) {
        console.error("usage: debrief set-kind <clusterId> <R|O|C|Q|X> [secondary]");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const res = setClusterKind(corpus, {
        clusterId,
        primary,
        ...(secondary !== undefined ? { secondary } : {}),
      });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "pending": {
      const { flags } = parseArgs(rest);
      const { corpus } = await loadAtResolved(flags, undefined, true);
      const limit = str(flags, "limit");
      printJson(getPendingQuestions(corpus, { ...(limit !== undefined ? { limit: Number(limit) } : {}) }));
      return;
    }

    case "skip": {
      const { positionals, flags } = parseArgs(rest);
      const id = positionals[0];
      if (!id) {
        console.error("usage: debrief skip <clusterId|themeId>");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const kind = idKind(corpus, id);
      const res = skipQuestion(corpus, kind === "theme" ? { themeId: id } : { clusterId: id });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "record-protocol": {
      const { positionals, flags } = parseArgs(rest);
      const statement = positionals[0];
      if (!statement) {
        console.error("usage: debrief record-protocol <statement> [--confidence 0.0-1.0]");
        process.exitCode = 1;
        return;
      }
      const { corpus, corpusPath } = await loadAtResolved(flags);
      const confidence = str(flags, "confidence");
      const res = recordProtocol(corpus, {
        statement,
        confidence: confidence !== undefined ? Number(confidence) : 0.5,
      });
      await saveCorpus(corpusPath, corpus);
      printJson(res);
      return;
    }

    case "export-rules": {
      const { flags } = parseArgs(rest);
      const { corpus } = await loadAtResolved(flags, undefined, true);
      printJson(exportRulesFile(corpus));
      return;
    }

    case "version":
    case undefined:
      console.log("debrief 0.0.0");
      console.log("ingest:  extract <file> | corpus [session.jsonl] [corpus.json] [--global] | show [--global] | serve [--global] (alias: mcp)");
      console.log("read:    patterns [--answered-by user|inferred|none] | themes | evidence <id> | pending | grouping-task | export-rules");
      console.log("write:   ask <id> [--mode self|user] | answer <id> <text> [--source user --confirmed] | group <name> <ids...> |");
      console.log("         ungroup <themeId> <ids...> | merge <from> <into> | add-alias <subject> <id> | set-kind <id> <kind> | skip <id> | record-protocol <stmt>");
      console.log("zero-config: omit paths to use the current project's corpus; --global for the cross-project roll-up; --corpus <path> to override.");
      console.log("free text:   use `--` before verbatim answer/group/protocol text that begins with `--`, e.g. answer <id> -- \"--maybe\".");
      return;

    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof CorpusReadError) {
    console.error(`corpus read error (${err.kind}): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  // Print a clean one-line message (not the whole Error + stack) so skill consumers parsing
  // stderr get a friendly message, consistent with the per-command usage errors above.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
