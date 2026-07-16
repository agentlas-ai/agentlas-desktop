// Main 프로세스에서 renderer로 push하는 상태/오류 메시지의 i18n.
// 원칙: "영어 사용자에게는 한국어가 보이면 안 됨" (renderer i18n과 동일).
// renderer는 McpInvocationRequest.locale로 자기 locale을 알려준다.
export type RuntimeLocale = "ko" | "en";

/** McpInvocationRequest나 부분 입력에서 locale을 안전하게 추출. fallback은 "en". */
export function pickLocale(req: { locale?: string } | undefined | null): RuntimeLocale {
  const raw = req?.locale ?? "";
  return raw === "ko" ? "ko" : "en";
}

/** Electron app.getLocale() / "ko-KR" 형식을 ko|en으로 정규화 */
export function normalizeOsLocale(raw: string | undefined): RuntimeLocale {
  if (!raw) return "en";
  return raw.toLowerCase().startsWith("ko") ? "ko" : "en";
}

type Args = Record<string, string | number>;

function fmt(template: string, args?: Args): string {
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(args[k] ?? ""));
}

// 같은 키는 항상 ko/en 둘 다 채운다. UI 노출 메시지만 — 디버그/stderr는 그대로 영어.
const DICT = {
  ko: {
    thinking: "{agent}가 생각 중...",
    sending: "전송 중...",
    callingBackend: "{backend} 호출 중...",
    cliImageReady: "첨부 이미지 {count}개를 파일로 준비했습니다 — {backend}가 해당 경로를 읽습니다",
    cliNoImage: "{backend}은 이미지 첨부 미지원 — 텍스트만 전송됩니다",
    cliNoImageClaude:
      "{backend}은 이미지 첨부 미지원 — 텍스트만 전송됩니다 (BYOK API로 전환하면 멀티모달 가능)",
    errChatNotFound: "채팅을 찾지 못했습니다.",
    errAgentNotFound: "에이전트가 삭제되었거나 찾을 수 없습니다.",
    errNoRuntime:
      "연결된 LLM 백엔드가 없습니다. 설정에서 Claude Code/Codex/Gemini CLI 또는 API 키를 연결해 주세요.",
    errNoRunner: "지원하지 않는 런타임 조합: {kind}/{backend}",
    errKeyMissingAnthropic: "Anthropic API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errKeyMissingOpenAI: "OpenAI API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errKeyMissingGoogle: "Google API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errCliMissingClaude:
      "claude CLI를 찾지 못했습니다. `npm i -g @anthropic-ai/claude-code` 후 다시 시도하세요.",
    errCliMissingCodex: "codex CLI를 찾지 못했습니다. `npm i -g @openai/codex` 후 다시 시도하세요.",
    errCliMissingGemini:
      "gemini CLI를 찾지 못했습니다. `npm i -g @google/gemini-cli` 후 다시 시도하세요.",
    errCliMissingGrok:
      "공식 xAI Grok CLI를 찾지 못했습니다. `curl -fsSL https://x.ai/cli/install.sh | bash` 후 다시 시도하세요.",
    errOllamaUnreachable:
      "로컬 Ollama 서버에 연결하지 못했습니다 ({host}). `ollama serve`가 실행 중인지 확인하세요.",
    errOllamaNoModel:
      "사용할 Ollama 모델이 없습니다. 터미널에서 `ollama pull gemma3` 등으로 모델을 받은 뒤 설정에서 선택하세요.",
    sysGuide:
      "사용자의 인터페이스 언어는 한국어입니다. 사용자가 어떤 언어로 입력하든 항상 한국어로 답변하세요. 사용자가 이번 메시지에서 다른 언어로 답하라고 명시적으로 요청할 때만 그 언어를 쓰세요.",
    sysHeader: "당신은 Agentlas Desktop에서 사용자가 설치한 전문 어시스턴트입니다.",
    sysToolsOff:
      "현재 권한에서는 도구 호출이나 코드 실행을 하지 않습니다. 브라우저/MCP 도구가 필요하면 write 또는 full 권한으로 실행하세요.",
    sysAgentDef: "── 에이전트 정의 ──",
    histPrev: "── 이전 대화 ──",
    histThis: "── 이번 요청 ──",
    histPrevSection: "[이전 대화]",
    histThisSection: "[이번 요청]",
    speakerUser: "사용자",
    speakerAssistant: "어시스턴트",
    projectContext: "[프로젝트 컨텍스트 — {name}]",
    firmContext: "[회사 컨텍스트 — {name}]",
    firmCeoGuide:
      "당신은 이 회사의 CEO이며, 사용자가 이 채팅에서 명령을 내릴 때는 회사 전체에 대한 지시로 해석하세요.",
    firmOrgChart: "현재 조직도:",
    firmReportSuffix: "(보고: {to})",
    firmDelegateNote:
      "(CEO로서 어느 본부에 무엇을 맡길지 위임 계획을 정리해 응답하세요.)",
    compacted: "컨텍스트 압축 — 이전 대화 {n}개 메시지를 요약으로 접었습니다",
    compactedDigestHeader: "[압축된 이전 대화 요약 — 오래된 맥락을 간추렸습니다]",
    aborted: "사용자가 정지 버튼으로 실행을 중지했습니다.",
    mcpToolsAttached: "MCP 도구 {count}개 연결됨",
    mcpToolCallUnsupported: "이 모델/서버는 도구 호출(tool_calls) 응답 형식을 지원하지 않는 것 같습니다 — 도구 없이 텍스트로만 계속합니다.",
  },
  en: {
    thinking: "{agent} is thinking...",
    sending: "Sending...",
    callingBackend: "Calling {backend}...",
    cliImageReady: "Prepared {count} attached image file(s) — {backend} will read those paths",
    cliNoImage: "{backend} does not support image attachments — sending text only",
    cliNoImageClaude:
      "{backend} does not support image attachments — sending text only (switch to BYOK API for multimodal)",
    errChatNotFound: "Chat not found.",
    errAgentNotFound: "Agent was removed or could not be found.",
    errNoRuntime:
      "No LLM backend connected. Connect a Claude Code/Codex/Gemini CLI or an API key in Settings.",
    errNoRunner: "Unsupported runtime combination: {kind}/{backend}",
    errKeyMissingAnthropic: "Anthropic API key is not saved. Add it in Settings.",
    errKeyMissingOpenAI: "OpenAI API key is not saved. Add it in Settings.",
    errKeyMissingGoogle: "Google API key is not saved. Add it in Settings.",
    errCliMissingClaude:
      "claude CLI not found. Install with `npm i -g @anthropic-ai/claude-code` and try again.",
    errCliMissingCodex: "codex CLI not found. Install with `npm i -g @openai/codex` and try again.",
    errCliMissingGemini:
      "gemini CLI not found. Install with `npm i -g @google/gemini-cli` and try again.",
    errCliMissingGrok: "Official xAI Grok CLI not found. Install with `curl -fsSL https://x.ai/cli/install.sh | bash` and try again.",
    errOllamaUnreachable:
      "Couldn't reach the local Ollama server ({host}). Make sure `ollama serve` is running.",
    errOllamaNoModel:
      "No Ollama model available. Pull one in your terminal (e.g. `ollama pull gemma3`), then select it in Settings.",
    sysGuide:
      "The user's interface language is English. Always reply in English, regardless of the language the user writes in. Only use another language if the user explicitly asks you to in this message.",
    sysHeader: "You are a specialist assistant installed by the user in Agentlas Desktop.",
    sysToolsOff:
      "Do not invoke tools or execute code in the current permission mode. Switch to write or full permission when browser/MCP tools are needed.",
    sysAgentDef: "── Agent definition ──",
    histPrev: "── Previous turns ──",
    histThis: "── Current request ──",
    histPrevSection: "[Previous turns]",
    histThisSection: "[Current request]",
    speakerUser: "User",
    speakerAssistant: "Assistant",
    projectContext: "[Project context — {name}]",
    firmContext: "[Firm context — {name}]",
    firmCeoGuide:
      "You are the CEO of this firm. Interpret the user's instructions in this chat as orders to the entire firm.",
    firmOrgChart: "Current org chart:",
    firmReportSuffix: "(reports to: {to})",
    firmDelegateNote:
      "(As CEO, lay out which head you'd task with what in your reply.)",
    compacted: "Context compacted — folded {n} earlier messages into a summary",
    compactedDigestHeader: "[Summary of compacted earlier conversation — older context condensed]",
    aborted: "Run stopped from the stop button.",
    mcpToolsAttached: "{count} MCP tool(s) attached",
    mcpToolCallUnsupported: "This model/server doesn't seem to support tool-call responses — continuing with text only, no tools.",
  },
} as const;

export type StatusKey = keyof typeof DICT.ko;

export function tStatus(locale: RuntimeLocale, key: StatusKey, args?: Args): string {
  return fmt(DICT[locale][key], args);
}

export type { RuntimeLocale as Locale };
