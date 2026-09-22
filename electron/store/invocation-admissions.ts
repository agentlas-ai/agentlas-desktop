import { createHash } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { getDb } from "./db";

/** Main-normalized immutable request snapshot; admitted still requires service validation. */
export const INVOCATION_ADMISSION_DIGEST_VERSION = "main-canonical-json-v1" as const;

export type InvocationAdmissionStatus = "pending" | "admitted" | "rejected";

export interface InvocationAdmission {
  runId: string;
  chatId: string;
  inputDigest: string;
  digestVersion: typeof INVOCATION_ADMISSION_DIGEST_VERSION;
  ownerProcessEpoch: string;
  status: InvocationAdmissionStatus;
  pendingAt: string;
  updatedAt: string;
  admittedAt: string | null;
  rejectedAt: string | null;
  rejectionReasonCode: string | null;
}

interface AdmissionRow {
  run_id: string;
  chat_id: string;
  input_digest: string;
  digest_version: typeof INVOCATION_ADMISSION_DIGEST_VERSION;
  owner_process_epoch: string;
  status: InvocationAdmissionStatus;
  pending_at: string;
  updated_at: string;
  admitted_at: string | null;
  rejected_at: string | null;
  rejection_reason_code: string | null;
}

export interface InvocationAdmissionIdentity {
  runId: string;
  chatId: string;
  /** Main-created canonical JSON, not a renderer-provided digest or raw IPC body. Never persisted. */
  canonicalRequestJson: string;
  /** Unique boot/process epoch, not merely a PID. */
  ownerProcessEpoch: string;
}

/**
 * A pre-admission start refusal may predate the invocation_admissions table
 * (for example, a store opened by Desktop 1.2.32).  The IPC catch writes
 * invoke_prompt_bound only after service.start proves that its durable start
 * boundary was not crossed.  Keep that proof content-free and expose it as a
 * read-only receipt so a renderer can reconcile the exact user turn without
 * inventing a new run or replaying an uncertain external action.
 */
export interface VerifiedStartRejectedReceipt {
  runId: string;
  chatId: string;
  promptMessageId: string;
  rejectedAt: string;
  goalId: string | null;
  rejectionReasonCode: string | null;
}

/**
 * Fingerprint the Main-sanitized renderer request, including image bytes without
 * retaining them in the JSON passed to the store. Keys are sorted so an IPC
 * object's insertion order cannot change the identity of the same request.
 * The caller must first strip renderer-forbidden authority; the service must
 * validate the request before this pending snapshot can become admitted.
 */
export function canonicalInvocationRequestJson(request: McpInvocationRequest): string {
  const canonicalValue = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("invocation_admission_request_too_deep");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1) ?? null);
    if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) throw new Error("invocation_admission_invalid_request_value");
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
      if (item !== undefined) result[key] = item;
    }
    return result;
  };
  if (request.images !== undefined && !Array.isArray(request.images)) {
    throw new Error("invocation_admission_invalid_images");
  }
  const images = request.images?.map((image) => {
    if (!image || typeof image !== "object" || typeof image.data !== "string") {
      throw new Error("invocation_admission_invalid_images");
    }
    const { data, ...metadata } = image;
    return { ...metadata, dataSha256: createHash("sha256").update(data, "utf8").digest("hex") };
  });
  const value = canonicalValue({ ...request, ...(images ? { images } : {}) }, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 1024 * 1024) {
    throw new Error("invocation_admission_invalid_canonical_request");
  }
  return json;
}

export type InvocationAdmissionWriteResult =
  | { kind: "created" | "existing" | "admitted" | "rejected"; admission: InvocationAdmission }
  | { kind: "conflict"; reason: "run-identity" | "pending-chat" | "owner-epoch" | "not-found" | "already-decided" | "start-already-exists"; admission?: InvocationAdmission };

function decode(row: AdmissionRow): InvocationAdmission {
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    inputDigest: row.input_digest,
    digestVersion: row.digest_version,
    ownerProcessEpoch: row.owner_process_epoch,
    status: row.status,
    pendingAt: row.pending_at,
    updatedAt: row.updated_at,
    admittedAt: row.admitted_at,
    rejectedAt: row.rejected_at,
    rejectionReasonCode: row.rejection_reason_code,
  };
}

