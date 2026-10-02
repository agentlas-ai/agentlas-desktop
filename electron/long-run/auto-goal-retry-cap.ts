/** Historical retry counters remain available for diagnostics. As of 2026-10-02,
 * no retry count stops a Goal or requires owner review before independent work.
 * Evidence-backed completion remains the normal verifier's responsibility. */
import { getDb } from "../store/db";
import {
  AUTO_GOAL_OWNER_REVIEW_REQUIRED, AUTO_GOAL_SETTLED_WITH_EVIDENCE, settleAutomaticGoalAtRetryCap,
  currentCompleteGoalVerificationEvidence,
  type LongRunRecord,
} from "../store/long-runs";
import { completeChatGoalContract } from "../store/chat-goals";
import { appendChatMessage, getChat, setChatGoalBinding } from "../store/chats";
import { cappedGoalOwnerReviewMessage } from "./goal-wait-refusal";

export const AUTOMATIC_GOAL_RETRY_CAP = 2;

export function isAutomaticGoal(run: Pick<LongRunRecord, "goalId">): boolean {
  return run.goalId.startsWith("goal:auto-message:");
}








export function automaticGoalRetryCount(runId: string): number {
  const row = getDb().prepare(`WITH boundary AS (
      SELECT COALESCE(MAX(seq), 0) AS seq FROM long_run_events WHERE run_id = ? AND (
        kind = 'run.goal_revision_bound'
        OR (kind = 'run.user_control' AND actor_kind = 'user'
          AND (json_extract(payload_json, '$.action') = 'resume_with_message' OR json_extract(payload_json, '$.command') = 'resume'))
        OR (kind = 'run.status_changed' AND actor_kind = 'user' AND json_extract(payload_json, '$.to') IN ('queued', 'running'))))
    SELECT COUNT(*) AS n FROM long_run_events, boundary WHERE run_id = ? AND long_run_events.seq > boundary.seq AND (
      (kind = 'run.status_changed' AND actor_kind = 'host' AND (
        json_extract(payload_json, '$.reason') GLOB 'verification_inconclusive_retry:*'
        OR json_extract(payload_json, '$.reason') GLOB 'verification_repairable_retry:*'
        OR json_extract(payload_json, '$.reason') = 'blocked-sweep-resume')))`)
    .get(runId, runId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function automaticGoalAtRetryCap(_run: LongRunRecord): boolean {
  // Retry history remains measurable, but no count parks a Goal for owner review.
  return false;
}

/** Latest complete, current, authorized verifier round with resolvable host refs. */
export function automaticGoalSettlementEvidence(runId: string): { refs: string[]; receiptIds: string[] } | null {
  return currentCompleteGoalVerificationEvidence(runId);
}

/** `status` is the durable host-status marker (both lines here stay prominent: a closed goal, an owner review). */
function notify(run: LongRunRecord, locale: "ko" | "en", status: "goal-closed" | "needs-owner", ko: string, en: string): void {
  if (!run.rootChatId) return;
  try { appendChatMessage(run.rootChatId, "assistant", locale === "ko" ? ko : en, { hostNotice: { purpose: "host-status", runId: run.id, status } }); }
  catch (error) { console.warn("[auto-goal-retry-cap] chat notice failed:", error); }
}

/** Settle a capped automatic Goal. Returns the coded outcome, or null when the Goal is not capped. */
export function settleCappedAutomaticGoal(run: LongRunRecord, locale: "ko" | "en"): string | null {
  if (!automaticGoalAtRetryCap(run)) return null;
  if (run.status === "blocked" && run.blockedReason === AUTO_GOAL_OWNER_REVIEW_REQUIRED) return AUTO_GOAL_OWNER_REVIEW_REQUIRED;
  const retries = automaticGoalRetryCount(run.id);
  const evidence = automaticGoalSettlementEvidence(run.id);
  try {
    if (evidence) {
      settleAutomaticGoalAtRetryCap({ runId: run.id, expectedVersion: run.version, outcome: AUTO_GOAL_SETTLED_WITH_EVIDENCE,
        retries, evidenceRefs: evidence.refs, receiptIds: evidence.receiptIds });
      completeChatGoalContract(run.goalId, "completed");
      if (run.rootChatId && getChat(run.rootChatId)?.goalId === run.goalId) setChatGoalBinding(run.rootChatId, null);
      notify(run, locale, "goal-closed", "확인된 결과가 있어 이 목표를 마쳤어요(자동 재시도 2회 한도). 빠진 게 있으면 말씀해 주세요.",
        "I closed this goal on the verified result (automatic retry limit of 2 reached). Tell me if anything is missing.");
      return AUTO_GOAL_SETTLED_WITH_EVIDENCE;
    }
    settleAutomaticGoalAtRetryCap({ runId: run.id, expectedVersion: run.version, outcome: AUTO_GOAL_OWNER_REVIEW_REQUIRED,
      retries, evidenceRefs: [], receiptIds: [] });
    // Name what stopped it (goal-wait-refusal.ts): the single "could not confirm" sentence was shown on
    // 2026-09-27 for a Goal whose only problem was a refused follow-up timer.
    notify(run, locale, "needs-owner", cappedGoalOwnerReviewMessage(run.blockedReason, "ko"), cappedGoalOwnerReviewMessage(run.blockedReason, "en"));
    return AUTO_GOAL_OWNER_REVIEW_REQUIRED;
  } catch (error) {
    return error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "auto_goal_retry_cap_failed";
  }
}
