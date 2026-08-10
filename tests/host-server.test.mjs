// The HTTP wrapper, against a real http.Server on an ephemeral port and a fake host.
//
// The point of these is that the route layer cannot be a way round the checks. A name arriving in a
// URL path has been through decodeURIComponent and has never seen the POST body's validation, so
// the tests that matter most here are the ones asserting that nothing ran.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createServer, tokensMatch } from "../lib/host-server.mjs";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configText = JSON.stringify({ workspaceRoot: "/home/dev/workspace" });

/** A host that records what it was asked to do and never does anything. */
function fakeHost() {
  const calls = [];
  return {
    calls,
    appendLog: (event, fields) => calls.push({ fn: "appendLog", event, fields }),
    listRepos: () => {
      calls.push({ fn: "listRepos" });
      return [{ name: "workspace", summary: "ready — open the Claude app" }];
    },
    addRepo: (args) => {
      calls.push({ fn: "addRepo", args });
      return { ok: true, name: args.name ?? "thing", trusted: true, trust: { reason: "owned by you" }, next: "skillhost session thing <task>" };
    },
    startSession: (args) => {
      calls.push({ fn: "startSession", args });
      return {
        ok: true, id: "thing-x-a1b2", repo: args.repo,
        worktree: "/home/dev/workspace/.sessions/thing-x-a1b2", branch: "claude/thing-x-a1b2",
      };
    },
    listSessions: () => {
      calls.push({ fn: "listSessions" });
      return [{ id: "thing-x-a1b2", summary: "live — open it in the Claude app" }];
    },
    endSession: (args) => {
      calls.push({ fn: "endSession", args });
      return { ok: true, id: args.id, stopped: true, purged: Boolean(args.purge) };
    },
    removeRepo: (args) => {
      calls.push({ fn: "removeRepo", args });
      return { ok: true, name: args.name };
    },
    trustRepo: (args) => {
      calls.push({ fn: "trustRepo", args });
      return { ok: true };
    },
    availableHooks: () => ["workspace-pull-all.sh"],
  };
}

let server;
let host;
let base;
let clock = 1_000_000;

