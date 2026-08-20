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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
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

/** 스킬 번들 설치 결과 — mcp_servers가 아니라 ~/.agentlas/plugins/<slug>/ 파일시스템 기록. */
export interface HubPluginSkillInstallSummary {
  /** 스킬 파일이 착지한 디렉터리 (plugin.json 마커 포함). */
  dir: string;
  installed: string[];
  failed: Array<{ name: string; reason: string }>;
  /** 매니페스트가 sha256을 선언했고 모든 설치 파일이 검증을 통과했는가. */
  verified: boolean;
}

export interface HubPluginBridgeResult {
  receipts: HubPluginBridgeReceipt[];
  /** 이번 런 config에 포함할 신규/기존 http·sse 서버 row id들. */
  liveServerIds: string[];
  /** manifest.skills 가 실콘텐츠를 실었을 때만 존재 — 스킬 번들 설치 결과. */
  skills?: HubPluginSkillInstallSummary;
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

/**
 * 이 경로는 "이 호스트의 MCP 엔드포인트"라고 명시하는가.
 *
 * 저장소 호스트를 통째로 막으면 그 호스트가 **진짜로 운영하는** MCP 엔드포인트까지
 * 함께 죽는다 — GitLab 공식 서버 `https://gitlab.com/api/v4/mcp` 가 그렇게 사라져
 * 사용자에게 0개로 도달했다(2026-08-20 실측: 시드 1행 → 서빙 0행, 그 주소를 직접
 * 찔러 보면 `{"message":"401 Unauthorized"}` 로 살아 있다).
 * 막아야 할 것은 호스트가 아니라 `https://github.com/owner/repo` 같은 **페이지**다.
 */
const MCP_ENDPOINT_PATH = /(?:^|\/)(?:mcp|sse)(?:$|[/?#])|(?:^|\/)api\//i;

/** 실 MCP 원격 엔드포인트인지 — https 필수, 저장소/패키지 HTML 페이지는 거부. */
export function isLikelyRemoteMcpEndpoint(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (REPO_PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    // 저장소 호스트에서는 경로가 스스로 MCP 엔드포인트임을 말할 때만 통과시킨다.
    return MCP_ENDPOINT_PATH.test(url.pathname);
  }
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

// ── 스킬 번들 (플러그인 = MCP와 별개의 능력 패키지, 오너 결정 2026-08-20) ──────
//
// manifest.skills 행이 files[]에 실콘텐츠를 실으면 설치 대상이다. 설치는
// mcp_servers 등록이 아니라 ~/.agentlas/plugins/<slug>/ 아래 파일 착지 +
// plugin.json 마커(schema agentlas.local-plugin/v1)로 남는다 — 터미널·Agentlas-OS·
// 데스크탑이 같은 파일시스템 규약으로 공유한다(터미널 동형: engine/hub/plugins.cjs).

export interface HubManifestSkillFile {
  /** 스킬 디렉터리 기준 상대 경로 (SKILL.md, references/x.md …). */
  path: string;
  content: string;
  /** 매니페스트가 선언한 콘텐츠 해시 — 있으면 설치 전에 검증한다. */
  sha256?: string;
}

export interface HubManifestSkillRow {
  name: string;
  description?: string;
  /** 빈 배열 = 이름뿐인 레거시 행(설치할 것 없음). */
  files: HubManifestSkillFile[];
}

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SKILL_FILE_MAX_BYTES = 512 * 1024;

/** 스킬 파일 상대 경로 검증 — 절대경로·상위 탈출·널바이트·백슬래시 거부. */
export function isSafeSkillRelativePath(value: string): boolean {
  if (typeof value !== "string" || !value || value.length > 260) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("~"));
}

function normalizeManifestSkillRows(raw: unknown): HubManifestSkillRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: HubManifestSkillRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || !SKILL_SLUG_RE.test(name)) continue;
    const description = typeof row.description === "string" ? row.description.trim() : undefined;
    const files: HubManifestSkillFile[] = [];
    if (Array.isArray(row.files)) {
      for (const fileItem of row.files) {
        if (!fileItem || typeof fileItem !== "object") continue;
        const file = fileItem as Record<string, unknown>;
        const filePath = typeof file.path === "string" ? file.path.trim() : "";
        const content = typeof file.content === "string" ? file.content : "";
        if (!isSafeSkillRelativePath(filePath) || !content.trim()) continue;
        if (Buffer.byteLength(content, "utf8") > SKILL_FILE_MAX_BYTES) continue;
        const sha256 = typeof file.sha256 === "string" && /^[0-9a-f]{64}$/i.test(file.sha256)
          ? file.sha256.toLowerCase()
          : undefined;
        files.push({ path: filePath, content, ...(sha256 ? { sha256 } : {}) });
      }
    }
    rows.push({ name, ...(description ? { description } : {}), files });
  }
  return rows;
}

