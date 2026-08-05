import { randomUUID } from "node:crypto";
import type {
  AutomationRunRecord,
  AutomationTriggerEventAttention,
  AutomationTriggerEventReconcileInput,
  Trigger,
  TriggerKind,
} from "../../shared/types";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";

export const TRIGGER_EVENT_MAX_ATTEMPTS = 48;
export const TRIGGER_EVENT_LEASE_MS = 2 * 60 * 1000;
export const TRIGGER_EVENT_MAX_PAYLOAD_BYTES = 256 * 1024;
const TRIGGER_EVENT_RETRY_BASE_MS = 5_000;
const TRIGGER_EVENT_RETRY_MAX_MS = 60 * 60 * 1000;

export type TriggerEventStatus = "pending" | "claimed" | "delivered" | "parked";

export interface TriggerEventPayload {
  output?: string;
  [key: string]: unknown;
}

export interface TriggerEventRecord {
  id: string;
  automationId: string;
  triggerKind: Exclude<TriggerKind, "schedule">;
  dedupeKey: string;
  payload: TriggerEventPayload;
  payloadValid: boolean;
  status: TriggerEventStatus;
  attemptCount: number;
  nextAttemptAt: string;
  claimOwner: string | null;
  claimedUntil: string | null;
  runId: string | null;
  runStatus: string | null;
  runOutcome: AutomationRunRecord["status"] | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface TriggerEventRow {
  id: string;
  automation_id: string;
  trigger_kind: string;
  dedupe_key: string;
  payload_json: string;
  status: TriggerEventStatus;
  attempt_count: number;
  next_attempt_at: string;
  claim_owner: string | null;
  claimed_until: string | null;
  run_id: string | null;
  run_status: string | null;
  run_outcome: AutomationRunRecord["status"] | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface TriggerDeliveryHooks {
  /** Stable occurrence identity for checkpoint binding across retries/restarts. */
  occurrenceId: string;
  /** Called only after the scheduler owns the automation's cross-process lease. */
  onAccepted(): void;
  /** Bound before graph execution, so crash recovery can prove a completed delivery. */
  onRunBound(runId: string): void;
  /** Scheduler-level classification, distinct from the graph row's status. */
  onCompleted(status: AutomationRunRecord["status"], error?: string | null): void;
}

export interface TriggerDispatchResult {
  accepted: boolean;
  status?: AutomationRunRecord["status"];
  error?: string | null;
  output?: string;
}

function parsePayload(raw: string): { payload: TriggerEventPayload; valid: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { payload: parsed as TriggerEventPayload, valid: true };
    }
  } catch {
    // A malformed durable payload is parked by the dispatcher, never executed.
  }
  return { payload: {}, valid: false };
}

function toRecord(row: TriggerEventRow): TriggerEventRecord {
  const parsedPayload = parsePayload(row.payload_json);
  return {
    id: row.id,
    automationId: row.automation_id,
    triggerKind: row.trigger_kind as TriggerEventRecord["triggerKind"],
    dedupeKey: row.dedupe_key,
    payload: parsedPayload.payload,
    payloadValid: parsedPayload.valid,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    claimOwner: row.claim_owner,
    claimedUntil: row.claimed_until,
    runId: row.run_id,
    runStatus: row.run_status,
    runOutcome: row.run_outcome,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

function finiteIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("trigger_event_time_invalid");
  return value.toISOString();
}

function validateTriggerKind(kind: TriggerKind): asserts kind is TriggerEventRecord["triggerKind"] {
  // v91부터 "command"(코드·다른 에이전트가 명시적으로 부른 요청)도 이 대기열에 앉는다.
  if (kind !== "fs" && kind !== "chain" && kind !== "webhook" && kind !== "poll" && kind !== "command") {
    throw new Error(`trigger_event_kind_invalid: ${kind}`);
  }
}

function serializePayload(payload: TriggerEventPayload): string {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > TRIGGER_EVENT_MAX_PAYLOAD_BYTES) {
    throw new Error("trigger_event_payload_too_large");
  }
  return json;
}

