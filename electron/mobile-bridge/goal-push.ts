/**
 * One phone push per place a Goal stops (a Goal that ran three runs rang the phone three times).
 *
 * A Goal turns one owner sentence into several runs, and every run ends with its own `final`. Pushing at each final made one Goal ring
 * once per run (measured a real installation: 1,161 Goal finals, all still "pending"; the Finance Goal rang three times in
 * two minutes). A final of a Goal run is therefore HELD here and pushed only when the Goal stops: the same notice the final would have
 * sent (resultReady, the thread, the run's own dedupe key), so a phone and a relay of any release read it as before.
 *
 * "Stops" is a machine fact of the Goal's own ledger, never read from text (goalPushVerdict): the Goal is closed, waits for the owner, is
 * paused or out of budget, rests until a time or condition that is not within GOAL_PUSH_NEXT_RUN_WITHIN_MS, or has nothing left that would
 * start. "Continues" is only POSITIVE evidence: a run or verification still going, or the host's own follow-up due within that time.
 * Unsure means continues; the signal that settles it is the next write to the ledger, never a timer.
 *
 * Signals (authority.ts): a run settling, the long-run change bus (this process's writes) and the data_version watch (the background service's
 * writes). A hold is in memory only; what survives a restart is found again from the store (catchUp), and the push queue's own dedupe key
 * (`device:run-result:host:run`) keeps a stop that was already delivered from ringing twice. No table, column or timer is added.
 */
import { getDb } from "../store/db";
import { getLongRunByGoalId, goalOwnerAnswerHold, longRunOwnerHold, pendingBlockedGoalRetry } from "../store/long-runs";
import { latestGoalWaitSubscription } from "../long-run/wait-subscriptions";
import type { MobilePushNotice } from "./push";

/** A follow-up the host starts within this time is the same working session; later than that the Goal is resting and the owner is told. */
export const GOAL_PUSH_NEXT_RUN_WITHIN_MS = 120_000;
/** A restart looks back this far for a Goal that stopped while no bridge was listening. */
export const GOAL_PUSH_CATCH_UP_MS = 10 * 60_000;
/** Goals held at once (a Goal is held from its final until it stops). Past the cap the oldest hold is let go. */
const MAX_HELD_GOALS = 64;

/** `continuing` carries `scheduled`: true when the ledger shows the next run (a follow-up or wait due within the window), false when it only has not shown a stop yet. */
export type GoalPushVerdict = { state: "continuing"; scheduled: boolean } | { state: "dropped" } | { state: "stopped"; ownerAnswer: boolean; failed: boolean };

/** What the Goal's ledger says about the next run, read at the moment of the question. */
export function goalPushVerdict(goalId: string, now = Date.now()): GoalPushVerdict {
  const run = getLongRunByGoalId(goalId);
  // The Goal went with its conversation: nothing to tell about.
  if (!run) return { state: "dropped" };
  // Stopped or deleted by the owner (closeGoal "cancelled"): the owner is looking at it.
  if (run.status === "cancelled" || run.status === "cancelling") return { state: "dropped" };
  if (run.status === "completed") return { state: "stopped", ownerAnswer: false, failed: false };
  if (run.status === "failed") return { state: "stopped", ownerAnswer: false, failed: true };
  if (run.surface === "science") return { state: "stopped", ownerAnswer: false, failed: false };
  // Held for the owner's answer (a decision card): the push says it is a question.
  if (goalOwnerAnswerHold(run.id) || run.status === "waiting_user") return { state: "stopped", ownerAnswer: true, failed: false };
  if (longRunOwnerHold(run.id)) return { state: "stopped", ownerAnswer: false, failed: false };
  // Where the host would start the next run, if it will: its own follow-up, or the registered wait.
  const times: Array<number | null> = [];
  const retry = pendingBlockedGoalRetry(run.id);
  if (retry) times.push(Date.parse(retry.nextAt));
  const wait = latestGoalWaitSubscription(goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) times.push(wait.nextCheckAt ? Date.parse(wait.nextCheckAt) : null);
  if (times.length > 0) {
    // A wait with no time (a condition) rests until it holds: the owner is told. An unreadable time is treated the same way.
    const soonest = Math.min(...times.map((time) => (time !== null && Number.isFinite(time) ? time : Number.POSITIVE_INFINITY)));
    return soonest - now <= GOAL_PUSH_NEXT_RUN_WITHIN_MS ? { state: "continuing", scheduled: true } : { state: "stopped", ownerAnswer: false, failed: false };
  }
  // Paused (the owner, the budget, an approval) with nothing scheduled: it does not start by itself.
  if (run.status === "paused") return { state: "stopped", ownerAnswer: false, failed: false };
  // queued / running / verifying / waiting for a worker or tool without a schedule yet / blocked (the host never leaves a Goal there):
  // a run or a verdict is about to write the next fact.
  return { state: "continuing", scheduled: false };
}

