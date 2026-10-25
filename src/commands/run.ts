import { Command } from "commander";
import { runOpenCode } from "../adapters/opencode.js";
import { stripAnsi } from "../core/text.js";
import { getDefaultChecks } from "../verification/defaults.js";
import { runChecks } from "../verification/checks.js";
import { formatReport } from "../verification/report.js";
import {
  isGitRepo,
  getStatus,
  getHead,
  getChangedSince,
} from "../workspace/git.js";

export type RunOptions = {
  allowDirty?: boolean;
};

export async function runTask(
  prompt: string,
  options?: RunOptions
): Promise<void> {
  if (!prompt || !prompt.trim()) {
    console.error("Error: task description cannot be empty.");
    process.exitCode = 1;
    return;
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

  const result = await runOpenCode(process.cwd(), prompt);

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

  // After OpenCode succeeds, run verification checks
  const checks = getDefaultChecks(process.cwd());
  const checkResults = await runChecks(checks, process.cwd());
  const report = formatReport(checkResults);
  console.log(report);

  const isVerified =
    checkResults.length > 0 &&
    checkResults.every((r) => r.status === "passed");

  if (!isVerified) {
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
  .action(async (task: string, options: RunOptions) => {
    await runTask(task, options);
  });
