import fs from "node:fs";
import path from "node:path";
import type { CheckDefinition, CheckResult } from "./checks.js";

export type DefaultChecksList = (CheckDefinition | CheckResult)[] & {
  checks: CheckDefinition[];
  skipped: CheckResult[];
  skippedResults: CheckResult[];
};

export function getDefaultChecks(cwd: string): DefaultChecksList {
  const pkgPath = path.join(cwd, "package.json");
  let scripts: Record<string, string> = {};

  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) {
        scripts = parsed.scripts;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  const items: (CheckDefinition | CheckResult)[] = [];

  if (typeof scripts.typecheck === "string") {
    items.push({
      name: "typecheck",
      command: "npm",
      args: ["run", "typecheck"],
    });
  } else {
    items.push({
      name: "typecheck",
      command: "npm",
      args: ["run", "typecheck"],
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      skipReason: "Script 'typecheck' not found in package.json",
    });
  }

  if (typeof scripts.test === "string") {
    items.push({
      name: "tests",
      command: "npm",
      args: ["test"],
    });
  } else {
    items.push({
      name: "tests",
      command: "npm",
      args: ["test"],
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      skipReason: "Script 'test' not found in package.json",
    });
  }

  const list = items as DefaultChecksList;
  list.checks = items.filter(
    (item): item is CheckDefinition =>
      !("status" in item && item.status === "skipped")
  );
  list.skipped = items.filter(
    (item): item is CheckResult => "status" in item && item.status === "skipped"
  );
  list.skippedResults = list.skipped;

  return list;
}