function validId(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invocation_admission_invalid_${name}`);
  }
}

function validateIdentity(input: InvocationAdmissionIdentity): string {
  validId(input.runId, "run_id");
  validId(input.chatId, "chat_id");
  validId(input.ownerProcessEpoch, "owner_process_epoch");
  if (input.ownerProcessEpoch.length > 128) throw new Error("invocation_admission_invalid_owner_process_epoch");
  const json = input.canonicalRequestJson;
  if (typeof json !== "string" || json.length < 2 || Buffer.byteLength(json, "utf8") > 1024 * 1024) {
    throw new Error("invocation_admission_invalid_canonical_request");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("invocation_admission_invalid_canonical_request"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== json) {
    throw new Error("invocation_admission_invalid_canonical_request");
  }
  return createHash("sha256")
    .update(`${INVOCATION_ADMISSION_DIGEST_VERSION}\0`, "utf8")
    .update(json, "utf8")
    .digest("hex");
}

function rowForRun(runId: string): AdmissionRow | undefined {
  return getDb().prepare("SELECT * FROM invocation_admissions WHERE run_id = ?")
    .get(runId) as AdmissionRow | undefined;
}

interface StartRejectedRow {
  run_id: string;
  chat_id: string | null;
  ts: string;
  payload_json: string;
}

function boundedReceiptText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function startRejectedPayload(payloadJson: string): {
  promptMessageId: string;
  goalId: string | null;
  rejectionReasonCode: string | null;
} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (payload.startRejected !== true || !boundedReceiptText(payload.promptMessageId)) return null;
  const goalId = boundedReceiptText(payload.goalId, 512) ? payload.goalId : null;
  const rejectionReasonCode = typeof payload.rejectionReasonCode === "string"
    && /^[a-z][a-z0-9_-]{0,79}$/u.test(payload.rejectionReasonCode)
    ? payload.rejectionReasonCode
    : null;
  return { promptMessageId: payload.promptMessageId, goalId, rejectionReasonCode };
}

function hasUserPromptMessage(chatId: string, promptMessageId: string): boolean {
  try {
    const row = getDb().prepare(
      "SELECT 1 AS found FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user' LIMIT 1",
    ).get(promptMessageId, chatId) as { found?: number } | undefined;
    return row?.found === 1;
  } catch {
    // A missing/corrupt transcript is not proof that the rejected direction
    // belongs to this chat. Keep the receipt unresolved and fail closed.
    return false;
  }
}

/** Read the Main-owned Goal captured by preflight, if that marker is valid. */
export function getInvocationPreflightGoalId(runId: string, expectedChatId?: string): string | null {
  validId(runId, "run_id");
  if (expectedChatId !== undefined) validId(expectedChatId, "chat_id");
  const row = getDb().prepare(
    "SELECT chat_id, payload_json FROM run_events WHERE run_id = ? AND kind = 'invoke_preflight_started' ORDER BY seq ASC LIMIT 1",
  ).get(runId) as { chat_id?: string | null; payload_json?: string } | undefined;
  if (!row?.payload_json || (expectedChatId !== undefined && row.chat_id !== expectedChatId)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload_json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const goalId = (parsed as Record<string, unknown>).goalId;
  return boundedReceiptText(goalId, 512) ? goalId : null;
}

/**
 * Reconcile a legacy startRejected marker without treating it as an ordinary
 * invocation receipt.  A matching invoke_started row always wins: a missing
 * admission row is not enough to prove a no-start outcome by itself.
 */
export function getVerifiedStartRejectedReceipt(runId: string): VerifiedStartRejectedReceipt | null {
  validId(runId, "run_id");
  const row = getDb().prepare(`
    SELECT run_id, chat_id, ts, payload_json
      FROM run_events
     WHERE run_id = ?
       AND kind = 'invoke_prompt_bound'
       AND NOT EXISTS (
         SELECT 1 FROM run_events started
          WHERE started.run_id = run_events.run_id
            AND started.kind = 'invoke_started'
       )
     ORDER BY seq ASC
     LIMIT 1
  `).get(runId) as StartRejectedRow | undefined;
  if (!row || row.run_id !== runId || !boundedReceiptText(row.chat_id, 512)) return null;
  const payload = startRejectedPayload(row.payload_json);
  if (!payload || !boundedReceiptText(row.ts, 128)) return null;
  if (!hasUserPromptMessage(row.chat_id, payload.promptMessageId)) return null;
  return {
    runId,
    chatId: row.chat_id,
    promptMessageId: payload.promptMessageId,
    rejectedAt: row.ts,
    goalId: payload.goalId ?? getInvocationPreflightGoalId(runId, row.chat_id),
    rejectionReasonCode: payload.rejectionReasonCode,
  };
}

function exactIdentity(row: AdmissionRow, input: InvocationAdmissionIdentity, digest: string): boolean {
  return row.chat_id === input.chatId && row.input_digest === digest
    && row.digest_version === INVOCATION_ADMISSION_DIGEST_VERSION;
}

function anyStartReceipt(runId: string): { chat_id: string | null } | undefined {
  return getDb().prepare(
    "SELECT chat_id FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1",
  ).get(runId) as { chat_id: string | null } | undefined;
}

/** Read-only status lookup. No prompt, canonical request, or attachment data is returned. */
export function getInvocationAdmission(runId: string): InvocationAdmission | null {
  validId(runId, "run_id");
  const row = rowForRun(runId);
  return row ? decode(row) : null;
}

export function getPendingInvocationAdmissionForChat(chatId: string): InvocationAdmission | null {
  validId(chatId, "chat_id");
  const row = getDb().prepare(
    "SELECT * FROM invocation_admissions WHERE chat_id = ? AND status = 'pending' LIMIT 1",
  ).get(chatId) as AdmissionRow | undefined;
  return row ? decode(row) : null;
}

/** Exact run/digest replay is idempotent; another pending run in the chat is not. */
export function createInvocationAdmission(
  input: InvocationAdmissionIdentity,
  now: Date = new Date(),
): InvocationAdmissionWriteResult {
  const digest = validateIdentity(input);
  const timestamp = now.toISOString();
  return getDb().transaction((): InvocationAdmissionWriteResult => {
    const old = rowForRun(input.runId);
    if (old) {
      return exactIdentity(old, input, digest)
        ? { kind: "existing", admission: decode(old) }
        : { kind: "conflict", reason: "run-identity", admission: decode(old) };
    }
    if (anyStartReceipt(input.runId)) return { kind: "conflict", reason: "start-already-exists" };
    const inserted = getDb().prepare(`
      INSERT OR IGNORE INTO invocation_admissions
        (run_id, chat_id, input_digest, digest_version, owner_process_epoch, status, pending_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(input.runId, input.chatId, digest, INVOCATION_ADMISSION_DIGEST_VERSION,
      input.ownerProcessEpoch, timestamp, timestamp);
    if (inserted.changes === 1) return { kind: "created", admission: decode(rowForRun(input.runId)!) };
    const concurrentRun = rowForRun(input.runId);
    if (concurrentRun) {
      return exactIdentity(concurrentRun, input, digest)
        ? { kind: "existing", admission: decode(concurrentRun) }
        : { kind: "conflict", reason: "run-identity", admission: decode(concurrentRun) };
    }
    const pending = getPendingInvocationAdmissionForChat(input.chatId);
    if (pending) return { kind: "conflict", reason: "pending-chat", admission: pending };
    throw new Error("invocation_admission_insert_not_applied");
  })();
}

