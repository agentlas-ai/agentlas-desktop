import { createHash, randomUUID } from "node:crypto";
import type { ToolApprovalDecision, ToolApprovalRequestEvent } from "../../shared/types";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { createNativeJsonTransfers, NATIVE_JSON_CHUNK_BYTES, type NativeJsonTransferDescriptor } from "./native-json-transfer";
import { nativeToolApprovalOwner, type NativeApprovalObservation } from "../runtime/native-approval-provenance";
import { onToolApprovalRequested, onToolApprovalResolved, resolveNativeToolApproval, resolveToolApproval, getToolApprovalResolution,
  listNativeToolApprovalRequests } from "../runtime/tool-approval";
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const own = Object.keys(value); return own.length === keys.length && own.every(key => keys.includes(key));
}
/** One genuine signed peer, original pending source request, exact native run
 * provenance and original ledger. IDs select captured objects, never authority. */
export function createNativeInvocationApprovalChannel(options: {
  identity: NativeAuthenticatedIdentity; getIdentity(): NativeAuthenticatedIdentity | null;
  accepts(owner: NativeApprovalObservation): boolean;
  notify(method: string, params: unknown, sourceMode?: "live" | "post-denial"): boolean;
  maxRetainedBytes: number; maxItems: number; onFault(error: unknown): void;
}) {
  const records = new Map<string, { request: ToolApprovalRequestEvent; owner: NativeApprovalObservation; transferOwner: object; transferId: string; resolved: boolean; uncertainty?: unknown }>();
  // Historical consent is owned by the original registry, not live execution
  // capacity. Retain identity/offset metadata and a weak original; never a second
  // full payload buffer or a live slot. A missing original is uncertainty.
  type Historical = { original: WeakRef<ToolApprovalRequestEvent>; owner: NativeApprovalObservation; descriptor: NativeJsonTransferDescriptor; nextOffset: number; lastOffset?: number; resolved: boolean; uncertainty?: unknown };
  const historical = new Map<string, Historical>();
  let available = true;
  const releases: Array<() => void> = [];
  const dispose = () => { if (!available) return; available = false; for (const release of releases.splice(0)) release();
    for (const record of records.values()) transfers.release(record.transferOwner); records.clear(); historical.clear(); };
  const fault = (error: unknown) => { if (!available) return;
    options.notify("invocation.approval.unavailable", { version: "agentlas.native-approval.v1", code: (error as {code?:string})?.code ?? "native_approval_delivery_failed" }, "live");
    dispose(); options.onFault(error); };
  const current = () => { if (!available || options.getIdentity() !== options.identity) fail("native_approval_channel_changed"); };
  const transfers = createNativeJsonTransfers({ maxPending: options.maxItems, maxRetainedBytes: options.maxRetainedBytes,
    isCurrent: owner => available && options.getIdentity() === options.identity && [...records.values()].some(r => r.transferOwner === owner) });
  const receive = (request: ToolApprovalRequestEvent) => {
    if (!available) return;
    let observedOwner: NativeApprovalObservation | undefined;
    try {
      current(); const owner = observedOwner = nativeToolApprovalOwner(request);
      if (!owner || !options.accepts(owner)) return;
      if (owner.mode === "post-denial") {
        if (historical.has(request.id)) return;
        // Prune only dead weak references. Original source/ledger ownership is
        // unchanged and no unresolved source object is arbitrarily deleted.
        for (const [id, item] of historical) if (!item.original.deref() && !item.resolved) historical.delete(id);
        const bytes = Buffer.from(JSON.stringify(request), "utf8");
        if (bytes.length > options.maxRetainedBytes) fail("native_approval_historical_card_unavailable");
        const descriptor: NativeJsonTransferDescriptor = Object.freeze({version: "agentlas.native-json.v1", kind: "checkpoint-value", transferId: randomUUID(), byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex")});
        historical.set(request.id, {original: new WeakRef(request), owner, descriptor, nextOffset: 0, resolved: false});
        if (!options.notify("invocation.approval.ready", {version: "agentlas.native-approval.v1", requestId: request.id, runId: owner.runId, chatId: owner.chatId, transfer: descriptor}, owner.mode)) fail("native_approval_channel_unavailable");
        return;
      }
      if (records.has(request.id)) return;
      while (records.size >= options.maxItems) {
        const completed = [...records.entries()].find(([, record]) => record.resolved);
        if (!completed) fail("native_approval_capacity_exhausted");
        transfers.release(completed[1].transferOwner); records.delete(completed[0]);
      }
      const transferOwner = Object.freeze({ nonce: randomUUID() });
      const record = { request, owner, transferOwner, transferId: "", resolved: false }; records.set(request.id, record);
      let descriptor;
      try { descriptor = transfers.issue(transferOwner, "checkpoint-value", request, options.maxRetainedBytes); }
      catch (error) { records.delete(request.id); throw error; }
      record.transferId = descriptor.transferId;
      if (!options.notify("invocation.approval.ready", { version: "agentlas.native-approval.v1", requestId: request.id,
        runId: owner.runId, chatId: owner.chatId, transfer: descriptor }, owner.mode)) fail("native_approval_channel_unavailable");
    } catch (error) {
      const record = records.get(request.id) ?? historical.get(request.id);
      // Original historical consent is not a live execution or channel lease.
      // Retain its source record/uncertainty; one old card cannot revoke a
      // current subscription or fabricate an approval for a future call.
      if (observedOwner?.mode === "post-denial") { if (record) record.uncertainty = error; console.warn("[native-invocation] historical consent observation unavailable"); }
      else fault(error);
    }
  };
  releases.push(onToolApprovalRequested(receive), onToolApprovalResolved(id => {
    const record = records.get(id) ?? historical.get(id); if (!record || !available) return;
    record.resolved = true; if ("transferOwner" in record) transfers.release(record.transferOwner);
    if (!options.notify("invocation.approval.resolved", { version: "agentlas.native-approval.v1", requestId: id,
      receipt: getToolApprovalResolution(id) }, record.owner.mode)) {
        const error = Object.assign(new Error("native_approval_channel_unavailable"), {code:"native_approval_channel_unavailable"});
        if (record.owner.mode === "post-denial") record.uncertainty = error; else fault(error);
      }
  }));
  for (const request of listNativeToolApprovalRequests()) receive(request);
  return {
    read(identity: NativeAuthenticatedIdentity, input: unknown) {
      current(); if (identity !== options.identity) fail("native_approval_channel_changed");
      if (!exact(input, ["requestId", "transferId", "offset"]) || typeof input.requestId !== "string"
        || typeof input.transferId !== "string" || !Number.isSafeInteger(input.offset)) fail("native_approval_read_invalid");
      const old = historical.get(input.requestId);
      if (old) {
        const original = old.original.deref();
        if (!original) fail("native_approval_original_observation_unavailable");
        const owner = nativeToolApprovalOwner(original);
        if (!owner || owner.mode !== "post-denial" || !options.accepts(owner) || old.resolved || input.transferId !== old.descriptor.transferId) fail("native_approval_original_request_required");
        const bytes = Buffer.from(JSON.stringify(original), "utf8"), offset = Number(input.offset);
        if (bytes.length !== old.descriptor.byteLength || createHash("sha256").update(bytes).digest("hex") !== old.descriptor.digest) fail("native_approval_original_request_changed");
        if (offset === 0 && old.nextOffset === bytes.length) { old.nextOffset = 0; old.lastOffset = undefined; }
        if (offset < 0 || offset >= bytes.length || (offset !== old.nextOffset && offset !== old.lastOffset)) fail("native_json_offset_invalid");
        const nextOffset = Math.min(bytes.length, offset + NATIVE_JSON_CHUNK_BYTES);
        old.lastOffset = offset; old.nextOffset = nextOffset;
        return {transferId: input.transferId, offset, nextOffset, done: nextOffset === bytes.length, data: bytes.subarray(offset, nextOffset).toString("base64")};
      }
      const record = records.get(input.requestId);
      if (!record || record.transferId !== input.transferId) fail("native_approval_original_request_required");
      return transfers.read(record.transferOwner, input.transferId, Number(input.offset));
    },
    reply(identity: NativeAuthenticatedIdentity, input: unknown) {
      current(); if (identity !== options.identity) fail("native_approval_channel_changed");
      if (!exact(input, ["version", "requestId", "decision", "actionId"]) || input.version !== "agentlas.native-approval-reply.v1"
        || typeof input.requestId !== "string" || typeof input.actionId !== "string"
        || !["allow_once", "allow_session", "allow_always", "deny"].includes(String(input.decision))) fail("native_approval_reply_invalid");
      const record = records.get(input.requestId) ?? historical.get(input.requestId);
      // The original private request was source-admitted when captured. A
      // later bounded run-observation eviction cannot revoke its consent-only
      // card; live source ownership is rechecked by the original resolver.
      if (!record) fail("native_approval_original_request_required");
      // The original source already settled this exact observed object. The
      // original resolver now serves its durable receipt (or conflict), with
      // no waiter, capability or effect to dispatch again.
      if(record.resolved)return resolveToolApproval(input.requestId,input.decision as ToolApprovalDecision,input.actionId);
      const original = "request" in record ? record.request : record.original.deref();
      if (!original) fail("native_approval_original_observation_unavailable");
      return resolveNativeToolApproval(original, input.decision as ToolApprovalDecision, input.actionId);
    },
    receipt(identity: NativeAuthenticatedIdentity, requestId: string) {
      current(); if (identity !== options.identity || !records.has(requestId) && !historical.has(requestId)) fail("native_approval_original_request_required");
      return getToolApprovalResolution(requestId);
    },
    observationMode(requestId: string) { return records.get(requestId)?.owner.mode ?? historical.get(requestId)?.owner.mode; },
    observationCounts() { return {live: records.size, historical: historical.size, liveBytes: transfers.retainedBytes}; },
    dispose,
    get available() { return available && options.getIdentity() === options.identity; },
  };
}
