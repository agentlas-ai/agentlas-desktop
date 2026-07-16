// 대화 연속성 헬퍼 — 어떤 러너/경로로 실행돼도 "같은 대화"가 유지되게 하는 공용 모듈.
//
// 두 가지 문제를 함께 푼다:
//  1) CLI 세션을 이어갈 수 없어 히스토리를 텍스트로 재주입할 때, 모델이 그 기록을
//     "이전 세션/다른 대화"로 취급하지 않도록 연속성 프레이밍을 붙인다.
//  2) 재주입 히스토리가 무한히 자라지 않도록 compactHistory로 오래된 턴만 요약 다이제스트로
//     접는다 — "컨텍스트가 찼을 때만 압축, 그 외 전부 원문 유지" 계약의 구현.
import type { ChatHistoryEntry } from "../../shared/types";
import { tStatus, type RuntimeLocale } from "./status-i18n";
import { compactHistory } from "./compact";

/** CLI 러너가 새 세션을 시드할 때 재주입 히스토리에 허용하는 유효 컨텍스트(토큰). */
export const CLI_HISTORY_CONTEXT_TOKENS = 120_000;

/** 스웜 워커/신시사이저에 주입하는 대화 컨텍스트 예산 — 워커 수만큼 곱해지므로 보수적으로. */
export const SWARM_HISTORY_CONTEXT_TOKENS = 8_000;

function continuityNote(locale: RuntimeLocale): string {
  return locale === "ko"
    ? "위 기록은 지금 이어지고 있는 바로 이 대화다. 너는 처음부터 이 대화를 함께한 어시스턴트로서 자연스럽게 이어서 답한다. '이전 세션', '이전 대화 기록을 보면' 같은 표현으로 별개의 대화처럼 언급하지 마라."
    : "The transcript above is THIS very conversation, still in progress. Continue it naturally as the assistant who has been present from the start. Never refer to it as a 'previous session' or a separate conversation.";
}

export interface ConversationContextResult {
  /** 완성된 히스토리 블록(헤더 + 필요 시 다이제스트 + 최근 원문 + 연속성 노트). 히스토리가 없으면 "". */
  block: string;
  /** 다이제스트로 접힌 과거 메시지 수 — 0이면 전부 원문 유지. */
  droppedCount: number;
}

/**
 * 히스토리를 연속성 프레이밍이 붙은 단일 텍스트 블록으로 렌더링한다.
 * 예산(contextWindowTokens)을 넘길 때만 오래된 턴을 다이제스트로 접고, 그 외에는 원문 유지.
 */
export function renderConversationContext(
  history: ChatHistoryEntry[],
  locale: RuntimeLocale,
  contextWindowTokens: number,
): ConversationContextResult {
  if (history.length === 0) return { block: "", droppedCount: 0 };
  const { recent, digest, droppedCount } = compactHistory(history, {
    contextWindow: contextWindowTokens,
    locale,
  });
  const user = tStatus(locale, "speakerUser");
  const assistant = tStatus(locale, "speakerAssistant");
  const lines = recent.map((m) => `${m.role === "user" ? user : assistant}: ${m.text}`);
  const parts: string[] = [tStatus(locale, "histPrev")];
  if (digest) parts.push(digest, "");
  parts.push(lines.join("\n\n"), "", continuityNote(locale));
  return { block: parts.join("\n"), droppedCount };
}

/** 스웜/Ollama 등 다른 경로 턴의 gap-replay에 허용하는 컨텍스트 예산(토큰). */
export const GAP_HISTORY_CONTEXT_TOKENS = 16_000;

/**
 * 세션이 마지막으로 본 시점(sessionUpdatedAt) 이후에 쌓인 메시지들 — 같은 채팅이
 * 스웜/Ollama 등 다른 실행 경로로 진행한 턴들이다. resume 세션의 컨텍스트에는 없으므로
 * gap-replay로 메워야 "어떤 경로로 빠져도" 대화가 유지된다.
 */
export function unseenHistoryGap(
  history: ChatHistoryEntry[],
  sessionUpdatedAt: string | null | undefined,
): ChatHistoryEntry[] {
  if (!sessionUpdatedAt) return [];
  // ISO 8601 문자열은 사전순 비교가 시간순 비교와 일치한다. 밀리초가 같은 메시지는
  // 누락보다 한 번 더 전달하는 편이 안전하므로 경계를 포함한다(at-least-once replay).
  return history.filter((m) => m.createdAt && m.createdAt >= sessionUpdatedAt);
}

/** gap 메시지들을 resume 턴에 실을 블록으로 렌더링한다. 없으면 "". */
export function renderGapContext(
  gap: ChatHistoryEntry[],
  locale: RuntimeLocale,
): string {
  if (gap.length === 0) return "";
  const intro = locale === "ko"
    ? "네가 이 대화에서 마지막으로 응답한 이후, 아래 턴들이 다른 실행 경로(스웜/다른 러너)로 진행됐다. 모두 같은 대화의 일부다."
    : "Since your last reply in this conversation, the turns below happened via another execution path (swarm/another runner). They are all part of this same conversation.";
  const { block } = renderConversationContext(gap, locale, GAP_HISTORY_CONTEXT_TOKENS);
  return `${intro}\n${block}`;
}

/**
 * 세션 resume 턴의 사용자 메시지를 구성한다 — 호스트가 이번 턴에만 주는 배경 컨텍스트
 * (메모리 캡슐·온톨로지·MCP 선택 등)를 사용자 메시지 앞에 명확히 구분해 싣는다.
 * resume에서는 시스템 프롬프트가 재전송되지 않으므로 이 경로가 유일한 전달 수단이다.
 */
export function composeResumeTurnPrompt(
  userPrompt: string,
  turnContext: string | undefined,
  locale: RuntimeLocale,
): string {
  const ctx = turnContext?.trim();
  if (!ctx) return userPrompt;
  const header = locale === "ko"
    ? "── 턴 컨텍스트(호스트 주입 배경 정보 — 사용자 메시지 아님, 언급·인용하지 말 것) ──"
    : "── Turn context (host-injected background — not part of the user's message; do not mention or quote it) ──";
  return [header, ctx, "", tStatus(locale, "histThis"), userPrompt].join("\n");
}
