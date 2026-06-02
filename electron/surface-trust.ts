// Trust registry and linter for Agentlas Surface Manifest.
// This is the product boundary between a nice-looking model answer and an OS
// object that can be safely persisted, reopened, and operated.
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceCapability,
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
} from "../shared/types";
import { lintSurfaceDelegation } from "../shared/surface-delegation";

export interface SurfaceTrustRule {
  id: string;
  severity: "error";
  description: string;
}

export const SURFACE_TRUST_REGISTRY: SurfaceTrustRule[] = [
  {
    id: "no-executable-payloads",
    severity: "error",
    description: "Surface manifests may not contain executable HTML, JavaScript, CSS, iframes, or event handlers.",
  },
  {
    id: "mutating-actions-require-capability",
    severity: "error",
    description: "Actions that write files, install tools, connect services, use credentials, or request payment need declared capabilities.",
  },
  {
    id: "generation-requires-budget",
    severity: "error",
    description: "Model generation or paid jobs require a budget with limit and approval threshold.",
  },
  {
    id: "remote-media-requires-allowlist",
    severity: "error",
    description: "Remote media rendered or materialized by a surface needs a network/external-api allowlist.",
  },
  {
    id: "important-values-require-evidence",
    severity: "error",
    description: "Rows containing important numbers, prices, dates, or percentages must point to evidence or mark a source/trust kind.",
  },
  {
    id: "claims-reference-known-evidence",
    severity: "error",
    description: "Claim evidenceIds must refer to evidence entries present in the same manifest.",
  },
  {
    id: "missing-service-requires-delegation-path",
    severity: "error",
    description: "Missing/proposed service connectors must declare an OS delegation path: MCP/API, browser, vault credential, payment approval, alternate provider, or generated helper.",
  },
  {
    id: "payment-requires-explicit-approval-contract",
    severity: "error",
    description: "Payment actions must declare merchant, quote or amount/currency, recurrence, approval mode, and no raw card storage.",
  },
];

const EXECUTABLE_KEY_RE = /^(html|css|script|scripts|javascript|jsx|tsx|iframe|srcdoc|dangerouslySetInnerHTML|on[A-Z].*)$/;
const EXECUTABLE_STRING_RE = /<\s*(script|iframe|style|link|object|embed)\b|javascript:|on(?:click|load|error|submit|mouseover)\s*=/i;
const URL_KEYS = ["url", "src", "thumbnail", "previewUrl", "imageUrl", "videoUrl", "fileUrl"];
const IMPORTANT_KEY_RE = /(price|cost|amount|total|revenue|profit|rate|percent|percentage|score|deadline|date|eta|limit|budget|metric|kpi)/i;
const PRICE_OR_PERCENT_RE = /(?:[$€£₩¥]\s?\d|\d[\d,]*(?:\.\d+)?\s?(?:%|usd|krw|eur|gbp|jpy|원|달러))/i;
const ISOISH_DATE_RE = /\b(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]20\d{2})\b/;
const MUTATING_CAPABILITY_REQUIREMENTS: Record<string, string[]> = {
  generate: ["model-generation"],
  "scaffold-agent-team": ["filesystem"],
  "scaffold-app": ["filesystem"],
  "operate-app": ["filesystem", "browser-session", "credential", "human-approval"],
  "install-mcp": ["filesystem"],
  "deploy-preview": ["filesystem", "external-api", "network"],
  "scaffold-tool": ["filesystem"],
  "run-tool-smoke": ["filesystem"],
  "install-tool-mcp": ["filesystem"],
  "materialize-asset-pack": ["filesystem"],
  "run-smoke-test": ["filesystem"],
  "connect-service": ["browser-session", "external-api", "credential"],
  "delegate-browser": ["browser-session"],
  "request-credential": ["credential"],
  "request-payment-approval": ["human-approval", "payment", "payment-method"],
};

