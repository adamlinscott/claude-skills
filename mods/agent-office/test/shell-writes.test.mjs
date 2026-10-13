import { test } from "node:test";
import assert from "node:assert/strict";
import { shellWrites } from "../shell-writes.mjs";

const VERSION = "C:\\Users\\adamr\\Projects\\claude-skills\\.claude\\worktrees\\version-4a64c9";
const TESTING = "C:\\Users\\adamr\\Projects\\claude-skills\\.claude\\worktrees\\session-detection-testing-f96742";
const readme = (cwd) => [cwd.replace(/\\/g, "/") + "/README.md"];

test("Adam's 13 Oct test: every Bash write to README.md is read, and every read-only command is not", () => {
  // The Bash commands of both conversations and the subagent, verbatim, each with the folder it ran in.
  const calls = [
    [VERSION, "wc -l README.md; tail -n 15 README.md", []],
    [VERSION, "cat >> README.md <<'EOF'\n\n## 😄 Jokes\n\nWhy do programmers prefer dark mode? Because light attracts bugs.\n\nA SQL query walks into a bar, walks up to two tables and asks, \"Can I join you?\"\nEOF\ntail -n 6 README.md", readme(VERSION)],
    [VERSION, "tail -n 8 README.md", []],
    [TESTING, "tail -c 200 README.md; printf '\\n\\n---\\n\\nWhy do programmers prefer dark mode? Because light attracts bugs.\\n' >> README.md; tail -n 4 README.md", readme(TESTING)],
    [TESTING, "printf '\\nA SQL query walks into a bar, goes up to two tables and asks: \"Can I join you?\"\\n' >> README.md; tail -n 3 README.md", readme(TESTING)],
    [TESTING, "tail -n 6 README.md", []],
    [TESTING, "cd \"C:/Users/adamr/Projects/claude-skills/.claude/worktrees/session-detection-testing-f96742\" && tail -c 200 README.md | od -c | tail -5; git status --short", []],
    [TESTING, "cd \"C:/Users/adamr/Projects/claude-skills/.claude/worktrees/session-detection-testing-f96742\" && printf '\\nWhy do programmers prefer dark mode? Because light attracts bugs.\\n' >> README.md && tail -n 3 README.md", readme(TESTING)],
    [TESTING, "cd \"C:/Users/adamr/Projects/claude-skills/.claude/worktrees/session-detection-testing-f96742\" && sed -i '$ d' README.md && printf 'My code has no bugs, only features that the test suite hasn'\"'\"'t been introduced to yet.\\n' >> README.md && tail -n 3 README.md && git diff --stat", readme(TESTING)],
  ];
  for (const [cwd, command, writes] of calls) assert.deepEqual(shellWrites(command, cwd), writes, command);
});

test("redirects: > and >> write; stderr, descriptors, /dev/null and input don't; a heredoc's body is not commands", () => {
  const cwd = "/home/adam/repo";
  assert.deepEqual(shellWrites("ls 2>/dev/null > out.txt 2>&1; echo y >&2; echo z &> both.log; echo q > /dev/null; sort < in.txt 2> err.log", cwd), ["/home/adam/repo/out.txt"]);
  assert.deepEqual(shellWrites("cat <<-EOF > a.md\n\techo body > not-a-write.md\n\tEOF\necho done >> b.md", cwd), ["/home/adam/repo/a.md", "/home/adam/repo/b.md"]);
});

test("commands that write: tee, sed -i, perl -i, cp, mv, install, touch", () => {
  const cwd = "/r";
  const cases = [
    ["echo x | tee -a log.txt other.txt", ["/r/log.txt", "/r/other.txt"]],
    ["sed -i.bak -e 's/a/b/' -e 's/c/d/' a.txt b.txt", ["/r/a.txt", "/r/b.txt"]],
    ["sed 's/a/b/' a.txt", []],
    ["perl -pi -e 's/a/b/' p.txt", ["/r/p.txt"]],
    ["cp -r src/a.md docs/b.md", ["/r/docs/b.md"]],
    ["mv a.md b.md lib/", ["/r/lib/a.md", "/r/lib/b.md"]],
    ["install -m 644 build/x /r/bin/", ["/r/bin/x"]],
    ["install -d /r/bin", []],
    ["touch -d yesterday t1 t2", ["/r/t1", "/r/t2"]],
  ];
  for (const [command, writes] of cases) assert.deepEqual(shellWrites(command, cwd), writes, command);
});

test("PowerShell: Set-Content, Add-Content, Out-File and New-Item -ItemType File, by name or position", () => {
  const cwd = "C:\\r";
  const cases = [
    ["Set-Content -Path a.txt -Value 'x'", ["C:/r/a.txt"]],
    ["'x' | Out-File -Encoding utf8 -FilePath C:\\r\\b.txt -Append", ["C:/r/b.txt"]],
    ["Add-Content c.txt 'more'", ["C:/r/c.txt"]],
    ["(Get-Content d.txt) | Set-Content -LiteralPath:'d.txt'", ["C:/r/d.txt"]],
    ["New-Item -ItemType File -Path docs -Name e.md -Force", ["C:/r/docs/e.md"]],
    ["New-Item -ItemType Directory f", []],
    ["Get-ChildItem > list.txt; Remove-Item x 2> $null; Write-Output y > $null", ["C:/r/list.txt"]],
  ];
  for (const [command, writes] of cases) assert.deepEqual(shellWrites(command, cwd, { powershell: true }), writes, command);
});

test("skipped, never guessed: variables, globs, ~, a cd it can't place, and relative paths with no cwd", () => {
  assert.deepEqual(shellWrites('echo x > "$OUT"; echo x > *.md; cp a.md ~/b.md; echo x > "plain $x.md"', "/r"), []);
  assert.deepEqual(shellWrites("cd $DIR && echo x > a.md", "/r"), []);
  assert.deepEqual(shellWrites("echo x > a.md; echo x > /abs/b.md", null), ["/abs/b.md"]);
  // Literal quotes keep a dollar sign: '$x' is a file name, not a variable.
  assert.deepEqual(shellWrites("echo x > '$x.md'", "/r"), ["/r/$x.md"]);
});

test("Git Bash: /c/… paths become C:/… under a Windows cwd; cd follows relative and absolute folders", () => {
  assert.deepEqual(shellWrites("echo x > /c/Users/adam/a.md", "C:\\Users\\adam"), ["C:/Users/adam/a.md"]);
  assert.deepEqual(shellWrites("cd /c/Users/adam/repo && cd lib && echo x >> b.md", "C:\\elsewhere"), ["C:/Users/adam/repo/lib/b.md"]);
  assert.deepEqual(shellWrites("echo x > /c/a.md", "/home/adam"), ["/c/a.md"]);
});
