import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunOpenCode = vi.fn();

vi.mock("../src/adapters/opencode.js", () => ({
  runOpenCode: (...args: unknown[]) => mockRunOpenCode(...args),
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
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("success: prints cleaned output, does not print error banner, sets no exit code", async () => {
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
    expect(logSpy).toHaveBeenCalledWith("Success: created project");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("failure: prints clear failure line with cleaned error to stderr and sets exitCode to 1", async () => {
    mockRunOpenCode.mockResolvedValueOnce({
      success: false,
      output: "",
      error: "\u001b[31mError: module not found\u001b[0m",
      timedOut: false,
    });

    await runTask("Build the project");

    expect(errorSpy).toHaveBeenCalled();
    const errorMessage = errorSpy.mock.calls[0]?.[0] as string;
    expect(errorMessage).toContain("Task failed");
    expect(errorMessage).toContain("Error: module not found");
    expect(errorMessage).not.toContain("\u001b[31m");
    expect(process.exitCode).toBe(1);
  });

  it("timeout: reports timed out and sets exitCode to 1", async () => {
    mockRunOpenCode.mockResolvedValueOnce({
      success: false,
      output: "",
      error: "Command execution killed",
      timedOut: true,
    });

    await runTask("Long task that exceeds limit");

    expect(errorSpy).toHaveBeenCalled();
    const errorMessage = errorSpy.mock.calls[0]?.[0] as string;
    expect(errorMessage.toLowerCase()).toContain("timed out");
    expect(errorMessage).toContain("Command execution killed");
    expect(process.exitCode).toBe(1);
  });

  it("empty task: rejects empty prompt with clear message, exitCode 1, and never calls adapter", async () => {
    await runTask("");

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot be empty")
    );
    expect(process.exitCode).toBe(1);

    // Also test whitespace-only task
    errorSpy.mockClear();
    process.exitCode = undefined;

    await runTask("    ");

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot be empty")
    );
    expect(process.exitCode).toBe(1);
  });
});
