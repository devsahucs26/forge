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

import { runTask } from "../src/commands/run.js";

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
      expect(process.exitCode).toBeUndefined();
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

  describe("Task execution & verification", () => {
    it("success: runs verification when OpenCode succeeds and sets no error code when VERIFIED", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "\u001b[32mSuccess: created project\u001b[0m\r\n",
        error: "\x1B[0m\r\n> build · auto\r\n\x1B[0m\r\n",
        timedOut: false,
      });

      await runTask("Create a hello world app");

      expect(mockRunOpenCode).toHaveBeenCalledWith(
        process.cwd(),
        "Create a hello world app"
      );
      expect(mockRunChecks).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Success: created project");
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("VERIFIED"));
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it("success: sets exitCode 1 when verification is FAILED", async () => {
      mockRunOpenCode.mockResolvedValueOnce({
        success: true,
        output: "Done",
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
          durationMs: 200,
          stdout: "",
          stderr: "Tests failed",
        },
      ]);

      await runTask("Make changes");

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("FAILED"));
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
  });
});
