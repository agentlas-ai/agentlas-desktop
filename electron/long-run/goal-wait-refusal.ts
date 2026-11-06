















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

/**
 * Refusals whose answer the host already has: the proposal itself cannot be scheduled (its time lies at or after its own deadline,
 * or the deadline is past), and nothing else about the Goal is in question. The model cannot fix them by being told again and the
 * owner has nothing to decide, so they never park the Goal: the turn is verified now (finite Goal) or the host schedules its own
 * observation (ongoing Goal).
 */
export const HOST_RESOLVABLE_WAIT_REFUSALS: ReadonlySet<string> = new Set(["goal_wait_timer_invalid", "goal_wait_deadline_elapsed"]);

export function waitRefusalHostResolves(reason: string): boolean { return HOST_RESOLVABLE_WAIT_REFUSALS.has(reason); }

/** A timer refused only because the Goal is finite ends the turn; it does not block the Goal. */
export function finiteGoalTimerRefusalEndsTurn(input: {
  reason: string;
  lifecycle: string | null | undefined;
  status: string | null | undefined;
  intent: GoalWaitIntent | null | undefined;
  aborted: boolean;
}): boolean {
  if (input.lifecycle !== "finite" || input.status !== "running" || input.aborted) return false;
  if (waitRefusalHostResolves(input.reason)) return true;
  return (input.reason === "goal_wait_ongoing_authority_required" || input.reason === "goal_wait_goal_deadline_passed")
    && input.intent?.subject.kind === "timer";
}

/**
 * A refused wait of a running ONGOING Goal that the host answers by scheduling its own observation instead of leaving the Goal
 * without a next step. A refusal that came after an episode capture is left to the episode's own recovery unless the host
 * resolves it (above) and this turn still owns the episode: the owner has not held the Goal and no newer producer replaced it.
 */
export function ongoingWaitRefusalSchedulesObservation(input: {
  reason: string;
  lifecycle: string | null | undefined;
  status: string | null | undefined;
  aborted: boolean;
  hasTransientAttachments: boolean;
  episodeRefused: boolean;
  ownerHold: boolean;
  producerIsThisTurn: boolean;
}): boolean {
  if (input.lifecycle !== "ongoing" || input.status !== "running" || input.aborted || input.hasTransientAttachments) return false;
  if (!input.episodeRefused) return true;
  return waitRefusalHostResolves(input.reason) && !input.ownerHold && input.producerIsThisTurn;
}

/** What the service does with a refused wait: end the turn through verification, schedule the host's observation, leave an episode refusal to
 * its recovery owner ("protect": the Goal is blocked as a typed fact and nothing is scheduled over the owner's hold, a Stop or a newer producer),
 * or the generic path. One decision, so a test can drive it with the same facts the service reads. */
export type WaitRefusalDisposition = "end_turn_verification" | "schedule_observation" | "protect_episode" | "generic";
export function waitRefusalDisposition(input: {
  reason: string; lifecycle: string | null | undefined; status: string | null | undefined; intent: GoalWaitIntent | null | undefined;
  aborted: boolean; hasTransientAttachments: boolean; episodeRefused: boolean; ownerHold: boolean; producerIsThisTurn: boolean;
}): WaitRefusalDisposition {
  if (finiteGoalTimerRefusalEndsTurn(input)) return "end_turn_verification";
  if (ongoingWaitRefusalSchedulesObservation(input)) return "schedule_observation";
  return input.episodeRefused ? "protect_episode" : "generic";
}

export function finiteGoalTimerRefusalMessage(locale: "ko" | "en", intent: GoalWaitIntent | null | undefined,
  reason = "goal_wait_ongoing_authority_required"): string {
  if (reason === "goal_wait_goal_deadline_passed") {
    return locale === "ko"
      ? "목표 마감이 지나 더 기다리지 않고, 지금 결과를 목표치와 대조해 검증합니다."
      : "The goal's deadline has passed, so there is no further wait: the result is now verified against the target.";
  }
  // The proposal's own time and deadline do not fit: the host does not ask for another time, it verifies what exists now.
  if (reason === "goal_wait_timer_invalid") {
    return locale === "ko"
      ? "요청한 재확인 시각이 대기 마감과 맞지 않아 예약하지 않았어요. 목표를 닫는 건 아니에요: 이번 턴은 지금까지의 결과로 검증하고, 끝나지 않았으면 이어갑니다."
      : "The requested check time does not fit the wait's own deadline, so it was not scheduled. The goal is not closed: this turn is verified against the results so far, and it continues if it is not done.";
  }
  if (reason === "goal_wait_deadline_elapsed") {
    return locale === "ko"
      ? "대기 마감이 이미 지나 기다리지 않고, 지금 상태로 검증합니다. 목표를 닫는 건 아니에요."
      : "The wait's deadline had already passed, so there is no wait: the current state is verified now. The goal is not closed.";
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