/** 세 채널이 공유하는 로컬 플러그인 저장소 루트. */
export function agentlasPluginsDir(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

function pluginMarkerPath(slug: string): string {
  return path.join(agentlasPluginsDir(), slug, "plugin.json");
}

/** ~/.agentlas/plugins/<slug>/plugin.json 마커가 이미 있는가. */
export function isSkillBundleInstalled(slug: string): boolean {
  if (!SKILL_SLUG_RE.test(slug)) return false;
  try {
    return fs.existsSync(pluginMarkerPath(slug));
  } catch {
    return false;
  }
}

/**
 * manifest.skills 의 실콘텐츠를 ~/.agentlas/plugins/<slug>/skills/<name>/ 에 쓴다.
 *
 * 무결성: 행이 sha256을 선언하면 쓰기 전에 검증하고, 불일치 파일은 설치하지 않는다
 * (그 스킬만 failed로 남고 나머지는 계속). 해시가 아예 없으면 매니페스트 URL을
 * 출처로 기록만 한다 — 해시와 콘텐츠가 같은 응답으로 오므로 이 검증은 전송 무결성이지
 * 발행자 서명이 아니다(서명 체계는 아직 없음, 정직한 한계).
 */
export function installSkillBundle(input: {
  slug: string;
  manifestUrl: string;
  skills: HubManifestSkillRow[];
  meta?: { name?: string; family?: string; version?: string | null };
  installedBy?: string;
}): HubPluginSkillInstallSummary {
  if (!SKILL_SLUG_RE.test(input.slug)) {
    return { dir: "", installed: [], failed: [{ name: input.slug, reason: "invalid plugin slug" }], verified: false };
  }
  const pluginDir = path.join(agentlasPluginsDir(), input.slug);
  const installed: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const markerSkills: Array<{ name: string; files: Array<{ path: string; sha256: string; verified: boolean }> }> = [];
  let allDeclared = true;
  for (const skill of input.skills) {
    if (skill.files.length === 0) continue; // 이름뿐인 레거시 행 — 설치할 것 없음
    if (!SKILL_SLUG_RE.test(skill.name)) {
      failed.push({ name: skill.name, reason: "invalid skill name" });
      continue;
    }
    const skillDir = path.join(pluginDir, "skills", skill.name);
    const writtenFiles: Array<{ path: string; sha256: string; verified: boolean }> = [];
    let skillFailed: string | null = null;
    for (const file of skill.files) {
      const actual = createHash("sha256").update(file.content, "utf8").digest("hex");
      if (file.sha256 && file.sha256 !== actual) {
        skillFailed = `sha256 mismatch for ${file.path}`;
        break;
      }
      if (!file.sha256) allDeclared = false;
      writtenFiles.push({ path: file.path, sha256: actual, verified: Boolean(file.sha256) });
    }
    if (skillFailed) {
      failed.push({ name: skill.name, reason: skillFailed });
      continue;
    }
    try {
      for (let i = 0; i < skill.files.length; i++) {
        const target = path.join(skillDir, skill.files[i].path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, skill.files[i].content, "utf8");
      }
      installed.push(skill.name);
      markerSkills.push({ name: skill.name, files: writtenFiles });
    } catch (error) {
      failed.push({
        name: skill.name,
        reason: error instanceof Error ? error.message.slice(0, 160) : "write failed",
      });
    }
  }
  const verified = installed.length > 0 && allDeclared;
  if (installed.length > 0) {
    // 마커는 마지막에 쓴다 — 마커가 있으면 스킬 파일도 있다는 뜻이어야 한다.
    const marker = {
      schema: "agentlas.local-plugin/v1",
      slug: input.slug,
      name: input.meta?.name ?? input.slug,
      family: input.meta?.family ?? null,
      version: input.meta?.version ?? null,
      installedAt: new Date().toISOString(),
      installedBy: input.installedBy ?? "agentlas-desktop",
      // 해시는 매니페스트와 같은 응답에서 왔다 — 무결성 출처는 이 URL이다.
      source: { manifestUrl: input.manifestUrl, contentVerification: verified ? "manifest-sha256" : "none" },
      skills: markerSkills,
    };
    try {
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(pluginMarkerPath(input.slug), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    } catch (error) {
      failed.push({
        name: "plugin.json",
        reason: error instanceof Error ? error.message.slice(0, 160) : "marker write failed",
      });
    }
  }
  return { dir: pluginDir, installed, failed, verified };
}

export interface HubPluginManifestPayload {
  mcp: HubManifestMcpRow[];
  skills: HubManifestSkillRow[];
  name?: string;
  family?: string;
  version?: string | null;
}

export async function fetchHubPluginManifest(manifestUrl: string): Promise<HubPluginManifestPayload | null> {
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
    const parsed = JSON.parse(text) as {
      mcp?: unknown;
      skills?: unknown;
      name?: unknown;
      family?: unknown;
      version?: unknown;
    };
    return {
      mcp: normalizeManifestMcpRows(parsed?.mcp),
      skills: normalizeManifestSkillRows(parsed?.skills),
      ...(typeof parsed?.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed?.family === "string" ? { family: parsed.family } : {}),
      ...(typeof parsed?.version === "string" ? { version: parsed.version } : { version: null }),
    };
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
): Promise<{
  rows: HubManifestMcpRow[];
  needsLocalExecution: boolean;
  alreadyInstalledIds: string[];
  /** 실콘텐츠가 실린 설치 가능한 스킬들 — MCP 행과 별개의 능력 패키지 절반. */
  skills: Array<{ name: string; description?: string; fileCount: number }>;
  skillsAlreadyInstalled: boolean;
}> {
  const fetchManifest = deps.fetchManifest ?? fetchHubPluginManifest;
  const manifest = await fetchManifest(manifestUrl);
  const rows = manifest?.mcp ?? [];
  const skills = (manifest?.skills ?? [])
    .filter((skill) => skill.files.length > 0)
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      fileCount: skill.files.length,
    }));
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
  // slug는 매니페스트 URL의 마지막 경로 조각이다(/api/plugins/<slug>).
  const slugFromUrl = (() => {
    try {
      const segments = new URL(manifestUrl).pathname.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "";
    } catch {
      return "";
    }
  })();
  return {
    rows,
    needsLocalExecution: rows.some((row) => row.transport === "stdio"),
    alreadyInstalledIds,
    skills,
    skillsAlreadyInstalled: skills.length > 0 && isSkillBundleInstalled(slugFromUrl),
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
  const installableSkills = (manifest?.skills ?? []).filter((skill) => skill.files.length > 0);
  const receipts: HubPluginBridgeReceipt[] = [];
  const liveServerIds: string[] = [];

  // ── 스킬 번들 절반 — mcp_servers가 아니라 ~/.agentlas/plugins/<slug>/ 에 착지 ──
  // 과거에는 skills-only 매니페스트가 여기서 "no machine-connectable MCP endpoint"로
  // 전멸했다(스키마만 분리되고 실행이 MCP 등록으로 붕괴돼 있던 결함). 이제 스킬은
  // 스킬대로 설치되고, mcp[]가 함께 있으면 아래 서버 등록도 그대로 진행된다.
  let skillSummary: HubPluginSkillInstallSummary | undefined;
  if (installableSkills.length > 0) {
    skillSummary = installSkillBundle({
      slug: input.slug,
      manifestUrl: input.manifestUrl,
      skills: installableSkills,
      meta: { name: manifest?.name, family: manifest?.family, version: manifest?.version ?? null },
    });
    if (skillSummary.installed.length > 0) {
      receipts.push({
        slug: input.slug,
        serverName: `${input.slug}:skills(${skillSummary.installed.join(", ")})`.slice(0, 120),
        transport: "skills",
        action: "connected",
        reason: skillSummary.verified
          ? undefined
          : "installed without a declared content hash — manifest URL recorded as provenance",
      });
    }
    for (const failure of skillSummary.failed) {
      receipts.push({
        slug: input.slug,
        serverName: `${input.slug}:${failure.name}`.slice(0, 120),
        transport: "skills",
        action: "skipped",
        reason: failure.reason,
      });
    }
  }

  if (rows.length === 0) {
    if (skillSummary) {
      return { receipts, liveServerIds: [], skills: skillSummary };
    }
    return {
      receipts: [{
        slug: input.slug,
        serverName: input.slug,
        transport: "unknown",
        action: "skipped",
        reason: "no machine-connectable MCP endpoint or installable skill payload in the Hub manifest",
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
  return { receipts, liveServerIds: [...new Set(liveServerIds)], ...(skillSummary ? { skills: skillSummary } : {}) };
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
      // 스킬 번들은 자동 브리지가 설치하지 않는다 — 원격 메타데이터가 사람 확인 없이
      // 로컬 파일(에이전트 지시문)을 쓰게 두면 stdio 자동 실행 금지와 같은 계열의
      // 구멍이 된다. 마켓플레이스/터미널의 명시적 설치 경로로 정직하게 안내한다.
      const hasSkillPayload = (manifest?.skills ?? []).some((skill) => skill.files.length > 0);
      receipts.push({
        slug: candidate.slug,
        serverName: candidate.name,
        transport: hasSkillPayload ? "skills" : "unknown",
        action: hasSkillPayload ? "needs-approval" : "skipped",
        reason: hasSkillPayload
          ? "skill bundle — install it explicitly from the marketplace (files are never written from run-time metadata)"
          : "no machine-connectable MCP endpoint in the Hub manifest",
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