export function lintSurfaceTrust(manifest: AgentlasSurfaceManifest): string[] {
  const errors: string[] = [];
  const capabilities = manifest.capabilities ?? [];

  if (containsExecutablePayload(manifest as unknown as JsonValue)) {
    errors.push(
      "Trust rule no-executable-payloads: manifest contains executable HTML/JS/CSS/iframe/event-handler content.",
    );
  }

  for (const action of manifest.actions ?? []) {
    const required = MUTATING_CAPABILITY_REQUIREMENTS[action.type];
    if (!required) continue;
    if (!hasAnyCapability(capabilities, required)) {
      errors.push(
        `Trust rule mutating-actions-require-capability: action "${action.id}" (${action.type}) requires one of [${required.join(", ")}].`,
      );
    }
  }

  const hasGeneration =
    hasAnyCapability(capabilities, ["model-generation"]) ||
    (manifest.actions ?? []).some((action) => action.type === "generate") ||
    (manifest.jobs ?? []).some((job) => Number(job.costEstimate ?? 0) > 0 || Number(job.costSpent ?? 0) > 0);
  if (hasGeneration) {
    if (
      typeof manifest.budget?.limit !== "number" ||
      typeof manifest.budget?.approvalThreshold !== "number" ||
      !manifest.budget.currency
    ) {
      errors.push(
        "Trust rule generation-requires-budget: generation/paid jobs require budget.currency, budget.limit, and budget.approvalThreshold.",
      );
    }
    if (!manifest.jobs?.length) {
      errors.push("Trust rule generation-requires-budget: generation work requires durable jobs with stable ids.");
    }
  }

  for (const url of remoteMediaUrls(manifest)) {
    if (!isRemoteAllowed(capabilities, url)) {
      errors.push(`Trust rule remote-media-requires-allowlist: remote media URL is not allowlisted: ${url}`);
    }
  }

  for (const issue of importantValueIssues(manifest)) {
    errors.push(`Trust rule important-values-require-evidence: ${issue}`);
  }

  const evidenceIds = new Set((manifest.evidence ?? []).map((item) => item.id));
  for (const claim of manifest.claims ?? []) {
    for (const id of claim.evidenceIds ?? []) {
      if (!evidenceIds.has(id)) {
        errors.push(`Trust rule claims-reference-known-evidence: claim "${claim.id}" references missing evidence "${id}".`);
      }
    }
  }

  for (const issue of lintSurfaceDelegation(manifest)) {
    const rule = issue.toLowerCase().includes("payment")
      ? "payment-requires-explicit-approval-contract"
      : "missing-service-requires-delegation-path";
    errors.push(`Trust rule ${rule}: ${issue}`);
  }

  return errors;
}

function hasAnyCapability(capabilities: AgentlasSurfaceCapability[], types: string[]): boolean {
  return capabilities.some((capability) => types.includes(capability.type));
}

function containsExecutablePayload(value: JsonValue): boolean {
  if (typeof value === "string") return EXECUTABLE_STRING_RE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsExecutablePayload(item));
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => EXECUTABLE_KEY_RE.test(key) || containsExecutablePayload(nested));
}

function remoteMediaUrls(manifest: AgentlasSurfaceManifest): string[] {
  const urls: string[] = [];
  for (const [name, data] of Object.entries(manifest.data)) {
    if (data.type !== "media" && name !== "assets") continue;
    for (const row of rowsOf(data)) {
      for (const key of URL_KEYS) {
        const value = stringField(row, key);
        if (value && /^https?:\/\//i.test(value)) urls.push(value);
      }
    }
  }
  return [...new Set(urls)];
}

function importantValueIssues(manifest: AgentlasSurfaceManifest): string[] {
  const issues: string[] = [];
  for (const [dataName, data] of Object.entries(manifest.data)) {
    for (const [rowIndex, row] of rowsOf(data).entries()) {
      if (!rowHasImportantValue(row) || rowHasEvidence(row)) continue;
      issues.push(`data.${dataName}.rows[${rowIndex}] contains a number/price/date/KPI-like value without evidenceIds, source, or trust kind.`);
    }
  }
  return issues;
}

function rowHasImportantValue(row: JsonObject): boolean {
  for (const [key, value] of Object.entries(row)) {
    if (key === "evidenceIds" || key === "evidenceId" || key === "sourceId") continue;
    if (typeof value === "number" && IMPORTANT_KEY_RE.test(key)) return true;
    if (typeof value !== "string") continue;
    if (IMPORTANT_KEY_RE.test(key) && value.trim()) return true;
    if (PRICE_OR_PERCENT_RE.test(value) || ISOISH_DATE_RE.test(value)) return true;
  }
  return false;
}

function rowHasEvidence(row: JsonObject): boolean {
  return Boolean(
    stringField(row, "evidenceId") ||
      stringField(row, "sourceId") ||
      stringField(row, "source") ||
      stringField(row, "provider") ||
      stringField(row, "kind") ||
      stringField(row, "evidenceKind") ||
      stringField(row, "trust") ||
      (Array.isArray(row.evidenceIds) && row.evidenceIds.some((item) => typeof item === "string" && item.trim())),
  );
}

function isRemoteAllowed(capabilities: AgentlasSurfaceCapability[], url: string): boolean {
  return capabilities.some((capability) => {
    if (capability.type !== "network" && capability.type !== "external-api") return false;
    return (capability.allowlist ?? []).some((entry) => allowlistMatches(entry, url));
  });
}

function allowlistMatches(entry: string, url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedEntry = new URL(entry);
    if (parsedUrl.origin === parsedEntry.origin) return true;
    return url.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
  } catch {
    return false;
  }
}

function rowsOf(data: AgentlasSurfaceDataSet): JsonObject[] {
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function stringField(row: JsonObject, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
