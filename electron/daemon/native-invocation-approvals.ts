import { randomUUID } from "node:crypto";
import type { ToolApprovalDecision, ToolApprovalRequestEvent } from "../../shared/types";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { createNativeJsonTransfers } from "./native-json-transfer";
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
  notify(method: string, params: unknown): boolean;
  maxRetainedBytes: number; maxItems: number; onFault(error: unknown): void;
}) {
  const records = new Map<string, { request: ToolApprovalRequestEvent; owner: NativeApprovalObservation; transferOwner: object; transferId: string; resolved: boolean }>();
  let available = true;
  const releases: Array<() => void> = [];
  const dispose = () => { if (!available) return; available = false; for (const release of releases.splice(0)) release();
    for (const record of records.values()) transfers.release(record.transferOwner); records.clear(); };
  const fault = (error: unknown) => { if (!available) return;
    options.notify("invocation.approval.unavailable", { version: "agentlas.native-approval.v1", code: (error as {code?:string})?.code ?? "native_approval_delivery_failed" });
    dispose(); options.onFault(error); };
  const current = () => { if (!available || options.getIdentity() !== options.identity) fail("native_approval_channel_changed"); };
  const transfers = createNativeJsonTransfers({ maxPending: options.maxItems, maxRetainedBytes: options.maxRetainedBytes,
    isCurrent: owner => available && options.getIdentity() === options.identity && [...records.values()].some(r => r.transferOwner === owner) });
  const receive = (request: ToolApprovalRequestEvent) => {
    if (!available) return;
    try {
      current(); const owner = nativeToolApprovalOwner(request);
      if (!owner || !options.accepts(owner)) return;
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
        runId: owner.runId, chatId: owner.chatId, transfer: descriptor })) fail("native_approval_channel_unavailable");
    } catch (error) { fault(error); }
  };
  releases.push(onToolApprovalRequested(receive), onToolApprovalResolved(id => {
    const record = records.get(id); if (!record || !available) return;
    record.resolved = true; transfers.release(record.transferOwner);
    if (!options.notify("invocation.approval.resolved", { version: "agentlas.native-approval.v1", requestId: id,
      receipt: getToolApprovalResolution(id) })) fault(Object.assign(new Error("native_approval_channel_unavailable"), {code:"native_approval_channel_unavailable"}));
  }));
  for (const request of listNativeToolApprovalRequests()) receive(request);
  return {
    read(identity: NativeAuthenticatedIdentity, input: unknown) {
      current(); if (identity !== options.identity) fail("native_approval_channel_changed");
      if (!exact(input, ["requestId", "transferId", "offset"]) || typeof input.requestId !== "string"
        || typeof input.transferId !== "string" || !Number.isSafeInteger(input.offset)) fail("native_approval_read_invalid");
      const record = records.get(input.requestId);
      if (!record || record.transferId !== input.transferId) fail("native_approval_original_request_required");
      return transfers.read(record.transferOwner, input.transferId, Number(input.offset));
    },
    reply(identity: NativeAuthenticatedIdentity, input: unknown) {
      current(); if (identity !== options.identity) fail("native_approval_channel_changed");
      if (!exact(input, ["version", "requestId", "decision", "actionId"]) || input.version !== "agentlas.native-approval-reply.v1"
        || typeof input.requestId !== "string" || typeof input.actionId !== "string"
        || !["allow_once", "allow_session", "allow_always", "deny"].includes(String(input.decision))) fail("native_approval_reply_invalid");
      const record = records.get(input.requestId);
      // The original private request was source-admitted when captured. A
      // later bounded run-observation eviction cannot revoke its consent-only
      // card; live source ownership is rechecked by the original resolver.
      if (!record) fail("native_approval_original_request_required");
      // The original source already settled this exact observed object. The
      // original resolver now serves its durable receipt (or conflict), with
      // no waiter, capability or effect to dispatch again.
      if(record.resolved)return resolveToolApproval(record.request.id,input.decision as ToolApprovalDecision,input.actionId);
      return resolveNativeToolApproval(record.request, input.decision as ToolApprovalDecision, input.actionId);
    },
    receipt(identity: NativeAuthenticatedIdentity, requestId: string) {
      current(); if (identity !== options.identity || !records.has(requestId)) fail("native_approval_original_request_required");
      return getToolApprovalResolution(requestId);
    },
    dispose,
    get available() { return available && options.getIdentity() === options.identity; },
  };
}
