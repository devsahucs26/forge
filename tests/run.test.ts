import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveRunReport, redact, type RunReport } from "../src/core/run-store.js";

const realRepoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const realRunsDir = path.join(realRepoRoot, ".forge", "runs");
const initialRunsSnapshot = fs.existsSync(realRunsDir)
  ? fs.readdirSync(realRunsDir)
  : [];

const mockRunOpenCode = vi.fn();
const mockGetDefaultChecks = vi.fn();
const mockRunChecks = vi.fn();

const mockIsGitRepo = vi.fn();
const mockGetStatus = vi.fn();
const mockGetHead = vi.fn();
const mockGetChangedSince = vi.fn();
const mockGetCommittedSince = vi.fn();

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
  getCommittedSince: (...args: unknown[]) => mockGetCommittedSince(...args),
}));

import {
  runTask,
  buildRepairPrompt,
  quoteForPowerShell,
  categorizeChanges,
} from "../src/commands/run.js";
import type { CheckResult } from "../src/verification/checks.js";

describe("runTask command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let testCwd: string;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-run-test-cwd-"));
    vi.spyOn(process, "cwd").mockReturnValue(testCwd);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockIsGitRepo.mockResolvedValue(true);
    mockGetStatus.mockResolvedValue({
      clean: true,
      changedFiles: [],
      files: [],
      trackedFiles: [],
      untrackedFiles: [],
    });
    mockGetHead.mockResolvedValue("head12345");
    mockGetChangedSince.mockResolvedValue([]);
    mockGetCommittedSince.mockResolvedValue([]);

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
    if (testCwd && fs.existsSync(testCwd)) {
      try {
        fs.rmSync(testCwd, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  afterAll(() => {
    const currentEntries = fs.existsSync(realRunsDir)
      ? fs.readdirSync(realRunsDir)
      : [];
    expect(
      currentEntries,
      "The test suite created or modified files in the real .forge/runs folder!"
    ).toEqual(initialRunsSnapshot);
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

    it("changed files reported: uncategorized files listed under review manually and safe review hints printed", async () => {
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
      expect(allLogs).toContain("Review manually:");
      expect(allLogs).toContain("src/new.ts");
      expect(allLogs).toContain("tests/new.test.ts");
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
      expect(allLogs).not.toContain("git restore .");
      expect(allLogs).not.toContain("git clean -fd");
    });

    it("changed files split into tracked and untracked groups with PowerShell undo commands", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Updated files",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce([
        "src/modified.ts",
        "src/untracked.ts",
      ]);
      mockGetStatus
        .mockResolvedValueOnce({ clean: true, changedFiles: [] })
        .mockResolvedValueOnce({
          clean: false,
          changedFiles: ["src/modified.ts", "src/untracked.ts"],
          trackedFiles: ["src/modified.ts"],
          untrackedFiles: ["src/untracked.ts"],
        });

      await runTask("Modify and add files");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("Tracked files (modified or deleted):");
      expect(allLogs).toContain("src/modified.ts");
      expect(allLogs).toContain("To undo: git restore 'src/modified.ts'");
      expect(allLogs).toContain("Untracked files (new):");
      expect(allLogs).toContain("src/untracked.ts");
      expect(allLogs).toContain("To undo: Remove-Item 'src/untracked.ts'");
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
      expect(allLogs).not.toContain("git restore .");
      expect(allLogs).not.toContain("git clean -fd");
    });

    it("quotes paths for PowerShell with single quotes and escapes existing single quotes", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Updated files with tricky names",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce([
        "src/it's a tracked file.ts",
        "src/new file with spaces.ts",
      ]);
      mockGetStatus
        .mockResolvedValueOnce({ clean: true, changedFiles: [] })
        .mockResolvedValueOnce({
          clean: false,
          changedFiles: [
            "src/it's a tracked file.ts",
            "src/new file with spaces.ts",
          ],
          trackedFiles: ["src/it's a tracked file.ts"],
          untrackedFiles: ["src/new file with spaces.ts"],
        });

      await runTask("Tricky file paths");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("To undo: git restore 'src/it''s a tracked file.ts'");
      expect(allLogs).toContain("To undo: Remove-Item 'src/new file with spaces.ts'");
    });

    it("brand-new untracked file is classified as untracked and undoes with Remove-Item", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Created hello.txt",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce(["hello.txt"]);
      mockGetStatus
        .mockResolvedValueOnce({
          clean: true,
          changedFiles: [],
          files: [],
          trackedFiles: [],
          untrackedFiles: [],
        })
        .mockResolvedValueOnce({
          clean: false,
          changedFiles: ["hello.txt"],
          trackedFiles: [],
          untrackedFiles: ["hello.txt"],
          files: [{ path: "hello.txt", status: "??", type: "untracked" }],
        });

      await runTask("Create hello.txt");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("Untracked files (new):");
      expect(allLogs).toContain("hello.txt");
      expect(allLogs).toContain("To undo: Remove-Item 'hello.txt'");
      expect(allLogs).not.toContain("Review manually:");
    });

    it("files committed by the agent during run go under review manually with a note", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Committed changes",
        error: "",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce(["src/committed.ts"]);
      mockGetCommittedSince.mockResolvedValueOnce(["src/committed.ts"]);
      mockGetStatus
        .mockResolvedValueOnce({
          clean: true,
          changedFiles: [],
          files: [],
          trackedFiles: [],
          untrackedFiles: [],
        })
        .mockResolvedValueOnce({
          clean: true,
          changedFiles: [],
          files: [],
          trackedFiles: [],
          untrackedFiles: [],
        });

      await runTask("Commit something");

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("Review manually:");
      expect(allLogs).toContain("src/committed.ts (committed during run)");
      expect(allLogs).not.toContain("To undo: git restore 'src/committed.ts'");
      expect(allLogs).not.toContain("To undo: Remove-Item 'src/committed.ts'");
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
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
      expect(allLogs).not.toContain("git restore .");
      expect(allLogs).not.toContain("git clean -fd");
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

    it("OpenCode timeout with a new untracked file still prints the file and 'To undo: Remove-Item ...'", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "Partial output before timeout",
        error: "Execution timed out after 300000ms",
        timedOut: true,
      });
      mockGetChangedSince.mockResolvedValueOnce(["temp-created.txt"]);
      mockGetStatus
        .mockResolvedValueOnce({ clean: true, changedFiles: [] })
        .mockResolvedValueOnce({
          clean: false,
          changedFiles: ["temp-created.txt"],
          trackedFiles: [],
          untrackedFiles: ["temp-created.txt"],
          files: [{ path: "temp-created.txt", status: "??", type: "untracked" }],
        });

      await runTask("Task that times out");

      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const errorCalls = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join(" ");
      expect(errorCalls.toLowerCase()).toContain("timed out");
      expect(errorCalls).toContain("Nothing was verified");
      expect(process.exitCode).toBe(1);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("Untracked files (new):");
      expect(allLogs).toContain("temp-created.txt");
      expect(allLogs).toContain("To undo: Remove-Item 'temp-created.txt'");
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
    });

    it("OpenCode failure with a modified tracked file prints 'git restore ...'", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "Error log",
        error: "Compilation failed",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce(["src/index.ts"]);
      mockGetStatus
        .mockResolvedValueOnce({ clean: true, changedFiles: [] })
        .mockResolvedValueOnce({
          clean: false,
          changedFiles: ["src/index.ts"],
          trackedFiles: ["src/index.ts"],
          untrackedFiles: [],
          files: [{ path: "src/index.ts", status: " M", type: "tracked" }],
        });

      await runTask("Task that fails");

      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const errorCalls = errorSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join(" ");
      expect(errorCalls).toContain("Task failed");
      expect(errorCalls).toContain("Nothing was verified");
      expect(process.exitCode).toBe(1);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("Files changed by this run:");
      expect(allLogs).toContain("Tracked files (modified or deleted):");
      expect(allLogs).toContain("src/index.ts");
      expect(allLogs).toContain("To undo: git restore 'src/index.ts'");
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
    });

    it("failure with no changes prints 'No files changed.'", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "",
        error: "General failure",
        timedOut: false,
      });
      mockGetChangedSince.mockResolvedValueOnce([]);

      await runTask("Task that fails with no changes");

      expect(mockRunChecks).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);

      const allLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allLogs).toContain("No files changed.");
      expect(allLogs).toContain('To review changes: git diff (and "git status" for new files).');
      expect(allLogs).toContain("Note: Forge never runs these commands automatically.");
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
      expect(allLogs).toContain(
        "Agent runs: 2 (1 initial + 1 repairs, up to 2 repairs allowed)"
      );
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
      expect(allLogs).toContain(
        "Agent runs: 3 (1 initial + 2 repairs, up to 2 repairs allowed)"
      );
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
      expect(allLogs).toContain(
        "Agent runs: 1 (1 initial + 0 repairs, up to 0 repairs allowed)"
      );
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
      expect(allLogs).toContain(
        "Agent runs: 1 (1 initial + 0 repairs, up to 2 repairs allowed)"
      );
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

  describe("PowerShell quoting and change categorization helpers", () => {
    it("quoteForPowerShell wraps in single quotes and doubles existing single quotes", () => {
      expect(quoteForPowerShell("src/index.ts")).toBe("'src/index.ts'");
      expect(quoteForPowerShell("src/path with spaces.ts")).toBe(
        "'src/path with spaces.ts'"
      );
      expect(quoteForPowerShell("src/it's a test.ts")).toBe(
        "'src/it''s a test.ts'"
      );
      expect(quoteForPowerShell("src/it's 'very' tricky.ts")).toBe(
        "'src/it''s ''very'' tricky.ts'"
      );
    });

    it("categorizeChanges splits into tracked, untracked, and manual groups", () => {
      const changed = [
        "src/tracked.ts",
        "src/untracked.ts",
        "src/unknown.ts",
      ];
      const statusData = {
        clean: false,
        changedFiles: ["src/tracked.ts", "src/untracked.ts", "src/unknown.ts"],
        trackedFiles: ["src/tracked.ts"],
        untrackedFiles: ["src/untracked.ts"],
        files: [
          { path: "src/tracked.ts", status: " M", type: "tracked" as const },
          { path: "src/untracked.ts", status: "??", type: "untracked" as const },
        ],
      };

      const result = categorizeChanges(changed, statusData);
      expect(result.tracked).toEqual(["src/tracked.ts"]);
      expect(result.untracked).toEqual(["src/untracked.ts"]);
      expect(result.manual).toEqual([{ path: "src/unknown.ts" }]);
    });

    it("categorizeChanges parses git porcelain status prefixes", () => {
      const changed = [
        "?? src/new.ts",
        " M src/modified.ts",
        "D  src/deleted.ts",
        "src/other.ts",
      ];
      const result = categorizeChanges(changed);
      expect(result.untracked).toEqual(["src/new.ts"]);
      expect(result.tracked).toEqual(["src/modified.ts", "src/deleted.ts"]);
      expect(result.manual).toEqual([{ path: "src/other.ts" }]);
    });

    it("categorizeChanges flags committed files under manual with a note", () => {
      const changed = ["src/committed.ts", "src/untracked.ts"];
      const statusData = {
        clean: false,
        changedFiles: ["src/untracked.ts"],
        untrackedFiles: ["src/untracked.ts"],
      };
      const committedFiles = ["src/committed.ts"];

      const result = categorizeChanges(changed, statusData, committedFiles);
      expect(result.untracked).toEqual(["src/untracked.ts"]);
      expect(result.manual).toEqual([
        { path: "src/committed.ts", note: "committed during run" },
      ]);
    });
  });

  describe("Run reports and redaction", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-run-report-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    });

    afterEach(() => {
      if (tmpDir && fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
    });

    it("saveRunReport writes valid JSON at the expected path", () => {
      const report: RunReport = {
        id: "20261028T013000Z-ab12cd",
        task: "Implement unit tests",
        startedAt: "2026-10-28T01:30:00.000Z",
        finishedAt: "2026-10-28T01:30:05.000Z",
        options: { allowDirty: false, maxRepairs: 2 },
        startHead: "head123",
        attempts: [
          {
            number: 1,
            kind: "initial",
            agentSuccess: true,
            timedOut: false,
            durationMs: 5000,
            checks: [
              {
                name: "typecheck",
                status: "passed",
                exitCode: 0,
                durationMs: 120,
                outputTail: "Clean typecheck",
              },
            ],
          },
        ],
        verdict: "VERIFIED",
        changedFiles: ["src/feature.ts"],
        exitCode: 0,
      };

      const expectedPath = path.join(
        tmpDir,
        ".forge",
        "runs",
        "20261028T013000Z-ab12cd",
        "report.json"
      );
      const savedPath = saveRunReport(tmpDir, report);

      expect(savedPath).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
      expect(parsed.id).toBe("20261028T013000Z-ab12cd");
      expect(parsed.task).toBe("Implement unit tests");
      expect(parsed.verdict).toBe("VERIFIED");
      expect(parsed.exitCode).toBe(0);
      expect(parsed.attempts).toHaveLength(1);
      expect(parsed.attempts[0].checks[0].name).toBe("typecheck");
    });

    it("redaction masks the patterns above and leaves normal text alone", () => {
      // sk- style keys
      expect(redact("sk-proj-abc1234567890xyz")).toBe("[REDACTED]");
      expect(redact("API key is sk-123456789")).toBe("API key is [REDACTED]");
      expect(redact("sk_live_9876543210")).toBe("[REDACTED]");

      // Bearer <token>
      expect(redact("Authorization: Bearer secret-token-xyz")).toBe(
        "Authorization: Bearer [REDACTED]"
      );
      expect(redact("Bearer my_jwt_token_12345")).toBe("Bearer [REDACTED]");

      // ghp_ and github_pat_ tokens
      expect(redact("Token: ghp_123456789012345678901234567890123456")).toBe(
        "Token: [REDACTED]"
      );
      expect(redact("github_pat_11ABCD_1234567890abcdef")).toBe("[REDACTED]");

      // KEY/TOKEN/SECRET/PASSWORD assignments like API_KEY=abc
      expect(redact("API_KEY=my_secret_key")).toBe("API_KEY=[REDACTED]");
      expect(redact("SECRET=my_super_secret")).toBe("SECRET=[REDACTED]");
      expect(redact("TOKEN=auth_token_999")).toBe("TOKEN=[REDACTED]");
      expect(redact("PASSWORD=db_password_123")).toBe("PASSWORD=[REDACTED]");
      expect(redact("DB_PASSWORD='quoted_secret'")).toBe("DB_PASSWORD=[REDACTED]");
      expect(redact('CLIENT_SECRET="double_quoted"')).toBe("CLIENT_SECRET=[REDACTED]");
      expect(redact("api_key=lowercase_secret")).toBe("api_key=[REDACTED]");

      // Normal text alone
      expect(redact("This is normal text without any credentials.")).toBe(
        "This is normal text without any credentials."
      );
      expect(redact("Everything passed successfully.")).toBe(
        "Everything passed successfully."
      );
      expect(redact("Primary key is id in users table.")).toBe(
        "Primary key is id in users table."
      );
      expect(redact("keyword arguments in python")).toBe(
        "keyword arguments in python"
      );
      expect(redact("monkey=banana")).toBe("monkey=banana");
    });

    it("outputTail is truncated to 2000 characters", () => {
      const longOutput = "\u001b[31m" + "X".repeat(3000) + "\u001b[0m";
      const report: RunReport = {
        id: "20261028T013000Z-longtail",
        task: "Check tail length",
        startedAt: "2026-10-28T01:30:00.000Z",
        finishedAt: "2026-10-28T01:30:01.000Z",
        options: { allowDirty: false, maxRepairs: 0 },
        startHead: "head123",
        attempts: [
          {
            number: 1,
            kind: "initial",
            agentSuccess: true,
            timedOut: false,
            durationMs: 1000,
            checks: [
              {
                name: "longcheck",
                status: "failed",
                exitCode: 1,
                durationMs: 50,
                outputTail: longOutput,
              },
            ],
          },
        ],
        verdict: "FAILED",
        changedFiles: [],
        exitCode: 1,
      };

      const savedPath = saveRunReport(tmpDir, report);
      expect(savedPath).toBeTruthy();

      const parsed = JSON.parse(fs.readFileSync(savedPath!, "utf-8"));
      const tail = parsed.attempts[0].checks[0].outputTail;
      expect(tail.length).toBe(2000);
      expect(tail).toBe("X".repeat(2000));
      expect(tail).not.toContain("\u001b[31m");
    });

    it("a write failure returns null and does not throw", () => {
      const badTarget = path.join(tmpDir, "file_blocking_dir");
      fs.writeFileSync(badTarget, "I am a file, not a directory");

      const report: RunReport = {
        id: "fail-test",
        task: "Test failure",
        startedAt: "2026-10-28T01:30:00.000Z",
        finishedAt: "2026-10-28T01:30:01.000Z",
        options: { allowDirty: false, maxRepairs: 0 },
        startHead: null,
        attempts: [],
        verdict: "UNVERIFIED",
        changedFiles: [],
        exitCode: 1,
      };

      expect(() => {
        const result = saveRunReport(badTarget, report);
        expect(result).toBeNull();
      }).not.toThrow();
    });

    it("runTask saves a report with VERIFIED verdict on success", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Code generated cleanly",
        error: "",
        timedOut: false,
      });
      mockRunChecks.mockResolvedValueOnce([
        {
          name: "typecheck",
          command: "npm",
          args: ["run", "typecheck"],
          status: "passed",
          exitCode: 0,
          durationMs: 50,
          stdout: "ok",
          stderr: "",
        },
      ]);

      await runTask("Build login page", { cwd: tmpDir });
      expect(process.exitCode).toBe(0);

      const runsDir = path.join(tmpDir, ".forge", "runs");
      expect(fs.existsSync(runsDir)).toBe(true);
      const runFolders = fs.readdirSync(runsDir);
      expect(runFolders).toHaveLength(1);

      const successReportPath = path.join(runsDir, runFolders[0], "report.json");
      expect(fs.existsSync(successReportPath)).toBe(true);
      const successReport = JSON.parse(
        fs.readFileSync(successReportPath, "utf-8")
      );
      expect(successReport.verdict).toBe("VERIFIED");
      expect(successReport.exitCode).toBe(0);
      expect(successReport.attempts).toHaveLength(1);
      expect(successReport.attempts[0].agentSuccess).toBe(true);
      expect(successReport.attempts[0].timedOut).toBe(false);

      const allSuccessLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allSuccessLogs).toContain(`Run report saved: ${successReportPath}`);
    });

    it("runTask saves a report with FAILED verdict on failure", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Code with bug",
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
          durationMs: 80,
          stdout: "",
          stderr: "Expected 1 to be 2",
        },
      ]);

      await runTask("Fix broken test", { cwd: tmpDir, maxRepairs: 0 });
      expect(process.exitCode).toBe(1);

      const failRunsDir = path.join(tmpDir, ".forge", "runs");
      const failFolders = fs.readdirSync(failRunsDir);
      expect(failFolders).toHaveLength(1);

      const failureReportPath = path.join(
        failRunsDir,
        failFolders[0],
        "report.json"
      );
      const failureReport = JSON.parse(
        fs.readFileSync(failureReportPath, "utf-8")
      );
      expect(failureReport.verdict).toBe("FAILED");
      expect(failureReport.exitCode).toBe(1);
      expect(failureReport.attempts).toHaveLength(1);
      expect(failureReport.attempts[0].checks[0].status).toBe("failed");

      const allFailLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allFailLogs).toContain(`Run report saved: ${failureReportPath}`);
    });

    it("runTask saves a report with AGENT_FAILED verdict on OpenCode timeout (mocked)", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: false,
        output: "",
        error: "agent process timed out",
        timedOut: true,
      });

      await runTask("Long running task", { cwd: tmpDir });
      expect(process.exitCode).toBe(1);

      const timeoutRunsDir = path.join(tmpDir, ".forge", "runs");
      const timeoutFolders = fs.readdirSync(timeoutRunsDir);
      expect(timeoutFolders).toHaveLength(1);

      const timeoutReportPath = path.join(
        timeoutRunsDir,
        timeoutFolders[0],
        "report.json"
      );
      const timeoutReport = JSON.parse(
        fs.readFileSync(timeoutReportPath, "utf-8")
      );
      expect(timeoutReport.verdict).toBe("AGENT_FAILED");
      expect(timeoutReport.exitCode).toBe(1);
      expect(timeoutReport.attempts).toHaveLength(1);
      expect(timeoutReport.attempts[0].agentSuccess).toBe(false);
      expect(timeoutReport.attempts[0].timedOut).toBe(true);

      const allTimeoutLogs = logSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join("\n");
      expect(allTimeoutLogs).toContain(`Run report saved: ${timeoutReportPath}`);
    });

    it("runTask saves no report when refused because the tree is dirty", async () => {
      mockGetStatus.mockResolvedValueOnce({
        clean: false,
        changedFiles: ["dirty_file.ts"],
      });

      await runTask("Should refuse", { cwd: tmpDir });
      expect(process.exitCode).toBe(1);
      expect(mockRunOpenCode).not.toHaveBeenCalled();

      // No .forge directory should be created
      expect(fs.existsSync(path.join(tmpDir, ".forge"))).toBe(false);
    });
  });
});

describe("Guard: Real project .forge/runs isolation", () => {
  it("verifies the real .forge/runs folder was not modified by the test suite", () => {
    const currentEntries = fs.existsSync(realRunsDir)
      ? fs.readdirSync(realRunsDir)
      : [];
    expect(
      currentEntries,
      "The test suite created or modified files in the real .forge/runs folder!"
    ).toEqual(initialRunsSnapshot);
  });
});

