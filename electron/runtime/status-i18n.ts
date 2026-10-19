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
    agentContextTurnWait: "같은 에이전트가 다른 대화에서 일하는 중이라, 그 일이 끝나면 이어서 시작합니다. 지금 시작하려면 그 대화에서 중지하세요...",
    // The wait stopped without the session (agent-context-turn-order.ts): what is happening and what to do, in words the screen already uses.
    agentContextTurnParkedApproval: "같은 에이전트가 다른 대화에서 승인을 기다리고 있어서 이어서 시작하지 못했어요. 그 대화에서 승인하거나 중지한 뒤 다시 보내 주세요.",
    agentContextTurnParkedQuestion: "같은 에이전트가 다른 대화에서 답을 기다리고 있어서 이어서 시작하지 못했어요. 그 대화에서 답하거나 중지한 뒤 다시 보내 주세요.",
    agentContextTurnStuck: "같은 에이전트가 다른 대화에서 일하다 멈춘 것 같아서 이어서 시작하지 못했어요. Agentlas를 다시 열어 정리한 뒤 다시 보내 주세요.",
    agentContextTurnWaitExpired: "같은 에이전트가 다른 대화에서 오래 일하고 있어서 기다리다 멈췄어요. 그 일이 끝나거나 그 대화에서 중지한 뒤 다시 보내 주세요.",
    callingBackend: "{backend} 호출 중...",
    schemaInPromptOnly: "이 실행 경로는 출력 형식을 강제할 수 없어 지시문으로만 요청합니다.",
    cliImageReady: "첨부 이미지 {count}개를 파일로 준비했습니다 — {backend}가 해당 경로를 읽습니다",
    cliNoImage: "{backend}은 이미지 첨부 미지원 — 텍스트만 전송됩니다",
    cliNoImageClaude:
      "{backend}은 이미지 첨부 미지원 — 텍스트만 전송됩니다 (BYOK API로 전환하면 멀티모달 가능)",
    errChatNotFound: "채팅을 찾지 못했습니다.",
    errAgentNotFound: "에이전트가 삭제되었거나 찾을 수 없습니다.",
    errAgentArchived: "보관된 에이전트입니다. 설정 › 저장공간에서 복구하세요.",
    errNoRuntime:
      "연결된 LLM 백엔드가 없습니다. 설정에서 Claude Code/Codex/Antigravity 또는 API 키를 연결해 주세요.",
    errNoRunner: "지원하지 않는 런타임 조합: {kind}/{backend}",
    errKeyMissingAnthropic: "Anthropic API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errKeyMissingOpenAI: "OpenAI API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errKeyMissingGoogle: "Google API 키가 저장되어 있지 않습니다. 설정에서 추가하세요.",
    errCliMissingClaude:
      "claude CLI를 찾지 못했습니다. `npm i -g @anthropic-ai/claude-code` 후 다시 시도하세요.",
    errCliMissingCodex: "codex CLI를 찾지 못했습니다. `npm i -g @openai/codex` 후 다시 시도하세요.",
    errCliMissingAntigravity:
      "Antigravity CLI(agy)를 찾지 못했습니다. Antigravity를 설치하고 로그인한 뒤 다시 시도하세요.",
    errCliMissingGrok:
      "공식 xAI Grok CLI를 찾지 못했습니다. `curl -fsSL https://x.ai/cli/install.sh | bash` 후 다시 시도하세요.",
    errOllamaUnreachable:
      "로컬 Ollama 서버에 연결하지 못했습니다 ({host}). `ollama serve`가 실행 중인지 확인하세요.",
    errOllamaNoModel:
      "사용할 Ollama 모델이 없습니다. 터미널에서 `ollama pull gemma3` 등으로 모델을 받은 뒤 설정에서 선택하세요.",
    errLocalEmptyAnswer:
      "로컬 모델({model})이 답을 한 글자도 내지 않고 끝났습니다. 모델을 바꾸거나 더 짧은 요청으로 다시 시도하세요.",
    errLocalToolLoopStuck:
      "로컬 모델({model})이 도구 호출만 {turns}번 반복하고 답에 도달하지 못했습니다. 이번 실행은 결과로 인정하지 않습니다.",
    





    sysAgentDef: "── 에이전트 정의 ──",
    histPrev: "── 이전 대화 ──",
    histThis: "── 이번 요청 ──",
    histPrevSection: "[이전 대화]",
    histThisSection: "[이번 요청]",
    speakerUser: "사용자",
    speakerAssistant: "어시스턴트",
    projectContext: "[프로젝트 컨텍스트 — {name}]",
    firmContext: "[회사 컨텍스트 — {name}]",
    firmCeoGuide: "역할: 이 회사 CEO. 이 채팅의 지시 = 회사 전체 지시.",
    firmOrgChart: "현재 조직도:",
    firmReportSuffix: "(보고: {to})",
    firmDelegateNote: "(CEO: 어느 본부에 무엇을 맡길지 답에 정리.)",
    compacted: "컨텍스트 압축 — 이전 대화 {n}개 메시지를 요약으로 접었습니다",
    compactedDigestHeader: "[압축된 이전 대화 요약]",
    // 중지 원인은 여러 가지다(사람이 누름·무활동 워치독·단계 시간 초과·예산 소진).
    // 예전엔 전부 "사용자가 정지 버튼으로"라고 단정해, 누른 적 없는 사람이 거짓 사유를 받았다.
    aborted: "실행이 중지되었습니다.",
    abortedByUser: "사용자가 정지 버튼으로 실행을 중지했습니다.",
    mcpToolsAttached: "도구 {count}개 연결됨",
    mcpToolCallUnsupported: "이 모델/서버는 도구 호출(tool_calls) 응답 형식을 지원하지 않는 것 같습니다 — 도구 없이 텍스트로만 계속합니다.",
  },
  en: {
    thinking: "{agent} is thinking...",
    sending: "Sending...",
    agentContextTurnWait: "This agent is still working in another conversation; this turn starts when that one finishes (stop it there to start now)...",
    agentContextTurnParkedApproval: "This agent is waiting for your approval in another conversation, so this could not start. Approve or stop it there, then send again.",
    agentContextTurnParkedQuestion: "This agent is waiting for your answer in another conversation, so this could not start. Answer or stop it there, then send again.",
    agentContextTurnStuck: "This agent's work in another conversation seems to have stopped midway, so this could not start. Reopen Agentlas to clear it, then send again.",
    agentContextTurnWaitExpired: "This agent has been busy in another conversation for a long time, so waiting stopped. Send again once it finishes, or stop it there.",
    callingBackend: "Calling {backend}...",
    schemaInPromptOnly: "This runtime path cannot enforce the output schema — asking for it in the prompt instead.",
    cliImageReady: "Prepared {count} attached image file(s) — {backend} will read those paths",
    cliNoImage: "{backend} does not support image attachments — sending text only",
    cliNoImageClaude:
      "{backend} does not support image attachments — sending text only (switch to BYOK API for multimodal)",
    errChatNotFound: "Chat not found.",
    errAgentNotFound: "Agent was removed or could not be found.",
    errAgentArchived: "This agent is archived. Restore it in Settings › Storage.",
    errNoRuntime:
      "No LLM backend connected. Connect Claude Code, Codex, Antigravity, or an API key in Settings.",
    errNoRunner: "Unsupported runtime combination: {kind}/{backend}",
    errKeyMissingAnthropic: "Anthropic API key is not saved. Add it in Settings.",
    errKeyMissingOpenAI: "OpenAI API key is not saved. Add it in Settings.",
    errKeyMissingGoogle: "Google API key is not saved. Add it in Settings.",
    errCliMissingClaude:
      "claude CLI not found. Install with `npm i -g @anthropic-ai/claude-code` and try again.",
    errCliMissingCodex: "codex CLI not found. Install with `npm i -g @openai/codex` and try again.",
    errCliMissingAntigravity:
      "Antigravity CLI (agy) was not found. Install and sign in to Antigravity, then try again.",
    errCliMissingGrok: "Official xAI Grok CLI not found. Install with `curl -fsSL https://x.ai/cli/install.sh | bash` and try again.",
    errOllamaUnreachable:
      "Couldn't reach the local Ollama server ({host}). Make sure `ollama serve` is running.",
    errOllamaNoModel:
      "No Ollama model available. Pull one in your terminal (e.g. `ollama pull gemma3`), then select it in Settings.",
    errLocalEmptyAnswer:
      "The local model ({model}) finished without producing a single character. Try another model or a shorter request.",
    errLocalToolLoopStuck:
      "The local model ({model}) kept calling tools for {turns} turns without reaching an answer. This run is not accepted as a result.",
    sysAgentDef: "── Agent definition ──",
    histPrev: "── Previous turns ──",
    histThis: "── Current request ──",
    histPrevSection: "[Previous turns]",
    histThisSection: "[Current request]",
    speakerUser: "User",
    speakerAssistant: "Assistant",
    projectContext: "[Project context — {name}]",
    firmContext: "[Firm context — {name}]",
    firmCeoGuide: "role: CEO of this firm; instructions in this chat = orders to the whole firm",
    firmOrgChart: "Current org chart:",
    firmReportSuffix: "(reports to: {to})",
    firmDelegateNote: "(CEO: state which head gets what.)",
    compacted: "Context compacted — folded {n} earlier messages into a summary",
    compactedDigestHeader: "[Summary of compacted earlier conversation]",
    aborted: "The run was stopped.",
    abortedByUser: "Run stopped from the stop button.",
    mcpToolsAttached: "{count} tool(s) attached",
    mcpToolCallUnsupported: "This model/server doesn't seem to support tool-call responses — continuing with text only, no tools.",
  },
} as const;

export type StatusKey = keyof typeof DICT.ko;

export function tStatus(locale: RuntimeLocale, key: StatusKey, args?: Args): string {
  return fmt(DICT[locale][key], args);
}

export type { RuntimeLocale as Locale };
