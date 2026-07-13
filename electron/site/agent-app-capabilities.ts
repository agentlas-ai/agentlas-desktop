import fs from "node:fs";
import path from "node:path";
import type {
  SiteAgentAppCapabilityIssue,
  SiteAgentAppCapabilityProfile,
  SiteAgentAppMcpConsentReceipt,
} from "../../shared/site-studio";
import type { McpInvocationRequest } from "../../shared/types";
import type { InstalledMcpServer, McpServerStatus } from "../../shared/types";
import { getCatalogEntry } from "../mcp-tools/catalog";
import { testServerConnection } from "../mcp-tools/client";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { listInstalledServers } from "../mcp-tools/registry";
import { hasEnvVar } from "../secrets/vault";
import {
  SITE_AGENT_APP_READONLY_MCP_ALLOWLIST,
  validSiteAgentAppMcpConsentDecision,
} from "./agent-app-mcp-consent";

/**
 * Agent Apps accept untrusted browser input. Only catalog capabilities whose
 * effects are independently known to be read-only may cross this boundary.
 * Custom MCP rows and semantic capability names are never executable grants.
 */
const SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const BRAVE_TOOL_ALLOWLIST = new Set(["brave_web_search", "brave_local_search"]);

export type SiteAgentAppCapabilityDisclosure = {
  available: string[];
  unavailable: SiteAgentAppCapabilityIssue[];
};

export type PreparedSiteAgentAppCapabilities = {
  grant: NonNullable<McpInvocationRequest["agentAppRuntimeToolGrant"]> | null;
  disclosure: SiteAgentAppCapabilityDisclosure;
  /** Reconciles a runtime change that happened after the JIT preflight. */
  finalDisclosure: () => SiteAgentAppCapabilityDisclosure;
  cleanup: () => void;
};

export type SiteAgentAppCapabilityPreparationDeps = {
  verifyServer?: (server: InstalledMcpServer) => Promise<McpServerStatus>;
  hasCredential?: (key: string) => Promise<boolean>;
  listInstalled?: () => InstalledMcpServer[];
  buildConfig?: typeof buildMcpConfigFile;
  /** False means run the app stateless/no-tool and disclose the runtime mismatch. */
  runtimeEligible?: boolean;
  /** Required for every non-empty grant; the renderer can never provide either value. */
  projectId?: string;
  consentReceipt?: SiteAgentAppMcpConsentReceipt | null;
};

function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return SAFE_ID_RE.test(id) ? id : null;
}