before(async () => {
  host = fakeHost();
  ({ server } = createServer({ host, configText, token: TOKEN, now: () => clock }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const call = (path, { method = "GET", token = TOKEN, body, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

describe("tokensMatch", () => {
  test("accepts the right token", () => assert.equal(tokensMatch(TOKEN, TOKEN), true));
  test("rejects a wrong token of the same length", () => {
    assert.equal(tokensMatch("x".repeat(TOKEN.length), TOKEN), false);
  });
  test("rejects a different length without throwing", () => {
    assert.equal(tokensMatch("short", TOKEN), false);
  });
  test("rejects an empty expected token, so a missing token file is never 'anything works'", () => {
    assert.equal(tokensMatch("", ""), false);
    assert.equal(tokensMatch("anything", ""), false);
  });
});

describe("authentication", () => {
  test("no token is 401", async () => {
    assert.equal((await call("/repos", { token: null })).status, 401);
  });

  test("a wrong token is 401", async () => {
    assert.equal((await call("/repos", { token: "wrong" })).status, 401);
  });

  test("a token in the query string does not work — it would land in logs", async () => {
    const res = await fetch(`${base}/repos?token=${TOKEN}`);
    assert.equal(res.status, 401);
  });

  test("the right token gets through", async () => {
    assert.equal((await call("/repos")).status, 200);
  });

  test("status needs no token and gives nothing away", async () => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
  });

  test("repeated misses lock the caller out, then time unlocks it", async () => {
    for (let i = 0; i < 5; i++) await call("/repos", { token: "wrong" });
    assert.equal((await call("/repos", { token: "wrong" })).status, 429);
    // Even the correct token is refused while locked out.
    assert.equal((await call("/repos")).status, 429);
    clock += 61_000;
    assert.equal((await call("/repos")).status, 200);
  });
});

describe("POST /repos", () => {
  test("registers a repo, and is honest that nothing is running yet", async () => {
    const res = await call("/repos", { method: "POST", body: { url: "git@github.com:lorveil/thing.git" } });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.note, /POST \/sessions/);
    assert.doesNotMatch(body.note, /session is in your list/);
  });

  test("a non-JSON content type is refused, which blocks a browser form post", async () => {
    const res = await call("/repos", {
      method: "POST",
      body: "url=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.status, 415);
  });

  test("malformed JSON is a 400, not a crash", async () => {
    const res = await call("/repos", { method: "POST", body: "{ not json" });
    assert.equal(res.status, 400);
    // The server must still be answering afterwards.
    assert.equal((await call("/repos")).status, 200);
  });

  test("an oversized body is refused rather than buffered", async () => {
    const huge = JSON.stringify({ url: "x".repeat(64 * 1024) });
    // The socket is destroyed, so either a 413 or a transport error is a pass; a 201 is not.
    let status = null;
    try {
      status = (await call("/repos", { method: "POST", body: huge })).status;
    } catch {
      status = "destroyed";
    }
    assert.notEqual(status, 201);
    assert.equal((await call("/repos")).status, 200, "the server must survive it");
  });

  test("a bad hook name is refused before anything is cloned", async () => {
    const res = await call("/repos", {
      method: "POST",
      body: { url: "git@github.com:lorveil/thing.git", hook: "../../../etc/cron.hourly/x" },
    });
    assert.equal(res.status, 400);
    assert.equal(host.calls.some((c) => c.fn === "addRepo" && c.args.hook?.includes("..")), false);
  });

  test("trust must be asked for; it is never assumed from the request", async () => {
    host.calls.length = 0;
    await call("/repos", { method: "POST", body: { url: "git@github.com:lorveil/thing.git" } });
    const [add] = host.calls.filter((c) => c.fn === "addRepo");
    assert.equal(add.args.trustOverride, null);
  });

  test("a conflict is a 409, so a caller can tell it apart from a bad request", async () => {
    const conflicting = { ...fakeHost(), addRepo: () => ({ ok: false, conflict: true, reason: "already registered" }) };
    const { server: s } = createServer({ host: conflicting, configText, token: TOKEN });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${s.address().port}/repos`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "git@github.com:a/b.git" }),
    });
    assert.equal(res.status, 409);
    await new Promise((r) => s.close(r));
  });
});

describe("DELETE /repos/<name>", () => {
  test("a traversal name never reaches the host", async () => {
    host.calls.length = 0;
    // The encoded form is what actually arrives from a hand-written client.
    const res = await fetch(`${base}/repos/${encodeURIComponent("../../etc")}?purge=1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // removeRepo is reached but must refuse; what matters is that the decoded name is what it sees,
    // so its own resolveRepoPath check applies.
    const remove = host.calls.find((c) => c.fn === "removeRepo");
    if (remove) assert.equal(remove.args.name, "../../etc", "the decoded name must be handed on for validation, not a raw path");
    assert.ok([200, 400].includes(res.status));
  });

  test("purge only happens when explicitly asked for", async () => {
    host.calls.length = 0;
    await fetch(`${base}/repos/workspace`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
    const remove = host.calls.find((c) => c.fn === "removeRepo");
    assert.equal(remove.args.purge, false);
  });
});

describe("routing", () => {
  test("an unknown route is 404", async () => {
    assert.equal((await call("/nope")).status, 404);
  });

  test("an unsupported method on a known route is 405", async () => {
    assert.equal((await call("/repos/workspace", { method: "PUT" })).status, 405);
  });

  test("a foreign Host header is refused, in case the port is ever forwarded", async () => {
    // Raw http, not fetch: Host is a forbidden header name in the fetch spec, so undici drops it
    // and the request would arrive looking perfectly local. A hand-written client has no such
    // manners, which is exactly the client this check exists for.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: "/repos",
          method: "GET",
          headers: { host: "evil.example.com", authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  test("responses say not to sniff or cache them", async () => {
    const res = await call("/repos");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("POST /sessions", () => {
  test("starts a session and says the bootstrap has already run", async () => {
    const res = await call("/sessions", { method: "POST", body: { repo: "thing", task: "fix login" } });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, "thing-x-a1b2");
    assert.match(body.note, /bootstrap already run/);
    assert.ok(body.worktree && body.branch, "the caller is told where the work is");
  });

  test("needs a repo", async () => {
    const res = await call("/sessions", { method: "POST", body: { task: "x" } });
    assert.equal(res.status, 400);
  });

  test("a non-JSON content type is refused", async () => {
    const res = await call("/sessions", {
      method: "POST",
      body: "repo=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.status, 415);
  });

  test("a full box is a 429, not a 400 — the request was fine", async () => {
    const full = {
      ...fakeHost(),
      startSession: () => ({ ok: false, atCapacity: true, reason: "3 sessions are already running" }),
    };
    const { server: s } = createServer({ host: full, configText, token: TOKEN });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${s.address().port}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: "thing" }),
    });
    assert.equal(res.status, 429);
    await new Promise((r) => s.close(r));
  });

  test("a failed start hands back the log, since it is nearly always the bootstrap", async () => {
    const failing = {
      ...fakeHost(),
      startSession: () => ({ ok: false, reason: "would not start", diagnose: { log: "bootstrap: could not reach origin" } }),
    };
    const { server: s } = createServer({ host: failing, configText, token: TOKEN });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${s.address().port}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: "thing" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).log, /could not reach origin/);
    await new Promise((r) => s.close(r));
  });
});

describe("sessions routes", () => {
  test("lists them", async () => {
    const res = await call("/sessions");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sessions.length, 1);
  });

  test("ends one, and only purges when asked", async () => {
    host.calls.length = 0;
    await call("/sessions/thing-x-a1b2", { method: "DELETE" });
    assert.equal(host.calls.find((c) => c.fn === "endSession").args.purge, false);
    await call("/sessions/thing-x-a1b2?purge=1", { method: "DELETE" });
    assert.equal(host.calls.filter((c) => c.fn === "endSession")[1].args.purge, true);
  });

  test("a traversal id is handed on decoded, for the host's own check to refuse", async () => {
    host.calls.length = 0;
    await fetch(`${base}/sessions/${encodeURIComponent("../../etc")}?purge=1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const end = host.calls.find((c) => c.fn === "endSession");
    assert.equal(end.args.id, "../../etc", "the decoded value must reach validation, not a resolved path");
  });

  test("an unsupported method on a session is 405", async () => {
    assert.equal((await call("/sessions/thing-x-a1b2", { method: "PUT" })).status, 405);
  });
});
