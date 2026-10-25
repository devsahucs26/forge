import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunOpenCode = vi.fn();
const mockGetDefaultChecks = vi.fn();
const mockRunChecks = vi.fn();

const mockIsGitRepo = vi.fn();
const mockGetStatus = vi.fn();
const mockGetHead = vi.fn();
const mockGetChangedSince = vi.fn();

vi.mock("../src/adapters/opencode.js", () => ({
  runOpenCode: (...args: unknown[]) => mockRunOpenCode(...args),
}));

vi.mock("../src/verification/defaults.js", () => ({
  getDefaultChecks: (...args: unknown[]) => mockGetDefaultChecks(...args),
}));

vi.mock("../src/verification/checks.js", () => ({
  runChecks: (...args: unknown[]) => mockRunChecks(...args),
}));

vi.mock("../src/workspace/git.js", () => ({
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args),
  getStatus: (...args: unknown[]) => mockGetStatus(...args),
  getHead: (...args: unknown[]) => mockGetHead(...args),
  getChangedSince: (...args: unknown[]) => mockGetChangedSince(...args),
}));

import { runTask, buildRepairPrompt } from "../src/commands/run.js";
import type { CheckResult } from "../src/verification/checks.js";

describe("runTask command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockIsGitRepo.mockResolvedValue(true);
    mockGetStatus.mockResolvedValue({ clean: true, changedFiles: [] });
    mockGetHead.mockResolvedValue("head12345");
    mockGetChangedSince.mockResolvedValue([]);

    mockGetDefaultChecks.mockReturnValue([
      { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
    ]);
    mockRunChecks.mockResolvedValue([
      {
        name: "typecheck",
        command: "npm",
        args: ["run", "typecheck"],
        status: "passed",
        exitCode: 0,
        durationMs: 100,
        stdout: "",
        stderr: "",
      },
    ]);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  describe("Git safety", () => {
    it("not a repo: refuses to run, prints error, sets exitCode 1, never calls OpenCode", async () => {
      mockIsGitRepo.mockResolvedValueOnce(false);

      await runTask("Do something");

      expect(mockRunOpenCode).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("not a git repository")
      );
      expect(process.exitCode).toBe(1);
    });

    it("dirty tree refused: refuses to run without --allow-dirty, prints files, sets exitCode 1", async () => {
      mockGetStatus.mockResolvedValueOnce({
        clean: false,
        changedFiles: ["src/index.ts", "package.json"],
      });

      await runTask("Refactored code");

      expect(mockRunOpenCode).not.toHaveBeenCalled();
      const allErrors = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allErrors).toContain("working tree is not clean");
      expect(allErrors).toContain("src/index.ts");
      expect(allErrors).toContain("package.json");
      expect(process.exitCode).toBe(1);
    });

    it("--allow-dirty continues with a warning: runs OpenCode when tree is dirty", async () => {
      mockGetStatus.mockResolvedValueOnce({
        clean: false,
        changedFiles: ["src/index.ts"],
      });
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Completed task",
        error: "",
        timedOut: false,
      });

      await runTask("Do something", { allowDirty: true });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("working tree is not clean")
      );
      expect(mockRunOpenCode).toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it("clean tree runs normally", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Clean task done",
        error: "",
        timedOut: false,
      });

      await runTask("Update docs");

      expect(mockRunOpenCode).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("changed files reported: prints list of changed files and review/undo instructions", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Created file",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce([
        "src/new.ts",
        "tests/new.test.ts",
      ]);

      await runTask("Add new feature");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("src/new.ts");
      expect(allLogs).toContain("tests/new.test.ts");
      expect(allLogs).toContain("git diff");
      expect(allLogs).toContain("git restore .");
      expect(allLogs).toContain("git clean -fd");
    });

    it("reports 'No files changed.' when run produced no changes", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Nothing to do",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce([]);

      await runTask("Check docs");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("No files changed.");
      expect(allLogs).toContain("git diff");
    });
  });

  describe("Task execution & error handling", () => {
    it("empty task: rejects empty prompt with clear message, exitCode 1, and never calls git or adapter", async () => {
      await runTask("");

      expect(mockIsGitRepo).not.toHaveBeenCalled();
      expect(mockRunOpenCode).not.toHaveBeenCalled();
      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot be empty")
      );
      expect(process.exitCode).toBe(1);
    });

    it("failure: does NOT run verification, prints nothing was verified, sets exitCode 1", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "",
        error: "\u001b[31mError: module not found\u001b[0m",
        timedOut: false,
      });

      await runTask("Build the project");

      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const errorCalls = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join(" ");
      expect(errorCalls).toContain("Task failed");
      expect(errorCalls).toContain("Error: module not found");
      expect(errorCalls).toContain("Nothing was verified");
      expect(process.exitCode).toBe(1);
    });

    it("timeout: does NOT run verification, prints nothing was verified, sets exitCode 1", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "",
        error: "Command execution killed",
        timedOut: true,
      });

      await runTask("Long task that exceeds limit");

      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const errorCalls = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join(" ");
      expect(errorCalls.toLowerCase()).toContain("timed out");
      expect(errorCalls).toContain("Command execution killed");
      expect(errorCalls).toContain("Nothing was verified");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("Bounded repair loop", () => {
    it("invalid --max-repairs is rejected with clear error and exitCode 1", async () => {
      await runTask("Task", { maxRepairs: -1 });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--max-repairs must be an integer between 0 and 5")
      );
      expect(process.exitCode).toBe(1);
      expect(mockRunOpenCode).not.toHaveBeenCalled();

      errorSpy.mockClear();
      process.exitCode = undefined;
      await runTask("Task", { maxRepairs: 6 });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--max-repairs must be an integer between 0 and 5")
      );
      expect(process.exitCode).toBe(1);

      errorSpy.mockClear();
      process.exitCode = undefined;
      await runTask("Task", { maxRepairs: "invalid" });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--max-repairs must be an integer between 0 and 5")
      );
      expect(process.exitCode).toBe(1);
    });

    it("fails then passes after one repair gives VERIFIED", async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: "Fixed code",
        error: "",
        timedOut: false,
      });

      // Attempt 1 fails, attempt 2 passes
      mockRunChecks
        .mockResolvedValueOnce([
          {
            name: "typecheck",
            command: "npm",
            args: ["run", "typecheck"],
            status: "failed",
            exitCode: 1,
            durationMs: 150,
            stdout: "",
            stderr: "Type error: number is not string",
          },
        ])
        .mockResolvedValueOnce([
          {
            name: "typecheck",
            command: "npm",
            args: ["run", "typecheck"],
            status: "passed",
            exitCode: 0,
            durationMs: 120,
            stdout: "",
            stderr: "",
          },
        ]);

      await runTask("Fix types", { maxRepairs: 2 });

      expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      expect(mockRunChecks).toHaveBeenCalledTimes(2);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Attempt 1 of 3: checks failed, asking the agent to repair...");
      expect(allLogs).toContain("Attempts used: 2 of 3");
      expect(allLogs).toContain("Verdict: VERIFIED");
      expect(process.exitCode).toBe(0);
    });

    it("always failing stops after exactly max-repairs repairs and reports FAILED", async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: "Attempted fix",
        error: "",
        timedOut: false,
      });

      // 3 attempts total: maxRepairs = 2 -> 1 initial + 2 repairs
      mockRunChecks
        .mockResolvedValueOnce([
          {
            name: "tests",
            command: "npm",
            args: ["test"],
            status: "failed",
            exitCode: 1,
            durationMs: 100,
            stdout: "",
            stderr: "Fail 1",
          },
        ])
        .mockResolvedValueOnce([
          {
            name: "tests",
            command: "npm",
            args: ["test"],
            status: "failed",
            exitCode: 1,
            durationMs: 100,
            stdout: "",
            stderr: "Fail 2",
          },
        ])
        .mockResolvedValueOnce([
          {
            name: "tests",
            command: "npm",
            args: ["test"],
            status: "failed",
            exitCode: 1,
            durationMs: 100,
            stdout: "",
            stderr: "Fail 3",
          },
        ]);

      await runTask("Fix broken test", { maxRepairs: 2 });

      expect(mockRunOpenCode).toHaveBeenCalledTimes(3);
      expect(mockRunChecks).toHaveBeenCalledTimes(3);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Attempts used: 3 of 3");
      expect(allLogs).toContain("Verdict: FAILED");
      expect(process.exitCode).toBe(1);
    });

    it("--max-repairs 0 makes no repair call", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Initial run",
        error: "",
        timedOut: false,
      });

      mockRunChecks.mockResolvedValueOnce([
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "failed",
          exitCode: 1,
          durationMs: 100,
          stdout: "",
          stderr: "Test failure",
        },
      ]);

      await runTask("Task with no repairs", { maxRepairs: 0 });

      expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
      expect(mockRunChecks).toHaveBeenCalledTimes(1);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Attempts used: 1 of 1");
      expect(allLogs).toContain("Verdict: FAILED");
      expect(process.exitCode).toBe(1);
    });

    it("UNVERIFIED triggers no repair", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Initial run",
        error: "",
        timedOut: false,
      });

      mockRunChecks.mockResolvedValueOnce([
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          skipReason: "Script 'test' not found in package.json",
        },
      ]);

      await runTask("Task without tests", { maxRepairs: 2 });

      expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
      expect(mockRunChecks).toHaveBeenCalledTimes(1);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Attempts used: 1 of 3");
      expect(allLogs).toContain("Verdict: UNVERIFIED");
      expect(process.exitCode).toBe(1);
    });

    it("OpenCode failure during a repair stops", async () => {
      mockRunOpenCode
        .mockResolvedValueOnce({
          success: true,
          output: "First run OK",
          error: "",
          timedOut: false,
        })
        .mockResolvedValueOnce({
          success: false,
          output: "",
          error: "API rate limit reached",
          timedOut: false,
        });

      mockRunChecks.mockResolvedValueOnce([
        {
          name: "typecheck",
          command: "npm",
          args: ["run", "typecheck"],
          status: "failed",
          exitCode: 1,
          durationMs: 100,
          stdout: "",
          stderr: "Syntax error",
        },
      ]);

      await runTask("Task that fails repair", { maxRepairs: 2 });

      expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      expect(mockRunChecks).toHaveBeenCalledTimes(1);

      const allErrors = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allErrors).toContain("Task failed: API rate limit reached");
      expect(allErrors).toContain("Nothing was verified.");
      expect(process.exitCode).toBe(1);
    });

    it("identical failure output stops early", async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: "Done",
        error: "",
        timedOut: false,
      });

      const sameFailure: CheckResult[] = [
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "failed",
          exitCode: 1,
          durationMs: 100,
          stdout: "",
          stderr: "Same exact error output",
        },
      ];

      // Return identical error for attempts 1 and 2
      mockRunChecks
        .mockResolvedValueOnce(sameFailure)
        .mockResolvedValueOnce(sameFailure);

      await runTask("Task with unchanging error", { maxRepairs: 3 });

      // Should stop after 2 runs instead of continuing through all 4
      expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      expect(mockRunChecks).toHaveBeenCalledTimes(2);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Stopping repair loop: failure output is identical to the previous attempt");
      expect(process.exitCode).toBe(1);
    });

    it("the repair prompt contains the original task and failed output and does not contain passed checks", () => {
      const failedChecks: CheckResult[] = [
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "failed",
          exitCode: 1,
          durationMs: 100,
          stdout: "",
          stderr: "AssertionError: expected true to be false",
        },
      ];

      const repairPrompt = buildRepairPrompt(
        "Build authentication flow",
        failedChecks
      );

      expect(repairPrompt).toContain("Build authentication flow");
      expect(repairPrompt).toContain(
        "The following checks failed after your changes. Fix the problems. Change only what is needed, do not delete or weaken tests, and do not edit package.json scripts to make checks pass."
      );
      expect(repairPrompt).toContain("Check 'tests' failed:");
      expect(repairPrompt).toContain(
        "AssertionError: expected true to be false"
      );
      expect(repairPrompt).not.toContain("typecheck");
      expect(repairPrompt).not.toContain("Check 'passed'");
    });
  });
});
