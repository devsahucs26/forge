import type { CheckResult } from "./checks.js";

export function formatReport(results: CheckResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    const statusMap: Record<CheckResult["status"], string> = {
      passed: "PASS",
      failed: "FAIL",
      timed_out: "TIMEOUT",
      skipped: "SKIPPED",
    };

    const statusLabel = statusMap[r.status] || r.status.toUpperCase();
    const exitLabel = r.exitCode !== null ? `exit ${r.exitCode}` : "exit none";
    const durationLabel = `${Math.round(r.durationMs)}ms`;

    if (r.status === "skipped") {
      const reasonPart = r.skipReason ? ` - ${r.skipReason}` : "";
      lines.push(`${r.name}: ${statusLabel} (${exitLabel}, ${durationLabel})${reasonPart}`);
    } else {
      lines.push(`${r.name}: ${statusLabel} (${exitLabel}, ${durationLabel})`);
    }

    if (r.status === "failed" || r.status === "timed_out") {
      const failedOutput = [r.stdout, r.stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      if (failedOutput) {
        lines.push(failedOutput);
      }
    }
  }

  let verdict: "VERIFIED" | "FAILED" | "UNVERIFIED";
  if (results.length === 0) {
    verdict = "UNVERIFIED";
  } else if (results.some((r) => r.status === "failed" || r.status === "timed_out")) {
    verdict = "FAILED";
  } else if (results.some((r) => r.status === "skipped")) {
    verdict = "UNVERIFIED";
  } else if (results.every((r) => r.status === "passed")) {
    verdict = "VERIFIED";
  } else {
    verdict = "UNVERIFIED";
  }

  lines.push(`Verdict: ${verdict}`);

  return lines.join("\n");
}