export interface EnqueueTriggerEventInput {
  id?: string;
  automationId: string;
  triggerKind: TriggerKind;
  dedupeKey: string;
  payload?: TriggerEventPayload;
  now?: Date;
  /** Poll cursor CAS. The event insert and cursor advance share one IMMEDIATE commit. */
  pollCursor?: {
    expectedTrigger: Extract<Trigger, { kind: "poll" }>;
    nextTrigger: Extract<Trigger, { kind: "poll" }>;
  };
}

export interface EnqueueTriggerEventResult {
  event: TriggerEventRecord;
  inserted: boolean;
  cursorAdvanced: boolean;
}

/**
 * Preserve a callback-only source occurrence when its enabled/registration
 * contract changed before the normal enqueue could commit. This is an
 * attention record, not an execution fallback; a missing/deleted target still
 * rejects because there is no owner to reconcile it.
 */
export function parkRejectedSourceTriggerEvent(
  input: Omit<EnqueueTriggerEventInput, "pollCursor"> & { error: string },
): boolean {
  validateTriggerKind(input.triggerKind);
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 512) throw new Error("trigger_event_dedupe_key_invalid");
  const nowIso = finiteIso(input.now ?? new Date());
  const inserted = getDb().prepare(
    `INSERT OR IGNORE INTO automation_trigger_events (
       id, automation_id, trigger_kind, dedupe_key, payload_json, status,
       attempt_count, next_attempt_at, last_error, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, 'parked', 0, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM automations WHERE id = ? AND trigger_type = ?
     )`,
  ).run(
    input.id ?? randomUUID(),
    input.automationId,
    input.triggerKind,
    dedupeKey,
    serializePayload(input.payload ?? {}),
    nowIso,
    input.error.slice(0, 4_000),
    nowIso,
    nowIso,
    input.automationId,
    input.triggerKind,
  );
  if (inserted.changes === 1) {
    emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  }
  return inserted.changes === 1;
}

/**
 * Persist a source event before the source is acknowledged. For poll events,
 * trigger_json.lastSeen advances in the same transaction, so a crash cannot
 * produce either a lost event or a cursor that points past an unqueued event.
 */
