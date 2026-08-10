import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildReviewPrompt,
  collectGitReviewInput,
  parseArgs,
  parseContext,
  shellQuote,
  truncateText,
} from "../bin/code-review.js";

test("parseContext prefers focused pane fields", () => {
  const context = parseContext(JSON.stringify({
    workspace_id: "w1",
    workspace_cwd: "/repo",
    focused_pane_id: "p2",
    focused_pane_cwd: "/repo/packages/app",
  }), "/fallback");

  assert.deepEqual(context, {
    workspaceId: "w1",
    sourcePaneId: "p2",
    cwd: "/repo/packages/app",
  });
});

test("parseArgs reads mode and worker flags", () => {
  assert.deepEqual(parseArgs(["--mode", "tab", "--worker", "--prompt", "/tmp/p"]), {
    mode: "tab",
    sendBack: true,
    worker: true,
    promptPath: "/tmp/p",
  });
});

test("truncateText leaves short text and marks long text", () => {
  assert.equal(truncateText("abc", 5), "abc");
  assert.match(truncateText("abcdef", 3), /\[\.\.\. truncated at 3 characters \.\.\.\]/);
});

test("shellQuote handles single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("buildReviewPrompt includes status, diff, and verdict instruction", () => {
  const prompt = buildReviewPrompt({
    cwd: "/repo",
    status: " M index.js",
    diff: "diff --git a/index.js b/index.js",
    truncated: true,
  });

  assert.match(prompt, /VERDICT: APPROVE or REJECT/);
  assert.match(prompt, / M index\.js/);
  assert.match(prompt, /Diff was truncated/);
});

test("collectGitReviewInput captures staged and unstaged diffs", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-review-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "index.js"), "console.log('one');\n");
  execFileSync("git", ["add", "index.js"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

  writeFileSync(join(dir, "index.js"), "console.log('two');\n");
  const input = collectGitReviewInput(dir, 10000);

  assert.match(input.status, /M index\.js/);
  assert.match(input.diff, /UNSTAGED DIFF/);
  assert.match(input.diff, /console\.log\('two'\)/);
});
