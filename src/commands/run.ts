import { Command } from "commander";
import { runOpenCode } from "../adapters/opencode.js";
import { stripAnsi } from "../core/text.js";

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
    process.exitCode = 1;
  }
}

export const runCommand = new Command("run")
  .description("Run a task using OpenCode agent")
  .argument("<task>", "The task description or prompt to execute")
  .action(async (task: string) => {
    await runTask(task);
  });
