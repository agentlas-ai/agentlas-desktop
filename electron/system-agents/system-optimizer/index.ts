// System Optimizer system agent — 자동화가 실패했고 Runtime Doctor의 결정론 수리로
// 해결되지 않았을 때만 발사되는 2차 관문. 사용자 시스템(런타임 CLI 설정, MCP/플러그인,
// OS 권한, 환경)을 전반적으로 진단·수리한다. Hephaestus 패키지(system-optimizer)와
// 같은 플레이북을 공유한다 — 이 파일이 원본(single source of truth)이다.
import type { OnDemandModule, SystemAgentSpec } from "../types";

/** 자동화 실패 시 원샷 진단 런에 주입하는 플레이북 프롬프트. */
export function buildSystemOptimizerPrompt(input: {
  automationName: string;
  errorMessage: string;
  doctorSummary?: string;
  consecutiveFailures: number;
}): string {
  return [
    "## System Optimizer — automation failure triage",
    `Agentlas 백그라운드 자동화 "${input.automationName}"가 ${input.consecutiveFailures}회 연속 실패했다. 너의 임무는 이 자동화를 다시 굴러가게 만드는 *시스템 차원의* 원인을 찾아 안전하게 수리하는 것이다.`,
    "",
    "### 실패 정보",
    "```",
    input.errorMessage.slice(0, 1500),
    "```",
    input.doctorSummary ? `Runtime Doctor 1차 진단: ${input.doctorSummary}` : "Runtime Doctor 1차 진단: 해당 없음(unknown).",
    "",
    "### 진단 순서 (증거 기반 — 추측으로 설정을 바꾸지 마라)",
    "1. 런타임 CLI 건강: `codex exec --skip-git-repo-check \"Reply OK\" </dev/null`(stdin 반드시 닫기), `claude --version` 등으로 실제 exit code와 stderr를 확인한다.",
    "2. MCP/플러그인 오염: `~/.codex/config.toml`의 `[mcp_servers.*]`와 `[plugins.*]`를 점검한다. 미인증 OAuth 원격 MCP(http type + oauth_resource)가 활성화돼 있으면 런타임 전체가 죽는다 — 사용자가 쓰지 않는 서비스라면 `enabled = false`로 내린다. 수정 전 반드시 백업을 만든다.",
    "3. OS 권한: 자동화가 computer-use/browser 모드면 macOS 접근성·화면 기록 권한, 브라우저 프로필 락을 확인한다.",
    "4. 자원/환경: 디스크 여유, PATH에 CLI 존재 여부, 만료된 토큰(auth.json) 여부.",
    "",
    "### 수리 규칙",
    "- 파괴적이지 않은 수리(플러그인 비활성화, 설정 백업 후 수정, 캐시 정리)는 즉시 실행한다.",
    "- 로그인/OAuth/결제/OS 권한처럼 사용자만 할 수 있는 일은 정확히 한 가지 행동으로 요청한다.",
    "- 수정한 파일은 전부 `<파일>.bak-optimizer-<시각>` 백업을 남긴다.",
    "- 시크릿·토큰 값을 출력에 절대 노출하지 마라.",
    "",
    "### 출력 계약 (반드시 이 형식)",
    "```",
    "## System Optimizer Report",
    "root_cause: <한 줄>",
    "evidence: <명령/파일:라인/exit code>",
    "repairs_applied: <적용한 수리 목록, 없으면 none>",
    "user_action_needed: <사용자가 해야 할 일 한 가지, 없으면 none>",
    "safe_to_retry: yes | no",
    "```",
  ].join("\n");
}

const RUNTIME_CONFIG_MODULE: OnDemandModule = {
  id: "optimizer-runtime-config",
  title: "Runtime config triage",
  keywords: ["codex", "claude", "cli", "config.toml", "mcp", "plugin", "oauth", "exit", "런타임", "플러그인", "설정"],
  description: "CLI 런타임 설정과 MCP/플러그인 오염을 점검·수리하는 절차.",
  load: () =>
    [
      "### Runtime config triage",
      "- 미인증 OAuth 원격 MCP가 활성화된 플러그인은 런타임 프로세스 전체를 fatal로 죽인다. 에러의 호스트와 플러그인 `.mcp.json`의 url 호스트를 대조해 정확한 플러그인만 비활성화한다.",
      "- CLI 스모크는 반드시 stdin을 닫고(`</dev/null`) 실행한다 — codex exec는 stdin이 열려 있으면 영구 블록한다.",
      "- 설정 수정은 항상 백업 후. 사용자가 쓰는(인증된) 플러그인을 오폭하지 않는다.",
    ].join("\n"),
};

const PERMISSIONS_MODULE: OnDemandModule = {
  id: "optimizer-os-permissions",
  title: "OS permissions",
  keywords: ["permission", "accessibility", "screen", "tcc", "권한", "손쉬운 사용", "화면 기록"],
  description: "macOS TCC 권한(접근성/화면 기록)과 브라우저 프로필 락 점검.",
  load: () =>
    [
      "### OS permissions",
      "- 언사인드 재설치는 TCC 권한을 리셋한다 — 접근성/화면 기록이 꺼져 있으면 사용자에게 재부여를 요청한다.",
      "- 브라우저 프로필 락은 이미 떠 있는 Chrome 인스턴스가 원인일 수 있다. 죽이지 말고 보고한다.",
    ].join("\n"),
};

export const SYSTEM_OPTIMIZER_SYSTEM_AGENT: SystemAgentSpec = {
  id: "system-optimizer",
  core: [
    "## System Optimizer",
    "You repair the user's machine-level setup so Agentlas automations run reliably: runtime CLIs, MCP servers/plugins, OS permissions, environment.",
    "Evidence first: never change configuration you have not confirmed broken. Back up every file you modify. Never expose secrets.",
    "Prefer the smallest repair that unblocks the automation; escalate to the user only for actions requiring their identity (login, OAuth, OS permission, payment).",
  ].join("\n"),
  modules: [RUNTIME_CONFIG_MODULE, PERMISSIONS_MODULE],
};
