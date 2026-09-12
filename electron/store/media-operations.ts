import path from "node:path";
import { getDb } from "./db";
import {
  MEDIA_OPERATION_SCHEMA_VERSION,
  isMediaCancellationState,
  isMediaOperationLifecycle,
  validateMediaOperationIntent,
  type MediaCancellationState,
  type MediaOperationEvent,
  type MediaOperationIntent,
  type MediaOperationLifecycle,
  type MediaOperationRecord,
  type MediaOperationResult,
  type MediaProviderCapabilities,
} from "../../shared/media-operation";

interface MediaOperationRow {
  id: string;
  modality: string;
  provider_id: string;
  model_id: string;
  client_request_key: string;
  input_digest: string;
  intent_json: string;
  spend_limit_usd: number | null;
  capabilities_json: string;
  lifecycle: string;
  provider_operation_id: string | null;
  provider_checkpoint_json: string | null;
  provider_status: string | null;
  cancellation: string;
  cancel_requested_at: string | null;
  cancel_confirmed_at: string | null;
  result_path: string | null;
  result_sha256: string | null;
  result_receipt_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  poll_attempts: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MediaOperationEventRow {
  operation_id: string;
  sequence: number;
  from_lifecycle: string | null;
  to_lifecycle: string;
  cancellation: string;
  reason_code: string;
  detail_json: string | null;
  created_at: string;
}

export interface MediaOperationPatch {
  lifecycle?: MediaOperationLifecycle;
  providerOperationId?: string | null;
  providerCheckpoint?: unknown | null;
  providerStatus?: string | null;
  cancellation?: MediaCancellationState;
  cancelRequestedAt?: string | null;
  cancelConfirmedAt?: string | null;
  result?: MediaOperationResult | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  incrementPollAttempts?: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const SAFE_FAILURE_CODE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_PROVIDER_STATUS_BYTES = 1024;

const TRANSITIONS: Record<MediaOperationLifecycle, ReadonlySet<MediaOperationLifecycle>> = {
  submit_intent: new Set(["submit_intent", "submitting", "failed"]),
  submitting: new Set(["submitting", "provider_accepted", "verifying", "outcome_unknown", "failed"]),
  provider_accepted: new Set(["provider_accepted", "running", "verifying", "failed", "outcome_unknown"]),
  running: new Set(["running", "verifying", "failed", "outcome_unknown"]),
  verifying: new Set(["verifying", "succeeded", "failed"]),
  outcome_unknown: new Set(["outcome_unknown", "provider_accepted", "failed"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
};

function parseJson(raw: string, field: string): unknown {
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`media_operation_corrupt:${field}`); }
}

function encodeJson(value: unknown, field: string, maxBytes = MAX_JSON_BYTES): string {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`media_operation_json_invalid:${field}`); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new Error(`media_operation_json_too_large:${field}`);
  }
  return encoded;
}

function parseCapabilities(raw: string): MediaProviderCapabilities {
  const value = parseJson(raw, "capabilities") as Partial<MediaProviderCapabilities> | null;
  if (!value || !["idempotency_key", "client_request_lookup", "none"].includes(String(value.submitRecovery))
    || !["provider_operation_id", "client_request_key", "none"].includes(String(value.statusLookup))
    || !["provider", "local_only"].includes(String(value.cancellation))) {
    throw new Error("media_operation_corrupt:capabilities");
  }
  return value as MediaProviderCapabilities;
}

