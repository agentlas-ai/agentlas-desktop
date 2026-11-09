import { randomUUID } from "node:crypto";
import {
  acknowledgeTriggerEvent,
  beginTriggerEventAttempt,
  bindTriggerEventRun,
  claimNextTriggerEvent,
  completeTriggerEventRun,
  deferTriggerEventClaim,
  expireStaleEventsOfDisabledAutomations,
  failTriggerEventAttempt,
  getTriggerEvent,
  parkTriggerEventClaim,
  closeParkedStoppedCheckEvents,
  closeTriggerEventAfterStoppedCheck,
  noteClosedOccurrenceInTimeline,
  renewTriggerEventClaim,
  settleUnconfirmedTriggerEventAttempt,
  type TriggerDeliveryHooks,
  type StoppedCheckClosure,
  type TriggerDispatchResult,
  type TriggerEventRecord,
  type TriggerEventPayload,
} from "../store/trigger-events";
import { requiresGraphReconciliation } from "../automation-strategy-cycle";
import { tryRecordRunEvent } from "../store/run-events";
import { currentUiLocale } from "../ui-locale";

export type TriggerEventRunFn = (
  automationId: string,
  ctx: TriggerEventPayload,
  hooks: TriggerDeliveryHooks,
) => Promise<TriggerDispatchResult>;

const OWNER = `${process.pid}:${process.argv.includes("--headless-automations") ? "headless" : "gui"}:trigger:${randomUUID()}`;
const CLAIM_RENEW_MS = 30_000;
const IDLE_PUMP_MS = 30_000;
const BUSY_RETRY_MS = 5_000;
const MAX_DRAIN_BATCH = 32;

/**
 * A delivery that ended with an unknown outside effect keeps running within bounds (store/trigger-events.ts
 * settleUnconfirmedTriggerEventAttempt: 3 deliveries, or the first repeat of the same held steps when no model step is among them).
 * When that closes the occurrence, the app records it itself and asks the owner nothing: a ledger entry on the run and one plain
 * line in the automation's timeline. The next occurrence of the automation is another event and runs normally.
 */
function settleUnconfirmedDelivery(
  event: TriggerEventRecord,
  error: string,
  facts: { signature: string; askableAgain: boolean } | undefined,
): void {
  const settled = settleUnconfirmedTriggerEventAttempt(event.id, OWNER, error, {
    signature: facts?.signature ?? null,
    askableAgain: facts?.askableAgain ?? true,
  });
  if (!settled.closed) return;
  const runId = settled.runId ?? getTriggerEvent(event.id)?.runId ?? null;
  tryRecordRunEvent({
    runId: runId ?? `trigger-event:${event.id}`,
    automationId: event.automationId,
    kind: "trigger_event_unconfirmed_closed",
    sourceEventId: `trigger-event-unconfirmed-closed:${event.id}`,
    evidencePhase: "observed",
    payload: {
      schemaVersion: "agentlas.trigger-event-unconfirmed-close.v1",
      eventId: event.id,
      deliveries: settled.deliveries,
      reasonCode: settled.reason === "repeat" ? "unknown_outcome_repeat" : "unknown_outcome_cap",
    },
  });
  const ko = currentUiLocale() === "ko";
  const line = settled.reason === "repeat"
    ? (ko
      ? "같은 단계가 다시 같은 모습으로 멈춰 앱이 이 회차를 스스로 닫았어요. 바깥에 반영됐는지 확인하지 못했고, 같은 단계를 더 돌리지 않아요. 다음 회차는 평소처럼 실행돼요."
      : "The same step stopped the same way again, so the app closed this occurrence by itself. It could not confirm whether the step took effect outside and does not run it again. The next occurrence runs as usual.")
    : (ko
      ? `바깥에 반영됐는지 ${settled.deliveries}번 시도하고도 확인하지 못해 앱이 이 회차를 스스로 닫았어요. 더 이어서 돌리지 않아요. 다음 회차는 평소처럼 실행돼요.`
      : `After ${settled.deliveries} tries the app could not confirm whether the step took effect outside, so it closed this occurrence by itself. It does not run it again. The next occurrence runs as usual.`);
  try { noteClosedOccurrenceInTimeline(event.automationId, event.id, runId, line); } catch { /* the closing is durable; the line is a courtesy */ }
}

/**
 * A check that failed and cannot change by running the occurrence again ends it: the app closes the occurrence by
 * itself, a ledger entry on the run and one plain line in the automation's run history, the owner is asked nothing, and the next occurrence
 * is another event that runs normally. No parked state, so there is no Retry that could only judge the same result again.
 */
