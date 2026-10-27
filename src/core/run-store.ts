import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripAnsi } from "./text.js";

export type CheckSummary = {
  name: string;
  status: string;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
};

export type AttemptSummary = {
  number: number;
  kind: "initial" | "repair";
  agentSuccess: boolean;
  timedOut: boolean;
  durationMs: number;
  checks: CheckSummary[];
};

export type RunReport = {
  id: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  options: { allowDirty: boolean; maxRepairs: number };
  startHead: string | null;
  attempts: AttemptSummary[];
  verdict: "VERIFIED" | "FAILED" | "UNVERIFIED" | "AGENT_FAILED";
  changedFiles: string[];
  exitCode: number;
};

export function redact(text: string): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  let result = text;

  // 1. Bearer <token>
  result = result.replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]");

  // 2. sk- style keys (OpenAI / Anthropic etc)
  result = result.replace(/\bsk[-_][A-Za-z0-9_-]+/g, "[REDACTED]");

  // 3. ghp_ / github_pat_ tokens
  result = result.replace(
    /\b(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g,
    "[REDACTED]"
  );

  // 4. KEY/TOKEN/SECRET/PASSWORD assignments like API_KEY=abc
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:_key(?:_|\b)|apikey|\bkey(?:_|\b)|token|secret|password|passwd)[A-Za-z0-9_]*\s*=\s*)(?:(['"])(?:(?!\2).)*\2|\S+)/gi,
    "$1[REDACTED]"
  );

  return result;
}

export function sanitizeOutputTail(output: string): string {
  const stripped = stripAnsi(output || "");
  const redacted = redact(stripped);
  return redacted.length > 2000 ? redacted.slice(-2000) : redacted;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redact(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "outputTail" && typeof v === "string") {
        result[k] = sanitizeOutputTail(v);
      } else {
        result[k] = redactDeep(v);
      }
    }
    return result as T;
  }
  return value;
}

export function generateRunId(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  const randomSuffix = crypto.randomBytes(3).toString("hex");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z-${randomSuffix}`;
}

export function saveRunReport(cwd: string, report: RunReport): string | null {
  try {
    const id =
      report.id && typeof report.id === "string" && report.id.trim()
        ? report.id.trim()
        : generateRunId();

    const reportWithId: RunReport = { ...report, id };
    const sanitizedReport = redactDeep(reportWithId);

    const runDir = path.join(cwd, ".forge", "runs", id);
    fs.mkdirSync(runDir, { recursive: true });
    const filePath = path.join(runDir, "report.json");
    fs.writeFileSync(filePath, JSON.stringify(sanitizedReport, null, 2), "utf-8");
    return filePath;
  } catch {
    return null;
  }
}
