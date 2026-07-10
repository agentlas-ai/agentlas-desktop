export type BuildScanDisposition = "passed" | "warning" | "blocked" | "unverified";
export type BuildScanSeverityBucket = "passed" | "warning" | "blocked";

export interface BuildScanFinding {
  severity: string;
  message: string;
  file?: string;
}

function normalizedGateValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function buildScanFindings(scan: unknown): BuildScanFinding[] | null {
  if (Array.isArray(scan)) {
    return scan.map(normalizeFinding);
  }
  if (!scan || typeof scan !== "object") return null;
  const record = scan as Record<string, unknown>;
  if (record.status === "unverified" || record.ok === false) return null;
  if (!Array.isArray(record.findings)) return null;
  return record.findings.map(normalizeFinding);
}

export function buildScanDisposition(scan: unknown): BuildScanDisposition {
  if (scan && typeof scan === "object" && !Array.isArray(scan)) {
    const record = scan as Record<string, unknown>;
    if (normalizedGateValue(record.status) === "unverified" || record.ok === false) return "unverified";
    const gate = normalizedGateValue(record.verdict ?? record.status);
    if (["block", "blocked", "fail", "failed", "deny", "denied"].includes(gate)) return "blocked";
    if (["warn", "warning", "needs-review", "review"].includes(gate)) return "warning";
  }
  const findings = buildScanFindings(scan);
  if (!findings) return "unverified";
  if (findings.some((finding) => buildScanSeverityBucket(finding.severity) === "blocked")) return "blocked";
  if (findings.some((finding) => buildScanSeverityBucket(finding.severity) === "warning")) return "warning";
  return "passed";
}

export function buildScanSeverityBucket(severity: unknown): BuildScanSeverityBucket {
  const value = String(severity ?? "").trim();
  if (/^(block|blocked|blocker|critical|high|fail|failed)$/i.test(value)) return "blocked";
  if (/^(warning|warn|medium|needs-review|review)$/i.test(value)) return "warning";
  return "passed";
}

function normalizeFinding(value: unknown): BuildScanFinding {
  const finding = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    // Agentlas OS security scan uses verdict=BLOCK|WARN while the Cloud package
    // review uses severity=blocker|high|medium. Preserve both contracts.
    severity: String(finding.severity ?? finding.verdict ?? finding.level ?? "info"),
    message: String(finding.message ?? finding.type ?? finding.id ?? "finding"),
    ...(typeof finding.file === "string"
      ? { file: finding.file }
      : typeof finding.path === "string"
        ? { file: finding.path }
        : {}),
  };
}