function uniqueIssues(issues: SiteAgentAppCapabilityIssue[]): SiteAgentAppCapabilityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.id}:${issue.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

export function noSiteAgentAppCapabilities(): SiteAgentAppCapabilityProfile {
  return {
    schemaVersion: 1,
    source: "none",
    readonlyMcpCatalogIds: [],
    unavailable: [],
  };
}

export function declaredSiteAgentAppCapabilities(
  requested: unknown,
  source: Exclude<SiteAgentAppCapabilityProfile["source"], "none">,
  additionalUnavailable: SiteAgentAppCapabilityIssue[] = [],
): SiteAgentAppCapabilityProfile {
  const ids = Array.isArray(requested)
    ? requested.map(safeId).filter((id): id is string => Boolean(id))
    : [];
  const readonlyMcpCatalogIds = [...new Set(ids.filter((id) => SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(id)))];
  const unavailable = ids
    .filter((id) => !SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(id))
    .map((id): SiteAgentAppCapabilityIssue => ({ id, reason: "not-allowlisted" }));
  return {
    schemaVersion: 1,
    source,
    readonlyMcpCatalogIds,
    unavailable: uniqueIssues([...unavailable, ...additionalUnavailable]),
  };
}

/** Strictly rebuild a persisted public profile and drop unknown/private keys. */
export function normalizeSiteAgentAppCapabilityProfile(
  value: unknown,
  fallbackSource: SiteAgentAppCapabilityProfile["source"],
): SiteAgentAppCapabilityProfile {
  if (!value || typeof value !== "object") {
    return fallbackSource === "none"
      ? noSiteAgentAppCapabilities()
      : declaredSiteAgentAppCapabilities([], fallbackSource);
  }
  const raw = value as {
    schemaVersion?: unknown;
    source?: unknown;
    readonlyMcpCatalogIds?: unknown;
    unavailable?: unknown;
  };
  const source = raw.source === "declared-package" || raw.source === "declared-routing-card" || raw.source === "composed-target"
    ? raw.source
    : fallbackSource;
  const issues: SiteAgentAppCapabilityIssue[] = [];
  if (Array.isArray(raw.unavailable)) {
    for (const item of raw.unavailable) {
      if (!item || typeof item !== "object") continue;
      const issue = item as { id?: unknown; reason?: unknown };
      const id = safeId(issue.id);
      if (!id) continue;
      if (
        issue.reason === "not-allowlisted" ||
        issue.reason === "blocked-by-agent-app-policy" ||
        issue.reason === "consent-required" ||
        issue.reason === "not-installed" ||
        issue.reason === "key-missing" ||
        issue.reason === "not-configured" ||
        issue.reason === "runtime-unavailable"
      ) issues.push({ id, reason: issue.reason });
    }
  }
  const normalized = declaredSiteAgentAppCapabilities(raw.readonlyMcpCatalogIds, source === "none" ? "declared-package" : source, issues);
  return source === "none" && normalized.readonlyMcpCatalogIds.length === 0 && normalized.unavailable.length === 0
    ? noSiteAgentAppCapabilities()
    : normalized;
}

export function mergeSiteAgentAppCapabilities(
  profiles: SiteAgentAppCapabilityProfile[],
  requested: string[] = [],
  unavailable: SiteAgentAppCapabilityIssue[] = [],
  forceComposed = false,
): SiteAgentAppCapabilityProfile {
  const nonEmpty = profiles.filter((profile) =>
    profile.source !== "none" || profile.readonlyMcpCatalogIds.length > 0 || profile.unavailable.length > 0);
  if (!nonEmpty.length && !requested.length && !unavailable.length) return noSiteAgentAppCapabilities();
  const source: Exclude<SiteAgentAppCapabilityProfile["source"], "none"> =
    forceComposed || nonEmpty.length > 1 ? "composed-target" : nonEmpty[0]?.source === "declared-routing-card"
      ? "declared-routing-card"
      : "declared-package";
  return declaredSiteAgentAppCapabilities(
    [...requested, ...nonEmpty.flatMap((profile) => profile.readonlyMcpCatalogIds)],
    source,
    [...nonEmpty.flatMap((profile) => profile.unavailable), ...unavailable],
  );
}

function safeRuntimeEnv(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, secret]) => SECRET_ALIAS_RE.test(key) && typeof secret === "string" && secret.length > 0),
  );
}

function preparedCapabilities(
  grant: PreparedSiteAgentAppCapabilities["grant"],
  disclosure: SiteAgentAppCapabilityDisclosure,
  cleanup: () => void,
): PreparedSiteAgentAppCapabilities {
  return {
    grant,
    disclosure,
    cleanup,
    finalDisclosure: () => {
      if (!grant || grant.runtimeStatus !== "runtime-unavailable") return disclosure;
      return {
        available: [],
        unavailable: uniqueIssues([
          ...disclosure.unavailable,
          ...grant.availableCatalogIds.map((id): SiteAgentAppCapabilityIssue => ({ id, reason: "runtime-unavailable" })),
        ]),
      };
    },
  };
}

