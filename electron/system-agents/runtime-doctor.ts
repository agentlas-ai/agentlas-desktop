// Runtime Doctor — 자동화 실패의 "시스템 원인"을 결정론적으로 진단·수리하는 1차 관문.
// 사례(2026-07-08): codex CLI 업데이트가 openai-curated 플러그인(notion 등)을 자동 활성화
// → 미인증 OAuth 원격 MCP(mcp.notion.com)가 매 실행 AuthRequired fatal → codex exit 1
// → 사용자가 쓰지도 않는 서비스 때문에 모든 자동화 사망. 이런 계열은 LLM 없이 즉시 고친다.
// 결정론 수리가 불가능한 실패는 system-optimizer(LLM) 에이전트가 2차로 맡는다.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type DoctorFailureKind =
  | "mcp-oauth-unauthenticated" // 미인증 OAuth 원격 MCP가 런타임을 죽임
  | "codex-config-invalid" // config.toml 스키마 위반(예: stdio 서버에 url 키)으로 codex 기동 실패
  | "cli-exit" // CLI가 0이 아닌 코드로 종료(원인 미상)
  | "timeout" // 장시간 무응답 자동 중단
  | "unknown";

export interface DoctorAction {
  title: string;
  detail: string;
}

export interface DoctorReport {
  kind: DoctorFailureKind;
  /** 사람이 읽는 한 줄 진단 */
  summary: string;
  /** 결정론 수리가 실제로 적용됐는가 */
  repaired: boolean;
  actions: DoctorAction[];
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/**
 * 에러 텍스트에서 OAuth 자원 메타데이터로 명시된 호스트만 추출한다.
 * stderr의 모든 URL을 수집하면 도움말·문서 링크와 관련된 정상 플러그인까지
 * 수리 대상이 될 수 있다. 자동 수리는 구조화된 증거가 있을 때만 실행한다.
 */
function extractHosts(error: string): string[] {
  const hosts = new Set<string>();
  const addUrlHost = (rawUrl: string): void => {
    try {
      hosts.add(new URL(rawUrl.replace(/[\]}>),.;]+$/g, "")).hostname.toLowerCase());
    } catch {
      /* 잘못된 메타데이터 URL은 자동 수리 증거로 쓰지 않음 */
    }
  };
  const patterns = [
    /resource_metadata(?:_url)?\s*[:=]\s*\\?["']?(https?:\/\/[^\s"'\\)>,]+)/gi,
    /(https?:\/\/[^\s"'\\)>,]+\/\.well-known\/oauth-protected-resource(?:[/?#][^\s"'\\)>,]*)?)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(error || "")) !== null) addUrlHost(m[1]);
  }
  return [...hosts];
}

/** config.toml 스키마 위반이 지목한 mcp_servers 이름을 뽑는다(예: mcp_servers.agentlas). */
function extractBadMcpServer(error: string): string | null {
  const m = /mcp_servers\.([a-z0-9_.-]+)/i.exec(error || "");
  return m ? m[1] : null;
}

export function classifyAutomationFailure(error: string): {
  kind: DoctorFailureKind;
  hosts: string[];
  badServer?: string | null;
} {
  const text = error || "";
  if (/authrequired|invalid_token|oauth-protected-resource|www_authenticate/i.test(text)) {
    return { kind: "mcp-oauth-unauthenticated", hosts: extractHosts(text) };
  }
  // codex config.toml 파싱 실패(예: stdio 서버에 url 키) → CLI가 아예 기동 못 함.
  if (/error loading config\.toml|url is not supported for stdio|invalid config/i.test(text)) {
    return { kind: "codex-config-invalid", hosts: [], badServer: extractBadMcpServer(text) };
  }
  if (/no response for \d+s|auto-aborted/i.test(text)) return { kind: "timeout", hosts: [] };
  if (/(?:CLI exit|exited with code)\s+[1-9]\d*/i.test(text)) {
    return { kind: "cli-exit", hosts: extractHosts(text) };
  }
  return { kind: "unknown", hosts: [] };
}

interface OauthPluginHit {
  /** config.toml 섹션 키, 예: notion@openai-curated */
  pluginKey: string;
  host: string;
}

/**
 * ~/.codex/plugins/cache/<marketplace>/<plugin>/<ver>/.mcp.json 을 훑어
 * 실패 호스트와 일치하는 http(OAuth) MCP를 실어 나르는 플러그인을 찾는다.
 * 호스트가 에러에 직접 등장한 플러그인만 지목한다 — 인증돼서 잘 도는 플러그인을
 * 오폭하지 않기 위한 안전핀(인증됐다면 AuthRequired에 그 호스트가 나올 수 없다).
 */
function findOauthPluginsByHost(hosts: string[]): OauthPluginHit[] {
  if (hosts.length === 0) return [];
  const cacheRoot = path.join(codexHome(), "plugins", "cache");
  const hits: OauthPluginHit[] = [];
  let marketplaces: string[] = [];
  try {
    marketplaces = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const marketplace of marketplaces) {
    const marketplaceDir = path.join(cacheRoot, marketplace);
    let plugins: string[] = [];
    try {
      plugins = readdirSync(marketplaceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      const pluginDir = path.join(marketplaceDir, plugin);
      let versions: string[] = [];
      try {
        versions = readdirSync(pluginDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const ver of versions) {
        const mcpJson = path.join(pluginDir, ver, ".mcp.json");
        if (!existsSync(mcpJson)) continue;
        try {
          const parsed = JSON.parse(readFileSync(mcpJson, "utf8")) as {
            mcpServers?: Record<string, { type?: string; url?: string }>;
          };
          for (const server of Object.values(parsed.mcpServers ?? {})) {
            if (!server?.url) continue;
            let host = "";
            try {
              host = new URL(server.url).hostname.toLowerCase();
            } catch {
              continue;
            }
            // 호스트가 정확히 같을 때만 자동 수리한다. 부모/자식 도메인 관계만으로는
            // 어느 플러그인이 실패했는지 증명할 수 없다.
            if (hosts.includes(host)) {
              // cache 디렉토리 "openai-curated-remote"는 config 키에선 "openai-curated".
              const marketplaceKey = marketplace.replace(/-remote$/, "");
              hits.push({ pluginKey: `${plugin}@${marketplaceKey}`, host });
            }
          }
        } catch {
          /* 손상된 .mcp.json은 건너뜀 */
        }
      }
    }
  }
  // pluginKey 중복 제거
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.pluginKey) ? false : (seen.add(h.pluginKey), true)));
}

/** config.toml에서 해당 플러그인을 enabled = false 로 내린다. 반환: 실제 변경 여부. */
function disableCodexPlugin(pluginKey: string): boolean {
  const configPath = path.join(codexHome(), "config.toml");
  if (!existsSync(configPath)) return false;
  const original = readFileSync(configPath, "utf8");
  const header = `[plugins."${pluginKey}"]`;
  let next: string;
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerMatch = new RegExp(`^[ \\t]*${escapeRegExp(header)}[ \\t]*(?:#.*)?\\r?$`, "m").exec(original);
  if (headerMatch) {
    const headerLineEnd = headerMatch.index + headerMatch[0].length;
    const newlineIndex = original.indexOf("\n", headerLineEnd);
    const bodyStart = newlineIndex === -1 ? original.length : newlineIndex + 1;
    const remaining = original.slice(bodyStart);
    const nextSection = /^[ \t]*\[[^\r\n]+\][ \t]*(?:#.*)?\r?$/m.exec(remaining);
    const sectionEnd = nextSection ? bodyStart + nextSection.index : original.length;
    const section = original.slice(headerMatch.index, sectionEnd);
    const replacedSection = section.replace(
      /^([ \t]*enabled[ \t]*=[ \t]*)true([ \t]*(?:#.*)?)(?=\r?$)/m,
      "$1false$2",
    );
    if (replacedSection === section) return false; // 이미 false거나 해당 섹션에 enabled=true가 없음
    next = original.slice(0, headerMatch.index) + replacedSection + original.slice(sectionEnd);
  } else {
    next = `${original.trimEnd()}\n\n${header}\nenabled = false\n`;
  }
  const backup = `${configPath}.bak-doctor-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(configPath, backup);
  writeFileSync(configPath, next);
  return true;
}

/**
 * 자동화 실패 에러를 진단하고, 아는 계열이면 즉시 수리한다.
 * 부작용이 있는 수리는 반드시 백업을 남기고, 무엇을 왜 바꿨는지 actions로 보고한다.
 */
export function runRuntimeDoctor(errorMessage: string): DoctorReport {
  const { kind, hosts, badServer } = classifyAutomationFailure(errorMessage);
  const actions: DoctorAction[] = [];

  if (kind === "codex-config-invalid") {
    // 진단만 한다(자동 수리 안 함): 원격 MCP 항목이라 안전한 무손실 수리가 없고,
    // 사용자가 어느 항목을 어떻게 고칠지 알아야 한다. 명확한 조치를 안내한다.
    const where = badServer ? `[mcp_servers.${badServer}]` : "일부 [mcp_servers.*] 항목";
    return {
      kind,
      summary: `codex의 ~/.codex/config.toml ${where} 이(가) 잘못돼 codex가 기동하지 못합니다(예: stdio 서버에 url 키). 다른 런타임(claude-code)으로 우회하거나 그 항목을 고치세요.`,
      repaired: false,
      actions,
    };
  }

  if (kind === "mcp-oauth-unauthenticated") {
    const hits = findOauthPluginsByHost(hosts);
    let repairedAny = false;
    for (const hit of hits) {
      try {
        const changed = disableCodexPlugin(hit.pluginKey);
        if (changed) {
          repairedAny = true;
          actions.push({
            title: `codex plugin disabled: ${hit.pluginKey}`,
            detail: `미인증 OAuth MCP(${hit.host})가 런타임을 죽여서 ~/.codex/config.toml에서 비활성화했습니다(백업 생성). 이 서비스를 쓰려면 인증 후 다시 켜세요.`,
          });
        }
      } catch (err) {
        actions.push({
          title: `repair failed: ${hit.pluginKey}`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      kind,
      summary:
        hits.length > 0
          ? `런타임에 미인증 OAuth MCP 플러그인(${hits.map((h) => h.pluginKey).join(", ")})이 붙어 있어 CLI가 죽었습니다.`
          : `미인증 OAuth MCP(${hosts.join(", ") || "unknown host"})가 런타임을 죽였지만 어떤 플러그인인지 특정하지 못했습니다.`,
      repaired: repairedAny,
      actions,
    };
  }

  if (kind === "timeout") {
    return {
      kind,
      summary:
        "실행이 장시간 무응답이라 자동 중단됐습니다. 대화형 인증 대기·stdin 블록·원격 MCP 행이 흔한 원인입니다.",
      repaired: false,
      actions,
    };
  }

  if (kind === "cli-exit") {
    return {
      kind,
      summary: "런타임 CLI가 비정상 종료했지만 아는 수리 계열이 아닙니다. 시스템 최적화 에이전트 진단이 필요합니다.",
      repaired: false,
      actions,
    };
  }

  return { kind: "unknown", summary: "", repaired: false, actions };
}
