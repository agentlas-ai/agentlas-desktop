import { getDb } from "../store/db";

/** A failed/cancelled owner direction remains a barrier. Only a Main-issued
 * receipt that withdraws an exact superseded host report can release it. Old
 * rows without such a receipt remain blocked; no historical inference occurs. */
export function hasPendingInvocationDirection(invocationRunId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM invocation_steers AS s
    WHERE s.original_run_id = ? AND s.status IN ('queued','draining','failed','cancelled')
      AND NOT (s.status = 'cancelled' AND EXISTS (
        SELECT 1 FROM run_events AS e WHERE e.run_id = s.original_run_id AND e.chat_id = s.chat_id
          AND e.kind = 'invocation_host_steer_withdrawn'
          AND json_extract(e.payload_json, '$.queuedRequestId') = s.id
          AND json_extract(e.payload_json, '$.reason') = 'host_report_superseded'))
    LIMIT 1`).get(invocationRunId));
}
