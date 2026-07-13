import type {
  SiteAgentAppMcpConsentReceipt,
  SiteAgentAppMcpCredentialMode,
  SiteAgentAppMcpKeyState,
  SiteAgentAppMcpReadiness,
  SiteAgentAppMcpRecommendation,
  SiteAgentAppMcpRecommendationRow,
  SiteProjectMeta,
} from "../../shared/site-studio";
import type { InstalledMcpServer, McpToolCatalogEntry } from "../../shared/types";
import { getCatalogEntry } from "../mcp-tools/catalog";
import { listInstalledServers } from "../mcp-tools/registry";
import { hasEnvVar } from "../secrets/vault";
import { hasPinnedSiteAgentAppExecutable } from "./agent-app-capabilities";
import {
  createSiteAgentAppMcpConsentReceipt,
  validSiteAgentAppMcpConsentDecision,
} from "./agent-app-mcp-consent";
import {
  getSiteProject,
  updateSiteAgentAppMcpConsent,
} from "./store";

export type SiteAgentAppMcpRecommendationDeps = {
  listInstalled?: () => InstalledMcpServer[];
  hasCredential?: (key: string) => Promise<boolean>;
};

function safeDisplay(value: unknown, fallback: string, max = 100): string {
  const text = typeof value === "string"
    ? value.replace(/[\0\r\n`<>]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return (text || fallback).slice(0, max);
}

function requiredCredentialKeys(entry: McpToolCatalogEntry): string[] {
  return entry.envRequirements
    .filter((requirement) => requirement.required)
    .map((requirement) => requirement.key);
}

export function siteAgentAppMcpCredentialMode(entry: McpToolCatalogEntry): SiteAgentAppMcpCredentialMode {
  return requiredCredentialKeys(entry).length > 0 ? "key-required" : "keyless";
}

async function rowForEntry(
  entry: McpToolCatalogEntry,
  allRows: InstalledMcpServer[],
  registryAvailable: boolean,
  hasCredential: (key: string) => Promise<boolean>,
): Promise<SiteAgentAppMcpRecommendationRow> {
  const rows = allRows.filter((server) => server.catalogId === entry.id);
  const enabledRows = rows.filter((server) => server.enabled);
  const requiredKeys = requiredCredentialKeys(entry);
  let keyState: SiteAgentAppMcpKeyState = requiredKeys.length ? "unknown" : "not-required";
  if (requiredKeys.length) {
    try {
      const states = await Promise.all(requiredKeys.map((key) => hasCredential(key)));
      keyState = states.every(Boolean) ? "present" : "missing";
    } catch {
      keyState = "unknown";
    }
  }

  const exactlyConfigured = enabledRows.length === 1 &&
    hasPinnedSiteAgentAppExecutable(enabledRows[0]) &&
    requiredKeys.every((key) => enabledRows[0].envKeys.includes(key));
  let readiness: SiteAgentAppMcpReadiness;
  if (!registryAvailable) readiness = "not-configured";
  else if (!rows.length) readiness = "not-installed";
  else if (!exactlyConfigured || keyState === "unknown") readiness = "not-configured";
  else if (keyState === "missing") readiness = "missing-key";
  else readiness = "ready";

  return {
    catalogId: entry.id,
    name: safeDisplay(entry.nameEn || entry.name, entry.id),
    mark: safeDisplay(entry.mark, "M", 3),
    credentialMode: siteAgentAppMcpCredentialMode(entry),
    installed: rows.length > 0,
    enabled: enabledRows.length > 0,
    keyState,
    readiness,
  };
}

/**
 * Read-only, value-safe recommendation. It reads only catalog metadata,
 * registry booleans, and Keychain presence booleans; it never probes or starts
 * an MCP process. Connection verification remains a one-run preflight.
 */
export async function recommendSiteAgentAppMcpForProject(
  project: SiteProjectMeta,
  deps: SiteAgentAppMcpRecommendationDeps = {},
): Promise<SiteAgentAppMcpRecommendation> {
  if (project.surface !== "agent-app") throw new Error("Agent App project required.");
  const ids = project.agentAppContract?.capabilities.readonlyMcpCatalogIds ?? [];
  let registryAvailable = true;
  let installed: InstalledMcpServer[] = [];
  try {
    installed = (deps.listInstalled ?? listInstalledServers)();
  } catch {
    registryAvailable = false;
  }
  const hasCredential = deps.hasCredential ?? hasEnvVar;
  const rows: SiteAgentAppMcpRecommendationRow[] = [];
  for (const id of ids) {
    const entry = getCatalogEntry(id);
    if (!entry) continue;
    rows.push(await rowForEntry(entry, installed, registryAvailable, hasCredential));
  }

  const decision = validSiteAgentAppMcpConsentDecision(
    project.agentAppContract?.capabilities,
    project.id,
    project.agentAppMcpConsent,
  );
  const status: SiteAgentAppMcpRecommendation["status"] = rows.length === 0
    ? "not-required"
    : decision === "approved"
      ? "approved"
      : decision === "declined"
        ? "declined"
        : "review-required";
  const receipt = decision ? project.agentAppMcpConsent : null;
  return {
    schemaVersion: 1,
    projectId: project.id,
    targetName: safeDisplay(project.agentAppTarget?.name, "Agent App", 160),
    status,
    rows,
    receiptId: receipt?.receiptId ?? null,
    decidedAt: receipt?.decidedAt ?? null,
  };
}

export async function getSiteAgentAppMcpRecommendation(
  projectId: string,
): Promise<SiteAgentAppMcpRecommendation> {
  return recommendSiteAgentAppMcpForProject(getSiteProject(projectId));
}

export async function recordSiteAgentAppMcpDecision(
  projectId: string,
  decision: SiteAgentAppMcpConsentReceipt["decision"],
): Promise<SiteAgentAppMcpRecommendation> {
  const project = getSiteProject(projectId);
  if (project.surface !== "agent-app" || !project.agentAppContract) {
    throw new Error("Agent App MCP recommendation is unavailable.");
  }
  if (project.agentAppContract.capabilities.readonlyMcpCatalogIds.length === 0) {
    return recommendSiteAgentAppMcpForProject(project);
  }
  const receipt = createSiteAgentAppMcpConsentReceipt({
    projectId: project.id,
    profile: project.agentAppContract.capabilities,
    decision,
  });
  const updated = updateSiteAgentAppMcpConsent(project.id, receipt);
  return recommendSiteAgentAppMcpForProject(updated);
}