/**
 * The callback must synchronously persist the exact invoke_started event using
 * the shared getDb() handle (for example recordRunEvent). It runs inside this
 * transaction; do not perform network/provider work or other external effects.
 * No pre-existing receipt may be retroactively called an atomic admission.
 */
export function admitInvocationWithStartReceipt(
  input: InvocationAdmissionIdentity,
  writeStartReceipt: () => void,
  now: Date = new Date(),
): InvocationAdmissionWriteResult {
  const digest = validateIdentity(input);
  const timestamp = now.toISOString();
  return getDb().transaction((): InvocationAdmissionWriteResult => {
    const row = rowForRun(input.runId);
    if (!row) return { kind: "conflict", reason: "not-found" };
    if (!exactIdentity(row, input, digest)) return { kind: "conflict", reason: "run-identity", admission: decode(row) };
    if (row.owner_process_epoch !== input.ownerProcessEpoch) {
      return { kind: "conflict", reason: "owner-epoch", admission: decode(row) };
    }
    if (row.status !== "pending") {
      return { kind: "conflict", reason: "already-decided", admission: decode(row) };
    }
    if (anyStartReceipt(input.runId)) {
      return { kind: "conflict", reason: "start-already-exists", admission: decode(row) };
    }
    writeStartReceipt();
    const receipts = getDb().prepare(
      "SELECT chat_id FROM run_events WHERE run_id = ? AND kind = 'invoke_started'",
    ).all(input.runId) as Array<{ chat_id: string | null }>;
    if (receipts.length !== 1 || receipts[0].chat_id !== input.chatId) {
      // Throw, rather than returning a conflict: the callback's DB writes must
      // roll back along with this admission attempt.
      throw new Error("invocation_admission_start_receipt_missing_or_mismatched");
    }
    getDb().prepare(`UPDATE invocation_admissions
      SET status = 'admitted', admitted_at = ?, updated_at = ?
      WHERE run_id = ? AND status = 'pending'`).run(timestamp, timestamp, input.runId);
    return { kind: "admitted", admission: decode(rowForRun(input.runId)!) };
  })();
}

