import { createHash, randomUUID } from "node:crypto";
import type {
  SiteAgentAppCapabilityProfile,
  SiteAgentAppMcpConsentReceipt,
  SiteAgentAppMcpRecommendationRow,
} from "../../shared/site-studio";

/**
 * Policy-approved MCP inventory for untrusted Site Agent Apps. Keep this list
 * separate from the global MCP registry: a globally installed tool is not an
 * Agent App capability until this boundary explicitly admits it.
 */
// Only Agentlas-owned, content-pinned artifacts may execute for an untrusted
// Agent App. Brave's catalog entry currently installs through unpinned npx, so
// it remains visible in the global MCP catalog but cannot cross this boundary.
export const SITE_AGENT_APP_READONLY_MCP_CATALOG_IDS = ["agentlas-time"] as const;
export const SITE_AGENT_APP_READONLY_MCP_ALLOWLIST = new Set<string>(
  SITE_AGENT_APP_READONLY_MCP_CATALOG_IDS,
);

const CONSENT_POLICY_VERSION = "site-agent-app-readonly-mcp-consent.v1";
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

function declaredIds(profile: SiteAgentAppCapabilityProfile | null | undefined): string[] {
  if (!profile || !Array.isArray(profile.readonlyMcpCatalogIds)) return [];
  return [...new Set(
    profile.readonlyMcpCatalogIds
      .filter((id): id is string => typeof id === "string" && SAFE_ID_RE.test(id))
      .filter((id) => SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(id)),
  )].sort();
}

/** Stable consent binding. Environment readiness is intentionally not part of it. */
export function siteAgentAppMcpRecommendationDigest(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
): string {
  return createHash("sha256")
    .update(CONSENT_POLICY_VERSION)
    .update("\0")
    .update(JSON.stringify(declaredIds(profile)))
    .digest("hex");
}

/**
 * Value-free TOCTOU binding for the exact rows shown in the native review.
 * Names/marks are display copy and deliberately excluded; grant-affecting
 * install, enable, key, and readiness facts are all included.
 */
export function siteAgentAppMcpReadinessDigest(
  rows: SiteAgentAppMcpRecommendationRow[],
): string {
  const frozen = rows.map((row) => ({
    catalogId: row.catalogId,
    credentialMode: row.credentialMode,
    installed: row.installed,
    enabled: row.enabled,
    keyState: row.keyState,
    readiness: row.readiness,
  })).sort((a, b) => a.catalogId.localeCompare(b.catalogId));
  return createHash("sha256")
    .update(CONSENT_POLICY_VERSION)
    .update("\0readiness\0")
    .update(JSON.stringify(frozen))
    .digest("hex");
}

export function createSiteAgentAppMcpConsentReceipt(input: {
  projectId: string;
  profile: SiteAgentAppCapabilityProfile | null | undefined;
  decision: SiteAgentAppMcpConsentReceipt["decision"];
  readinessDigest: string;
  /** Catalog ids that were ready and visible at the exact approval moment. */
  approvedCatalogIds: string[];
  now?: Date;
}): SiteAgentAppMcpConsentReceipt {
  if (!SHA256_RE.test(input.readinessDigest)) {
    throw new Error("Agent App MCP readiness digest is invalid.");
  }
  const ids = declaredIds(input.profile);
  const approvedCatalogIds = input.decision === "approved"
    ? [...new Set(input.approvedCatalogIds)]
      .filter((id) => ids.includes(id))
      .sort()
    : [];
  return {
    schemaVersion: 1,
    receiptId: randomUUID(),
    projectId: input.projectId,
    recommendationDigest: siteAgentAppMcpRecommendationDigest(input.profile),
    readinessDigest: input.readinessDigest,
    decision: input.decision,
    approvedCatalogIds,
    decidedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** Strict persistence normalizer; unknown fields and malformed values are discarded. */
export function normalizeSiteAgentAppMcpConsentReceipt(
  value: unknown,
): SiteAgentAppMcpConsentReceipt | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SiteAgentAppMcpConsentReceipt>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.receiptId !== "string" ||
    !UUID_RE.test(raw.receiptId) ||
    typeof raw.projectId !== "string" ||
    !UUID_RE.test(raw.projectId) ||
    typeof raw.recommendationDigest !== "string" ||
    !SHA256_RE.test(raw.recommendationDigest) ||
    typeof raw.readinessDigest !== "string" ||
    !SHA256_RE.test(raw.readinessDigest) ||
    (raw.decision !== "approved" && raw.decision !== "declined") ||
    !Array.isArray(raw.approvedCatalogIds) ||
    typeof raw.decidedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.decidedAt))
  ) return null;
  if (raw.approvedCatalogIds.some(
    (id) => typeof id !== "string" || !SAFE_ID_RE.test(id) || !SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(id),
  )) return null;
  const approvedCatalogIds = [...new Set(raw.approvedCatalogIds)].sort();
  if (approvedCatalogIds.length !== raw.approvedCatalogIds.length) return null;
  if (raw.decision === "declined" && approvedCatalogIds.length > 0) return null;
  return {
    schemaVersion: 1,
    receiptId: raw.receiptId,
    projectId: raw.projectId,
    recommendationDigest: raw.recommendationDigest,
    readinessDigest: raw.readinessDigest,
    decision: raw.decision,
    approvedCatalogIds,
    decidedAt: new Date(raw.decidedAt).toISOString(),
  };
}

export function validSiteAgentAppMcpConsentDecision(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
  projectId: string,
  receipt: SiteAgentAppMcpConsentReceipt | null | undefined,
  expectedReadinessDigest?: string,
): SiteAgentAppMcpConsentReceipt["decision"] | null {
  const normalized = normalizeSiteAgentAppMcpConsentReceipt(receipt);
  if (!normalized || normalized.projectId !== projectId) return null;
  const ids = declaredIds(profile);
  if (normalized.recommendationDigest !== siteAgentAppMcpRecommendationDigest(profile)) return null;
  if (expectedReadinessDigest && normalized.readinessDigest !== expectedReadinessDigest) return null;
  if (normalized.decision === "approved") {
    if (normalized.approvedCatalogIds.some((id) => !ids.includes(id))) return null;
  }
  return normalized.decision;
}

export function approvedSiteAgentAppMcpCatalogIds(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
  projectId: string,
  receipt: SiteAgentAppMcpConsentReceipt | null | undefined,
): string[] {
  if (validSiteAgentAppMcpConsentDecision(profile, projectId, receipt) !== "approved") return [];
  return normalizeSiteAgentAppMcpConsentReceipt(receipt)?.approvedCatalogIds ?? [];
}
