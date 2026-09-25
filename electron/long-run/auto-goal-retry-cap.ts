/*
 * Retry cap for system-admitted Goals (owner decision 2026-09-25).
 *
 * A Goal the app admitted on its own (automatic intake) gets at most AUTOMATIC_GOAL_RETRY_CAP host
 * continuations — verifier retries, sweep resumes, effect-observation resumes and observation
 * dispatches — counted since the latest owner action. At the cap the host stops spending and settles:
 * done-with-evidence when the latest verification has passed criteria with admitted host refs and none
 * failed, otherwise it asks the owner once and waits (coded blocked reason; the owner's next message or
 * Resume continues it). Measured before: a one-line file write ran 17 invocations / 7 verifier attempts.
 * Explicit Goals (goal chip, owner-defined) keep their own unbounded-by-this-rule contract.
 */
import { getDb } from "../store/db";
import {
  AUTO_GOAL_OWNER_REVIEW_REQUIRED, AUTO_GOAL_SETTLED_WITH_EVIDENCE, settleAutomaticGoalAtRetryCap,
  type LongRunRecord,
} from "../store/long-runs";
import { completeChatGoalContract } from "../store/chat-goals";
import { appendChatMessage, getChat, setChatGoalBinding } from "../store/chats";

export const AUTOMATIC_GOAL_RETRY_CAP = 2;

export function isAutomaticGoal(run: Pick<LongRunRecord, "goalId">): boolean {
  return run.goalId.startsWith("goal:auto-message:");
}

/** Host continuations since the latest owner action (revision binding, user resume, resume with message). */
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
        OR json_extract(payload_json, '$.reason') IN ('blocked-sweep-resume', 'effect-observation-resume')))
      OR (kind = 'run.effect_observation' AND json_extract(payload_json, '$.action') = 'dispatched'))`)
    .get(runId, runId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function automaticGoalAtRetryCap(run: LongRunRecord): boolean {
  return isAutomaticGoal(run) && automaticGoalRetryCount(run.id) >= AUTOMATIC_GOAL_RETRY_CAP;
}

/** Latest verifier round: passed criteria with admitted refs and no failed criterion. */
export function automaticGoalSettlementEvidence(runId: string): { refs: string[]; receiptIds: string[] } | null {
  const worker = getDb().prepare(`SELECT verifier_worker_id AS w FROM long_run_verification_receipts
    WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`).get(runId) as { w: string } | undefined;
  if (!worker) return null;
  const rows = getDb().prepare(`SELECT id, verdict, evidence_refs_json FROM long_run_verification_receipts
    WHERE run_id = ? AND verifier_worker_id = ? ORDER BY rowid`).all(runId, worker.w) as Array<{ id: string; verdict: string; evidence_refs_json: string }>;
  if (!rows.length || rows.some((row) => row.verdict === "failed")) return null;
  const refs = new Set<string>(); const receiptIds: string[] = [];
  for (const row of rows) {
    if (row.verdict !== "passed") continue;
    try { for (const ref of JSON.parse(row.evidence_refs_json) as unknown[]) if (typeof ref === "string") refs.add(ref); } catch { /* malformed refs prove nothing */ }
    receiptIds.push(row.id);
  }
  return refs.size > 0 ? { refs: [...refs], receiptIds } : null;
}

function notify(run: LongRunRecord, locale: "ko" | "en", ko: string, en: string): void {
  if (!run.rootChatId) return;
  try { appendChatMessage(run.rootChatId, "assistant", locale === "ko" ? ko : en, { hostNotice: { purpose: "goal-continuation", runId: run.id } }); }
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
      notify(run, locale, "확인된 결과가 있어 이 목표를 마쳤어요(자동 재시도 2회 한도). 빠진 게 있으면 말씀해 주세요.",
        "I closed this goal on the verified result (automatic retry limit of 2 reached). Tell me if anything is missing.");
      return AUTO_GOAL_SETTLED_WITH_EVIDENCE;
    }
    settleAutomaticGoalAtRetryCap({ runId: run.id, expectedVersion: run.version, outcome: AUTO_GOAL_OWNER_REVIEW_REQUIRED,
      retries, evidenceRefs: [], receiptIds: [] });
    notify(run, locale, "두 번 다시 확인했지만 결과를 확인하지 못해 여기서 멈췄어요. 답장하거나 재개를 누르면 이어서 할게요.",
      "I checked twice and could not confirm the result, so I stopped here. Reply or press Resume and I will continue.");
    return AUTO_GOAL_OWNER_REVIEW_REQUIRED;
  } catch (error) {
    return error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "auto_goal_retry_cap_failed";
  }
}