export function enqueueTriggerEvent(input: EnqueueTriggerEventInput): EnqueueTriggerEventResult {
  validateTriggerKind(input.triggerKind);
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 512) throw new Error("trigger_event_dedupe_key_invalid");
  if (!input.automationId || input.automationId.length > 512) {
    throw new Error("trigger_event_automation_id_invalid");
  }
  if (input.pollCursor && input.triggerKind !== "poll") {
    throw new Error("trigger_event_cursor_kind_mismatch");
  }
  const db = getDb();
  const nowIso = finiteIso(input.now ?? new Date());
  const id = input.id ?? randomUUID();
  const payloadJson = serializePayload(input.payload ?? {});
  let inserted = false;
  let cursorAdvanced = !input.pollCursor;

  const commit = db.transaction(() => {
    const result = db.prepare(
      `INSERT OR IGNORE INTO automation_trigger_events (
         id, automation_id, trigger_kind, dedupe_key, payload_json, status,
         attempt_count, next_attempt_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM automations
         WHERE id = ? AND enabled = 1
           -- 소스가 미는 종류(fs/chain/webhook/poll)는 그 자동화가 실제로 그 소스를 듣고
           -- 있을 때만 앉힌다 — 아니면 아무도 안 듣는 이벤트가 대기열에 쌓인다.
           -- ★"command"는 다르다. 부르는 쪽이 명시적으로 지목한 요청이라, 예약으로 도는
           --   자동화든 입력을 받는 자동화든 이름으로 부를 수 있어야 한다. 여기서 종류를
           --   맞추라고 하면 코드·다른 에이전트는 예약 자동화를 영영 못 부른다.
           AND (? = 'command' OR trigger_type = ?)
       )`,
    ).run(
      id,
      input.automationId,
      input.triggerKind,
      dedupeKey,
      payloadJson,
      nowIso,
      nowIso,
      nowIso,
      input.automationId,
      input.triggerKind,
      input.triggerKind,
    );
    inserted = result.changes === 1;
    const durable = db.prepare(
      `SELECT id FROM automation_trigger_events
       WHERE automation_id = ? AND trigger_kind = ? AND dedupe_key = ?`,
    ).get(input.automationId, input.triggerKind, dedupeKey) as { id: string } | undefined;
    if (!durable) throw new Error("trigger_event_enqueue_rejected");

    if (input.pollCursor) {
      const expectedJson = JSON.stringify(input.pollCursor.expectedTrigger);
      const nextJson = JSON.stringify(input.pollCursor.nextTrigger);
      const advanced = db.prepare(
        `UPDATE automations SET trigger_json = ?
         WHERE id = ? AND enabled = 1 AND trigger_type = 'poll' AND trigger_json = ?`,
      ).run(nextJson, input.automationId, expectedJson);
      cursorAdvanced = advanced.changes === 1;
      if (!cursorAdvanced) {
        // A concurrent edit changed the source contract. Do not execute an
        // event observed under the stale contract and never overwrite the edit.
        if (inserted) db.prepare("DELETE FROM automation_trigger_events WHERE id = ?").run(durable.id);
        throw new Error("trigger_event_poll_cursor_conflict");
      }
    }
  });
  commit.immediate();
  if (input.pollCursor && cursorAdvanced) {
    emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  }

  const row = db.prepare(
    `SELECT e.*, r.status AS run_status
     FROM automation_trigger_events e
     LEFT JOIN automation_runs r ON r.id = e.run_id
     WHERE e.automation_id = ? AND e.trigger_kind = ? AND e.dedupe_key = ?`,
  ).get(input.automationId, input.triggerKind, dedupeKey) as TriggerEventRow | undefined;
  if (!row) throw new Error("trigger_event_enqueue_missing_after_commit");
  return { event: toRecord(row), inserted, cursorAdvanced };
}

/** Advance a non-firing poll observation without overwriting a concurrent edit. */
export function advancePollCursor(
  automationId: string,
  expectedTrigger: Extract<Trigger, { kind: "poll" }>,
  nextTrigger: Extract<Trigger, { kind: "poll" }>,
): boolean {
  const result = getDb().prepare(
    `UPDATE automations SET trigger_json = ?
     WHERE id = ? AND enabled = 1 AND trigger_type = 'poll' AND trigger_json = ?`,
  ).run(JSON.stringify(nextTrigger), automationId, JSON.stringify(expectedTrigger));
  if (result.changes === 1) emitDesktopStoreChange({ entity: "automation", id: automationId });
  return result.changes === 1;
}

