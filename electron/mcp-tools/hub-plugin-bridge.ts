// Hub 플러그인 → 라이브 툴 브리지 — resolve된 Hub 후보를 "프롬프트 속 텍스트"로 끝내지 않고
// 실제 mcp_servers 레지스트리 등록 → 이번 런의 .mcp.json → 툴루프 노출까지 잇는다.
// 자율 경계(보안, 2026-07-23 재설계):
//  · http/sse 원격 엔드포인트(네트워크 연결만, 로컬 실행 없음)는 자동 연결한다.
//  · stdio(로컬 프로세스 실행 = 원격 메타데이터발 코드 실행)는 자동 실행하지 않는다 —
//    비활성 상태로 등록하고 승인 필요로 정직하게 표면화한다.
//  · GitHub/저장소 HTML 페이지를 MCP 엔드포인트로 등록하던 과거 결함은 여기서도 차단한다.
//  · ★ 이 모듈은 시크릿 "값"을 절대 다루지 않는다 — Hub 매니페스트의 envKeys는 필요한
//    환경변수 "이름"만 담고, mcp_servers에는 그 이름만 저장된다(installCustomServer는
//    이 파일 전체에서 값을 읽거나 쓰지 않음). 실제 키 값은 오직 사람이 MCP 설정 화면에서
//    입력해야 Keychain vault에 들어간다 — 이 브리지가 대신 채우거나 자동 승인하지 않는다.
//    즉 "원격 MCP 연결은 사람이 명시적으로 해야 한다"는 요건은 값 단계에서 이미 지켜지고
//    있고, 여기서 자동화하는 건 등록(연결 가능하다는 사실)뿐이다.
// 이 모듈의 실패는 런을 오염시키지 않는다(전부 격리, 결과는 영수증으로 보고).
import type { HubPluginCandidate } from "./auto-select";
import { installCustomServer, listInstalledServers, setServerEnabled } from "./registry";

export interface HubPluginBridgeReceipt {
  slug: string;
  serverName: string;
  transport: string;
  action: "connected" | "already-installed" | "needs-approval" | "skipped";
  reason?: string;
  serverId?: string;
}

export interface HubPluginBridgeResult {
  receipts: HubPluginBridgeReceipt[];
  /** 이번 런 config에 포함할 신규/기존 http·sse 서버 row id들. */
  liveServerIds: string[];
}

const BRIDGE_CANDIDATE_LIMIT = 3;
const MANIFEST_TIMEOUT_MS = 6_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

/** 저장소/문서 호스팅 페이지 — MCP 엔드포인트로 등록되면 안 되는 URL들. */
const REPO_PAGE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
]);

export interface HubManifestMcpRow {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
}

/** 실 MCP 원격 엔드포인트인지 — https 필수, 저장소/패키지 HTML 페이지는 거부. */
export function isLikelyRemoteMcpEndpoint(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (REPO_PAGE_HOSTS.has(url.hostname.toLowerCase())) return false;
  return true;
}

function normalizeManifestMcpRows(raw: unknown): HubManifestMcpRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: HubManifestMcpRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const transport = row.transport;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    const command = typeof row.command === "string" ? row.command.trim() : "";
    const args = Array.isArray(row.args) ? row.args.filter((v): v is string => typeof v === "string") : [];
    const envSource = row.envKeys ?? row.env;
    const envKeys = Array.isArray(envSource)
      ? envSource.filter((v): v is string => typeof v === "string")
      : envSource && typeof envSource === "object"
        ? Object.keys(envSource as Record<string, unknown>)
        : [];
    if ((transport === "http" || transport === "sse") && isLikelyRemoteMcpEndpoint(url)) {
      rows.push({ name, transport, url, envKeys });
    } else if (transport === "stdio" && command) {
      rows.push({ name, transport: "stdio", command, args, envKeys });
    } else if (!transport && isLikelyRemoteMcpEndpoint(url) && /\/(mcp|sse)(?:$|[/?#])/.test(url)) {
      // transport 미선언 레거시 행은 경로가 명시적으로 MCP를 가리킬 때만 원격으로 신뢰한다.
      rows.push({ name, transport: "http", url, envKeys });
    }
    // 그 외(저장소 URL, transport 없는 홈페이지 링크 등)는 연결정보가 아니다 — 조용히 제외.
  }
  return rows;
}

