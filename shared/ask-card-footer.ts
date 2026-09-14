/**
 * 묻는 카드 아래 단추가 **하는 일**과, 그 일을 부르는 이름.
 *
 * 이 단추 하나가 두 가지 일을 한다: 답한 것이 없으면 질문을 건너뛰고, 답한 것이 있으면 그 답을
 * 보낸다. 그런데 라벨은 늘 "건너뛰기"였다. 답을 적어 둔 사람이 라벨을 믿고 누르면
 * **적어 둔 답이 그대로 나간다** — 시킨 것과 정반대다.
 *
 * ★"답한 것"은 자유입력만이 아니다 (오너 신고 2026-09-14 재현): 여러 개 고르는 질문에서
 * 보기를 셋 골라도 자유입력이 비어 있으면 단추는 "건너뛰기"였고, 화면 어디에도 보낼 단추가
 * 없었다. 누르면 실제로는 고른 셋이 전송된다 — 라벨과 동작이 정반대로 갈라진 자리다.
 * 그래서 판단에 고른 보기가 있는지를 함께 넣는다.
 *
 * 판단을 여기 한 곳에 둬서, 화면과 검사가 같은 함수를 부르게 한다. 라벨과 동작이 갈라지면
 * 두 곳이 아니라 한 곳이 틀린 것이 된다.
 */

export type AskCardFooterAction = "submit" | "skip";

/** 사람이 이 질문에 이미 답한 것이 있는가 — 자유입력이든, 고른 보기든. */
export interface AskCardFooterState {
  freeText: string;
  /** 하나라도 고른 보기가 있으면 true. */
  hasSelection?: boolean;
}

/** 지금 이 단추를 누르면 실제로 일어나는 일. */
export function askCardFooterAction(state: AskCardFooterState | string): AskCardFooterAction {
  const s = typeof state === "string" ? { freeText: state } : state;
  return s.freeText.trim().length > 0 || Boolean(s.hasSelection) ? "submit" : "skip";
}

/** 그 일을 사람 말로 부른 이름. 동작과 같은 함수에서 갈라져 나온다. */
export function askCardFooterLabel(
  state: AskCardFooterState | string,
  labels: { skipLabel: string; submitLabel: string },
): string {
  return askCardFooterAction(state) === "submit" ? labels.submitLabel : labels.skipLabel;
}
