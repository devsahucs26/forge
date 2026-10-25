import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunOpenCode = vi.fn();
const mockGetDefaultChecks = vi.fn();
const mockRunChecks = vi.fn();

vi.mock("../src/adapters/opencode.js", () => ({
  runOpenCode: (...args: unknown[]) => mockRunOpenCode(...args),
}));

vi.mock("../src/verification/defaults.js", () => ({
  getDefaultChecks: (...args: unknown[]) => mockGetDefaultChecks(...args),
}));

vi.mock("../src/verification/checks.js", () => ({
  runChecks: (...args: unknown[]) => mockRunChecks(...args),
}));

import { runTask } from "../src/commands/run.js";

describe("runTask command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

  it("success: sets exitCode 1 when verification is UNVERIFIED", async () => {
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
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        skipReason: "Script not found",
      },
    ]);

    await runTask("Make changes");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("UNVERIFIED"));
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

  it("empty task: rejects empty prompt with clear message, exitCode 1, and never calls adapter or checks", async () => {
    await runTask("");

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(mockRunChecks).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot be empty")
    );
    expect(process.exitCode).toBe(1);

    // Also test whitespace-only task
    errorSpy.mockClear();
    process.exitCode = undefined;

    await runTask("    ");

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(mockRunChecks).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot be empty")
    );
    expect(process.exitCode).toBe(1);
  });
});
