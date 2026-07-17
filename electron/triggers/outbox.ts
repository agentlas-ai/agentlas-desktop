import { randomUUID } from "node:crypto";
import {
  acknowledgeTriggerEvent,
  beginTriggerEventAttempt,
  bindTriggerEventRun,
  claimNextTriggerEvent,
  completeTriggerEventRun,
  deferTriggerEventClaim,
  failTriggerEventAttempt,
  getTriggerEvent,
  parkTriggerEventClaim,
  renewTriggerEventClaim,
  type TriggerDeliveryHooks,
  type TriggerDispatchResult,
  type TriggerEventRecord,
  type TriggerEventPayload,
} from "../store/trigger-events";

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

function requiresGraphReconciliation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /automation_(?:ambiguous_side_effect|partial_reconciliation_required|partial_graph_changed)/i.test(message);
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
    if (requiresGraphReconciliation(result.error)) {
      if (!parkTriggerEventClaim(
        event.id,
        OWNER,
        result.error ?? "trigger_event_graph_reconciliation_required",
      )) {
        throw new Error("trigger_event_graph_reconciliation_park_conflict");
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
    failTriggerEventAttempt(
      event.id,
      OWNER,
      result.error ?? `automation_${result.status ?? "error"}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (attemptStarted && requiresGraphReconciliation(error)) {
        if (!parkTriggerEventClaim(event.id, OWNER, message)) {
          throw new Error("trigger_event_graph_reconciliation_park_conflict");
        }
      } else if (attemptStarted) failTriggerEventAttempt(event.id, OWNER, message);
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
