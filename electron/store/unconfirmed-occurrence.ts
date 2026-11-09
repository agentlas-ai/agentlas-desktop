import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { currentUiLocale } from "../ui-locale";

/**
 * Deliveries of one occurrence whose outside effect stayed unknown (a step that may have posted, sent or uploaded). The same cap as a
 * scheduled occurrence (automation-scheduler.ts MAX_SCHEDULE_OCCURRENCE_ATTEMPTS, which takes this value): the owner decided on
 * that such a step keeps running and a duplicate is accepted, but not 48 redeliveries (about 38 hours, up to ~96 runs of one
 * mutating step). At the cap the app closes the occurrence by itself; it asks the owner nothing and the next occurrence runs normally.
 * Lives here, with no import of the store, so the boot recovery in db.ts and the trigger outbox share one number.
 */
export const UNCONFIRMED_OCCURRENCE_MAX_DELIVERIES = 3;

export type DeadHostEventSettlement =
  | { closed: false; deliveries: number }
  | { closed: true; deliveries: number };

/** The one plain line the owner reads in the automation's run history when the app closes an occurrence by itself. */
export function deadHostClosedLine(deliveries: number, locale: "ko" | "en"): string {
  return locale === "ko"
    ? `앱이 ${deliveries}번 멈춰서 바깥에 반영됐는지 확인하지 못했고, 앱이 이 회차를 스스로 닫았어요. 더 이어서 돌리지 않아요. 다음 회차는 평소처럼 실행돼요.`
    : `The app stopped ${deliveries} times during this occurrence and could not confirm whether the step took effect outside, so it closed this occurrence by itself. It does not run it again. The next occurrence runs as usual.`;
}

/**
 * The host died while an event occurrence was running and its sealed checkpoint cannot prove the step in flight only read
 * (store/db.ts stale-run recovery). Before the event was parked for the owner. decision an interrupted
 * step of unknown outcome never stops to ask, a duplicate is accepted; the redelivery resumes the same occurrence (finished steps come
 * back from the checkpoint, an AI step is told once that the earlier attempt may have partly happened and checks first).
 *
 * Bounded like every other unknown outcome: the dead run is one delivery that ended unconfirmed, and the third closes the occurrence by
 * itself (status delivered with the typed reason in last_error, a run-event ledger entry, the occurrence's runs acknowledged, one plain
 * line in the automation's run history). The owner is asked nothing. Runs inside the caller's transaction.
 */
export function settleDeadHostTriggerEvent(
  db: Database.Database,
  input: { eventId: string; automationId: string; runId: string; occurrenceId: string | null; now: Date; hasRunEvents: boolean },
): DeadHostEventSettlement {
  const nowIso = input.now.toISOString();
  const columns = new Set((db.pragma("table_info(automation_trigger_events)") as Array<{ name: string }>).map((column) => column.name));
  const counted = columns.has("unknown_outcome_count");
  const before = counted
    ? (db.prepare("SELECT unknown_outcome_count AS n FROM automation_trigger_events WHERE id = ?").get(input.eventId) as { n: number | null } | undefined)?.n ?? 0
    : 0;
  const deliveries = before + 1;
  if (counted && deliveries >= UNCONFIRMED_OCCURRENCE_MAX_DELIVERIES) {
    const closed = db.prepare(
      `UPDATE automation_trigger_events
       SET status = 'delivered', claim_owner = NULL, claimed_until = NULL, delivered_at = ?,
           last_error = ?, unknown_outcome_count = ?, run_id = ?, updated_at = ?
       WHERE id = ? AND status = 'claimed'`,
    ).run(nowIso, "trigger_event_unconfirmed_closed:cap: trigger_event_host_died_unconfirmed", deliveries, input.runId, nowIso, input.eventId);
    if (closed.changes !== 1) return { closed: false, deliveries };
    const line = deadHostClosedLine(deliveries, currentUiLocale());
    const occurrence = input.occurrenceId ?? `trigger-event:${input.eventId}`;
    db.prepare(
      `UPDATE run_history SET acknowledged_at = ?
       WHERE automation_id = ? AND acknowledged_at IS NULL
         AND id IN (SELECT id FROM automation_runs WHERE automation_id = ? AND occurrence_id = ?)`,
    ).run(nowIso, input.automationId, input.automationId, occurrence);
    // The dead run never reached the scheduler's settlement, so it has no history row of its own: the line is that row.
    db.prepare(
      `INSERT OR IGNORE INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error, acknowledged_at)
       VALUES (?, ?, NULL, ?, 'partial', 0, ?, ?)`,
    ).run(input.runId, input.automationId, nowIso, line, nowIso);
    if (input.hasRunEvents) {
      const seq = Number((db.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM run_events WHERE run_id = ?").get(input.runId) as { seq?: number } | undefined)?.seq ?? 0);
      db.prepare(
        `INSERT INTO run_events (id, run_id, seq, ts, kind, automation_id, payload_json) VALUES (?, ?, ?, ?, 'trigger_event_unconfirmed_closed', ?, ?)`,
      ).run(`evt_${randomUUID()}`, input.runId, seq, nowIso, input.automationId, JSON.stringify({
        schemaVersion: "agentlas.trigger-event-unconfirmed-close.v1", eventId: input.eventId, deliveries, reasonCode: "host_died_cap",
      }));
    }
    return { closed: true, deliveries };
  }
  db.prepare(
    `UPDATE automation_trigger_events
     SET status = 'pending', claim_owner = NULL, claimed_until = NULL,
         run_id = NULL, run_outcome = NULL, next_attempt_at = ?, last_error = NULL, ${counted ? "unknown_outcome_count = ?," : ""} updated_at = ?
     WHERE id = ? AND status = 'claimed'`,
  ).run(...[nowIso, ...(counted ? [deliveries] : []), nowIso, input.eventId]);
  return { closed: false, deliveries };
}