export async function fetchHubPluginManifest(manifestUrl: string): Promise<{ mcp: HubManifestMcpRow[] } | null> {
  let url: URL;
  try {
    url = new URL(manifestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) return null;
    const parsed = JSON.parse(text) as { mcp?: unknown };
    return { mcp: normalizeManifestMcpRows(parsed?.mcp) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 자동 브리지가 등록해 두고 승인을 기다리는 stdio 서버들.
 *
 * 승인 대기는 이미 영구 상태다(`mcp_servers`에 `enabled=0`으로 앉아 있다). 그런데
 * 그 사실은 실행 중 채팅에 `needs-approval` 한 줄로 지나갈 뿐이라, 사용자가 그 순간을
 * 놓치면 어디서 무엇을 켜야 하는지 알 방법이 없었다. 화면이 이 목록을 직접 물어보면
 * 세션이 끊겨도, 대화를 새로 열어도 같은 답을 얻는다.
 *
 * 판별 기준은 브리지가 만든 행의 모양이다: 카탈로그 출신이 아니고(catalogId 없음),
 * 이름이 `<slug>:<서버이름>`이며, stdio이고, 꺼져 있다. 사용자가 직접 등록한 커스텀
 * 서버나 사용자가 의도적으로 끈 카탈로그 서버는 여기 들어오지 않는다.
 */
export function listPendingHubPluginApprovals(): Array<{
  serverId: string;
  slug: string;
  serverName: string;
  command: string | null;
  args: string[];
  envKeys: string[];
}> {
  let installed: ReturnType<typeof listInstalledServers>;
  try {
    installed = listInstalledServers();
  } catch {
    return [];
  }
  const pending: ReturnType<typeof listPendingHubPluginApprovals> = [];
  for (const server of installed) {
    if (server.enabled) continue;
    if (server.transport !== "stdio") continue;
    if (server.catalogId) continue;
    const name = String(server.name ?? "");
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    pending.push({
      serverId: server.id,
      slug: name.slice(0, colon),
      serverName: name.slice(colon + 1) || name,
      command: server.command ?? null,
      args: server.args ?? [],
      envKeys: server.envKeys ?? [],
    });
  }
  return pending;
}

/**
 * 이미 같은 연결이 등록돼 있는지. 자동 브리지와 사용자 설치가 **같은 판정**을 써야
 * "에이전트가 자동 등록해 둔 비활성 행"을 마켓플레이스 설치가 중복 생성하지 않고
 * 그 행을 그대로 켤 수 있다.
 */
function findEquivalentServer(
  installed: ReturnType<typeof listInstalledServers>,
  row: HubManifestMcpRow,
): ReturnType<typeof listInstalledServers>[number] | undefined {
  return installed.find((server) =>
    (row.url ? server.url === row.url : false) ||
    (server.transport === "stdio" && row.transport === "stdio" && server.command === row.command &&
      JSON.stringify(server.args) === JSON.stringify(row.args ?? [])));
}

/**
 * 사용자가 마켓플레이스에서 직접 고른 Hub 플러그인의 연결 정보를 **설치하지 않고** 읽어온다.
 *
 * 설치 버튼이 승인 시트를 띄우려면 "무엇이 실행되는가"를 먼저 보여줘야 한다. stdio 행은
 * 로컬에서 그 명령을 그대로 실행한다는 뜻이므로, 사람이 명령 원문을 보지 못한 채 누르는
 * 승인은 승인이 아니다. 그래서 미리보기와 설치를 두 단계로 나눈다.
 */
export async function previewHubPlugin(
  manifestUrl: string,
  deps: { fetchManifest?: typeof fetchHubPluginManifest } = {},
): Promise<{ rows: HubManifestMcpRow[]; needsLocalExecution: boolean; alreadyInstalledIds: string[] }> {
  const fetchManifest = deps.fetchManifest ?? fetchHubPluginManifest;
  const manifest = await fetchManifest(manifestUrl);
  const rows = manifest?.mcp ?? [];
  let installed: ReturnType<typeof listInstalledServers>;
  try {
    installed = listInstalledServers();
  } catch {
    installed = [];
  }
  const alreadyInstalledIds: string[] = [];
  for (const row of rows) {
    const existing = findEquivalentServer(installed, row);
    if (existing) alreadyInstalledIds.push(existing.id);
  }
  return {
    rows,
    needsLocalExecution: rows.some((row) => row.transport === "stdio"),
    alreadyInstalledIds,
  };
}

/**
 * 사용자가 승인 시트에서 명시적으로 누른 단일 Hub 플러그인을 설치한다.
 *
 * `bridgeHubPluginCandidates`(에이전트 실행 중 자동 브리지)와 갈라지는 점은 하나뿐이다:
 * 저기서는 아무도 누르지 않았으므로 stdio가 비활성으로 남지만, 여기서는 사람이 명령 원문을
 * 보고 눌렀으므로 `approveLocalExecution`이 참일 때만 활성으로 등록한다. 승인 없이 부르면
 * 자동 브리지와 똑같이 비활성으로 남는다 — 이 함수는 승인을 만들어내지 않는다.
 */
export async function installHubPlugin(input: {
  slug: string;
  manifestUrl: string;
  approveLocalExecution: boolean;
}, deps: { fetchManifest?: typeof fetchHubPluginManifest } = {}): Promise<HubPluginBridgeResult> {
  const fetchManifest = deps.fetchManifest ?? fetchHubPluginManifest;
  const manifest = await fetchManifest(input.manifestUrl);
  const rows = manifest?.mcp ?? [];
  const receipts: HubPluginBridgeReceipt[] = [];
  const liveServerIds: string[] = [];
  if (rows.length === 0) {
    return {
      receipts: [{
        slug: input.slug,
        serverName: input.slug,
        transport: "unknown",
        action: "skipped",
        reason: "no machine-connectable MCP endpoint in the Hub manifest",
      }],
      liveServerIds: [],
    };
  }
  let installed: ReturnType<typeof listInstalledServers>;
  try {
    installed = listInstalledServers();
  } catch {
    installed = [];
  }
  for (const row of rows) {
    try {
      const existing = findEquivalentServer(installed, row);
      if (existing) {
        // 이미 있는 행은 다시 만들지 않는다. 다만 승인을 새로 받은 stdio는 켜 준다 —
        // 자동 브리지가 비활성으로 남겨둔 바로 그 행이 여기로 들어온다.
        if (!existing.enabled && row.transport === "stdio" && input.approveLocalExecution) {
          setServerEnabled(existing.id, true);
          receipts.push({
            slug: input.slug,
            serverName: existing.name,
            transport: existing.transport,
            action: "connected",
            serverId: existing.id,
          });
        } else {
          receipts.push({
            slug: input.slug,
            serverName: existing.name,
            transport: existing.transport,
            action: "already-installed",
            serverId: existing.id,
          });
        }
        if (existing.transport === "http" || existing.transport === "sse") liveServerIds.push(existing.id);
        continue;
      }
      const server = installCustomServer({
        name: `${input.slug}:${row.name}`.slice(0, 120),
        transport: row.transport,
        ...(row.url ? { url: row.url } : {}),
        ...(row.command ? { command: row.command } : {}),
        args: row.args ?? [],
        envKeys: row.envKeys ?? [],
      });
      installed.push(server);
      if (row.transport === "stdio" && !input.approveLocalExecution) {
        setServerEnabled(server.id, false);
        receipts.push({
          slug: input.slug,
          serverName: server.name,
          transport: "stdio",
          action: "needs-approval",
          reason: "local execution was not approved",
          serverId: server.id,
        });
        continue;
      }
      if (row.transport === "http" || row.transport === "sse") liveServerIds.push(server.id);
      receipts.push({
        slug: input.slug,
        serverName: server.name,
        transport: row.transport,
        action: "connected",
        serverId: server.id,
      });
    } catch (error) {
      receipts.push({
        slug: input.slug,
        serverName: row.name,
        transport: row.transport,
        action: "skipped",
        reason: error instanceof Error ? error.message.slice(0, 160) : "registration failed",
      });
    }
  }
  return { receipts, liveServerIds: [...new Set(liveServerIds)] };
}

/**
 * resolve된 Hub 후보들을 라이브 서버로 브리지한다.
 * 반환된 liveServerIds를 이번 런의 buildMcpConfigFile catalogIds에 합치면
 * (커스텀 서버는 row id 매칭으로 포함됨) 러너가 즉시 툴콜할 수 있다.
 */
export async function bridgeHubPluginCandidates(
  candidates: HubPluginCandidate[],
  deps: {
    fetchManifest?: typeof fetchHubPluginManifest;
    limit?: number;
  } = {},
): Promise<HubPluginBridgeResult> {
  const fetchManifest = deps.fetchManifest ?? fetchHubPluginManifest;
  const receipts: HubPluginBridgeReceipt[] = [];
  const liveServerIds: string[] = [];
  let installedServers: ReturnType<typeof listInstalledServers>;
  try {
    installedServers = listInstalledServers();
  } catch {
    installedServers = [];
  }

  for (const candidate of candidates.slice(0, Math.max(1, deps.limit ?? BRIDGE_CANDIDATE_LIMIT))) {
    if (!candidate.manifestUrl) {
      receipts.push({
        slug: candidate.slug,
        serverName: candidate.name,
        transport: "unknown",
        action: "skipped",
        reason: "no manifest url",
      });
      continue;
    }
    const manifest = await fetchManifest(candidate.manifestUrl);
    if (!manifest || manifest.mcp.length === 0) {
      receipts.push({
        slug: candidate.slug,
        serverName: candidate.name,
        transport: "unknown",
        action: "skipped",
        reason: "no machine-connectable MCP endpoint in the Hub manifest",
      });
      continue;
    }
    for (const row of manifest.mcp) {
      try {
        const existing = findEquivalentServer(installedServers, row);
        if (existing) {
          receipts.push({
            slug: candidate.slug,
            serverName: existing.name,
            transport: existing.transport,
            action: "already-installed",
            serverId: existing.id,
          });
          if (existing.enabled && (existing.transport === "http" || existing.transport === "sse")) {
            liveServerIds.push(existing.id);
          }
          continue;
        }
        if (row.transport === "http" || row.transport === "sse") {
          const server = installCustomServer({
            name: `${candidate.slug}:${row.name}`.slice(0, 120),
            transport: row.transport,
            url: row.url,
            envKeys: row.envKeys ?? [],
          });
          installedServers.push(server);
          liveServerIds.push(server.id);
          receipts.push({
            slug: candidate.slug,
            serverName: server.name,
            transport: row.transport,
            action: "connected",
            serverId: server.id,
          });
        } else {
          // stdio = 로컬 프로세스 실행. 원격 메타데이터만으로 자동 실행하지 않는다.
          const server = installCustomServer({
            name: `${candidate.slug}:${row.name}`.slice(0, 120),
            transport: "stdio",
            command: row.command,
            args: row.args ?? [],
            envKeys: row.envKeys ?? [],
          });
          setServerEnabled(server.id, false);
          installedServers.push({ ...server, enabled: false });
          receipts.push({
            slug: candidate.slug,
            serverName: server.name,
            transport: "stdio",
            action: "needs-approval",
            reason: "local execution requires one-click approval in MCP settings",
            serverId: server.id,
          });
        }
      } catch (error) {
        receipts.push({
          slug: candidate.slug,
          serverName: row.name,
          transport: row.transport,
          action: "skipped",
          reason: error instanceof Error ? error.message.slice(0, 160) : "registration failed",
        });
      }
    }
  }
  return { receipts, liveServerIds: [...new Set(liveServerIds)] };
}
