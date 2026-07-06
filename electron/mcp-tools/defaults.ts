// Agentlas가 기본으로 갖고 있어야 하는 외부 MCP 플러그인.
// 설치는 SQLite 레지스트리에만 멱등 시드한다. 외부 바이너리/패키지 설치 스크립트는
// 사용자 동의 없이 실행하지 않는다.
import { installFromCatalog, listInstalledServers } from "./registry";
import { materializeBrowserCdpLauncher } from "./browser-cdp-launcher";

// agentlas-browser(실제 로그인 CDP)를 기본에 포함 — 신선 프로필 Playwright가 봇/네트워크
// 보안에 차단되는 사이트에서도 로그인 세션으로 동작하는 범용 브라우저 경로.
export const DEFAULT_MCP_CATALOG_IDS = [
  "hephaestus-network",
  "agentlas-browser",
  "playwright",
  "cua-driver",
] as const;

export function ensureDefaultMcpPluginsInstalled(): void {
  try {
    // agentlas-browser 런처 스크립트를 ~/.agentlas 에 물질화(catalog command가 이 경로를 실행).
    materializeBrowserCdpLauncher();
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