/**
 * The Goal whose push is held for this final, or null. The ONE rule both the push hold (authority.ts observeMobilePushNotices) and the
 * `final` the phone reads (projectMobileBridgeInvocationEvent: goalResult.status "pending") use, so they can never differ: a final the
 * hold keeps is announced to the phone as "the Goal goes on" and a final that is pushed as it always was carries no such mark.
 * A phone with push registered then skips the local alarm for the held final (the push rings once, at the stop); a phone without push
 * still rings per run, as it always did (mobile 81fb975 `_emitInvocationNotificationSignal`). Whether the Goal really continues is not
 * asked here: that verdict decides later, from the ledger, whether the held push is sent (goalPushVerdict).
 * Held: a run's own final (no teammate) that saved an answer, in a conversation that rings with its own results (not the personal agent's
 * One conversation, which has its own path, and not a room the personal agent supervises), and that carries a Goal's binding.
 */
export function goalHeldFinal(
  event: { kind?: string; agentId?: string | null; durableMessageId?: string | null; goalResult?: { goalId?: string | null } | null },
  chat: { personalOne: boolean; pushable: boolean },
): string | null {
  if (event.kind !== "final" || event.agentId || !event.durableMessageId || chat.personalOne || !chat.pushable) return null;
  const goalId = event.goalResult?.goalId;
  return typeof goalId === "string" && goalId ? goalId : null;
}

/** Cheap change mark of a Goal's ledger: a held Goal is read in full only when this moved. */
function ledgerMark(goalId: string): string {
  try {
    const row = getDb().prepare(`SELECT r.status AS status, r.version AS version, (SELECT MAX(seq) FROM long_run_events e WHERE e.run_id = r.id) AS seq
      FROM long_runs r WHERE r.goal_id = ? LIMIT 1`).get(goalId) as { status: string; version: number; seq: number | null } | undefined;
    return row ? `${row.status}:${row.version}:${row.seq ?? 0}` : "none";
  } catch { return "unknown"; }
}

interface Held { runId: string; chatId: string; asksOwner: boolean; failureRang: boolean; mark: string }

export interface GoalPushHoldOptions {
  hostId: string;
  /** The same sender as every other notice (observeMobilePushNotices' listener). */
  emit(notice: MobilePushNotice): void;
  /** The conversation still exists and is not one the personal agent runs (those rooms never ring with their own result). */
  chatPushable(chatId: string): boolean;
  verdict?(goalId: string, now: number): GoalPushVerdict;
  mark?(goalId: string): string;
  now?(): number;
}

export interface GoalPushHold {
  /** A Goal run's final: remember it instead of sending it. The newest final of a Goal replaces the one before. */
  hold(goalId: string, runId: string, chatId: string, asksOwner: boolean): void;
  /** Any other final of the conversation (not a Goal run's) is newer than a held one: the held push is let go. */
  supersede(chatId: string): void;
  /** The conversation's failure push rang: a Goal that then stops as failed does not ring a second time. */
  noteFailure(chatId: string): void;
  /** Ask each held Goal whether it stopped; sends the ones that did. */
  evaluate(): void;
  /** A restart: the Goals that stopped within the window while nothing listened. */
  catchUp(db?: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }): number;
  readonly size: number;
}

