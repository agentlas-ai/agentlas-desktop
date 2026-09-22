import { getDb } from "../store/db";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { latestTaskCheckpoint } from "../long-run/checkpoint";
import { validAppInstanceId } from "./diagnostic-log";

// The local control socket is owner-only. Still treat every parameter and
// ledger value as untrusted: this export contains IDs and lifecycle evidence,
// never JSON payloads, model text, URLs, file paths or exception messages.
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TERMINAL_KINDS = new Set([
  "invoke_completed", "invoke_failed", "invoke_threw", "invoke_cancelled", "invoke_interrupted",
]);
const ATTEMPT_STATES = new Set(["running", "completed", "failed", "interrupted", "cancelled", "uncertain"]);
const SIDE_EFFECT_STATES = new Set(["none", "committed", "uncertain"]);
const MAX_EFFECT_EVENTS_TO_VERIFY = 4_096;
const MAX_GOAL_EVENTS_TO_SCAN = 256;

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("daemon_diagnostics_identity_invalid");
  return value;
}

function optionalId(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredId(value);
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

interface AttemptRow {
  id: string;
  invocation_run_id: string;
  state: string;
  side_effect_state: string;
  app_instance_id: string | null;
  started_at: string;
  completed_at: string | null;
}

interface InvocationEventRow {
  id: string;
  seq: number;
  kind: string;
  ts: string;
}

interface CheckpointRow {
  seq: number;
  occurred_at: string;
  checkpoint_id: string | null;
  side_effects_state: string | null;
}

interface SuccessorRow {
  seq: number;
  kind: string;
  occurred_at: string;
  invocation_run_id: string | null;
}

function eventRef(row: InvocationEventRow | null): { eventId: string; seq: number; at: string | null; kind: string } | null {
  return row ? { eventId: requiredId(row.id), seq: row.seq, at: timestamp(row.ts), kind: row.kind } : null;
}

/** Bounded, read-only Goal evidence export. Its `settled` field comes from the
 * authoritative effect-boundary reader, not from a mere terminal event. */
export function goalContinuityDiagnostics(
  rawGoalId: unknown,
  processIdentity: { appInstanceId: string; bootId: string; pid: number; storeIdentity: string },
): Record<string, unknown> {
  const goalId = requiredId(rawGoalId);
  if (!validAppInstanceId(processIdentity.appInstanceId) || !ID.test(processIdentity.bootId)
    || !Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 1
    || !DIGEST.test(processIdentity.storeIdentity)) {
    throw new Error("daemon_diagnostics_process_identity_invalid");
  }
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science" || !run.rootChatId) {
    return { schemaVersion: "agentlas.daemon-diagnostics.v1", found: false,
      processRole: "desktop-daemon", appInstanceId: processIdentity.appInstanceId,
      bootId: processIdentity.bootId, pid: processIdentity.pid, goalId };
  }
  const runId = requiredId(run.id);
  const chatId = requiredId(run.rootChatId);
  const attempts = getDb().prepare(
    `SELECT a.id, a.invocation_run_id, a.state, a.side_effect_state,
            a.app_instance_id, a.started_at, a.completed_at
       FROM long_run_worker_attempts AS a
       JOIN long_run_workers AS w ON w.id = a.worker_id AND w.run_id = a.run_id
      WHERE a.run_id = ? AND w.role = 'controller' AND a.invocation_run_id IS NOT NULL
      ORDER BY a.started_at DESC, a.id DESC LIMIT 12`,
  ).all(runId) as AttemptRow[];
  let currentCheckpointId: string | null = null;
  try { currentCheckpointId = latestTaskCheckpoint(goalId)?.checkpointId ?? null; }
  catch { /* Corrupt/stale checkpoint cannot acquire current authority. */ }

  const episodes = attempts.map((attempt) => {
    const attemptId = requiredId(attempt.id);
    const invocationRunId = requiredId(attempt.invocation_run_id);
    const events = getDb().prepare(
      `SELECT id, seq, kind, ts FROM run_events
        WHERE run_id = ? AND chat_id = ?
          AND kind IN ('invoke_started','invoke_completed','invoke_failed','invoke_threw',
                       'invoke_cancelled','invoke_interrupted','runtime_effect_boundary')
        ORDER BY seq ASC LIMIT 64`,
    ).all(invocationRunId, chatId) as InvocationEventRow[];
    const started = events.find((row) => row.kind === "invoke_started") ?? null;
    const terminal = [...events].reverse().find((row) => TERMINAL_KINDS.has(row.kind)) ?? null;
    const effectEvent = [...events].reverse().find((row) => row.kind === "runtime_effect_boundary") ?? null;
    let effects: "settled" | "uncertain" | "unavailable" = "unavailable";
    let authoritativeReceiptId: string | null = null;
    const eventCount = (getDb().prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
      .get(invocationRunId) as { n: number }).n;
    if (eventCount <= MAX_EFFECT_EVENTS_TO_VERIFY) {
      try {
        const boundary = readInvocationEffectBoundary({ invocationRunId, expectedChatId: chatId });
        effects = boundary.effects;
        authoritativeReceiptId = optionalId(boundary.receiptEventId);
      } catch { /* Missing or foreign evidence remains unavailable. */ }
    }

    const checkpoint = getDb().prepare(
      `SELECT seq, occurred_at,
              json_extract(payload_json, '$.checkpoint.checkpointId') AS checkpoint_id,
              json_extract(payload_json, '$.checkpoint.sideEffects.state') AS side_effects_state
         FROM (SELECT seq, occurred_at, payload_json FROM long_run_events
                WHERE run_id = ? AND kind = 'run.task_checkpoint'
                ORDER BY seq DESC LIMIT ${MAX_GOAL_EVENTS_TO_SCAN})
        WHERE json_valid(payload_json) = 1
          AND json_extract(payload_json, '$.checkpoint.invocationRunId') = ?
        ORDER BY seq DESC LIMIT 1`,
    ).get(runId, invocationRunId) as CheckpointRow | undefined;
    const checkpointId = optionalId(checkpoint?.checkpoint_id);
    const successor = checkpointId ? getDb().prepare(
      `SELECT seq, kind, occurred_at,
              json_extract(payload_json, '$.invocationRunId') AS invocation_run_id
         FROM (SELECT seq, kind, occurred_at, payload_json FROM long_run_events
                WHERE run_id = ? AND kind IN ('run.checkpoint_continuation','run.checkpoint_startup')
                ORDER BY seq DESC LIMIT ${MAX_GOAL_EVENTS_TO_SCAN})
        WHERE json_valid(payload_json) = 1
          AND json_extract(payload_json, '$.checkpointId') = ?
        ORDER BY seq DESC LIMIT 1`,
    ).get(runId, checkpointId) as SuccessorRow | undefined : undefined;
    const successorInvocationId = optionalId(successor?.invocation_run_id);
    const successorStart = successorInvocationId ? getDb().prepare(
      "SELECT id, seq, kind, ts FROM run_events WHERE run_id = ? AND chat_id = ? AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1",
    ).get(successorInvocationId, chatId) as InvocationEventRow | undefined : undefined;
    const checkpointState = checkpoint?.side_effects_state === "settled" ? "settled" : "uncertain";
    return {
      attemptId,
      invocationRunId,
      appInstanceId: validAppInstanceId(attempt.app_instance_id) ? attempt.app_instance_id : null,
      attemptState: ATTEMPT_STATES.has(attempt.state) ? attempt.state : "unknown",
      sideEffectState: SIDE_EFFECT_STATES.has(attempt.side_effect_state) ? attempt.side_effect_state : "unknown",
      startedAt: timestamp(attempt.started_at), completedAt: timestamp(attempt.completed_at),
      invocationStart: eventRef(started), terminal: eventRef(terminal),
      effectReceipt: {
        status: effects,
        event: eventRef(effectEvent),
        authoritativeReceiptEventId: authoritativeReceiptId,
        inspectionLimitReached: eventCount > MAX_EFFECT_EVENTS_TO_VERIFY,
      },
      checkpoint: checkpoint && checkpointId ? {
        checkpointId, eventSeq: checkpoint.seq, recordedAt: timestamp(checkpoint.occurred_at),
        sideEffectsState: checkpointState,
        currentlyValid: currentCheckpointId === checkpointId,
      } : null,
      successor: successor && successorInvocationId ? {
        invocationRunId: successorInvocationId, claimSeq: successor.seq,
        claimKind: successor.kind, claimedAt: timestamp(successor.occurred_at),
        invocationStart: eventRef(successorStart ?? null),
      } : null,
      historicalChainEvidenceComplete: Boolean(started && terminal && effects === "settled" && checkpointId
        && checkpointState === "settled"
        && successorInvocationId && successorStart),
    };
  });
  return {
    schemaVersion: "agentlas.daemon-diagnostics.v1", found: true,
    processRole: "desktop-daemon", appInstanceId: processIdentity.appInstanceId,
    bootId: processIdentity.bootId, pid: processIdentity.pid,
    storeIdentity: processIdentity.storeIdentity,
    goalId, longRunId: runId, chatId,
    goalRevision: getLongRunGoalRevisionBinding(runId)?.revision ?? null,
    goalStatus: run.status,
    ledgerEventSeq: run.lastEventSeq,
    limitedToRecentControllerAttempts: 12,
    episodes,
  };
}
