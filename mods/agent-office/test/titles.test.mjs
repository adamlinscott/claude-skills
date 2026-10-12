import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { titleInputs, titleKey, nextTitle, cleanTitle, writtenTitles } from "../titles.mjs";
import { tempRoot, gitRepo, line, session, agent, engineIn, cc } from "./fixture.mjs";
import { office } from "./office.mjs";

test("the prompt holds the branch, edited files, agent types and tasks, and never a user line's text", async () => {
  const root = tempRoot();
  const home = path.join(root, "home");
  const main = gitRepo(path.join(root, "repo"), "main");
  const secret = "my bank PIN is 4921, please refactor the wizard";
  session(home, "s", [line.user(main, secret, 60, { gitBranch: "fix/wizard" }), line.tool(main, "Edit", { file_path: path.join(main, "lib", "wizard.mjs") }, 50)]);
  agent(home, "s", "w", { agentType: "worker", description: "Split the wizard steps" }, [line.user(main, secret, 20), line.tool(main, "Write", { file_path: path.join(main, "lib", "steps.mjs") }, 10)], { age: 10 });
  const m = await engineIn(home, main).model();

  const ask = nextTitle(m, new Map(), 0);
  assert.equal(ask.session, cc("s"));
  assert.equal(ask.prompt, ["Branch: fix/wizard", "Files edited:", "- lib/steps.mjs", "- lib/wizard.mjs", "Agent types: worker", "Subagent tasks:", "- Split the wizard steps"].join("\n"));
  assert.ok(!ask.prompt.includes("4921") && !ask.prompt.includes("bank"));
});

test("cache: asks only for branch stand-ins, again only when the inputs change, at most once per 10 minutes", () => {
  const m = office([
    { id: "a", sessions: [{ id: "s-a", titleFrom: "branch", team: [{ id: "w1", task: "Fix the wizard" }] }] },
    { id: "b", sessions: [{ id: "s-b", team: [{ id: "w2", task: "Named by Claude Code" }] }] },
  ]);
  const cache = new Map();
  const first = nextTitle(m, cache, 0);
  assert.equal(first.session, "s-a");
  assert.equal(first.key, titleKey(titleInputs(m, "s-a")));
  cache.set("s-a", { key: first.key, title: "Fixing the wizard", at: 0 });
  assert.equal(nextTitle(m, cache, 60 * 60000), null, "same inputs: no new call");

  m.agents.find((a) => a.id === "w1").task = "Test the wizard";
  assert.equal(nextTitle(m, cache, 9 * 60000), null, "changed, but inside 10 minutes");
  assert.equal(nextTitle(m, cache, 10 * 60000).session, "s-a");
  assert.deepEqual(writtenTitles(cache), { "s-a": "Fixing the wizard" });
});

test("a reply becomes a title: its first line, unquoted; empty is none", () => {
  assert.equal(cleanTitle('\n"Fixing the setup wizard."\nmore'), "Fixing the setup wizard");
  assert.equal(cleanTitle("  \n "), null);
  assert.equal(cleanTitle("x".repeat(80)).length, 60);
});
