import { Command } from "commander";
import { runOpenCode } from "../adapters/opencode.js";
import { stripAnsi } from "../core/text.js";
import { getDefaultChecks } from "../verification/defaults.js";
import { runChecks } from "../verification/checks.js";
import type { CheckResult } from "../verification/checks.js";
import { formatReport } from "../verification/report.js";
import {
  isGitRepo,
  getStatus,
  getHead,
  getChangedSince,
  getCommittedSince,
} from "../workspace/git.js";
import type { GitStatusResult } from "../workspace/git.js";
import {
  saveRunReport,
  generateRunId,
  type AttemptSummary,
  type CheckSummary,
  type RunReport,
} from "../core/run-store.js";

export type RunOptions = {
  allowDirty?: boolean;
  maxRepairs?: string | number;
  cwd?: string;
};

export function getVerdict(
  results: CheckResult[]
): "VERIFIED" | "FAILED" | "UNVERIFIED" {
  if (results.length === 0) return "UNVERIFIED";
  if (results.some((r) => r.status === "failed" || r.status === "timed_out")) {
    return "FAILED";
  }
  if (results.some((r) => r.status === "skipped")) {
    return "UNVERIFIED";
  }
  if (results.every((r) => r.status === "passed")) {
    return "VERIFIED";
  }
  return "UNVERIFIED";
}