/** Atomically claims one due delivery across GUI/headless processes. */
export function claimNextTriggerEvent(owner: string, now: Date = new Date()): TriggerEventRecord | null {
  if (!owner || owner.length > 240) throw new Error("trigger_event_owner_invalid");
  const db = getDb();
  const nowIso = finiteIso(now);
  const claimedUntil = new Date(now.getTime() + TRIGGER_EVENT_LEASE_MS).toISOString();
  let claimedId: string | null = null;
  const commit = db.transaction(() => {
    const candidate = db.prepare(
      `SELECT e.id
       FROM automation_trigger_events e
       JOIN automations a ON a.id = e.automation_id
       LEFT JOIN automation_runs r ON r.id = e.run_id
       WHERE a.enabled = 1
         AND e.status IN ('pending', 'claimed')
         AND e.next_attempt_at <= ?
         AND (
           e.status = 'pending' OR
           (e.claimed_until <= ? AND (e.run_id IS NULL OR r.status IS NULL OR r.status <> 'running'))
         )
       ORDER BY e.next_attempt_at ASC, e.created_at ASC, e.id ASC
       LIMIT 1`,
    ).get(nowIso, nowIso) as { id: string } | undefined;
    if (!candidate) return;
    const updated = db.prepare(
      `UPDATE automation_trigger_events
       SET status = 'claimed', claim_owner = ?, claimed_until = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'claimed')
         AND next_attempt_at <= ?
         AND (status = 'pending' OR claimed_until <= ?)`,
    ).run(owner, claimedUntil, nowIso, candidate.id, nowIso, nowIso);
    if (updated.changes === 1) claimedId = candidate.id;
  });
  commit.immediate();
  if (!claimedId) return null;
  const row = db.prepare(
    `SELECT e.*, r.status AS run_status
     FROM automation_trigger_events e
     LEFT JOIN automation_runs r ON r.id = e.run_id
     WHERE e.id = ?`,
  ).get(claimedId) as TriggerEventRow | undefined;
  return row ? toRecord(row) : null;
}

/** Record a real delivery attempt only after the automation lease is owned. */
export function beginTriggerEventAttempt(id: string, owner: string, now: Date = new Date()): number {
  const nowIso = finiteIso(now);
  const result = getDb().prepare(
    `UPDATE automation_trigger_events
     SET attempt_count = attempt_count + 1, run_id = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ? AND claimed_until > ?`,
  ).run(nowIso, id, owner, nowIso);
  if (result.changes !== 1) throw new Error("trigger_event_claim_lost_before_execution");
  const row = getDb().prepare("SELECT attempt_count FROM automation_trigger_events WHERE id = ?").get(id) as {
    attempt_count: number;
  } | undefined;
  if (!row) throw new Error("trigger_event_missing_before_execution");
  return row.attempt_count;
}

