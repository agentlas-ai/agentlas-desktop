/**
 * Single exact tool-level policy used by JIT preparation, orchestration, and
 * CLI dispatch. A catalog id alone is never authority for an Agent App.
 */
const TOOL_POLICY = {
  "agentlas-time": {
    required: ["get_current_time", "convert_time"],
    allowed: ["get_current_time", "convert_time"],
  },
} as const;

export type SiteAgentAppMcpCatalogId = keyof typeof TOOL_POLICY;

export function isSiteAgentAppMcpCatalogId(value: string): value is SiteAgentAppMcpCatalogId {
  return Object.prototype.hasOwnProperty.call(TOOL_POLICY, value);
}

export function validSiteAgentAppExposedToolNames(catalogId: string, values: string[]): boolean {
  if (!isSiteAgentAppMcpCatalogId(catalogId) || values.length === 0) return false;
  const names = new Set(values);
  if (names.size !== values.length) return false;
  const policy = TOOL_POLICY[catalogId];
  return policy.required.every((name) => names.has(name)) &&
    values.every((name) => (policy.allowed as readonly string[]).includes(name));
}

function parseTool(value: string): { catalogId: SiteAgentAppMcpCatalogId; name: string } | null {
  const match = value.match(/^mcp__([a-z0-9][a-z0-9_-]{0,79})__([a-z0-9][a-z0-9_-]{0,99})$/);
  if (!match || !isSiteAgentAppMcpCatalogId(match[1])) return null;
  const policy = TOOL_POLICY[match[1]];
  if (!(policy.allowed as readonly string[]).includes(match[2])) return null;
  return { catalogId: match[1], name: match[2] };
}

export function exactSiteAgentAppMcpCatalogIdsForTools(values: string[]): SiteAgentAppMcpCatalogId[] | null {
  if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) return null;
  const parsed = values.map(parseTool);
  if (parsed.some((entry) => !entry)) return null;
  const entries = parsed as Array<NonNullable<(typeof parsed)[number]>>;
  const ids = [...new Set(entries.map((entry) => entry.catalogId))].sort();
  for (const id of ids) {
    const names = entries.filter((entry) => entry.catalogId === id).map((entry) => entry.name);
    if (!validSiteAgentAppExposedToolNames(id, names)) return null;
  }
  return ids;
}

export function validSiteAgentAppMcpGrantTools(values: string[], catalogIds?: string[]): boolean {
  const inferred = exactSiteAgentAppMcpCatalogIdsForTools(values);
  if (!inferred) return false;
  if (!catalogIds) return true;
  if (catalogIds.length === 0 || new Set(catalogIds).size !== catalogIds.length) return false;
  if (catalogIds.some((id) => !isSiteAgentAppMcpCatalogId(id))) return false;
  return JSON.stringify([...catalogIds].sort()) === JSON.stringify(inferred);
}
