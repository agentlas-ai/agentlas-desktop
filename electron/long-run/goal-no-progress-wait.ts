import { getDb } from "../store/db";
import { goalOwnerAnswerHold, getLongRun, longRunOwnerHold, nextBlockedGoalRetrySlot, noProgressRetryDelayMs, releaseGoalOwnerAnswerHold,
  scheduleBlockedGoalRetry, type LongRunRecord } from "../store/long-runs";
import { VERIFICATION_NO_PROGRESS_REASON } from "../../shared/long-run-checkpoint";
import { HOST_OWNER_CARD_POSTED_KIND, pendingHostOwnerCard } from "./goal-owner-card-decision";
import { desktopAppInstanceId } from "./app-runtime-coordinator";

/*
 * A Goal whose verification keeps finding the same outcome rests until a later time; it is neither parked as blocked nor woken by the
 * minute. The host makes no model call in between. A new owner message, a new Goal revision (store/long-runs.ts
 * pullForwardNoProgressRetry) and an app restart each look once, at once.
 *
 * Why not "blocked": the host reads a requested blocked as running (shared/long-run.ts resolveNonBlockingGoalStatus) and the sweep resumes a
 * Goal within a minute, so the old stop was a name only. X Marketing repeated one result 38 times until the daily wake cap.
 */

/** The rest after a no-progress verification: 30 min at the limit, doubling per further identical verification, 6 h at most. */
export function scheduleNoProgressRetry(runId: string, noProgressRetries: number, nowMs = Date.now()): LongRunRecord | null {
  const run = getLongRun(runId);
  // A Goal resting for the owner (their own pause, or the answer to a question the turn asked) keeps that hold: nothing is scheduled under it.
  if (!run || run.surface === "science" || longRunOwnerHold(run.id) || goalOwnerAnswerHold(run.id)) return null;
  let appInstanceId: string | null = null;
  try { appInstanceId = desktopAppInstanceId(); } catch { /* a process without the coordinator writes the retry without an instance id */ }
  return scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "resume",
    // The counter lives in the checkpoint, never in this reason: a reason that changed on every turn made the AGI state fingerprint
    // open a new incident each time.
    fromReason: VERIFICATION_NO_PROGRESS_REASON, retryIndex: Math.max(0, Math.floor(noProgressRetries)),
    nextAt: new Date(nowMs + noProgressRetryDelayMs(noProgressRetries)).toISOString(),
    detail: VERIFICATION_NO_PROGRESS_REASON, trigger: "verification-no-progress", appInstanceId, requestedBy: "host" });
}

/**
 * Startup, once per store (an idempotent query): a Goal an earlier build held for the host's own "idle stop" card goes back onto a retry
 * schedule. That card was fixed host text, not a question the model asked, and nothing woke the Goal while it stood. The card message
 * stays as history and the owner's pick on it is still read (goal-owner-card-decision.ts). A hold the Goal's own later question took over
 * (a newer run.owner_answer_pending) is the model's real question and is left alone. Returns the number moved.
 */
export function releaseIdleStopCardHolds(options: { nowMs?: number; random?: () => number } = {}): number {
  const nowMs = options.nowMs ?? Date.now();
  const rows = getDb().prepare(`SELECT r.id AS id FROM long_runs r WHERE r.status='waiting_tool' AND r.surface!='science'
    AND r.blocked_reason='goal_owner_answer_required' AND EXISTS (
      SELECT 1 FROM long_run_events e WHERE e.run_id=r.id AND e.kind=?)`).all(HOST_OWNER_CARD_POSTED_KIND) as { id: string }[];
  let moved = 0;
  for (const row of rows) {
    try {
      const card = pendingHostOwnerCard(row.id);
      if (!card || card.cardKind !== "goal_idle_stop") continue;
      const newer = getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.owner_answer_pending' AND seq > ? LIMIT 1").get(row.id, card.seq);
      if (newer) continue;
      const held = getLongRun(row.id);
      if (!held || longRunOwnerHold(row.id)) continue;
      let appInstanceId: string | null = null;
      try { appInstanceId = desktopAppInstanceId(); } catch { /* see above */ }
      const released = releaseGoalOwnerAnswerHold({ runId: row.id, expectedVersion: held.version, reason: "idle_stop_card_retired", appInstanceId });
      // 30 s plus up to 5 min of jitter, so a burst of Goals does not wake together.
      const jitter = Math.floor(Math.min(0.999999, Math.max(0, (options.random ?? Math.random)())) * 5 * 60_000);
      scheduleBlockedGoalRetry({ runId: row.id, expectedVersion: released.version, kind: "resume", fromReason: "idle_stop_card_retired",
        retryIndex: nextBlockedGoalRetrySlot(row.id, nowMs).retryIndex, nextAt: new Date(nowMs + 30_000 + jitter).toISOString(),
        detail: "idle_stop_card_retired", trigger: "startup-cleanup", appInstanceId, requestedBy: "host" });
      moved += 1;
    } catch (error) { console.warn("[long-run] could not release an idle-stop card hold:", error); }
  }
  return moved;
}
