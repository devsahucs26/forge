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

import { runOpenCode } from "../src/adapters/opencode.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void;

describe("runOpenCode adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExistsSync.mockImplementation((targetPath: unknown) => {
      if (
        typeof targetPath === "string" &&
        targetPath.includes("opencode.exe")
      ) {
        return true;
      }
      return false;
    });

    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        cb?.(null, "Mocked command output", "");
        return mockChild;
      }
    );
  });

  it("success: process exits normally, result has success true, the stdout as output, timedOut false", async () => {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        cb?.(null, "Task completed successfully", "");
        return mockChild;
      }
    );

    const result = await runOpenCode("C:\\mock\\project", "Build the app");

    expect(result.success).toBe(true);
    expect(result.output).toBe("Task completed successfully");
    expect(result.error).toBe("");
    expect(result.timedOut).toBe(false);
    expect(mockStdinEnd).toHaveBeenCalled();
  });

  it("non-zero exit: success false, timedOut false, error contains the message", async () => {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        const err = Object.assign(new Error("Process failed"), {
          code: 1,
          killed: false,
        });
        cb?.(err, "", "Fatal error: unexpected token");
        return mockChild;
      }
    );

    const result = await runOpenCode("C:\\mock\\project", "Run broken code");

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain("Fatal error: unexpected token");
  });

  it("timeout: error with killed true, success false, timedOut true", async () => {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        const err = Object.assign(new Error("Process timed out"), {
          killed: true,
          signal: "SIGTERM",
        });
        cb?.(err, "", "Command timed out after 120000ms");
        return mockChild;
      }
    );

    const result = await runOpenCode("C:\\mock\\project", "Infinite loop");

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("Command timed out");
  });

  it("output too large: error code ERR_CHILD_PROCESS_STDIO_MAXBUFFER gives success false, timedOut false, error mentioning 5 MB", async () => {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        const err = Object.assign(new Error("maxBuffer exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          killed: true,
        });
        cb?.(err, "", "");
        return mockChild;
      }
    );

    const result = await runOpenCode("C:\\mock\\project", "Generate 10MB logs");

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain("5 MB");
  });

  it("the prompt is passed as a separate argument, unchanged, and the options include no shell and no shell: true", async () => {
    let capturedFile = "";
    let capturedArgs: string[] = [];
    let capturedOptions: Record<string, unknown> = {};

    mockExecFile.mockImplementation(
      (
        file: string,
        args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(null, "C:\\mocked\\opencode.exe\r\n", "");
          return mockChild;
        }

        capturedFile = file;
        capturedArgs = args;
        capturedOptions = (options as Record<string, unknown>) ?? {};
        cb?.(null, "ADAPTER_OK", "");
        return mockChild;
      }
    );

    const complexPrompt =
      'Reply with exactly ADAPTER_OK. & echo SHELL_INJECTED > test.txt | rm -rf / ; "quotes"';

    const result = await runOpenCode("C:\\mock\\project", complexPrompt);

    expect(result.success).toBe(true);
    // Prompt must be passed as an argument in the array, completely unchanged
    expect(capturedArgs).toEqual(["run", complexPrompt]);

    // Options must not include shell: true or any shell
    expect(capturedOptions.shell).toBeFalsy();

    // The invoked binary must not be a shell wrapper
    const lowerFile = capturedFile.toLowerCase();
    expect(lowerFile).not.toContain("cmd.exe");
    expect(lowerFile).not.toContain("powershell");
    expect(lowerFile).not.toContain("bash");
    expect(lowerFile).not.toContain("sh.exe");
  });

  it("executable not found: runOpenCode returns success false instead of throwing", async () => {
    mockExecFile.mockImplementation(
      (
        file: string,
        _args: string[],
        options: unknown,
        callback?: ExecFileCallback
      ) => {
        const cb = (
          typeof options === "function" ? options : callback
        ) as ExecFileCallback | undefined;

        if (file === "where.exe") {
          cb?.(new Error("where.exe failed: not found"), "", "");
          return mockChild;
        }

        cb?.(new Error("spawn ENOENT"), "", "");
        return mockChild;
      }
    );

    mockExistsSync.mockReturnValue(false);

    let threw = false;
    let result;
    try {
      result = await runOpenCode("C:\\mock\\project", "Some prompt");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result?.success).toBe(false);
    expect(result?.timedOut).toBe(false);
    expect(result?.error).toBeTruthy();
  });
});