/** Bind before any graph node runs; a terminal bound run is a durable delivery receipt. */
export function bindTriggerEventRun(id: string, owner: string, runId: string, now: Date = new Date()): void {
  if (!runId || runId.length > 512) throw new Error("trigger_event_run_id_invalid");
  const result = getDb().prepare(
    `UPDATE automation_trigger_events SET run_id = ?, run_outcome = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(runId, finiteIso(now), id, owner);
  if (result.changes !== 1) throw new Error("trigger_event_claim_lost_before_run_bind");
}

/** Seal the scheduler's final classification before its automation lease is released. */
export function completeTriggerEventRun(
  id: string,
  owner: string,
  status: AutomationRunRecord["status"],
  error: string | null = null,
  now: Date = new Date(),
): void {
  const result = getDb().prepare(
    `UPDATE automation_trigger_events SET run_outcome = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(status, error?.slice(0, 4_000) ?? null, finiteIso(now), id, owner);
  if (result.changes !== 1) throw new Error("trigger_event_claim_lost_before_completion_receipt");
}

export function renewTriggerEventClaim(id: string, owner: string, now: Date = new Date()): boolean {
  const until = new Date(now.getTime() + TRIGGER_EVENT_LEASE_MS).toISOString();
  const result = getDb().prepare(
    `UPDATE automation_trigger_events SET claimed_until = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(until, finiteIso(now), id, owner);
  return result.changes === 1;
}

export function acknowledgeTriggerEvent(id: string, owner: string, now: Date = new Date()): boolean {
  const nowIso = finiteIso(now);
  const result = getDb().prepare(
    `UPDATE automation_trigger_events
     SET status = 'delivered', claim_owner = NULL, claimed_until = NULL,
         delivered_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(nowIso, nowIso, id, owner);
  return result.changes === 1;
}

/** Lease contention is not an execution attempt and must never consume retry budget. */
export function deferTriggerEventClaim(
  id: string,
  owner: string,
  delayMs = TRIGGER_EVENT_RETRY_BASE_MS,
  now: Date = new Date(),
): boolean {
  const bounded = Math.max(1_000, Math.min(delayMs, TRIGGER_EVENT_RETRY_MAX_MS));
  const result = getDb().prepare(
    `UPDATE automation_trigger_events
     SET status = 'pending', claim_owner = NULL, claimed_until = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(new Date(now.getTime() + bounded).toISOString(), finiteIso(now), id, owner);
  return result.changes === 1;
}

export function failTriggerEventAttempt(
  id: string,
  owner: string,
  error: string,
  now: Date = new Date(),
): { parked: boolean; nextAttemptAt: string | null } {
  const db = getDb();
  const row = db.prepare(
    "SELECT attempt_count FROM automation_trigger_events WHERE id = ? AND status = 'claimed' AND claim_owner = ?",
  ).get(id, owner) as { attempt_count: number } | undefined;
  if (!row) throw new Error("trigger_event_claim_lost_after_execution");
  const parked = row.attempt_count >= TRIGGER_EVENT_MAX_ATTEMPTS;
  const exponent = Math.max(0, Math.min(row.attempt_count - 1, 16));
  const delay = Math.min(TRIGGER_EVENT_RETRY_BASE_MS * 2 ** exponent, TRIGGER_EVENT_RETRY_MAX_MS);
  const nextAttemptAt = parked ? null : new Date(now.getTime() + delay).toISOString();
  const updated = db.prepare(
    `UPDATE automation_trigger_events
     SET status = ?, claim_owner = NULL, claimed_until = NULL,
         next_attempt_at = COALESCE(?, next_attempt_at), last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(
    parked ? "parked" : "pending",
    nextAttemptAt,
    error.slice(0, 4_000),
    finiteIso(now),
    id,
    owner,
  );
  if (updated.changes !== 1) throw new Error("trigger_event_claim_lost_after_execution");
  return { parked, nextAttemptAt };
}

/** Preserve an occurrence whose external completion is ambiguous; never replay it automatically. */
export function parkTriggerEventClaim(
  id: string,
  owner: string,
  error: string,
  now: Date = new Date(),
): boolean {
  const result = getDb().prepare(
    `UPDATE automation_trigger_events
     SET status = 'parked', claim_owner = NULL, claimed_until = NULL,
         last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND claim_owner = ?`,
  ).run(error.slice(0, 4_000), finiteIso(now), id, owner);
  return result.changes === 1;
}

function toAttention(event: TriggerEventRecord): AutomationTriggerEventAttention {
  return {
    id: event.id,
    automationId: event.automationId,
    triggerKind: event.triggerKind,
    attemptCount: event.attemptCount,
    lastError: event.lastError ?? "trigger_event_reconciliation_required",
    runId: event.runId,
    runOutcome: event.runOutcome,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

/**
 * Resolve exactly one parked occurrence with an optimistic CAS. A generic
 * automation edit/toggle must never call this: `retry` is the user's explicit
 * assertion that the external effect did not happen; `completed` records the
 * opposite assertion and advances without executing again.
 */
export function reconcileParkedTriggerEvent(input: AutomationTriggerEventReconcileInput & {
  now?: Date;
}): AutomationTriggerEventAttention | null {
  if (!input.eventId || !input.automationId || !input.expectedUpdatedAt) {
    throw new Error("trigger_event_reconciliation_input_invalid");
  }
  if (input.resolution !== "completed" && input.resolution !== "retry") {
    throw new Error("trigger_event_reconciliation_resolution_invalid");
  }
  const now = input.now ?? new Date();
  const nowIso = finiteIso(now);
  const db = getDb();
  const commit = db.transaction(() => {
    const row = db.prepare(
      `SELECT e.run_id, r.status AS run_status
       FROM automation_trigger_events e
       LEFT JOIN automation_runs r ON r.id = e.run_id
       WHERE e.id = ? AND e.automation_id = ? AND e.status = 'parked' AND e.updated_at = ?`,
    ).get(input.eventId, input.automationId, input.expectedUpdatedAt) as {
      run_id: string | null;
      run_status: string | null;
    } | undefined;
    if (!row) throw new Error("trigger_event_reconciliation_conflict");
    // A retry can bind a generated run id before runGraph rejects an older
    // ambiguous checkpoint. Resolve by the stable event occurrence, not that
    // last (possibly phantom) run id, otherwise the raw event-level action can
    // bypass node reconciliation after enough retries.
    const occurrenceRun = db.prepare(
      `SELECT checkpoint_json
       FROM automation_runs
       WHERE automation_id = ? AND occurrence_id = ? AND status = 'error'
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
    ).get(input.automationId, `trigger-event:${input.eventId}`) as {
      checkpoint_json: string | null;
    } | undefined;
    if (occurrenceRun?.checkpoint_json) {
      try {
        const checkpoint = JSON.parse(occurrenceRun.checkpoint_json) as {
          ambiguousNodeIds?: unknown;
          inFlightNodeIds?: unknown;
        };
        const unresolved = [checkpoint.ambiguousNodeIds, checkpoint.inFlightNodeIds]
          .some((value) => Array.isArray(value) && value.length > 0);
        if (unresolved) throw new Error("trigger_event_graph_reconciliation_required");
      } catch (error) {
        if (error instanceof Error && error.message === "trigger_event_graph_reconciliation_required") throw error;
        // A malformed checkpoint cannot justify either external completion or retry.
        throw new Error("trigger_event_graph_reconciliation_required");
      }
    }
    // A mechanically successful graph has no failed checkpoint for safe replay.
    // Only the explicit "completed" assertion may consume that occurrence.
    if (input.resolution === "retry" && row.run_id && row.run_status === "ok") {
      throw new Error("trigger_event_graph_reconciliation_required");
    }
    const result = input.resolution === "completed"
      ? db.prepare(
          `UPDATE automation_trigger_events
           SET status = 'delivered', delivered_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ? AND automation_id = ? AND status = 'parked' AND updated_at = ?`,
        ).run(nowIso, nowIso, input.eventId, input.automationId, input.expectedUpdatedAt)
      : db.prepare(
          `UPDATE automation_trigger_events
           SET status = 'pending', attempt_count = 0, next_attempt_at = ?,
               run_id = NULL, run_outcome = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND automation_id = ? AND status = 'parked' AND updated_at = ?`,
        ).run(nowIso, nowIso, input.eventId, input.automationId, input.expectedUpdatedAt);
    if (result.changes !== 1) throw new Error("trigger_event_reconciliation_conflict");
  });
  commit.immediate();
  const reconciled = getTriggerEvent(input.eventId);
  if (!reconciled) throw new Error("trigger_event_missing_after_reconciliation");
  return reconciled.status === "parked" ? toAttention(reconciled) : null;
}

export function listTriggerEventAttention(automationId: string): AutomationTriggerEventAttention[] {
  return listTriggerEvents(automationId)
    .filter((event) => event.status === "parked")
    .map(toAttention);
}

export function getTriggerEvent(id: string): TriggerEventRecord | null {
  const row = getDb().prepare(
    `SELECT e.*, r.status AS run_status
     FROM automation_trigger_events e
     LEFT JOIN automation_runs r ON r.id = e.run_id
     WHERE e.id = ?`,
  ).get(id) as TriggerEventRow | undefined;
  return row ? toRecord(row) : null;
}

export function listTriggerEvents(automationId: string): TriggerEventRecord[] {
  const rows = getDb().prepare(
    `SELECT e.*, r.status AS run_status
     FROM automation_trigger_events e
     LEFT JOIN automation_runs r ON r.id = e.run_id
     WHERE e.automation_id = ? ORDER BY e.created_at ASC, e.id ASC`,
  ).all(automationId) as TriggerEventRow[];
  return rows.map(toRecord);
}
