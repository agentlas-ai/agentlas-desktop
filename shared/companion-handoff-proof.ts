import { createHash } from "node:crypto";

/** The exact, purpose-separated transcript for a verified Companion handoff.
 * This is a proof of the paired Desktop key, not authority to run Work.
 * The receiving authority must still validate its active reservation and claim.
 */
export const COMPANION_HANDOFF_PROOF_PURPOSE = "agentlas.companion.desktop-proof.v1";
export const COMPANION_HANDOFF_PROOF_FIELDS = [
  "userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "hostId", "oneId",
  "turnId", "commandId", "desktopChallenge", "method", "contextDigest", "payloadDigest", "contextRevision", "runGeneration",
] as const;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CHALLENGE = /^hch_[A-Za-z0-9_-]{22}$/;
const METHODS = new Set(["one.context-handoff.send.v1", "one.work-handoff.send.v1"]);

export function companionHandoffProofBytes(value: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("companion_handoff_proof_invalid");
  const b = value as Record<string, unknown>;
  const actual = Object.keys(b).sort(), expected = [...COMPANION_HANDOFF_PROOF_FIELDS].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index]) ||
      ![b.userId, b.workspaceId, b.accountSubject, b.familyId, b.deviceId, b.hostId, b.oneId, b.turnId, b.commandId]
        .every((v) => typeof v === "string" && ID.test(v)) ||
      typeof b.desktopChallenge !== "string" || !CHALLENGE.test(b.desktopChallenge) ||
      typeof b.method !== "string" || !METHODS.has(b.method) ||
      typeof b.contextDigest !== "string" || !DIGEST.test(b.contextDigest) ||
      typeof b.payloadDigest !== "string" || !DIGEST.test(b.payloadDigest) ||
      !Number.isSafeInteger(b.authEpoch) || Number(b.authEpoch) < 0 ||
      !Number.isSafeInteger(b.contextRevision) || Number(b.contextRevision) < 0 ||
      !Number.isSafeInteger(b.runGeneration) || Number(b.runGeneration) < 1) {
    throw new TypeError("companion_handoff_proof_invalid");
  }
  return Buffer.from(JSON.stringify([COMPANION_HANDOFF_PROOF_PURPOSE, ...COMPANION_HANDOFF_PROOF_FIELDS.map((field) => b[field])]), "utf8");
}

/** A receipt transcript is signed only after a trusted Desktop owner has read
 * the matching command and result from its own durable Work records. */
