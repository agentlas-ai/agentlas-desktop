/*
 * 이 창에서 답한 질문은 옛 목록 읽기로 되살아나지 않는다.
 *
 * 실측(오너 2026-10-18 "이미 지나간 질문칩은 계속 문제일으킴"): One 의 5초 새로고침은 틱 시작에
 * confirm.listPending() 을 읽고, 다른 읽기 열여덟 개를 기다린 뒤에야 그 목록을 화면에 넣는다. 그
 * 사이에 오너가 답하면 답하기 전에 읽은 목록이 방금 닫은 카드를 다시 띄웠다.
 *
 * 규칙: 답을 보낸 질문은 표시해 두고, Main 에서 온 모든 목록에서 뺀다. 표시는 Main 이 그 답을
 * 거절했고 질문이 아직 대기 중일 때만 푼다(release). Main 은 확정된 답의 질문을 다시 내놓지 않으므로
 * 표시가 남아도 지우는 것은 이미 끝난 질문뿐이다.
 */

export interface ConfirmationIdentity {
  chatId: string;
  sourceMessageId: string;
}

export interface ConfirmationAnswerFence {
  /** Marks a question answered here. False when it was already marked (an answer is already on its way). */
  claim(item: ConfirmationIdentity): boolean;
  /** Main refused the answer and the question is still pending: it may show again. */
  release(item: ConfirmationIdentity): void;
  has(item: ConfirmationIdentity): boolean;
  /** Main's pending list without the questions answered here. */
  apply<T extends ConfirmationIdentity>(pending: T[]): T[];
}

const key = (item: ConfirmationIdentity) => `${item.chatId}\0${item.sourceMessageId}`;

export function createConfirmationAnswerFence(limit = 200): ConfirmationAnswerFence {
  const answered = new Set<string>();
  return {
    claim(item) {
      const id = key(item);
      if (answered.has(id)) return false;
      answered.add(id);
      if (answered.size > limit) answered.delete(answered.values().next().value as string);
      return true;
    },
    release(item) {
      answered.delete(key(item));
    },
    has(item) {
      return answered.has(key(item));
    },
    apply(pending) {
      return answered.size === 0 ? pending : pending.filter((item) => !answered.has(key(item)));
    },
  };
}