function regularNonSymlinkFile(file: string, executable = false): boolean {
  if (!path.isAbsolute(file)) return false;
  try {
    const link = fs.lstatSync(file);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    if (path.resolve(fs.realpathSync(file)) !== path.resolve(file)) return false;
    if (executable) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Never let Agent App verification itself turn an `npx -y <package>` catalog
 * row into a download. A completed installation must point at a local pinned
 * executable (or a local script executed by an absolute Node binary).
 */
export function hasPinnedSiteAgentAppExecutable(server: InstalledMcpServer): boolean {
  if (server.transport !== "stdio" || !server.command || !regularNonSymlinkFile(server.command, true)) return false;
  const args = server.args ?? [];
  if (args.some((arg) => /^(?:https?:|git\+|npm:)/i.test(arg) || /^(?:-y|--yes|--package|-p|--eval|-e)$/.test(arg))) return false;
  const executableName = path.basename(server.command).toLowerCase();
  if (executableName === "npx" || executableName === "npm" || executableName === "pnpm" || executableName === "yarn" || executableName === "bunx") return false;
  if (/^(?:node|node\.exe|electron|electron\.exe)$/.test(executableName)) {
    return Boolean(args[0] && regularNonSymlinkFile(args[0]));
  }
  return true;
}

function verifiedBraveTools(status: McpServerStatus): string[] | null {
  if (!status.connected || status.missingEnv.length > 0 || status.error) return null;
  const names = [...new Set(status.tools.map((tool) => tool.name))];
  if (!names.includes("brave_web_search") || names.some((name) => !BRAVE_TOOL_ALLOWLIST.has(name))) return null;
  return names;
}

/**
 * Resolve a declaration into a one-run grant. Installation/enabled/key state
 * is checked just in time; unavailable entries are disclosed without key names
 * or provider error bodies. The derived config is deleted after the run.
 */
export async function prepareSiteAgentAppCapabilities(
  profile: SiteAgentAppCapabilityProfile | null | undefined,
  runId: string,
  deps: SiteAgentAppCapabilityPreparationDeps = {},
): Promise<PreparedSiteAgentAppCapabilities> {
  const normalized = normalizeSiteAgentAppCapabilityProfile(profile, profile?.source ?? "none");
  const requested = normalized.readonlyMcpCatalogIds;
  const unavailable = [...normalized.unavailable];
  const noTools = () => preparedCapabilities(
    null,
    { available: [], unavailable: uniqueIssues(unavailable) },
    () => {},
  );
  if (!requested.length) {
    return noTools();
  }
  if (
    !deps.projectId ||
    validSiteAgentAppMcpConsentDecision(normalized, deps.projectId, deps.consentReceipt) !== "approved"
  ) {
    for (const id of requested) unavailable.push({ id, reason: "consent-required" });
    return noTools();
  }
  if (deps.runtimeEligible === false) {
    for (const id of requested) unavailable.push({ id, reason: "runtime-unavailable" });
    return noTools();
  }

  let allRows: InstalledMcpServer[];
  try {
    allRows = (deps.listInstalled ?? listInstalledServers)();
  } catch {
    for (const id of requested) unavailable.push({ id, reason: "not-configured" });
    return noTools();
  }
  const requestedRows = allRows.filter((server) => server.catalogId && requested.includes(server.catalogId));
  const installedRows = requestedRows.filter((server) => server.enabled);
  const installed = installedRows.filter(hasPinnedSiteAgentAppExecutable);
  const installedCatalogIds = new Set(installed.map((server) => server.catalogId!));
  for (const id of requested) {
    if (!installedCatalogIds.has(id)) unavailable.push({
      id,
      reason: requestedRows.some((server) => server.catalogId === id) ? "not-configured" : "not-installed",
    });
  }
  if (!installed.length) {
    return noTools();
  }
  if (installed.length !== 1) {
    unavailable.push({ id: "brave-search", reason: "not-configured" });
    return noTools();
  }

  const hasCredential = deps.hasCredential ?? hasEnvVar;
  const credentialReady: InstalledMcpServer[] = [];
  for (const server of installed) {
    const entry = server.catalogId ? getCatalogEntry(server.catalogId) : null;
    const requiredKeys = entry?.envRequirements
      .filter((requirement) => requirement.required)
      .map((requirement) => requirement.key) ?? [];
    if (requiredKeys.some((key) => !server.envKeys.includes(key))) {
      unavailable.push({ id: server.catalogId!, reason: "not-configured" });
      continue;
    }
    try {
      const present = await Promise.all(requiredKeys.map((key) => hasCredential(key)));
      if (present.some((value) => !value)) {
        unavailable.push({ id: server.catalogId!, reason: "key-missing" });
        continue;
      }
    } catch {
      unavailable.push({ id: server.catalogId!, reason: "not-configured" });
      continue;
    }
    credentialReady.push(server);
  }
  if (!credentialReady.length) return noTools();

  const verifyServer = deps.verifyServer ?? ((server: InstalledMcpServer) => testServerConnection(server, { timeoutMs: 12_000 }));
  const verified: Array<{ server: InstalledMcpServer; tools: string[] }> = [];
  for (const server of credentialReady) {
    try {
      const status = await verifyServer(server);
      const tools = verifiedBraveTools(status);
      if (tools) verified.push({ server, tools });
      else unavailable.push({
        id: server.catalogId!,
        reason: status.missingEnv.length > 0 ? "key-missing" : "not-configured",
      });
    } catch {
      unavailable.push({ id: server.catalogId!, reason: "not-configured" });
    }
  }
  if (!verified.length) {
    return noTools();
  }

  let config: Awaited<ReturnType<typeof buildMcpConfigFile>>;
  try {
    config = await (deps.buildConfig ?? buildMcpConfigFile)({
      serverIds: verified.map(({ server }) => server.id),
      skipDefaultSeed: true,
      configKey: `site-agent-app-${runId}`,
    });
  } catch {
    config = null;
  }
  if (!config) {
    for (const id of installedCatalogIds) unavailable.push({ id, reason: "not-configured" });
    return noTools();
  }

  const included = config.includedServers ?? [];
  const includedCatalogIds = [...new Set(included.map((server) => server.catalogId).filter((id): id is string => Boolean(id)))];
  let serializedConfigSafe = false;
  try {
    const link = fs.lstatSync(config.configPath);
    const text = fs.readFileSync(config.configPath, "utf8");
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    const serverKeys = parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? Object.keys(parsed.mcpServers)
      : [];
    const latestRows = new Map((deps.listInstalled ?? listInstalledServers)().map((server) => [server.id, server]));
    serializedConfigSafe = link.isFile() && !link.isSymbolicLink() &&
      serverKeys.length === 1 && serverKeys[0] === "brave-search" &&
      !/\bnpx\b|(?:^|["\s])-y(?:["\s,]|$)|@modelcontextprotocol\/server-brave-search/i.test(text) &&
      included.every((server) => {
        const latest = latestRows.get(server.serverId);
        return Boolean(latest?.enabled && latest.catalogId === "brave-search" && hasPinnedSiteAgentAppExecutable(latest));
      });
  } catch {
    serializedConfigSafe = false;
  }
  const unexpected = included.some((server) =>
    !server.catalogId || !requested.includes(server.catalogId) || !SITE_AGENT_APP_READONLY_MCP_ALLOWLIST.has(server.catalogId));
  const verifiedByServerId = new Map(verified.map((entry) => [entry.server.id, entry]));
  const exactAllowedTools = included.flatMap((server) => {
    const entry = verifiedByServerId.get(server.serverId);
    return (entry?.tools ?? []).map((tool) => `mcp__${server.configKey}__${tool}`);
  });
  const exactTools = exactAllowedTools.length > 0 && exactAllowedTools.every((tool) =>
    /^mcp__[a-z0-9_-]+__(?:brave_web_search|brave_local_search)$/.test(tool));
  if (unexpected || !serializedConfigSafe || !exactTools || includedCatalogIds.length === 0) {
    try { fs.rmSync(config.configPath, { force: true }); } catch { /* best effort */ }
    for (const id of installedCatalogIds) unavailable.push({ id, reason: "not-configured" });
    return noTools();
  }
  for (const id of installedCatalogIds) {
    if (!includedCatalogIds.includes(id)) unavailable.push({ id, reason: "not-configured" });
  }

  const resolvedConfigPath = path.resolve(config.configPath);
  const cleanup = () => {
    try { fs.rmSync(resolvedConfigPath, { force: true }); } catch { /* one-run cleanup is best effort */ }
  };
  const grant: NonNullable<McpInvocationRequest["agentAppRuntimeToolGrant"]> = {
      schemaVersion: 1,
      mcpConfigPath: resolvedConfigPath,
      mcpAllowedTools: exactAllowedTools,
      mcpRuntimeEnv: safeRuntimeEnv(config.runtimeEnv),
      availableCatalogIds: includedCatalogIds,
      runtimeStatus: "prepared",
  };
  return preparedCapabilities(
    grant,
    { available: includedCatalogIds, unavailable: uniqueIssues(unavailable) },
    cleanup,
  );
}