function rowToRecord(row: MediaOperationRow | undefined): MediaOperationRecord | null {
  if (!row) return null;
  if (!isMediaOperationLifecycle(row.lifecycle) || !isMediaCancellationState(row.cancellation)
    || !["image", "video", "audio"].includes(row.modality) || !SHA256.test(row.input_digest)
    || !Number.isSafeInteger(row.poll_attempts) || row.poll_attempts < 0
    || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("media_operation_corrupt:row");
  const result = row.result_path || row.result_sha256 || row.result_receipt_json
    ? (() => {
      if (!row.result_path || !path.isAbsolute(row.result_path) || !row.result_sha256 || !SHA256.test(row.result_sha256)
        || !row.result_receipt_json) throw new Error("media_operation_corrupt:result");
      return { path: row.result_path, sha256: row.result_sha256, receipt: parseJson(row.result_receipt_json, "result_receipt") };
    })()
    : null;
  if (row.lifecycle === "succeeded" && !result) throw new Error("media_operation_corrupt:succeeded_without_result");
  return {
    schemaVersion: MEDIA_OPERATION_SCHEMA_VERSION,
    id: row.id,
    modality: row.modality as MediaOperationRecord["modality"],
    providerId: row.provider_id,
    modelId: row.model_id,
    clientRequestKey: row.client_request_key,
    inputDigest: row.input_digest,
    intent: parseJson(row.intent_json, "intent"),
    spendLimitUsd: row.spend_limit_usd,
    capabilities: parseCapabilities(row.capabilities_json),
    lifecycle: row.lifecycle,
    providerOperationId: row.provider_operation_id,
    providerCheckpoint: row.provider_checkpoint_json ? parseJson(row.provider_checkpoint_json, "provider_checkpoint") : null,
    providerStatus: row.provider_status,
    cancellation: row.cancellation,
    cancelRequestedAt: row.cancel_requested_at,
    cancelConfirmedAt: row.cancel_confirmed_at,
    result,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    pollAttempts: row.poll_attempts,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readRow(id: string): MediaOperationRow | undefined {
  return getDb().prepare("SELECT * FROM media_operations WHERE id = ?").get(id) as MediaOperationRow | undefined;
}

export function createMediaOperationIntent(input: MediaOperationIntent, now = new Date()): MediaOperationRecord {
  validateMediaOperationIntent(input);
  const intentJson = encodeJson(input.intent, "intent");
  const capabilitiesJson = encodeJson(input.capabilities, "capabilities", 4 * 1024);
  const timestamp = now.toISOString();
  return getDb().transaction(() => {
    const existing = getDb().prepare("SELECT * FROM media_operations WHERE id = ? OR client_request_key = ?")
      .get(input.id, input.clientRequestKey) as MediaOperationRow | undefined;
    if (existing) {
      const exact = existing.id === input.id && existing.modality === input.modality
        && existing.provider_id === input.providerId && existing.model_id === input.modelId
        && existing.client_request_key === input.clientRequestKey && existing.input_digest === input.inputDigest
        && existing.intent_json === intentJson && existing.capabilities_json === capabilitiesJson
        && existing.spend_limit_usd === (input.spendLimitUsd ?? null);
      if (!exact) throw new Error("media_operation_idempotency_conflict");
      const decoded = rowToRecord(existing);
      if (!decoded) throw new Error("media_operation_create_failed");
      return decoded;
    }
    getDb().prepare(`INSERT INTO media_operations (
      id, modality, provider_id, model_id, client_request_key, input_digest, intent_json,
      spend_limit_usd, capabilities_json, lifecycle, cancellation, poll_attempts,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submit_intent', 'none', 0, 1, ?, ?)`)
      .run(input.id, input.modality, input.providerId, input.modelId, input.clientRequestKey,
        input.inputDigest, intentJson, input.spendLimitUsd ?? null, capabilitiesJson, timestamp, timestamp);
    getDb().prepare(`INSERT INTO media_operation_events (
      operation_id, sequence, from_lifecycle, to_lifecycle, cancellation, reason_code, detail_json, created_at
    ) VALUES (?, 1, NULL, 'submit_intent', 'none', 'intent_recorded', NULL, ?)`)
      .run(input.id, timestamp);
    const created = rowToRecord(readRow(input.id));
    if (!created) throw new Error("media_operation_create_failed");
    return created;
  })();
}

export function getMediaOperation(id: string): MediaOperationRecord | null {
  return rowToRecord(readRow(id));
}

export function listRecoverableMediaOperations(modality?: MediaOperationRecord["modality"]): MediaOperationRecord[] {
  const rows = (modality
    ? getDb().prepare(`SELECT * FROM media_operations
        WHERE modality = ? AND (lifecycle IN ('submit_intent','submitting','provider_accepted','running','verifying','outcome_unknown') OR cancellation = 'requested')
        ORDER BY created_at`).all(modality)
    : getDb().prepare(`SELECT * FROM media_operations
        WHERE lifecycle IN ('submit_intent','submitting','provider_accepted','running','verifying','outcome_unknown') OR cancellation = 'requested'
        ORDER BY created_at`).all()) as MediaOperationRow[];
  return rows.map((row) => {
    const record = rowToRecord(row);
    if (!record) throw new Error("media_operation_corrupt:missing");
    return record;
  });
}

export function listMediaOperationEvents(operationId: string): MediaOperationEvent[] {
  const rows = getDb().prepare("SELECT * FROM media_operation_events WHERE operation_id = ? ORDER BY sequence")
    .all(operationId) as MediaOperationEventRow[];
  return rows.map((row) => {
    if (!isMediaOperationLifecycle(row.to_lifecycle) || (row.from_lifecycle !== null && !isMediaOperationLifecycle(row.from_lifecycle))
      || !isMediaCancellationState(row.cancellation)) throw new Error("media_operation_corrupt:event");
    return {
      operationId: row.operation_id,
      sequence: row.sequence,
      fromLifecycle: row.from_lifecycle,
      toLifecycle: row.to_lifecycle,
      cancellation: row.cancellation,
      reasonCode: row.reason_code,
      detail: row.detail_json ? parseJson(row.detail_json, "event_detail") : null,
      createdAt: row.created_at,
    };
  });
}

function validatePatch(current: MediaOperationRecord, patch: MediaOperationPatch): void {
  const lifecycle = patch.lifecycle ?? current.lifecycle;
  if (!TRANSITIONS[current.lifecycle].has(lifecycle)) throw new Error(`media_operation_transition_invalid:${current.lifecycle}:${lifecycle}`);
  const providerOperationId = patch.providerOperationId === undefined ? current.providerOperationId : patch.providerOperationId;
  if (providerOperationId !== null && !SAFE_PROVIDER_ID.test(providerOperationId)) throw new Error("media_provider_operation_id_invalid");
  if (patch.providerStatus !== undefined && patch.providerStatus !== null
    && Buffer.byteLength(patch.providerStatus, "utf8") > MAX_PROVIDER_STATUS_BYTES) throw new Error("media_provider_status_too_large");
  if (patch.failureCode !== undefined && patch.failureCode !== null && !SAFE_FAILURE_CODE.test(patch.failureCode)) {
    throw new Error("media_operation_failure_code_invalid");
  }
  const cancellation = patch.cancellation ?? current.cancellation;
  const allowedCancellation: Record<MediaCancellationState, ReadonlySet<MediaCancellationState>> = {
    none: new Set(["none", "requested", "confirmed"]),
    requested: new Set(["requested", "confirmed", "unconfirmed"]),
    unconfirmed: new Set(["unconfirmed", "confirmed"]),
    confirmed: new Set(["confirmed"]),
  };
  if (!allowedCancellation[current.cancellation].has(cancellation)) throw new Error("media_cancellation_transition_invalid");
  if (patch.result) {
    if (!path.isAbsolute(patch.result.path) || !SHA256.test(patch.result.sha256)) throw new Error("media_operation_result_invalid");
    encodeJson(patch.result.receipt, "result_receipt");
  }
  if (lifecycle === "succeeded" && !(patch.result ?? current.result)) throw new Error("media_operation_result_required");
  if (patch.failureMessage && Buffer.byteLength(patch.failureMessage, "utf8") > MAX_MESSAGE_BYTES) throw new Error("media_operation_failure_too_large");
  if (patch.providerCheckpoint !== undefined && patch.providerCheckpoint !== null) encodeJson(patch.providerCheckpoint, "provider_checkpoint");
}

export function patchMediaOperation(input: {
  id: string;
  expectedVersion: number;
  patch: MediaOperationPatch;
  reasonCode: string;
  detail?: unknown;
  now?: Date;
}): MediaOperationRecord {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.reasonCode)) throw new Error("media_operation_reason_invalid");
  const detailJson = input.detail === undefined ? null : encodeJson(input.detail, "event_detail", 32 * 1024);
  const timestamp = (input.now ?? new Date()).toISOString();
  return getDb().transaction(() => {
    const current = rowToRecord(readRow(input.id));
    if (!current) throw new Error("media_operation_not_found");
    if (current.version !== input.expectedVersion) throw new Error("media_operation_revision_conflict");
    validatePatch(current, input.patch);
    const nextLifecycle = input.patch.lifecycle ?? current.lifecycle;
    const nextProviderOperationId = input.patch.providerOperationId === undefined ? current.providerOperationId : input.patch.providerOperationId;
    const nextProviderCheckpoint = input.patch.providerCheckpoint === undefined
      ? (current.providerCheckpoint === null ? null : encodeJson(current.providerCheckpoint, "provider_checkpoint"))
      : (input.patch.providerCheckpoint === null ? null : encodeJson(input.patch.providerCheckpoint, "provider_checkpoint"));
    const nextProviderStatus = input.patch.providerStatus === undefined ? current.providerStatus : input.patch.providerStatus;
    const nextCancellation = input.patch.cancellation ?? current.cancellation;
    const nextCancelRequestedAt = input.patch.cancelRequestedAt === undefined ? current.cancelRequestedAt : input.patch.cancelRequestedAt;
    const nextCancelConfirmedAt = input.patch.cancelConfirmedAt === undefined ? current.cancelConfirmedAt : input.patch.cancelConfirmedAt;
    const nextResult = input.patch.result === undefined ? current.result : input.patch.result;
    const nextFailureCode = input.patch.failureCode === undefined ? current.failureCode : input.patch.failureCode;
    const nextFailureMessage = input.patch.failureMessage === undefined ? current.failureMessage : input.patch.failureMessage;
    const nextPollAttempts = current.pollAttempts + (input.patch.incrementPollAttempts ? 1 : 0);
    const nextVersion = current.version + 1;
    const changed = getDb().prepare(`UPDATE media_operations SET
      lifecycle = ?, provider_operation_id = ?, provider_checkpoint_json = ?, provider_status = ?,
      cancellation = ?, cancel_requested_at = ?, cancel_confirmed_at = ?, result_path = ?,
      result_sha256 = ?, result_receipt_json = ?, failure_code = ?, failure_message = ?,
      poll_attempts = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ?`).run(
        nextLifecycle, nextProviderOperationId, nextProviderCheckpoint, nextProviderStatus,
        nextCancellation, nextCancelRequestedAt, nextCancelConfirmedAt, nextResult?.path ?? null,
        nextResult?.sha256 ?? null, nextResult ? encodeJson(nextResult.receipt, "result_receipt") : null,
        nextFailureCode, nextFailureMessage, nextPollAttempts, nextVersion, timestamp, input.id, input.expectedVersion,
      );
    if (changed.changes !== 1) throw new Error("media_operation_revision_conflict");
    getDb().prepare(`INSERT INTO media_operation_events (
      operation_id, sequence, from_lifecycle, to_lifecycle, cancellation, reason_code, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, nextVersion, current.lifecycle, nextLifecycle, nextCancellation, input.reasonCode, detailJson, timestamp);
    const next = rowToRecord(readRow(input.id));
    if (!next) throw new Error("media_operation_update_failed");
    return next;
  })();
}
