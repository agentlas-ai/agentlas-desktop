import { getDb } from "../store/db";

/**
 * Terminal causes (invocation_steers.recovery_reason of a cancelled row) that end a queued steer without losing a
 * direction: the owner pulled it back, a newer host report replaced it, the owner stopped the run or the Goal, or a
 * waiting Goal parked the relay so its next turn carries it (store/invocation-steers.ts DurableQueuedSteerTerminalCause).
 */
const SETTLED_STEER_CAUSES = ["owner-withdrawn", "host-report-superseded", "held-system-retired", "held-returned-to-owner",
  "parked-for-waiting-goal", "run-stopped", "goal-stopped"] as const;

/**
 * A queued, draining, failed or cancelled owner direction remains a barrier: a Goal must not wait, verify or replay a startup
 * checkpoint over words of the owner that never ran. Three kinds of row are no such barrier, because no owner direction is
 * lost in them:
 *  - a HOST-written steer (promptOrigin "system": a teammate's report, a wake note, a continuation) that already ended
 *    (cancelled or failed): it carries no words of the owner, and the report ledger reverts it for another delivery;
 *  - a cancelled steer whose cause says its content went on elsewhere or was withdrawn on purpose (SETTLED_STEER_CAUSES);
 *  - the same host report withdrawn by a Main-issued receipt (kept for rows written before causes existed).
 * Owner measurement 2026-10-15..30: 12 of 13 verification_pending_direction refusals and the checkpoint_newer_user_direction ones were
 * teammate reports parked for a waiting Goal (cause parked-for-waiting-goal, no receipt, so the old rule held that
 * turn's verification and wait registration for ever). A steer still queued or draining is unchanged: it runs next.
 */
export function hasPendingInvocationDirection(invocationRunId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM invocation_steers AS s
    WHERE s.original_run_id = ? AND s.status IN ('queued','draining','failed','cancelled')
      AND NOT (s.status IN ('failed','cancelled') AND COALESCE(CASE WHEN json_valid(s.request_json)
        THEN json_extract(s.request_json, '$.promptOrigin') END, '') = 'system')
      AND NOT (s.status = 'cancelled' AND s.recovery_reason IN (${SETTLED_STEER_CAUSES.map(() => "?").join(",")}))
      AND NOT (s.status = 'cancelled' AND EXISTS (
        SELECT 1 FROM run_events AS e WHERE e.run_id = s.original_run_id AND e.chat_id = s.chat_id
          AND e.kind = 'invocation_host_steer_withdrawn'
          AND json_extract(e.payload_json, '$.queuedRequestId') = s.id
          AND json_extract(e.payload_json, '$.reason') = 'host_report_superseded'))
    LIMIT 1`).get(invocationRunId, ...SETTLED_STEER_CAUSES));
}
