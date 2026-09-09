// Agentlas가 기본으로 갖고 있어야 하는 외부 MCP 플러그인.
// 설치는 SQLite 레지스트리에만 멱등 시드한다. 외부 바이너리/패키지 설치 스크립트는
// 사용자 동의 없이 실행하지 않는다.
import { installFromCatalog, listInstalledServers, refreshInstalledCatalogServer } from "./registry";
import { materializeBrowserCdpLauncher } from "./browser-cdp-launcher";
import { AGENTLAS_SYSTEM_TIME_CATALOG_ID } from "./system-time-server";
import { AGENTLAS_COMPUTER_USE_CATALOG_ID } from "../computer-use/mcp-server";
import { AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID } from "../workspace-preview/mcp-server";

// agentlas-browser(실제 로그인 CDP)를 기본에 포함 — 신선 프로필 Playwright가 봇/네트워크
// 보안에 차단되는 사이트에서도 로그인 세션으로 동작하는 범용 브라우저 경로.
export const DEFAULT_MCP_CATALOG_IDS = [
  "hephaestus-network",
  "agentlas-browser",
  "playwright",
  AGENTLAS_COMPUTER_USE_CATALOG_ID,
  AGENTLAS_SYSTEM_TIME_CATALOG_ID,
  AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID,
] as const;

export function ensureDefaultMcpPluginsInstalled(): void {
  try {
    // agentlas-browser launcher is optional to the other global rows. Its
    // filesystem failure must not starve the in-memory System Time MCP.
    materializeBrowserCdpLauncher();
  } catch (err) {
    console.error("[mcp-defaults] Agentlas Browser MCP unavailable:", err);
  }

  let installed: Set<string>;
  try {
    installed = new Set(
      listInstalledServers()
        .map((server) => server.catalogId)
        .filter((id): id is string => Boolean(id)),
    );
  } catch (err) {
    console.error("[mcp-defaults] MCP registry unavailable:", err);
    return;
  }

  for (const catalogId of DEFAULT_MCP_CATALOG_IDS) {
    try {
      if (!installed.has(catalogId)) {
        installFromCatalog(catalogId);
        installed.add(catalogId);
      } else if (
        catalogId === "agentlas-browser" ||
        catalogId === "playwright" ||
        catalogId === AGENTLAS_SYSTEM_TIME_CATALOG_ID ||
        catalogId === AGENTLAS_COMPUTER_USE_CATALOG_ID ||
        catalogId === AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID
      ) {
        // Preserve the global row id, enabled state, and agent references while
        // migrating older ~/.agentlas pathname launches to the exact inline
        // payload shipped by this Desktop build.
        refreshInstalledCatalogServer(catalogId);
      }
    } catch (err) {
      console.error(`[mcp-defaults] ${catalogId} unavailable:`, err);
    }
  }
}