function recordStoppedCheckClosure(closure: StoppedCheckClosure, reasonCode: string): void {
  tryRecordRunEvent({
    runId: closure.runId ?? `trigger-event:${closure.id}`,
    automationId: closure.automationId,
    kind: "trigger_event_check_stopped_closed",
    sourceEventId: `trigger-event-check-stopped-closed:${closure.id}`,
    evidencePhase: "observed",
    payload: { schemaVersion: "agentlas.trigger-event-check-stop-close.v1", eventId: closure.id, reasonCode },
  });
  const ko = currentUiLocale() === "ko";
  const line = ko
    ? "검증이 같은 결과로 계속 통과하지 못했고 다시 돌려도 달라지지 않아서, 앱이 이 회차를 스스로 닫았어요. 더 이어서 돌리지 않아요. 다음 회차는 평소처럼 실행돼요."
    : "The check kept failing on the same result and running it again cannot change that, so the app closed this occurrence by itself. It does not run it again. The next occurrence runs as usual.";
  try { noteClosedOccurrenceInTimeline(closure.automationId, closure.id, closure.runId, line); } catch { /* the closing is durable; the line is a courtesy */ }
}

let runFn: TriggerEventRunFn | null = null;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let drainPromise: Promise<number> | null = null;
let stopped = true;

