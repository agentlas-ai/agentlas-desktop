















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

/**
 * True only for the refusal the app resolves on its own: an outside effect of this run is unconfirmed,
 * so the app re-reads the page read-only and continues without repeating it. Every other refused wait
 * needs the owner (a new time, a new deadline, or Resume). Decided by the reason code, never the copy.
 */
export function goalWaitRefusalResolvesItself(reason: string): boolean {
  return reason === "goal_wait_effects_uncertain";
}

/** Specific copy for a refused wait that does block the Goal. */
export function goalWaitRefusalMessage(reason: string, locale: "ko" | "en", intent?: GoalWaitIntent | null): string {
  const ko = locale === "ko";
  switch (reason) {
    case "goal_wait_effects_uncertain":
      return ko
        ? "이번 실행에서 바깥에 한 작업(클릭·입력 등) 중 결과가 기록으로 확인되지 않은 것이 있어 다음 확인을 예약하지 않았어요. 앱이 먼저 해당 페이지를 읽기 전용으로 다시 보고, 반영됐는지 확인되면 같은 작업을 반복하지 않고 이어갑니다. 직접 확인하셨다면 결과를 답장으로 알려 주셔도 됩니다."
        : "An outside action in this run (a click or typed input) has no recorded result, so the next check was not scheduled. The app will first reopen the page read-only to see whether it took effect, then continue without repeating it. If you already checked, reply with what you saw.";
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

/** Blockers that say "an outside effect is unknown" (mirrors effect-observation OBSERVABLE_BLOCK_REASONS). */
const EFFECT_UNKNOWN_BLOCKERS = new Set([
  "checkpoint_side_effects_uncertain", "goal_wait_effects_uncertain", "auto_goal_resume_attempt_unsettled",
  "goal_resume_effect_boundary_uncertain", "goal_wait_claimed_dispatch_uncertain", "goal_wait_claimed_binding_changed",
]);

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
  if (blockedReason && EFFECT_UNKNOWN_BLOCKERS.has(blockedReason)) {
    return ko
      ? "이전 실행에서 바깥에 한 작업(클릭·입력 등)이 실제로 반영됐는지 확정하지 못했고, 자동 재시도 한도에 도달해 멈췄어요. 해당 페이지에서 결과를 확인한 뒤 재개를 누르거나, 본 내용을 답장으로 알려 주시면 그 상태에서 반복 없이 이어갈게요."
      : "The effect of an earlier outside action (a click or typed input) remains unconfirmed, and the automatic retry limit was reached, so I stopped here. Check the page, then press Resume or reply with what you saw, and I will continue from that state without repeating it.";
  }
  return ko
    ? "자동 재시도 한도에 도달했고 아직 검증을 통과한 결과가 없어 여기서 멈췄어요. 부족한 점이나 방향을 답장으로 알려 주거나 재개를 누르면 이어서 할게요."
    : "The automatic retry limit was reached and no result has passed verification yet, so I stopped here. Reply with what is missing or which way to go, or press Resume, and I will continue.";
}
