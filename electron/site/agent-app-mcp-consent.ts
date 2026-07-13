import { createHash, randomUUID } from "node:crypto";
import type {
  SiteAgentAppCapabilityProfile,
  SiteAgentAppMcpConsentReceipt,
} from "../../shared/site-studio";

/**
 * Policy-approved MCP inventory for untrusted Site Agent Apps. Keep this list
 * separate from the global MCP registry: a globally installed tool is not an
 * Agent App capability until this boundary explicitly admits it.
 */
export const SITE_AGENT_APP_READONLY_MCP_CATALOG_IDS = ["brave-search"] as const;
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

export function createSiteAgentAppMcpConsentReceipt(input: {
  projectId: string;
  profile: SiteAgentAppCapabilityProfile | null | undefined;
  decision: SiteAgentAppMcpConsentReceipt["decision"];
  now?: Date;
}): SiteAgentAppMcpConsentReceipt {
  const ids = declaredIds(input.profile);
  return {
    schemaVersion: 1,
    receiptId: randomUUID(),
    projectId: input.projectId,
    recommendationDigest: siteAgentAppMcpRecommendationDigest(input.profile),
    decision: input.decision,
    approvedCatalogIds: input.decision === "approved" ? ids : [],
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
    (raw.decision !== "approved" && raw.decision !== "declined") ||
    !Array.isArray(raw.approvedCatalogIds) ||
    typeof raw.decidedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.decidedAt))
  ) return null;
  const approvedCatalogIds = [...new Set(raw.approvedCatalogIds.filter(
    (id): id is string => typeof id === "string" && SAFE_ID_RE.test(id) && SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(id),
  ))].sort();
  if (raw.decision === "declined" && approvedCatalogIds.length > 0) return null;
  return {
    schemaVersion: 1,
    receiptId: raw.receiptId,
    projectId: raw.projectId,
    recommendationDigest: raw.recommendationDigest,
    decision: raw.decision,
    approvedCatalogIds,
    decidedAt: new Date(raw.decidedAt).toISOString(),
  };
}

export function validSiteAgentAppMcpConsentDecision(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
  projectId: string,
  receipt: SiteAgentAppMcpConsentReceipt | null | undefined,
): SiteAgentAppMcpConsentReceipt["decision"] | null {
  const normalized = normalizeSiteAgentAppMcpConsentReceipt(receipt);
  if (!normalized || normalized.projectId !== projectId) return null;
  const ids = declaredIds(profile);
  if (normalized.recommendationDigest !== siteAgentAppMcpRecommendationDigest(profile)) return null;
  if (normalized.decision === "approved") {
    if (normalized.approvedCatalogIds.length !== ids.length) return null;
    if (normalized.approvedCatalogIds.some((id, index) => id !== ids[index])) return null;
  }
  return normalized.decision;
}

export function approvedSiteAgentAppMcpCatalogIds(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
  projectId: string,
  receipt: SiteAgentAppMcpConsentReceipt | null | undefined,
): string[] {
  return validSiteAgentAppMcpConsentDecision(profile, projectId, receipt) === "approved"
    ? declaredIds(profile)
    : [];
}