export type VerifiedNoStartProof = {
  kind: "prior-owner-epoch-terminated";
  verifiedOwnerProcessEpoch: string;
} | {
  /** Supplied only by the synchronous Main start wrapper before dispatch. */
  kind: "owner-start-boundary-not-crossed";
  verifiedOwnerProcessEpoch: string;
};

/**
 * A prior-epoch proof requires independent evidence that the old Main process
 * terminated. A current-epoch proof requires direct control-flow evidence
 * that start never crossed its durable dispatch boundary. Matching an epoch,
 * or observing no receipt in a still-live process, is NOT proof of no start.
 */
export function decideInvocationAdmission(input: InvocationAdmissionIdentity & {
  decision: "rejected";
  reasonCode: string;
  noStartProof: VerifiedNoStartProof;
}, now: Date = new Date()): InvocationAdmissionWriteResult {
  const digest = validateIdentity(input);
  const timestamp = now.toISOString();
  if (!input.noStartProof || !["prior-owner-epoch-terminated", "owner-start-boundary-not-crossed"].includes(input.noStartProof.kind)
    || input.noStartProof.verifiedOwnerProcessEpoch !== input.ownerProcessEpoch) {
    throw new Error("invocation_admission_unverified_no_start");
  }
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(input.reasonCode)) {
    throw new Error("invocation_admission_invalid_reason_code");
  }
  return getDb().transaction((): InvocationAdmissionWriteResult => {
    const row = rowForRun(input.runId);
    if (!row) return { kind: "conflict", reason: "not-found" };
    if (!exactIdentity(row, input, digest)) return { kind: "conflict", reason: "run-identity", admission: decode(row) };
    if (row.owner_process_epoch !== input.ownerProcessEpoch) {
      return { kind: "conflict", reason: "owner-epoch", admission: decode(row) };
    }
    if (row.status !== "pending") {
      return { kind: "conflict", reason: "already-decided", admission: decode(row) };
    }
    if (anyStartReceipt(input.runId)) {
      return { kind: "conflict", reason: "start-already-exists", admission: decode(row) };
    }
    getDb().prepare(`UPDATE invocation_admissions
      SET status = 'rejected', rejected_at = ?, rejection_reason_code = ?, updated_at = ?
      WHERE run_id = ? AND status = 'pending'`).run(timestamp, input.reasonCode, timestamp, input.runId);
    return { kind: "rejected", admission: decode(rowForRun(input.runId)!) };
  })();
}
