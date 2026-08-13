import type { CommittedQuestionAnswer } from "./types";

/** 표시 판정에 필요한 최소 대화 정보 — 렌더러의 UiMessage가 이 모양을 만족한다. */
export interface DecisionThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  streaming?: boolean;
}

export interface DecisionReceiptContext {
  /** 지금 이 스레드에 아직 답하지 않은 질문이 떠 있는가. 있으면 질문이 주인공이다. */
  hasPendingConfirmation: boolean;
}

/**
 * 확정된 결정 영수증("선택했어요")을 지금 보여 줄지 정한다.
 *
 * 영수증은 append-only 원장이라 채팅마다 영구히 쌓인다. 목록의 마지막 항목을 그대로
 * 렌더하면, 어제 고른 선택지가 오늘의 실행 결과 위에 계속 붙어 있게 된다
 * (제보 2026-08-13: 이전 대화에서 고른 "그냥 개념 설명"이 다음 실행에도 그대로 노출).
 *
 * 이 영수증이 말하는 값은 "골랐고, 그래서 지금 이걸 하는 중"이다. One이 그 결정에
 * 답을 끝낸 순간부터는 결과가 그 선택을 대신 말하므로 영수증은 잔해가 된다. 그래서
 * 판정 기준은 시간 창(최근 N분)이 아니라 대화 상태다:
 *   - 답한 질문이 아직 이 스레드에 남아 있는가
 *   - 그 질문 뒤에 **끝난** One의 답변이 왔는가 (스트리밍 중은 아직 끝난 답이 아니다)
 */
export function visibleDecisionReceipt(
  committedAnswers: readonly CommittedQuestionAnswer[],
  messages: readonly DecisionThreadMessage[],
  context: DecisionReceiptContext,
): CommittedQuestionAnswer | null {
  if (context.hasPendingConfirmation) return null;
  const committed = committedAnswers.at(-1) ?? null;
  if (!committed) return null;
  const decidedIndex = messages.findIndex((message) => message.id === committed.sourceMessageId);
  // 답한 질문이 이 스레드에 더는 없으면 그 결정은 이미 지나간 대화의 것이다.
  if (decidedIndex < 0) return null;
  const answeredSince = messages
    .slice(decidedIndex + 1)
    .some((message) => message.role === "assistant" && !message.streaming);
  return answeredSince ? null : committed;
}
