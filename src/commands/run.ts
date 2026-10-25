import { Command } from "commander";
import { runOpenCode } from "../adapters/opencode.js";
import { stripAnsi } from "../core/text.js";
import { getDefaultChecks } from "../verification/defaults.js";
import { runChecks } from "../verification/checks.js";
import type { CheckResult } from "../verification/checks.js";
import { formatReport } from "../verification/report.js";
import {
  isGitRepo,
  getStatus,
  getHead,
  getChangedSince,
} from "../workspace/git.js";

export type RunOptions = {
  allowDirty?: boolean;
  maxRepairs?: string | number;
};

export function getVerdict(
  results: CheckResult[]
): "VERIFIED" | "FAILED" | "UNVERIFIED" {
  if (results.length === 0) return "UNVERIFIED";
  if (results.some((r) => r.status === "failed" || r.status === "timed_out")) {
    return "FAILED";
  }
  if (results.some((r) => r.status === "skipped")) {
    return "UNVERIFIED";
  }
  if (results.every((r) => r.status === "passed")) {
    return "VERIFIED";
  }
  return "UNVERIFIED";
}

export function buildRepairPrompt(
  task: string,
  failedChecks: CheckResult[]
): string {
  const parts: string[] = [
    task,
    "",
    "The following checks failed after your changes. Fix the problems. Change only what is needed, do not delete or weaken tests, and do not edit package.json scripts to make checks pass.",
    "",
  ];

  for (const check of failedChecks) {
    const rawOutput = [check.stdout, check.stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    const cleanedOutput = stripAnsi(rawOutput).slice(-4000).trim();
    parts.push(`Check '${check.name}' failed:`);
    if (cleanedOutput) {
      parts.push(cleanedOutput);
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}

export async function runTask(
  prompt: string,
  options?: RunOptions
): Promise<void> {
  if (!prompt || !prompt.trim()) {
    console.error("Error: task description cannot be empty.");
    process.exitCode = 1;
    return;
  }

  let maxRepairs = 2;
  if (options?.maxRepairs !== undefined) {
    const rawVal = options.maxRepairs;
    const parsed =
      typeof rawVal === "number"
        ? rawVal
        : typeof rawVal === "string" && rawVal.trim() !== ""
        ? Number(rawVal.trim())
        : NaN;

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
      console.error(
        "Error: --max-repairs must be an integer between 0 and 5."
      );
      process.exitCode = 1;
      return;
    }
    maxRepairs = parsed;
  }

  const isRepo = await isGitRepo(process.cwd());
  if (!isRepo) {
    console.error("Error: current directory is not a git repository.");
    process.exitCode = 1;
    return;
  }

  const status = await getStatus(process.cwd());
  if (!status.clean) {
    if (!options?.allowDirty) {
      console.error(
        "Error: working tree is not clean. Uncommitted changes detected:"
      );
      for (const file of status.changedFiles) {
        console.error(`  ${file}`);
      }
      console.error(
        "Commit or stash your changes, or pass --allow-dirty to proceed anyway."
      );
      process.exitCode = 1;
      return;
    } else {
      console.warn(
        "Warning: working tree is not clean (--allow-dirty specified). Proceeding with uncommitted changes."
      );
    }
  }

  const startHead = await getHead(process.cwd());
  const runStartTime = Date.now();
  const MAX_RUN_TIME_MS = 15 * 60 * 1000;

  const totalAttempts = 1 + maxRepairs;
  let attempt = 1;
  let lastFailureKey: string | null = null;
  let lastCheckResults: CheckResult[] = [];
  let currentPrompt = prompt;

  while (attempt <= totalAttempts) {
    if (Date.now() - runStartTime >= MAX_RUN_TIME_MS) {
      console.error("Error: maximum run duration of 15 minutes exceeded.");
      break;
    }

    const result = await runOpenCode(process.cwd(), currentPrompt);

    const cleanedOutput = stripAnsi(result.output).trim();
    if (cleanedOutput) {
      console.log(cleanedOutput);
    }

    if (!result.success) {
      const cleanedError = stripAnsi(result.error).trim();
      let failureLine: string;
      if (result.timedOut) {
        failureLine = cleanedError
          ? `Task timed out: ${cleanedError}`
          : "Task timed out.";
      } else {
        failureLine = cleanedError
          ? `Task failed: ${cleanedError}`
          : "Task failed.";
      }
      console.error(failureLine);
      console.error("Nothing was verified.");
      process.exitCode = 1;
      return;
    }

    // Run verification checks
    const checks = getDefaultChecks(process.cwd());
    const checkResults = await runChecks(checks, process.cwd());
    lastCheckResults = checkResults;
    const verdict = getVerdict(checkResults);

    if (verdict === "VERIFIED") {
      break;
    }

    if (verdict === "UNVERIFIED") {
      // Do NOT repair when UNVERIFIED; report it and stop.
      break;
    }

    // verdict is FAILED
    const failedChecks = checkResults.filter(
      (r) => r.status === "failed" || r.status === "timed_out"
    );

    const failureKey = failedChecks
      .map(
        (r) =>
          `${r.name}:${r.status}:${r.exitCode}:${r.stdout.trim()}:${r.stderr.trim()}`
      )
      .join("|||");

    if (lastFailureKey !== null && failureKey === lastFailureKey) {
      console.log(
        "Stopping repair loop: failure output is identical to the previous attempt (no progress detected)."
      );
      break;
    }
    lastFailureKey = failureKey;

    if (attempt >= totalAttempts) {
      break;
    }

    console.log(
      `Attempt ${attempt} of ${totalAttempts}: checks failed, asking the agent to repair...`
    );

    currentPrompt = buildRepairPrompt(prompt, failedChecks);
    attempt++;
  }

  // Summary and final reporting
  console.log(`Attempts used: ${attempt} of ${totalAttempts}`);
  if (lastCheckResults.length > 0) {
    console.log(formatReport(lastCheckResults));
  }

  const finalVerdict = getVerdict(lastCheckResults);
  if (finalVerdict === "VERIFIED") {
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }

  // Report files changed by this run
  const changedFiles = await getChangedSince(process.cwd(), startHead);
  if (changedFiles.length > 0) {
    console.log("Files changed by this run:");
    for (const file of changedFiles) {
      console.log(`  ${file}`);
    }
  } else {
    console.log("No files changed.");
  }

  console.log(
    "To review changes, run: git diff. To undo changes, run: git restore . && git clean -fd (WARNING: this will permanently discard all uncommitted changes)."
  );
}

export const runCommand = new Command("run")
  .description("Run a task using OpenCode agent")
  .argument("<task>", "The task description or prompt to execute")
  .option("--allow-dirty", "Allow running in a dirty git working tree")
  .option(
    "--max-repairs <n>",
    "Maximum number of repair attempts (0-5)",
    "2"
  )
  .action(async (task: string, options: RunOptions) => {
    await runTask(task, options);
  });