export function buildRepairPrompt(
  task: string,
  failedChecks: CheckResult[]
): string {
  const parts: string[] = [
    task,
    "",
    "The following checks failed after your changes. Fix the problems. Change only what is needed, do not delete or weaken tests, and do not edit package.json scripts to make checks pass.",
    "",
  ];

  for (const check of failedChecks) {
    const rawOutput = [check.stdout, check.stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    const cleanedOutput = stripAnsi(rawOutput).slice(-4000).trim();
    parts.push(`Check '${check.name}' failed:`);
    if (cleanedOutput) {
      parts.push(cleanedOutput);
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}

export function quoteForPowerShell(filePath: string): string {
  return `'${filePath.replace(/'/g, "''")}'`;
}

export type ManualItem = {
  path: string;
  note?: string;
};

export type CategorizedChanges = {
  tracked: string[];
  untracked: string[];
  manual: ManualItem[];
};

export function categorizeChanges(
  changedFiles: string[],
  statusData?: Partial<GitStatusResult> | null,
  committedFiles?: string[]
): CategorizedChanges {
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  const manual: ManualItem[] = [];

  const knownTracked = new Set<string>();
  const knownUntracked = new Set<string>();

  if (statusData) {
    if (Array.isArray(statusData.files)) {
      for (const f of statusData.files) {
        if (f.type === "untracked" || f.status === "??") {
          knownUntracked.add(f.path.trim());
        } else {
          knownTracked.add(f.path.trim());
        }
      }
    }
    if (Array.isArray(statusData.trackedFiles)) {
      for (const f of statusData.trackedFiles) knownTracked.add(f.trim());
    }
    if (Array.isArray((statusData as { tracked?: string[] }).tracked)) {
      for (const f of (statusData as { tracked: string[] }).tracked)
        knownTracked.add(f.trim());
    }
    if (
      Array.isArray((statusData as { modifiedFiles?: string[] }).modifiedFiles)
    ) {
      for (const f of (statusData as { modifiedFiles: string[] }).modifiedFiles)
        knownTracked.add(f.trim());
    }
    if (
      Array.isArray((statusData as { deletedFiles?: string[] }).deletedFiles)
    ) {
      for (const f of (statusData as { deletedFiles: string[] }).deletedFiles)
        knownTracked.add(f.trim());
    }
    if (Array.isArray(statusData.untrackedFiles)) {
      for (const f of statusData.untrackedFiles) knownUntracked.add(f.trim());
    }
    if (Array.isArray((statusData as { untracked?: string[] }).untracked)) {
      for (const f of (statusData as { untracked: string[] }).untracked)
        knownUntracked.add(f.trim());
    }

    if (Array.isArray(statusData.changedFiles)) {
      for (const item of statusData.changedFiles) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed.startsWith("??")) {
            const path = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
            if (path) knownUntracked.add(path);
          } else if (
            /^[MADRCU?! ][MADRCU?! ]\s+/.test(trimmed) ||
            /^[MADRC]\s+/.test(trimmed)
          ) {
            const rawPath = trimmed.replace(/^[MADRCU?! ]+\s+/, "").trim();
            const path = rawPath.includes(" -> ")
              ? rawPath.split(" -> ").pop()!.trim().replace(/^["']|["']$/g, "")
              : rawPath.replace(/^["']|["']$/g, "");
            if (path) knownTracked.add(path);
          }
        } else if (item && typeof item === "object") {
          const path = (item as { path?: string }).path?.trim();
          if (path) {
            const obj = item as { type?: string; status?: string };
            if (obj.type === "untracked" || obj.status === "??") {
              knownUntracked.add(path);
            } else if (
              obj.type === "tracked" ||
              obj.type === "modified" ||
              obj.type === "deleted" ||
              (obj.status && /^[MADRC]/.test(obj.status))
            ) {
              knownTracked.add(path);
            }
          }
        }
      }
    }
  }

  const committedSet = new Set((committedFiles ?? []).map((f) => f.trim()));

  for (const rawFile of changedFiles) {
    if (typeof rawFile !== "string") continue;
    let file = rawFile.trim();

    if (!file) continue;

    const cleanPath = file.includes(" -> ")
      ? file.split(" -> ").pop()!.trim().replace(/^["']|["']$/g, "")
      : file.replace(/^["']|["']$/g, "");

    if (committedSet.has(cleanPath)) {
      manual.push({ path: cleanPath, note: "committed during run" });
      continue;
    }

    if (file.startsWith("??")) {
      untracked.add(file.slice(2).trim().replace(/^["']|["']$/g, ""));
    } else if (
      /^[MADRCU?! ][MADRCU?! ]\s+/.test(file) ||
      /^[MADRC]\s+/.test(file)
    ) {
      const rawPath = file.replace(/^[MADRCU?! ]+\s+/, "").trim();
      const target = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()!.trim().replace(/^["']|["']$/g, "")
        : rawPath.replace(/^["']|["']$/g, "");
      tracked.add(target);
    } else if (knownUntracked.has(cleanPath)) {
      untracked.add(cleanPath);
    } else if (knownTracked.has(cleanPath)) {
      tracked.add(cleanPath);
    } else {
      manual.push({ path: cleanPath });
    }
  }

  return {
    tracked: Array.from(tracked),
    untracked: Array.from(untracked),
    manual,
  };
}

export async function reportChangedFiles(
  cwd: string,
  startHead: string | null
): Promise<void> {
  const changedFiles = await getChangedSince(cwd, startHead);
  const currentStatus = await getStatus(cwd);
  const committedFiles = await getCommittedSince(cwd, startHead);

  if (changedFiles.length === 0) {
    console.log("No files changed.");
  } else {
    console.log("Files changed by this run:");
    const categorized = categorizeChanges(
      changedFiles,
      currentStatus,
      committedFiles
    );

    if (categorized.tracked.length > 0) {
      console.log("  Tracked files (modified or deleted):");
      for (const file of categorized.tracked) {
        console.log(`    ${file}`);
      }
      const quoted = categorized.tracked.map(quoteForPowerShell).join(" ");
      console.log(`  To undo: git restore ${quoted}`);
    }

    if (categorized.untracked.length > 0) {
      console.log("  Untracked files (new):");
      for (const file of categorized.untracked) {
        console.log(`    ${file}`);
      }
      const quoted = categorized.untracked.map(quoteForPowerShell).join(", ");
      console.log(`  To undo: Remove-Item ${quoted}`);
    }

    if (categorized.manual.length > 0) {
      console.log("  Review manually:");
      for (const item of categorized.manual) {
        if (item.note) {
          console.log(`    ${item.path} (${item.note})`);
        } else {
          console.log(`    ${item.path}`);
        }
      }
    }
  }

  console.log('To review changes: git diff (and "git status" for new files).');
  console.log("Note: Forge never runs these commands automatically.");
}

export async function runTask(
  prompt: string,
  options?: RunOptions
): Promise<void> {
  if (!prompt || !prompt.trim()) {
    console.error("Error: task description cannot be empty.");
    process.exitCode = 1;
    return;
  }

  let maxRepairs = 2;
  if (options?.maxRepairs !== undefined) {
    const rawVal = options.maxRepairs;
    const parsed =
      typeof rawVal === "number"
        ? rawVal
        : typeof rawVal === "string" && rawVal.trim() !== ""
        ? Number(rawVal.trim())
        : NaN;

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
      console.error(
        "Error: --max-repairs must be an integer between 0 and 5."
      );
      process.exitCode = 1;
      return;
    }
    maxRepairs = parsed;
  }

  const cwd = options?.cwd ?? process.cwd();
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    console.error("Error: current directory is not a git repository.");
    process.exitCode = 1;
    return;
  }

  const status = await getStatus(cwd);
  if (!status.clean) {
    if (!options?.allowDirty) {
      console.error(
        "Error: working tree is not clean. Uncommitted changes detected:"
      );
      for (const file of status.changedFiles) {
        console.error(`  ${file}`);
      }
      console.error(
        "Commit or stash your changes, or pass --allow-dirty to proceed anyway."
      );
      process.exitCode = 1;
      return;
    } else {
      console.warn(
        "Warning: working tree is not clean (--allow-dirty specified). Proceeding with uncommitted changes."
      );
    }
  }

  const startHead = await getHead(cwd);
  const runStartTime = Date.now();
  const startedAt = new Date(runStartTime).toISOString();
  const MAX_RUN_TIME_MS = 15 * 60 * 1000;

  const totalAttempts = 1 + maxRepairs;
  let attempt = 1;
  let lastFailureKey: string | null = null;
  let lastCheckResults: CheckResult[] = [];
  let currentPrompt = prompt;
  const attempts: AttemptSummary[] = [];

  const finalizeAndSaveReport = async (
    verdict: "VERIFIED" | "FAILED" | "UNVERIFIED" | "AGENT_FAILED",
    exitCode: number
  ) => {
    const finishedAt = new Date().toISOString();
    const changedFiles = await getChangedSince(cwd, startHead);
    const report: RunReport = {
      id: generateRunId(),
      task: prompt,
      startedAt,
      finishedAt,
      options: {
        allowDirty: Boolean(options?.allowDirty),
        maxRepairs,
      },
      startHead,
      attempts,
      verdict,
      changedFiles,
      exitCode,
    };
    const savedPath = saveRunReport(cwd, report);
    if (savedPath) {
      console.log(`Run report saved: ${savedPath}`);
    } else {
      console.log("Run report could not be saved.");
    }
  };

  while (attempt <= totalAttempts) {
    if (Date.now() - runStartTime >= MAX_RUN_TIME_MS) {
      console.error("Error: maximum run duration of 15 minutes exceeded.");
      break;
    }

    const attemptNumber = attempt;
    const attemptKind: "initial" | "repair" =
      attempt === 1 ? "initial" : "repair";
    const attemptStart = Date.now();

    const result = await runOpenCode(cwd, currentPrompt);

    const cleanedOutput = stripAnsi(result.output).trim();
    if (cleanedOutput) {
      console.log(cleanedOutput);
    }

    if (!result.success) {
      const attemptDuration = Date.now() - attemptStart;
      attempts.push({
        number: attemptNumber,
        kind: attemptKind,
        agentSuccess: false,
        timedOut: Boolean(result.timedOut),
        durationMs: attemptDuration,
        checks: [],
      });

      const cleanedError = stripAnsi(result.error).trim();
      let failureLine: string;
      if (result.timedOut) {
        failureLine = cleanedError
          ? `Task timed out: ${cleanedError}`
          : "Task timed out.";
      } else {
        failureLine = cleanedError
          ? `Task failed: ${cleanedError}`
          : "Task failed.";
      }
      console.error(failureLine);
      console.error("Nothing was verified.");
      process.exitCode = 1;
      await reportChangedFiles(cwd, startHead);
      await finalizeAndSaveReport("AGENT_FAILED", 1);
      return;
    }

    // Run verification checks
    const checks = getDefaultChecks(cwd);
    const checkResults = await runChecks(checks, cwd);
    lastCheckResults = checkResults;
    const attemptDuration = Date.now() - attemptStart;

    const checkSummaries: CheckSummary[] = checkResults.map((c) => {
      const raw = [c.stdout, c.stderr].filter(Boolean).join("\n");
      const stripped = stripAnsi(raw);
      const outputTail =
        stripped.length > 2000 ? stripped.slice(-2000) : stripped;
      return {
        name: c.name,
        status: c.status,
        exitCode: c.exitCode ?? null,
        durationMs: c.durationMs,
        outputTail,
      };
    });

    attempts.push({
      number: attemptNumber,
      kind: attemptKind,
      agentSuccess: true,
      timedOut: false,
      durationMs: attemptDuration,
      checks: checkSummaries,
    });

    const verdict = getVerdict(checkResults);

    if (verdict === "VERIFIED") {
      break;
    }

    if (verdict === "UNVERIFIED") {
      // Do NOT repair when UNVERIFIED; report it and stop.
      break;
    }

    // verdict is FAILED
    const failedChecks = checkResults.filter(
      (r) => r.status === "failed" || r.status === "timed_out"
    );

    const failureKey = failedChecks
      .map(
        (r) =>
          `${r.name}:${r.status}:${r.exitCode}:${r.stdout.trim()}:${r.stderr.trim()}`
      )
      .join("|||");

    if (lastFailureKey !== null && failureKey === lastFailureKey) {
      console.log(
        "Stopping repair loop: failure output is identical to the previous attempt (no progress detected)."
      );
      break;
    }
    lastFailureKey = failureKey;

    if (attempt >= totalAttempts) {
      break;
    }

    console.log(
      `Attempt ${attempt} of ${totalAttempts}: checks failed, asking the agent to repair...`
    );

    currentPrompt = buildRepairPrompt(prompt, failedChecks);
    attempt++;
  }

  // Summary and final reporting
  const repairsUsed = attempt - 1;
  console.log(
    `Agent runs: ${attempt} (1 initial + ${repairsUsed} repairs, up to ${maxRepairs} repairs allowed)`
  );
  if (lastCheckResults.length > 0) {
    console.log(formatReport(lastCheckResults));
  }

  const finalVerdict = getVerdict(lastCheckResults);
  const exitCode = finalVerdict === "VERIFIED" ? 0 : 1;
  if (finalVerdict === "VERIFIED") {
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }

  // Report files changed by this run
  await reportChangedFiles(cwd, startHead);

  if (attempts.length > 0) {
    await finalizeAndSaveReport(finalVerdict, exitCode);
  }
}

export const runCommand = new Command("run")
  .description("Run a task using OpenCode agent")
  .argument("<task>", "The task description or prompt to execute")
  .option("--allow-dirty", "Allow running in a dirty git working tree")
  .option(
    "--max-repairs <n>",
    "Maximum number of repair attempts (0-5)",
    "2"
  )
  .action(async (task: string, options: RunOptions) => {
    await runTask(task, options);
  });
