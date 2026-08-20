/**
 * Single exact tool-level policy used by JIT preparation, orchestration, and
 * CLI dispatch. A catalog id alone is never authority for an Agent App.
 *
 * ★오너 결정 2026-08-20 — Site 축 전부 개방. 예전에는 고정 표(agentlas-time 의
 * 도구 2종)만 유효했다. 이제 정책은 **형태 계약**이다: `mcp__<catalog>__<tool>`
 * 이름 규약과 중복 없음만 여기서 강제하고, 어떤 카탈로그·도구가 허용되는지는
 * 소유자 동의 영수증(agent-app-mcp-consent 의 digest 바인딩)이 결정한다.
 */
const SAFE_CATALOG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_TOOL_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export type SiteAgentAppMcpCatalogId = string;

export function isSiteAgentAppMcpCatalogId(value: string): value is SiteAgentAppMcpCatalogId {
  return typeof value === "string" && SAFE_CATALOG_RE.test(value);
}

export function validSiteAgentAppExposedToolNames(catalogId: string, values: string[]): boolean {
  if (!isSiteAgentAppMcpCatalogId(catalogId) || values.length === 0) return false;
  const names = new Set(values);
  if (names.size !== values.length) return false;
  return values.every((name) => typeof name === "string" && SAFE_TOOL_RE.test(name));
}

function parseTool(value: string): { catalogId: SiteAgentAppMcpCatalogId; name: string } | null {
  const match = value.match(/^mcp__([a-z0-9][a-z0-9_-]{0,79})__([a-z0-9][a-z0-9_-]{0,99})$/);
  if (!match || !isSiteAgentAppMcpCatalogId(match[1])) return null;
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
