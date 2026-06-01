// 모든 런타임(CLI 3종 + BYOK 3종)이 구현해야 하는 통합 인터페이스.
// mcp/client.ts가 활성 런타임 → 적절한 러너로 라우팅한다.
import type { ChatHistoryEntry, ImageAttachment } from "../../shared/types";
import { tStatus, type RuntimeLocale } from "./status-i18n";
import { GLOBAL_CONNECTION_SKILL } from "./global-skill";
import { SURFACE_PROTOCOL } from "../surface-emitter";
import { selectModules } from "../system-agents";
import { SURFACE_MODULE } from "../system-agents/desktop-chat/modules";

export interface RunnerRequest {
  systemPrompt: string;
  history: ChatHistoryEntry[];
  userPrompt: string;
  /** 첨부 이미지 — BYOK 멀티모달에만 사용, CLI는 무시 */
  images?: ImageAttachment[];
  /** 사용자에게 보일 라벨 — "Claude Code CLI" / "Anthropic API" / "Ollama · llama3.1" */
  backendLabel: string;
  /** ollama·BYOK 등 모델 선택이 필요한 LLM의 활성 모델 이름. 그 외엔 미설정 */
  model?: string;
  /** BYOK 긴 컨텍스트(1M) opt-in. Agentlas-managed 러너(BYOK/Ollama)만 사용. */
  longContext?: boolean;
  /** 작업량(reasoning effort) — Claude Code `--effort`로 전달. 그 외 러너는 무시. */
  effort?: string;
  /** 실행 취소 신호 — abort 시 CLI 러너는 자식 프로세스 kill, API 러너는 fetch abort. */
  signal?: AbortSignal;
  /** 도구 사용 권한 — read(읽기) / write(편집) / full(셸·외부). 런타임 권한 모드로 매핑. */
  permission?: "read" | "write" | "full";
  /**
   * 에이전트가 실제로 실행될 작업 디렉터리(= 사용자가 지정한 프로젝트/워킹 폴더).
   * 미설정이면 러너가 안전한 기본 폴더(agentRunCwd)를 쓴다. 파일 생성·빌드는 이 폴더에서 일어난다.
   */
  cwd?: string;
  /**
   * MCP 서버 구성 파일 경로(.mcp.json). 설정되면 Claude Code 러너가 `--mcp-config`로 전달한다.
   */
  mcpConfigPath?: string;
  /** 위 구성의 MCP 툴 이름 prefix 목록(예: "mcp__playwright"). write/full 권한에서 자동 승인용. */
  mcpAllowedTools?: string[];
  /** Codex CLI `exec`에 붙이는 MCP config override args (`-c mcp_servers...`). */
  mcpCodexConfigArgs?: string[];
  /** Agentlas-resolved environment: agent .env first, then global multimodal fallback/vault. */
  env?: NodeJS.ProcessEnv;
  /**
   * 현재 chat 식별자 — 세션 resume를 지원하는 러너(codex)가 (chatId, kind)별 CLI 세션을
   * 재사용해 시스템 프롬프트/히스토리를 매 턴 재전송하지 않도록 한다. 미설정이면 매번 full-context.
   */
  chatId?: string;
  /** 상태/오류 메시지 i18n에 사용. renderer가 동봉, fallback "en" */
  locale: RuntimeLocale;
}

export interface RunnerEvents {
  /** 토큰 또는 줄 단위 partial 출력 */
  onPartial: (chunk: string) => void;
  /** 사용자에게 보일 상태 줄 — locale 적용된 완성 문자열 */
  onStatus: (status: string) => void;
  /** 도구 호출 — Claude Code식 tool-use 블록 (이름 + 인자 JSON). 선택. */
  onTool?: (name: string, args?: string) => void;
}

export interface RunnerResult {
  text: string;
  /** 생성 토큰 수 (가능한 런타임만) */
  tokens?: number;
}

export type Runner = (
  req: RunnerRequest,
  events: RunnerEvents,
) => Promise<RunnerResult>;

/** 에이전트가 사용자에게 옵션 질문을 emit할 수 있는 프로토콜 — renderer/lib/ask-question.ts의 파서와 짝.
 *  로케일 무관, 영어로 — 모델은 항상 영어 docstring을 잘 따른다.
 *  토큰을 아끼기 위해 짧게. */
const ASK_PROTOCOL = `## Clarifying questions to the user

If — and only if — you need an explicit choice from the user to proceed, emit exactly one fenced block, then STOP and wait:

<<agentlas-ask>>
{ "question": "Question text ending with ?", "header": "Short label", "multiSelect": false, "options": [ { "label": "Option A", "description": "what happens" }, { "label": "Option B", "description": "what happens" } ] }
<</agentlas-ask>>

Rules:
- 2–4 options. First option is the recommended one when there's a clear default.
- Skip this when the user's answer wouldn't change what you do, or when a sensible default is obvious — pick it and proceed.
- After the fence, do NOT also answer. The user's selection arrives as their next message.`;

/** 표준 시스템 프롬프트 — 에이전트 프롬프트 앞에 붙는 안전 헤더.
 *  locale에 따라 LLM에게 답변 언어 가이드를 다르게 준다 (영어 사용자에게는 영어 가이드). */
export function wrapSystemPrompt(
  agentSystemPrompt: string,
  locale: RuntimeLocale,
  permission?: "read" | "write" | "full",
  /** 이번 턴의 사용자 입력 — 온디맨드 디스커버리(SURFACE 게이트)에 사용. 미제공 시 회귀 방지로 모두 포함. */
  userPrompt?: string,
): string {
  // write/full 권한이면 도구 사용 허용 안내(Claude Code식 tool-use). read/기본이면 도구 끔.
  const toolsLine =
    permission === "write" || permission === "full"
      ? "You have tools available (file read/write, shell, web search, MCP). Use them when they help complete the task, and say what you're doing."
      : tStatus(locale, "sysToolsOff");

  // 온디맨드: SURFACE_PROTOCOL(~16KB)은 요청이 surface(대시보드/앱/운영OS)에 해당할 때만 주입한다.
  // 단순 Q&A·대화 턴에서 16KB를 통째로 절약(코어 최소화). userPrompt 미제공(레거시 경로)이면 포함.
  // CONNECTION_SKILL은 코어 유지 — 외부연결 미스가 dead-end가 되는 걸 막기 위함(안전한 under-trigger).
  const includeSurface =
    userPrompt === undefined ||
    selectModules(userPrompt, [SURFACE_MODULE], { threshold: 0.8 }).selected.length > 0;

  const parts: string[] = [
    tStatus(locale, "sysHeader"),
    tStatus(locale, "sysGuide"),
    toolsLine,
    "",
    ASK_PROTOCOL,
    "",
    // 항상-켜진 백그라운드 스킬 — 사용자가 "API/MCP"를 몰라도 에이전트가 브라우저로 가입·로그인·키
    // 발급을 손잡고 안내한 뒤 저장하게 한다. 사용자에게는 보이지 않는다(시스템 프롬프트 내부).
    GLOBAL_CONNECTION_SKILL,
    "",
  ];
  if (includeSurface) {
    parts.push(SURFACE_PROTOCOL, "");
  }
  parts.push(tStatus(locale, "sysAgentDef"), agentSystemPrompt);
  return parts.join("\n");
}
