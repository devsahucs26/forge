import { Command } from "commander";
import { runOpenCode } from "../adapters/opencode.js";
import { stripAnsi } from "../core/text.js";
import { getDefaultChecks } from "../verification/defaults.js";
import { runChecks } from "../verification/checks.js";
import { formatReport } from "../verification/report.js";

export async function runTask(prompt: string): Promise<void> {
  if (!prompt || !prompt.trim()) {
    console.error("Error: task description cannot be empty.");
    process.exitCode = 1;
    return;
  }

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
}

export const runCommand = new Command("run")
  .description("Run a task using OpenCode agent")
  .argument("<task>", "The task description or prompt to execute")
  .action(async (task: string) => {
    await runTask(task);
  });