export function createGoalPushHold(options: GoalPushHoldOptions): GoalPushHold {
  const held = new Map<string, Held>();
  const verdictOf = options.verdict ?? goalPushVerdict;
  const markOf = options.mark ?? ledgerMark;
  const clock = () => options.now?.() ?? Date.now();
  const notice = (goalId: string, entry: { runId: string; chatId: string }, ownerAnswer: boolean): MobilePushNotice => ({
    category: "resultReady", destination: "thread", hostId: options.hostId,
    entityId: entry.chatId, dedupeKey: `run-result:${options.hostId}:${entry.runId}`,
    subject: "Agentlas", occurredAt: new Date(clock()).toISOString(), ...(ownerAnswer ? { reason: "ownerAnswer" as const } : {}),
  });
  const settle = (goalId: string, entry: Held, force: boolean): void => {
    const mark = markOf(goalId);
    if (!force && mark === entry.mark) return;
    entry.mark = mark;
    const verdict = verdictOf(goalId, clock());
    if (verdict.state === "continuing") return;
    held.delete(goalId);
    if (verdict.state === "dropped") return;
    // The run that failed already rang as a failure; the Goal ending failed says nothing new.
    if (verdict.failed && entry.failureRang) return;
    if (!options.chatPushable(entry.chatId)) return;
    options.emit(notice(goalId, entry, entry.asksOwner || verdict.ownerAnswer));
  };
  return {
    hold(goalId, runId, chatId, asksOwner) {
      held.delete(goalId); // Map order: the newest hold is last
      held.set(goalId, { runId, chatId, asksOwner, failureRang: false, mark: "" });
      // Audit 62 (bridge B9): past the cap the OLDEST hold is not dropped silently (a Goal that then stopped would never ring): its push is sent now, as every final rang before the hold existed.
      while (held.size > MAX_HELD_GOALS) {
        const oldest = held.keys().next().value as string; const entry = held.get(oldest)!; held.delete(oldest);
        try { if (options.chatPushable(entry.chatId)) options.emit(notice(oldest, entry, entry.asksOwner)); } catch { /* the next final rings itself */ }
      }
    },
    supersede(chatId) { for (const [goalId, entry] of held) if (entry.chatId === chatId) held.delete(goalId); },
    noteFailure(chatId) { for (const entry of held.values()) if (entry.chatId === chatId) entry.failureRang = true; },
    evaluate() {
      // The first read of a new hold is not skipped by an unchanged mark: it has never been read.
      for (const [goalId, entry] of [...held]) { try { settle(goalId, entry, entry.mark === ""); } catch { /* the next signal asks again */ } }
    },
    catchUp(db = getDb()) {
      let sent = 0;
      try {
        const since = new Date(clock() - GOAL_PUSH_CATCH_UP_MS).toISOString();
        const rows = db.prepare(`SELECT chat_id AS chatId, run_id AS runId, payload_json AS payload FROM run_events
          WHERE kind = 'goal_result_presentation' AND ts > ? ORDER BY rowid DESC LIMIT 64`).all(since) as Array<{ chatId: string | null; runId: string; payload: string }>;
        const seen = new Set<string>();
        for (const row of rows) {
          let goalId: unknown;
          try { goalId = (JSON.parse(row.payload) as { goalId?: unknown }).goalId; } catch { continue; }
          // An unbound presentation lives on a private stream (`goal-result:<message>`): it is no run's final.
          if (typeof goalId !== "string" || !row.chatId || !row.runId || row.runId.startsWith("goal-result:") || seen.has(goalId) || held.has(goalId)) continue;
          seen.add(goalId);
          const verdict = verdictOf(goalId, clock());
          // Audit 62 (bridge B9): a Goal that is STILL GOING after the restart is held again (the hold was in memory only): when it stops later, the ledger's next write rings it. It used to be forgotten here.
          if (verdict.state === "continuing" && options.chatPushable(row.chatId)) { held.set(goalId, { runId: row.runId, chatId: row.chatId, asksOwner: false, failureRang: false, mark: "" }); continue; }
          // A failed Goal rang as a failure when it failed; only a clean stop is found again here.
          if (verdict.state !== "stopped" || verdict.failed || !options.chatPushable(row.chatId)) continue;
          options.emit(notice(goalId, { runId: row.runId, chatId: row.chatId }, verdict.ownerAnswer));
          sent += 1;
        }
      } catch { /* the next start looks again */ }
      return sent;
    },
    get size() { return held.size; },
  };
}
