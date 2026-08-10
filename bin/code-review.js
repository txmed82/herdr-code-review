#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "opencode-go/glm-5.2:high";
const DEFAULT_MAX_CHARS = 30000;

function parseArgs(argv) {
  const args = { mode: "split", sendBack: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--worker") args.worker = true;
    else if (arg === "--mode") args.mode = argv[++index] ?? args.mode;
    else if (arg === "--prompt") args.promptPath = argv[++index];
    else if (arg === "--cwd") args.cwd = argv[++index];
    else if (arg === "--source-pane") args.sourcePaneId = argv[++index];
    else if (arg === "--no-send-back") args.sendBack = false;
  }
  return args;
}

function parseContext(raw, fallbackCwd = process.cwd()) {
  let context = {};
  try {
    context = JSON.parse(raw || "{}");
  } catch {
    context = {};
  }

  return {
    workspaceId: context.workspace_id || "",
    sourcePaneId: context.focused_pane_id || context.pane_id || "",
    cwd: context.focused_pane_cwd || context.workspace_cwd || fallbackCwd,
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function runGit(cwd, args) {
  return run("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }).trim();
}

function collectGitReviewInput(cwd, maxChars = DEFAULT_MAX_CHARS) {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const status = runGit(root, ["status", "--short"]);
  const staged = runGit(root, ["diff", "--staged", "--no-ext-diff"]);
  const unstaged = runGit(root, ["diff", "--no-ext-diff"]);

  const body = [
    staged && `STAGED DIFF:\n${staged}`,
    unstaged && `UNSTAGED DIFF:\n${unstaged}`,
  ].filter(Boolean).join("\n\n");

  return {
    root,
    status,
    diff: truncateText(body, maxChars),
    truncated: body.length > maxChars,
  };
}

function truncateText(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[... truncated at ${maxChars} characters ...]`;
}

function buildReviewPrompt({ cwd, status, diff, truncated }) {
  return `
You are reviewing code changes in ${cwd}.

Review stance:
- Lead with concrete findings ordered by severity.
- Use P0, P1, P2, and NIT labels.
- Include file paths and line numbers when possible.
- Only report actionable issues introduced by these changes.
- If there are no issues, say so clearly.
- End with VERDICT: APPROVE or REJECT.

Git status:
${status || "(clean)"}

${truncated ? "Diff was truncated; call that out if it limits confidence.\n\n" : ""}Diff:
${diff || "(no staged or unstaged diff)"}
`.trim();
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function createReviewPane({ mode, workspaceId, sourcePaneId, cwd }) {
  const herdr = herdrBin();
  if (mode === "tab") {
    const output = run(herdr, ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", "REVIEW // CODE", "--no-focus"]);
    return JSON.parse(output).result?.root_pane?.pane_id || "";
  }

  const args = ["pane", "split"];
  if (sourcePaneId) args.push(sourcePaneId);
  else args.push("--current");
  args.push("--direction", "right", "--ratio", "0.42", "--cwd", cwd, "--no-focus");

  const output = run(herdr, args);
  const paneId = JSON.parse(output).result?.pane?.pane_id || "";
  if (paneId) run(herdr, ["pane", "rename", paneId, "REVIEW // CODE"]);
  return paneId;
}

function commandExists(name) {
  if (process.platform === "win32") {
    return spawnSync("where", [name], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-lc", `command -v ${shellQuote(name)} >/dev/null 2>&1`]).status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runReviewer(promptPath, cwd) {
  const custom = process.env.HERDR_REVIEW_COMMAND;
  const env = { ...process.env, HERDR_REVIEW_PROMPT_PATH: promptPath, HERDR_REVIEW_CWD: cwd };

  if (custom) {
    return spawnSync(custom, { cwd, env, shell: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  }

  if (commandExists("omp")) {
    return spawnSync("omp", ["-p", "--model", process.env.HERDR_REVIEW_MODEL || DEFAULT_MODEL, `@${promptPath}`], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  if (commandExists("codex")) {
    return spawnSync("codex", ["exec", "--cd", cwd, "--skip-git-repo-check", "-"], {
      cwd,
      env,
      input: readFileSync(promptPath, "utf8"),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  throw new Error("no reviewer found: install omp/codex or set HERDR_REVIEW_COMMAND");
}

function sendBack(sourcePaneId, review) {
  if (!sourcePaneId || process.env.HERDR_REVIEW_SEND_BACK === "0") return;
  const text = `Code review result:\n\n${review.trim()}`;
  run(herdrBin(), ["pane", "send-text", sourcePaneId, text]);
  run(herdrBin(), ["pane", "send-keys", sourcePaneId, "enter"]);
}

function printHelp() {
  console.log(`Herdr Code Review

Usage:
  node bin/code-review.js --mode split
  node bin/code-review.js --mode tab

Environment:
  HERDR_REVIEW_MODEL       model for omp (default: ${DEFAULT_MODEL})
  HERDR_REVIEW_COMMAND     shell command override; reads HERDR_REVIEW_PROMPT_PATH
  HERDR_REVIEW_SEND_BACK=0 do not send the result to the source pane
  HERDR_REVIEW_MAX_CHARS   diff character budget (default: ${DEFAULT_MAX_CHARS})`);
}

function worker(args) {
  if (!args.promptPath || !existsSync(args.promptPath)) throw new Error("missing review prompt");
  const cwd = args.cwd || process.cwd();
  try {
    console.log("Herdr Code Review");
    console.log(`cwd: ${cwd}`);
    console.log("");

    const result = runReviewer(args.promptPath, cwd);
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const review = output || `review command exited ${result.status ?? 1} with no output`;

    console.log(review);
    sendBack(args.sourcePaneId, review);

    if ((result.status ?? 0) !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(args.promptPath, { force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.worker) return worker(args);

  const context = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  let input;
  try {
    input = collectGitReviewInput(context.cwd, Number(process.env.HERDR_REVIEW_MAX_CHARS || DEFAULT_MAX_CHARS));
  } catch (error) {
    console.error(`herdr-code-review: ${error.message}`);
    process.exit(1);
  }

  if (!input.status && !input.diff) {
    console.log("herdr-code-review: worktree clean; nothing to review");
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "herdr-code-review-"));
  const promptPath = join(tempDir, "prompt.md");
  writeFileSync(promptPath, buildReviewPrompt({ cwd: input.root, ...input }), "utf8");

  const paneId = createReviewPane({ ...context, cwd: input.root, mode: args.mode });
  if (!paneId) throw new Error("Herdr did not return a review pane id");

  const scriptPath = fileURLToPath(import.meta.url);
  run(herdrBin(), [
    "pane",
    "run",
    paneId,
    process.execPath,
    scriptPath,
    "--worker",
    "--prompt",
    promptPath,
    "--cwd",
    input.root,
    "--source-pane",
    args.sendBack ? context.sourcePaneId : "",
  ]);

  console.log(`herdr-code-review: launched review in ${paneId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`herdr-code-review: ${error.message}`);
    process.exit(1);
  }
}

export {
  buildReviewPrompt,
  collectGitReviewInput,
  parseArgs,
  parseContext,
  shellQuote,
  truncateText,
};
