















import type { GoalWaitIntent } from "./wait-emitter";
import { getDb } from "../store/db";

export const GOAL_WAIT_FINITE_TIMER_NOTICE = "goal-wait-finite-timer";

function followUpDate(intent: GoalWaitIntent | null | undefined): string | null {
  if (intent?.subject.kind !== "timer") return null;
  const at = Date.parse(intent.subject.notBefore);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null;
}

/** Whether this Goal revision's chat was already told about this refusal (the notice is once per revision). */
export function goalWaitRefusalAlreadyNotified(input: { chatId: string; goalId: string; revision: number | null; reason: string }): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = 'goal_wait_refused'
    AND json_extract(payload_json, '$.goalId') = ? AND json_extract(payload_json, '$.revision') IS ?
    AND json_extract(payload_json, '$.reasonCode') = ? AND json_extract(payload_json, '$.notified') = 1 LIMIT 1`)
    .get(input.chatId, input.goalId, input.revision, input.reason));
}

/** A timer refused only because the Goal is finite ends the turn; it does not block the Goal. */
export function finiteGoalTimerRefusalEndsTurn(input: {
  reason: string;
  lifecycle: string | null | undefined;
  status: string | null | undefined;
  intent: GoalWaitIntent | null | undefined;
  aborted: boolean;
}): boolean {
  return (input.reason === "goal_wait_ongoing_authority_required" || input.reason === "goal_wait_goal_deadline_passed")
    && input.lifecycle === "finite"
    && input.status === "running" && input.intent?.subject.kind === "timer" && !input.aborted;
}

export function finiteGoalTimerRefusalMessage(locale: "ko" | "en", intent: GoalWaitIntent | null | undefined,
  reason = "goal_wait_ongoing_authority_required"): string {
  if (reason === "goal_wait_goal_deadline_passed") {
    return locale === "ko"
      ? "목표 마감이 지나 더 기다리지 않고, 지금 결과를 목표치와 대조해 검증합니다."
      : "The goal's deadline has passed, so there is no further wait: the result is now verified against the target.";
  }

  // said "verifying the results so far to close the goal" for a goal that was far from done and kept running, and told
  // the owner to type a sentence. The refusal only ends this turn; say what was waiting and that the goal goes on.
  const date = followUpDate(intent);
  const next = intent?.nextAction?.replace(/\s+/g, " ").trim().slice(0, 160) ?? "";
  return locale === "ko"
    ? `이 목표는 마감 없이 한 번 끝내는 목표라 ${date ? `${date} ` : ""}재확인 예약${next ? `(“${next}”)` : ""}은 걸지 않았어요. 목표를 닫는 건 아니에요: 이번 턴은 지금까지의 결과로 검증하고, 아직 끝나지 않았으면 목표의 다음 회차에 이어갑니다.`
    : `This goal is a one-time goal without a deadline, so the ${date ? `${date} ` : ""}follow-up${next ? ` ("${next}")` : ""} was not scheduled. The goal is not closed: this turn is verified against the results so far, and if the goal is not done it continues at its next cycle.`;
}

/** Specific copy for a refused wait that does block the Goal. */
export function goalWaitRefusalMessage(reason: string, locale: "ko" | "en", intent?: GoalWaitIntent | null): string {
  const ko = locale === "ko";
  switch (reason) {
    case "goal_wait_ongoing_authority_required":
    case "goal_wait_goal_deadline_passed":
      return finiteGoalTimerRefusalMessage(locale, intent, reason);
    case "goal_wait_timer_invalid":
      return ko
        ? "요청한 재확인 시각이 지금부터 1분 이내이거나 마감 뒤라서 예약하지 못했어요. 답장으로 원하는 시각을 알려 주거나 재개를 누르면 이어서 진행합니다."
        : "The requested check time was less than a minute away or after the deadline, so it was not scheduled. Reply with the time you want, or press Resume to continue.";
    case "goal_wait_deadline_elapsed":
      return ko
        ? "대기 마감 시각이 이미 지나 예약하지 못했어요. 답장으로 새 마감을 알려 주거나 재개를 누르면 이어서 진행합니다."
        : "The wait's deadline had already passed, so it was not scheduled. Reply with a new deadline, or press Resume to continue.";
    default:
      return ko
        ? `대기를 등록하지 못해 목표를 멈췄어요(사유 코드: ${reason}). 답장하거나 재개를 누르면 이어서 진행합니다.`
        : `The wait could not be registered, so the goal is paused (reason code: ${reason}). Reply or press Resume to continue.`;
  }
}

/**
 * The automatic-goal retry cap's owner notice, named after what actually stopped the Goal. The old single
 * sentence ("I checked twice and could not confirm the result") was shown on 2026-09-27 for a Goal whose
 * only problem was a refused follow-up timer — nothing had been left unconfirmed.
 */
export function cappedGoalOwnerReviewMessage(blockedReason: string | null | undefined, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  if (blockedReason === "goal_wait_ongoing_authority_required") {
    return ko
      ? "이 목표는 한 번에 끝내는 작업이라 에이전트가 요청한 나중 재확인(시간 예약)을 걸 수 없어 여기서 멈췄어요. 결과물은 위에 있어요. 목표를 완료로 닫은 뒤, 계속 추적하길 원하시면 \"멈추라고 할 때까지 매주 확인하고 이어가줘\"처럼 보내 주세요. 멈출 때까지 도는 목표로 새로 잡습니다."
      : "This goal is a one-time task, so the later follow-up check the agent asked for could not be scheduled, and it stopped here. The results are above. Close the goal as complete; then, to keep tracking, send something like \"Check every week and keep going until I say stop\" — that starts a goal that runs until you stop it.";
  }
  return ko
    ? "자동 재시도 한도에 도달했고 아직 검증을 통과한 결과가 없어 여기서 멈췄어요. 부족한 점이나 방향을 답장으로 알려 주거나 재개를 누르면 이어서 할게요."
    : "The automatic retry limit was reached and no result has passed verification yet, so I stopped here. Reply with what is missing or which way to go, or press Resume, and I will continue.";
}
