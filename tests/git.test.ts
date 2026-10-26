import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStdinEnd = vi.fn();
const mockChild = {
  stdin: {
    end: mockStdinEnd,
  },
};

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import {
  isGitRepo,
  getStatus,
  getHead,
  getChangedSince,
} from "../src/workspace/git.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void;

describe("git workspace helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isGitRepo", () => {
    it("returns true when inside a git work tree", async () => {
      mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: ExecFileCallback) => {
        cb?.(null, "true\n", "");
        return mockChild;
      });

      const result = await isGitRepo("C:\\test\\repo");
      expect(result).toBe(true);
      expect(mockStdinEnd).toHaveBeenCalled();
    });

    it("returns false when not inside a git work tree", async () => {
      mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: ExecFileCallback) => {
        cb?.(new Error("fatal: not a git repository"), "", "");
        return mockChild;
      });

      const result = await isGitRepo("C:\\test\\not-repo");
      expect(result).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns clean: true and empty array when working tree has no changes", async () => {
      mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: ExecFileCallback) => {
        cb?.(null, "", "");
        return mockChild;
      });

      const result = await getStatus("C:\\test\\repo");
      expect(result.clean).toBe(true);
      expect(result.changedFiles).toEqual([]);
    });

    it("returns clean: false and parsed changed files when dirty", async () => {
      let passedArgs: string[] = [];
      mockExecFile.mockImplementation(
        (_f: string, args: string[], _o: unknown, cb?: ExecFileCallback) => {
          passedArgs = args;
          const output =
            " M src/index.ts\0?? new-file.txt\0R  renamed.ts\0old.ts\0";
          cb?.(null, output, "");
          return mockChild;
        }
      );

      const result = await getStatus("C:\\test\\repo");
      expect(passedArgs).toEqual([
        "status",
        "--porcelain=v1",
        "-z",
        "-uall",
      ]);
      expect(result.clean).toBe(false);
      expect(result.changedFiles).toEqual([
        "src/index.ts",
        "new-file.txt",
        "renamed.ts",
      ]);
      expect(result.trackedFiles).toEqual(["src/index.ts", "renamed.ts"]);
      expect(result.untrackedFiles).toEqual(["new-file.txt"]);
      expect(result.files).toEqual([
        { path: "src/index.ts", status: " M", type: "tracked" },
        { path: "new-file.txt", status: "??", type: "untracked" },
        {
          path: "renamed.ts",
          status: "R ",
          type: "tracked",
          origPath: "old.ts",
        },
      ]);
    });
  });

  describe("getHead", () => {
    it("returns commit hash when HEAD exists", async () => {
      mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: ExecFileCallback) => {
        cb?.(null, "abcdef1234567890\n", "");
        return mockChild;
      });

      const head = await getHead("C:\\test\\repo");
      expect(head).toBe("abcdef1234567890");
    });

    it("returns null when no commits exist", async () => {
      mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: ExecFileCallback) => {
        cb?.(new Error("fatal: ambiguous argument 'HEAD'"), "", "");
        return mockChild;
      });

      const head = await getHead("C:\\test\\repo");
      expect(head).toBeNull();
    });
  });

  describe("getChangedSince", () => {
    it("returns uncommitted and committed changes since startHead", async () => {
      mockExecFile.mockImplementation(
        (_f: string, args: string[], _o: unknown, cb?: ExecFileCallback) => {
          if (args.includes("status")) {
            cb?.(null, " M src/modified.ts\r\n?? untracked.ts\r\n", "");
          } else if (args.includes("diff")) {
            cb?.(null, "src/committed.ts\r\n", "");
          } else if (args[0] === "rev-parse" && args[1] === "HEAD") {
            cb?.(null, "newhead456\n", "");
          } else {
            cb?.(null, "", "");
          }
          return mockChild;
        }
      );

      const files = await getChangedSince("C:\\test\\repo", "oldhead123");
      expect(files).toContain("src/modified.ts");
      expect(files).toContain("untracked.ts");
      expect(files).toContain("src/committed.ts");
    });

    it("handles startHead === null when commits were created during the run", async () => {
      mockExecFile.mockImplementation(
        (_f: string, args: string[], _o: unknown, cb?: ExecFileCallback) => {
          if (args.includes("status")) {
            cb?.(null, "?? uncommitted.ts\r\n", "");
          } else if (args.includes("log")) {
            cb?.(null, "initial.ts\r\n", "");
          } else if (args[0] === "rev-parse" && args[1] === "HEAD") {
            cb?.(null, "firstcommit\n", "");
          } else {
            cb?.(null, "", "");
          }
          return mockChild;
        }
      );

      const files = await getChangedSince("C:\\test\\repo", null);
      expect(files).toContain("uncommitted.ts");
      expect(files).toContain("initial.ts");
    });
  });

  describe("git failure handled without throwing", () => {
    it("never throws when git execution fails or crashes", async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error("Git binary not found");
      });

      await expect(isGitRepo("C:\\test")).resolves.toBe(false);
      await expect(getStatus("C:\\test")).resolves.toEqual({
        clean: false,
        changedFiles: [],
        files: [],
        trackedFiles: [],
        untrackedFiles: [],
      });
      await expect(getHead("C:\\test")).resolves.toBeNull();
      await expect(getChangedSince("C:\\test", "somehead")).resolves.toEqual([]);
    });
  });
});