export const COMPANION_WORK_RECEIPT_PURPOSE = "agentlas.companion.work-receipt.v1";
export const COMPANION_WORK_FULL_CHUNK_PURPOSE = "agentlas.companion.work-full-chunk.v1";
export const COMPANION_WORK_FULL_CHUNK_BYTES = 8 * 1024;
export const COMPANION_WORK_FULL_MAX_BYTES = 6 * 1024 * 1024;
const FULL_FIELDS = ["userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "hostId", "oneId", "turnId", "commandId", "payloadDigest", "resultDigest", "fullDigest", "totalBytes", "index", "count", "chunkDigest"] as const;
/** A chunk proof is signed only by the Desktop owner of the frozen full result. */
export function companionWorkFullChunkBytes(value: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("companion_work_chunk_invalid");
  const c = value as Record<string, unknown>, expected = [...FULL_FIELDS, "data"].sort(), actual = Object.keys(c).sort();
  if (actual.length !== expected.length || !actual.every((key, i) => key === expected[i]) ||
      ![c.userId, c.workspaceId, c.accountSubject, c.familyId, c.deviceId, c.hostId, c.oneId, c.turnId, c.commandId].every((v) => typeof v === "string" && ID.test(v)) ||
      !Number.isSafeInteger(c.authEpoch) || Number(c.authEpoch) < 0 || ![c.payloadDigest, c.resultDigest, c.fullDigest, c.chunkDigest].every((v) => typeof v === "string" && DIGEST.test(v)) ||
      !Number.isSafeInteger(c.totalBytes) || Number(c.totalBytes) < 1 || Number(c.totalBytes) > COMPANION_WORK_FULL_MAX_BYTES ||
      !Number.isSafeInteger(c.count) || Number(c.count) !== Math.ceil(Number(c.totalBytes) / COMPANION_WORK_FULL_CHUNK_BYTES) ||
      !Number.isSafeInteger(c.index) || Number(c.index) < 0 || Number(c.index) >= Number(c.count) || typeof c.data !== "string" || !/^[A-Za-z0-9_-]+$/.test(c.data))
    throw new TypeError("companion_work_chunk_invalid");
  const bytes = Buffer.from(c.data, "base64url"), expectedSize = Math.min(COMPANION_WORK_FULL_CHUNK_BYTES, Number(c.totalBytes) - Number(c.index) * COMPANION_WORK_FULL_CHUNK_BYTES);
  if (bytes.toString("base64url") !== c.data || bytes.length !== expectedSize || createHash("sha256").update(bytes).digest("hex") !== c.chunkDigest)
    throw new TypeError("companion_work_chunk_invalid");
  return Buffer.from(JSON.stringify([COMPANION_WORK_FULL_CHUNK_PURPOSE, ...FULL_FIELDS.map((field) => c[field])]), "utf8");
}
const RECEIPT_FIELDS = ["userId", "workspaceId", "authEpoch", "accountSubject", "familyId", "deviceId", "hostId", "oneId", "turnId", "commandId", "payloadDigest", "state", "resultDigest", "resultVerified"] as const;
export function companionWorkReceiptBytes(value: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("companion_work_receipt_invalid");
  const r = value as Record<string, unknown>, v3 = Object.hasOwn(r, "executionModel") || Object.hasOwn(r, "executionHost"), v2 = Object.hasOwn(r, "fullResultPending"), actual = Object.keys(r).sort(), expected = [...RECEIPT_FIELDS, "result", ...(v2 ? ["fullResultPending"] : []), ...(v3 ? ["executionModel", "executionHost"] : [])].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index]) ||
      ![r.userId, r.workspaceId, r.accountSubject, r.familyId, r.deviceId, r.hostId, r.oneId, r.turnId, r.commandId].every((v) => typeof v === "string" && ID.test(v)) ||
      !Number.isSafeInteger(r.authEpoch) || Number(r.authEpoch) < 0 || typeof r.payloadDigest !== "string" || !DIGEST.test(r.payloadDigest) ||
      !["accepted", "completed", "failed", "cancelled", "interrupted"].includes(String(r.state)) || typeof r.result !== "string" ||
      Buffer.byteLength(r.result, "utf8") > 6000 || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(r.result) ||
      (v3 && (!v2 || (r.state === "accepted" && (r.executionModel !== null || r.executionHost !== null)) || !(r.executionModel === null || (typeof r.executionModel === "string" && r.executionModel.trim().length > 0 && r.executionModel.length <= 160 && !/[\p{Cs}\u0000-\u001f\u007f]/u.test(r.executionModel))) || !(r.executionHost === null || ["desktop", "daemon", "terminal"].includes(String(r.executionHost))))) ||
      typeof r.resultVerified !== "boolean" || (v2 && (typeof r.fullResultPending !== "boolean" || (r.state !== "completed" && r.fullResultPending))) || (r.state !== "completed" && r.resultVerified) || (r.state === "accepted" && r.result !== "") ||
      typeof r.resultDigest !== "string" || !DIGEST.test(r.resultDigest) || createHash("sha256").update(r.result, "utf8").digest("hex") !== r.resultDigest) {
    throw new TypeError("companion_work_receipt_invalid");
  }
  return Buffer.from(JSON.stringify([v3 ? "agentlas.companion.work-receipt.v3" : v2 ? "agentlas.companion.work-receipt.v2" : COMPANION_WORK_RECEIPT_PURPOSE, ...RECEIPT_FIELDS.map((field) => r[field]), ...(v2 ? [r.fullResultPending] : []), ...(v3 ? [r.executionModel, r.executionHost] : [])]), "utf8");
}
