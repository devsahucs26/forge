import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStdinEnd = vi.fn();
const mockChild = {
  stdin: {
    end: mockStdinEnd,
  },
};

const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    default: {
      ...(actual.default || {}),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    },
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

import { runChecks } from "../src/verification/checks.js";
import { getDefaultChecks } from "../src/verification/defaults.js";
import { formatReport } from "../src/verification/report.js";
import type { CheckResult } from "../src/verification/checks.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void;

describe("Verification engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExistsSync.mockReturnValue(true);

    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof _options === "function" ? _options : callback
        ) as ExecFileCallback | undefined;
        cb?.(null, "Check passed output", "");
        return mockChild;
      }
    );
  });

  describe("runChecks", () => {
    it("passed: normal execution returns passed status, exitCode 0, trimmed and stripped stdout", async () => {
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _opt: unknown, cb?: ExecFileCallback) => {
          cb?.(null, "\u001b[32mSuccess: all clean\u001b[0m\n", "");
          return mockChild;
        }
      );

      const checks = [
        { name: "test-check", command: "node", args: ["--version"] },
      ];
      const results = await runChecks(checks, "C:\\test\\dir");

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("passed");
      expect(results[0]?.exitCode).toBe(0);
      expect(results[0]?.stdout).toBe("Success: all clean\n");
      expect(results[0]?.stderr).toBe("");
      expect(mockStdinEnd).toHaveBeenCalled();
    });

    it("failed: non-zero exit code returns failed status with exitCode", async () => {
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _opt: unknown, cb?: ExecFileCallback) => {
          const err = Object.assign(new Error("Command failed"), {
            code: 2,
            killed: false,
          });
          cb?.(err, "", "Lint failed on line 12");
          return mockChild;
        }
      );

      const checks = [
        { name: "lint", command: "node", args: ["lint.js"] },
      ];
      const results = await runChecks(checks, "C:\\test\\dir");

      expect(results[0]?.status).toBe("failed");
      expect(results[0]?.exitCode).toBe(2);
      expect(results[0]?.stderr).toBe("Lint failed on line 12");
    });

    it("timed out: killed by timeout returns timed_out status with null exitCode", async () => {
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _opt: unknown, cb?: ExecFileCallback) => {
          const err = Object.assign(new Error("Timed out"), {
            killed: true,
            signal: "SIGTERM",
          });
          cb?.(err, "Partial stdout", "Process killed");
          return mockChild;
        }
      );

      const checks = [
        { name: "long-task", command: "node", args: ["sleep.js"] },
      ];
      const results = await runChecks(checks, "C:\\test\\dir", 1000);

      expect(results[0]?.status).toBe("timed_out");
      expect(results[0]?.exitCode).toBeNull();
    });

    it("max-buffer overflow: returns failed (not timed_out) and mentions 5 MB", async () => {
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _opt: unknown, cb?: ExecFileCallback) => {
          const err = Object.assign(new Error("maxBuffer exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
          });
          cb?.(err, "", "");
          return mockChild;
        }
      );

      const checks = [
        { name: "big-output", command: "node", args: ["generate.js"] },
      ];
      const results = await runChecks(checks, "C:\\test\\dir");

      expect(results[0]?.status).toBe("failed");
      expect(results[0]?.stderr).toContain("5 MB");
    });

    it("limits output to the last 4000 characters", async () => {
      const hugeOutput = "A".repeat(5000) + "END_OF_OUTPUT";
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _opt: unknown, cb?: ExecFileCallback) => {
          cb?.(null, hugeOutput, "");
          return mockChild;
        }
      );

      const checks = [
        { name: "overflow-text", command: "node", args: ["huge.js"] },
      ];
      const results = await runChecks(checks, "C:\\test\\dir");

      expect(results[0]?.stdout.length).toBe(4000);
      expect(results[0]?.stdout.endsWith("END_OF_OUTPUT")).toBe(true);
    });

    it("skipped: skips execution when check has skipReason or status skipped", async () => {
      const checks = [
        {
          name: "skipped-check",
          command: "npm",
          args: ["test"],
          skipReason: "Script not found",
        },
      ];
      const results = await runChecks(checks, "C:\\test\\dir");

      expect(results[0]?.status).toBe("skipped");
      expect(results[0]?.skipReason).toBe("Script not found");
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("never throws: handles unexpected exceptions and returns failed result", async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error("Synchronous spawn crash");
      });

      const checks = [
        { name: "crashing-check", command: "node", args: ["crash.js"] },
      ];

      let results: CheckResult[] = [];
      let threw = false;
      try {
        results = await runChecks(checks, "C:\\test\\dir");
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("failed");
      expect(results[0]?.stderr).toContain("Synchronous spawn crash");
    });
  });

  describe("getDefaultChecks", () => {
    it("returns both typecheck and tests when present in package.json", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: {
            typecheck: "tsc --noEmit",
            test: "vitest run",
          },
        })
      );

      const checks = getDefaultChecks("C:\\mock\\app");
      expect(checks).toHaveLength(2);
      expect(checks[0]?.name).toBe("typecheck");
      expect("status" in (checks[0] ?? {})).toBe(false);
      expect(checks[1]?.name).toBe("tests");
      expect("status" in (checks[1] ?? {})).toBe(false);
    });

    it("returns skipped checks when scripts are missing", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: {},
        })
      );

      const checks = getDefaultChecks("C:\\mock\\app");
      expect(checks).toHaveLength(2);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toContain("typecheck");
      expect(checks[1]?.status).toBe("skipped");
      expect(checks[1]?.skipReason).toContain("test");
    });
  });

  describe("formatReport", () => {
    it("returns VERIFIED when all checks pass", () => {
      const results: CheckResult[] = [
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
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "passed",
          exitCode: 0,
          durationMs: 450,
          stdout: "",
          stderr: "",
        },
      ];

      const report = formatReport(results);
      expect(report).toContain("typecheck: PASS (exit 0, 120ms)");
      expect(report).toContain("tests: PASS (exit 0, 450ms)");
      expect(report.trim().endsWith("VERIFIED")).toBe(true);
      expect(report).toContain("Verdict: VERIFIED");
    });

    it("returns FAILED when any check fails or times out, and includes failure output", () => {
      const results: CheckResult[] = [
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
        {
          name: "tests",
          command: "npm",
          args: ["test"],
          status: "failed",
          exitCode: 1,
          durationMs: 300,
          stdout: "",
          stderr: "AssertionError: expected 1 to be 2",
        },
      ];

      const report = formatReport(results);
      expect(report).toContain("tests: FAIL (exit 1, 300ms)");
      expect(report).toContain("AssertionError: expected 1 to be 2");
      expect(report.trim().endsWith("FAILED")).toBe(true);
    });

    it("returns UNVERIFIED when nothing failed but at least one check was skipped", () => {
      const results: CheckResult[] = [
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
      ];

      const report = formatReport(results);
      expect(report).toContain("tests: SKIPPED (exit none, 0ms) - Script 'test' not found in package.json");
      expect(report.trim().endsWith("UNVERIFIED")).toBe(true);
      expect(report).toContain("Verdict: UNVERIFIED");
    });

    it("returns UNVERIFIED when no checks exist", () => {
      const report = formatReport([]);
      expect(report.trim().endsWith("UNVERIFIED")).toBe(true);
      expect(report).toContain("Verdict: UNVERIFIED");
    });
  });
});
