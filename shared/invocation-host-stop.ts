import type { InvocationHostStopCause, InvocationRunReceipt } from "./types";

/**
 * 실행을 끊은 쪽이 Main 자신일 때 남기는 기계 표식(`AbortController.abort(new Error(<표식>))`).
 *
 * 이 표식으로 끝난 실행은 **실패가 아니다** — 앱이 닫혔거나, 오너가 목표를 멈추거나 지웠다.
 * 예전에는 사용자 [중지](stopped_by_user)만 "중단"으로 분류되고 나머지는 전부 `invoke_failed`
 * 로 적혀, One 대화 중간에 붉은 "· 실패 / 작업을 마치지 못했습니다" 줄이 섰다(설치본 실측
 * 2026-09-26: 목표 삭제 1건·앱 종료 1건). 목표 삭제로 끊긴 읽기 전용 턴은 "실패"였기 때문에
 * One 자동 복구가 1.4초 뒤 같은 대화에서 다시 돌렸다 — 오너가 지운 목표의 일을.
 *
 * 표식은 Main 이 직접 쓰는 닫힌 어휘다. 런타임·모델 문장은 여기에 들어오지 않는다.
 */
export const INVOCATION_HOST_STOP_CAUSES: readonly InvocationHostStopCause[] = [
  "app_closed",
  // 사람이 "업데이트하고 이어하기"를 눌러 멈춘 턴. 실패도, 효과 불확실도 아니다 — 새 판으로 켜지면 앱이 한 번 이어간다.
  "update_restart",
  "goal_paused_by_user",
  "goal_deleted_by_user",
];

/** 오너가 목표를 멈추거나 지운 것 — 사용자 [중지]와 같은 뜻(재시도·복구 대상이 아니다). */
export const OWNER_GOAL_STOP_CAUSES: readonly InvocationHostStopCause[] = ["goal_paused_by_user", "goal_deleted_by_user"];

/** 정확히 일치하는 표식만 인정한다(부분 일치·문장 해석 없음). */
export function invocationHostStopCause(value: unknown): InvocationHostStopCause | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (INVOCATION_HOST_STOP_CAUSES as readonly string[]).includes(trimmed) ? trimmed as InvocationHostStopCause : null;
}

export function isOwnerGoalStopCause(value: unknown): boolean {
  const cause = invocationHostStopCause(value);
  return cause !== null && OWNER_GOAL_STOP_CAUSES.includes(cause);
}

/** A terminal host/owner stop is not a provider or tool failure. */
export function isNonFailureInvocationStop(receipt: Pick<InvocationRunReceipt, "status" | "interruptionCause" | "hostStopCause">): boolean {
  if (receipt.status === "cancelled") return true;
  if (receipt.status !== "interrupted" && receipt.status !== "failed") return false;
  return receipt.interruptionCause === "steering" || invocationHostStopCause(receipt.hostStopCause) !== null;
}

/** 대화에 남기는 한 줄 — 무엇 때문에 멈췄는지와, 실패가 아니라는 사실. */
export function invocationHostStopCopy(cause: InvocationHostStopCause, locale: "ko" | "en"): { short: string; detail: string } {
  const ko = locale === "ko";
  if (cause === "app_closed") return ko
    ? { short: "앱 종료로 멈춤", detail: "앱이 종료되어 이 실행이 멈췄습니다. 실행 오류가 아닙니다. Goal 이 있는 대화는 앱을 다시 열면 앱이 이어서 진행합니다." }
    : { short: "stopped when the app closed", detail: "This run stopped because the app closed. It is not a run error. A conversation with a Goal continues on its own after the app reopens." };
  if (cause === "update_restart") return ko
    ? { short: "업데이트로 멈춤", detail: "업데이트를 설치하려고 이 실행을 잠시 멈췄습니다. 실행 오류가 아닙니다. 앱이 다시 켜지면 이어서 진행합니다." }
    : { short: "paused for the update", detail: "This run was paused so the update could install. It is not a run error. It continues when the app comes back." };
  if (cause === "goal_paused_by_user") return ko
    ? { short: "Goal 일시정지로 멈춤", detail: "Goal 을 일시정지해서 이 실행을 멈췄습니다. 실행 오류가 아닙니다. Goal 의 재개를 누르면 이어서 진행합니다." }
    : { short: "stopped when the Goal was paused", detail: "This run stopped because the Goal was paused. It is not a run error. Resume the Goal to continue." };
  return ko
    ? { short: "Goal 삭제로 멈춤", detail: "Goal 을 삭제해서 이 실행을 멈췄습니다. 실행 오류가 아닙니다. 다시 하려면 요청을 새로 보내 주세요." }
    : { short: "stopped when the Goal was deleted", detail: "This run stopped because the Goal was deleted. It is not a run error. Send the request again to start it fresh." };
}