async function deliverClaimedEvent(event: TriggerEventRecord, run: TriggerEventRunFn): Promise<void> {
  if (!event.payloadValid) {
    if (!parkTriggerEventClaim(event.id, OWNER, "trigger_event_payload_malformed")) {
      throw new Error("trigger_event_payload_park_conflict");
    }
    return;
  }
  // A process can crash after the graph became terminal but before outbox ack.
  // Only the scheduler-level outcome is a delivery receipt. A graph `ok` by
  // itself can still classify as partial/blocked and must never be false-acked.
  if (event.runId && (event.runOutcome === "ok" || event.runOutcome === "skipped")) {
    if (!acknowledgeTriggerEvent(event.id, OWNER)) {
      throw new Error("trigger_event_terminal_receipt_ack_conflict");
    }
    return;
  }
  if (event.runId && event.runStatus === "ok") {
    if (!parkTriggerEventClaim(event.id, OWNER, "trigger_event_completion_outcome_ambiguous")) {
      throw new Error("trigger_event_ambiguous_completion_park_conflict");
    }
    return;
  }

  let attemptStarted = false;
  let completionRecorded = false;
  let claimLost = false;
  const renewTimer = setInterval(() => {
    try {
      if (!renewTriggerEventClaim(event.id, OWNER)) claimLost = true;
    } catch {
      // A transient SQLITE_BUSY is not evidence of ownership loss. The next
      // heartbeat retries; every terminal mutation still uses owner CAS.
    }
  }, CLAIM_RENEW_MS);
  renewTimer.unref?.();

  try {
    const result = await run(
      event.automationId,
      structuredClone(event.payload),
      {
        occurrenceId: `trigger-event:${event.id}`,
        onAccepted: () => {
          beginTriggerEventAttempt(event.id, OWNER);
          attemptStarted = true;
        },
        onRunBound: (runId) => bindTriggerEventRun(event.id, OWNER, runId),
        onCompleted: (status, error) => {
          completeTriggerEventRun(event.id, OWNER, status, error ?? null);
          completionRecorded = true;
        },
      },
    );

    if (claimLost) throw new Error("trigger_event_claim_lost_during_execution");
    if (!result.accepted) {
      // A typed pre-dispatch refusal (stale definition/owner/input) cannot heal
      // by retrying this immutable command. Preserve it for explicit repair.
      if (result.status === "blocked") {
        if (!parkTriggerEventClaim(event.id, OWNER, result.error ?? "trigger_event_dispatch_blocked")) {
          throw new Error("trigger_event_dispatch_blocked_park_conflict");
        }
        return;
      }
      // Another GUI/headless path owns the automation lease. This was not an
      // execution attempt, so preserve retry budget and payload exactly.
      if (!deferTriggerEventClaim(event.id, OWNER, BUSY_RETRY_MS)) {
        throw new Error("trigger_event_busy_defer_conflict");
      }
      return;
    }
    if (!attemptStarted) {
      throw new Error("trigger_event_scheduler_accepted_without_attempt_receipt");
    }
    if (!completionRecorded && result.status) {
      completeTriggerEventRun(event.id, OWNER, result.status, result.error ?? null);
      completionRecorded = true;
    }
    if (result.status === "ok" || result.status === "skipped") {
      if (!acknowledgeTriggerEvent(event.id, OWNER)) {
        throw new Error("trigger_event_ack_conflict");
      }
      return;
    }
    // An unknown outside effect (result.effectsUnconfirmed, a MUTATION_UNVERIFIED step) does not park the occurrence for the
    // owner (decision it keeps running and the risk of a duplicate is accepted). The redelivery resumes the same
    // occurrence: finished steps come back from the checkpoint and the uncertain step runs again with the host's note. The budget is
    // not the 48 of an ordinary failure (about 38 hours, up to ~96 runs of one mutating step): 3 deliveries, the cap of a scheduled
    // occurrence, or the first repeat of the same held steps when no model step can read the note (settleUnconfirmedDelivery).
    // The graph kernel typed this failure as a check that a redelivery cannot change (it cannot rework its judged steps, returned the same
    // output again, used its budget, or a judged step may have acted outside). The app closes the occurrence itself; the owner is asked nothing.
    if (result.checkStopped) {
      const closure = closeTriggerEventAfterStoppedCheck(event.id, OWNER, result.checkStopped.reasonCode, result.error ?? "check_stopped");
      if (!closure) throw new Error("trigger_event_check_stopped_close_conflict");
      recordStoppedCheckClosure(closure, result.checkStopped.reasonCode);
      return;
    }
    // The owner's own Stop of the run is the other typed boundary: the event is parked, not redelivered, until the owner decides.
    if (result.automaticRetry === false) {
      if (!parkTriggerEventClaim(event.id, OWNER, result.error ?? "trigger_event_deterministic_failure")) {
        throw new Error("trigger_event_deterministic_failure_park_conflict");
      }
      return;
    }
    const completedEvent = getTriggerEvent(event.id);
    if (completedEvent?.runId && completedEvent.runStatus === "ok") {
      if (!parkTriggerEventClaim(
        event.id,
        OWNER,
        result.error ?? `trigger_event_${result.status ?? "ambiguous"}_after_graph_completion`,
      )) {
        throw new Error("trigger_event_non_success_completion_park_conflict");
      }
      return;
    }
    if (result.effectsUnconfirmed === true || requiresGraphReconciliation(result.error)) {
      settleUnconfirmedDelivery(event, result.error ?? `automation_${result.status ?? "error"}`, result.unconfirmed);
      return;
    }
    failTriggerEventAttempt(
      event.id,
      OWNER,
      result.error ?? `automation_${result.status ?? "error"}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (attemptStarted && requiresGraphReconciliation(message)) settleUnconfirmedDelivery(event, message, undefined);
      else if (attemptStarted) failTriggerEventAttempt(event.id, OWNER, message);
      else deferTriggerEventClaim(event.id, OWNER, BUSY_RETRY_MS);
    } catch {
      // A different owner won the CAS. It is authoritative; never mutate its
      // claim or synthesize a success receipt.
    }
  } finally {
    clearInterval(renewTimer);
  }
}

/**
 * Drain a bounded batch. Atomic DB claims make this safe when a GUI process and
 * a launchd headless process call it concurrently.
 */
export async function drainTriggerOutboxOnce(run: TriggerEventRunFn, limit = MAX_DRAIN_BATCH): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_DRAIN_BATCH));
  let delivered = 0;
  // Waiting occurrences of an automation that stays switched off for a week are closed here (never delivered, so nothing else would ever look).
  try { expireStaleEventsOfDisabledAutomations(); } catch { /* a busy store is retried on the next drain */ }
  // Occurrences parked for a failed check before the app closed such occurrences itself are closed the same way (through this path, never by hand).
  try { for (const closure of closeParkedStoppedCheckEvents()) recordStoppedCheckClosure(closure, "parked_earlier"); } catch { /* a busy store is retried on the next drain */ }
  for (let index = 0; index < boundedLimit; index += 1) {
    const event = claimNextTriggerEvent(OWNER);
    if (!event) break;
    await deliverClaimedEvent(event, run);
    delivered += 1;
  }
  return delivered;
}

function schedulePump(delayMs = 0): void {
  if (stopped || !runFn) return;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    void pump();
  }, Math.max(0, Math.min(delayMs, IDLE_PUMP_MS)));
  pumpTimer.unref?.();
}

async function pump(): Promise<void> {
  if (stopped || !runFn) return;
  if (drainPromise) return;
  const activeRun = runFn;
  drainPromise = drainTriggerOutboxOnce(activeRun);
  try {
    const count = await drainPromise;
    schedulePump(count >= MAX_DRAIN_BATCH ? 0 : IDLE_PUMP_MS);
  } catch (error) {
    console.error("[triggers] durable outbox drain failed:", error);
    schedulePump(BUSY_RETRY_MS);
  } finally {
    drainPromise = null;
  }
}

export function startTriggerOutbox(run: TriggerEventRunFn): void {
  runFn = run;
  stopped = false;
  schedulePump(0);
}

/** Wake the one shared pump after a source transaction commits. */
export function wakeTriggerOutbox(): void {
  schedulePump(0);
}

export function stopTriggerOutbox(): void {
  stopped = true;
  runFn = null;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
}
