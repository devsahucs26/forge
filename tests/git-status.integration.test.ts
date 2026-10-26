import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStatus } from "../src/workspace/git.js";

describe("git status integration test", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("checks parsed statuses from a real git repo with modified and untracked files", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-status-test-"));

    // Initialize git repository
    execFileSync("git", ["init"], { cwd: tempDir, windowsHide: true });

    // Set local git author configs and autocrlf
    execFileSync("git", ["config", "user.name", "Forge Integration Tester"], {
      cwd: tempDir,
      windowsHide: true,
    });
    execFileSync("git", ["config", "user.email", "forge-tester@example.com"], {
      cwd: tempDir,
      windowsHide: true,
    });
    execFileSync("git", ["config", "core.autocrlf", "false"], {
      cwd: tempDir,
      windowsHide: true,
    });

    // Create an initial file, stage it, and commit it
    const trackedPath = path.join(tempDir, "existing-tracked.txt");
    fs.writeFileSync(trackedPath, "initial tracked content\n", "utf8");
    execFileSync("git", ["add", "existing-tracked.txt"], {
      cwd: tempDir,
      windowsHide: true,
    });
    execFileSync("git", ["commit", "-m", "initial commit"], {
      cwd: tempDir,
      windowsHide: true,
    });

    // Modify the tracked file
    fs.appendFileSync(trackedPath, "updated tracked content\n", "utf8");

    // Create a new untracked file
    const untrackedPath = path.join(tempDir, "brand-new-untracked.txt");
    fs.writeFileSync(untrackedPath, "new untracked file content\n", "utf8");

    // Inspect status with getStatus
    const statusResult = await getStatus(tempDir);

    expect(statusResult.clean).toBe(false);
    expect(statusResult.changedFiles).toContain("existing-tracked.txt");
    expect(statusResult.changedFiles).toContain("brand-new-untracked.txt");
    expect(statusResult.trackedFiles).toEqual(["existing-tracked.txt"]);
    expect(statusResult.untrackedFiles).toEqual(["brand-new-untracked.txt"]);

    const trackedEntry = statusResult.files.find(
      (f) => f.path === "existing-tracked.txt"
    );
    expect(trackedEntry).toBeDefined();
    expect(trackedEntry?.type).toBe("tracked");
    expect(trackedEntry?.status).toBe(" M");

    const untrackedEntry = statusResult.files.find(
      (f) => f.path === "brand-new-untracked.txt"
    );
    expect(untrackedEntry).toBeDefined();
    expect(untrackedEntry?.type).toBe("untracked");
    expect(untrackedEntry?.status).toBe("??");
  });
});
