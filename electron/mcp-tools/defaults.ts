// Agentlas가 기본으로 갖고 있어야 하는 외부 MCP 플러그인.
// 설치는 SQLite 레지스트리에만 멱등 시드한다. 외부 바이너리/패키지 설치 스크립트는
// 사용자 동의 없이 실행하지 않는다.
import { installFromCatalog, listInstalledServers } from "./registry";

export const DEFAULT_MCP_CATALOG_IDS = ["hephaestus-network", "playwright", "cua-driver"] as const;

export function ensureDefaultMcpPluginsInstalled(): void {
  try {
    const installed = new Set(
      listInstalledServers()
        .map((server) => server.catalogId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const catalogId of DEFAULT_MCP_CATALOG_IDS) {
      if (!installed.has(catalogId)) {
        installFromCatalog(catalogId);
        installed.add(catalogId);
      }
    }
  } catch (err) {
    console.error("[mcp-defaults] ensureDefaultMcpPluginsInstalled failed:", err);
  }
}
