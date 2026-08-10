// The optional HTTP face of `skillhost`, for adding a repo from a phone.
//
// It wraps the same functions the CLI calls — no second code path, so the URL and name checks in
// host-plan.mjs cannot be bypassed by coming in this way instead.
//
// Two things about the threat model, stated here because they change what this file has to do:
//
//  1. It binds loopback, and on THIS box loopback is not a boundary. Every Claude session running
//     here is the same uid and can reach this port. So the guards below are not only about the
//     internet — they are about a session that has been talked into calling us.
//  2. Success means "a repo was registered", and a registered repo runs its own code on this box.
//     That is the product working as intended, which is exactly why the ownership check in
//     host-plan.mjs is not optional and cannot be turned off from here.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, validateHookName } from "./host-plan.mjs";

// A registration body is a URL and two short strings. Anything larger is either a mistake or an
// attempt to make us hold it in memory.
const MAX_BODY_BYTES = 8 * 1024;

// How long a caller is locked out after repeated bad tokens, and how many misses it takes.
const LOCKOUT_MS = 60_000;
const LOCKOUT_AFTER = 5;

/** Constant-time compare that does not throw on a length mismatch, and does not leak the length. */
export function tokensMatch(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths, so compare a fixed-size digest of each instead of
  // returning early on length — an early return is itself a timing signal.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure costs the same as a wrong-but-same-length token.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Build the server. `host` is a createHost() result; `now` is injectable so lockout can be tested
 * without waiting a minute.
 */
export function createServer({ host, configText, token, now = () => Date.now(), log = () => {} }) {
  const loaded = loadConfig(configText);
  if (!loaded.ok) throw new Error(loaded.reason);
  const config = loaded.config;

  const misses = new Map(); // remote address -> { count, until }

  const send = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      // Nothing here should ever be framed, embedded, or sniffed into something else.
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(payload);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // Destroy rather than respond: a client streaming megabytes is not owed a polite reply.
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const from = req.socket.remoteAddress ?? "unknown";
    try {
      // Host header check. If this port is ever forwarded or proxied, a browser on another site
      // must not be able to drive it by resolving a name to 127.0.0.1.
      const hostHeader = String(req.headers.host ?? "").split(":")[0];
      if (hostHeader && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostHeader)) {
        return send(res, 421, { error: "wrong host" });
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;

      // Unauthenticated, and deliberately says nothing a stranger could use.
      if (route === "GET /status") return send(res, 200, { ok: true, service: "skillhost" });

      const locked = misses.get(from);
      if (locked && locked.until > now()) return send(res, 429, { error: "too many attempts" });

      const auth = String(req.headers.authorization ?? "");
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!tokensMatch(supplied, token)) {
        const next = { count: (locked?.count ?? 0) + 1, until: 0 };
        if (next.count >= LOCKOUT_AFTER) next.until = now() + LOCKOUT_MS;
        misses.set(from, next);
        // Never echo what was supplied, and never accept a token from the query string: both end up
        // in logs, and this one is a key to running code on the box.
        host.appendLog("auth.reject", { from, route });
        return send(res, 401, { error: "unauthorized" });
      }
      misses.delete(from);

      if (route === "GET /repos") {
        return send(res, 200, { repos: host.listRepos({ config }) });
      }

      if (route === "GET /sessions") {
        return send(res, 200, { sessions: host.listSessions({ config }) });
      }

      // The one that matters from a phone: make a worktree, run the bootstrap to completion, start
      // Claude. It returns only once the unit is up, so a 201 means the tree really was prepared.
      if (route === "POST /sessions") {
        if (!/^application\/json/.test(String(req.headers["content-type"] ?? ""))) {
          return send(res, 415, { error: "send application/json" });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return send(res, 400, { error: "body was not valid JSON" });
        }
        if (!body.repo) return send(res, 400, { error: "which repo?" });
        const result = host.startSession({ repo: String(body.repo), task: String(body.task ?? ""), config });
        if (!result.ok) {
          // At capacity is a 429 rather than a 400: the request was fine, the box is full.
          const status = result.atCapacity ? 429 : 400;
          return send(res, status, { error: result.reason, log: result.diagnose?.log ?? null });
        }
        return send(res, 201, {
          id: result.id,
          repo: result.repo,
          worktree: result.worktree,
          branch: result.branch,
          note: "open the Claude app — this session is in your list, with the bootstrap already run",
        });
      }

      if (route === "POST /repos") {
        if (!/^application\/json/.test(String(req.headers["content-type"] ?? ""))) {
          // Also blocks the form-encoded POST a browser can make without a preflight.
          return send(res, 415, { error: "send application/json" });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return send(res, 400, { error: "body was not valid JSON" });
        }
        if (body.hook !== undefined) {
          const checked = validateHookName(body.hook, host.availableHooks?.() ?? []);
          if (!checked.ok) return send(res, 400, { error: checked.reason });
        }
        const result = host.addRepo({
          url: body.url,
          name: body.name ?? null,
          hook: body.hook ?? null,
          config,
          // Trust still has to be asked for explicitly, and still only helps if ownership allows it.
          trustOverride: body.trust === true ? true : null,
        });
        if (!result.ok) return send(res, result.conflict ? 409 : 400, { error: result.reason });
        return send(res, result.trusted ? 201 : 202, {
          name: result.name,
          trusted: result.trusted,
          reason: result.trust?.reason,
          next: result.next ?? null,
          // Registering a repo starts nothing, and says so rather than implying a session exists.
          note: result.trusted
            ? "registered — POST /sessions to start working in it"
            : "cloned, not trusted, so nothing may run in it yet",
        });
      }

      // Re-validated on every route, against the decoded value. A session id arriving in a URL
      // path has never been through the checks that run on a POST body.
      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        if (req.method === "DELETE") {
          const result = host.endSession({ id, config, purge: url.searchParams.get("purge") === "1" });
          return result.ok ? send(res, 200, result) : send(res, 400, { error: result.reason });
        }
        return send(res, 405, { error: "method not allowed" });
      }

      const repoMatch = /^\/repos\/([^/]+)$/.exec(url.pathname);
      if (repoMatch) {
        const name = decodeURIComponent(repoMatch[1]);
        if (req.method === "DELETE") {
          const result = host.removeRepo({ name, config, purge: url.searchParams.get("purge") === "1" });
          return result.ok ? send(res, 200, result) : send(res, 400, { error: result.reason });
        }
        if (req.method === "POST" && url.searchParams.has("trust")) {
          const result = host.trustRepo({ name, config });
          return result.ok ? send(res, 200, result) : send(res, 400, { error: result.reason });
        }
        return send(res, 405, { error: "method not allowed" });
      }

      return send(res, 404, { error: "no such route" });
    } catch (err) {
      const status = err?.status ?? 500;
      log(`skillhost: ${err?.message ?? err}`);
      // One malformed request must never take down the process that owns every repo on the box.
      if (!res.headersSent) send(res, status, { error: status === 413 ? "body too large" : "server error" });
    }
  });

  // Slow-loris protection, and a bound on how long a half-open socket can sit there.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return { server, config };
}
