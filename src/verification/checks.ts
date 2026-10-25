import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "../core/text.js";

export type CheckDefinition = {
  name: string;
  command: string;
  args: string[];
  skipReason?: string;
  status?: "passed" | "failed" | "timed_out" | "skipped";
};

export type CheckResult = {
  name: string;
  command: string;
  args: string[];
  status: "passed" | "failed" | "timed_out" | "skipped";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  skipReason?: string;
};

export async function runChecks(
  checks: (CheckDefinition | CheckResult)[],
  cwd: string,
  timeoutMs: number = 180_000
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    // If check was already skipped beforehand
    if ("status" in check && check.status === "skipped") {
      const skippedCheck = check as CheckResult;
      results.push({
        name: skippedCheck.name,
        command: skippedCheck.command,
        args: skippedCheck.args,
        status: "skipped",
        exitCode: skippedCheck.exitCode ?? null,
        durationMs: skippedCheck.durationMs ?? 0,
        stdout: skippedCheck.stdout ?? "",
        stderr: skippedCheck.stderr ?? "",
        skipReason: skippedCheck.skipReason ?? "Check skipped",
      });
      continue;
    }

    if (check.skipReason) {
      results.push({
        name: check.name,
        command: check.command,
        args: check.args,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        skipReason: check.skipReason,
      });
      continue;
    }

    let commandToRun = check.command;
    let argsToRun = [...check.args];

    // On Windows, npm is a .cmd launcher which cannot be executed directly via execFile
    // without invoking a shell. Execute node with npm-cli.js directly.
    if (process.platform === "win32" && check.command === "npm") {
      const npmCliPath = path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js"
      );

      if (!fs.existsSync(npmCliPath)) {
        results.push({
          name: check.name,
          command: check.command,
          args: check.args,
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          skipReason: `npm-cli.js not found at ${npmCliPath}`,
        });
        continue;
      }

      commandToRun = process.execPath;
      argsToRun = [npmCliPath, ...check.args];
    }

    const startTime = Date.now();

    try {
      const checkResult = await new Promise<CheckResult>((resolve) => {
        const child = execFile(
          commandToRun,
          argsToRun,
          {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 5 * 1024 * 1024,
            windowsHide: true,
          },
          (err, rawStdout, rawStderr) => {
            const durationMs = Math.max(0, Date.now() - startTime);

            const cleanedStdout = stripAnsi(rawStdout ?? "");
            const cleanedStderr = stripAnsi(rawStderr ?? "");

            const stdout = cleanedStdout.slice(-4000);
            let stderr = cleanedStderr.slice(-4000);

            if (!err) {
              resolve({
                name: check.name,
                command: check.command,
                args: check.args,
                status: "passed",
                exitCode: 0,
                durationMs,
                stdout,
                stderr,
              });
              return;
            }

            const isMaxBuffer =
              err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            const timedOut = Boolean(err.killed && !isMaxBuffer);

            if (isMaxBuffer) {
              const maxBufferMsg = "Output exceeded 5 MB";
              stderr = stderr ? `${stderr}\n${maxBufferMsg}` : maxBufferMsg;
            }

            let exitCode: number | null = null;
            if (typeof err.code === "number") {
              exitCode = err.code;
            } else if (
              "status" in err &&
              typeof (err as { status?: unknown }).status === "number"
            ) {
              exitCode = (err as { status: number }).status;
            } else if (!timedOut) {
              exitCode = 1;
            }

            resolve({
              name: check.name,
              command: check.command,
              args: check.args,
              status: timedOut ? "timed_out" : "failed",
              exitCode,
              durationMs,
              stdout,
              stderr,
            });
          }
        );

        child.stdin?.end();
      });

      results.push(checkResult);
    } catch (unexpectedError: unknown) {
      const durationMs = Math.max(0, Date.now() - startTime);
      const errMsg =
        unexpectedError instanceof Error
          ? unexpectedError.message
          : String(unexpectedError);
      results.push({
        name: check.name,
        command: check.command,
        args: check.args,
        status: "failed",
        exitCode: 1,
        durationMs,
        stdout: "",
        stderr: stripAnsi(errMsg).slice(-4000),
      });
    }
  }

  return results;
}
