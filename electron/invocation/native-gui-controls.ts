import { createHash } from "node:crypto";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { nativeOwnerTextChoices } from "./native-owner-text";
import type { NativeOwnerTextBinding, NativeOwnerTextKind, NativeOwnerTextReceipt } from "./native-owner-text";
import type { McpInvocationRequest } from "../../shared/types";
import { BrowserWindow } from "electron";
import type { ToolApprovalDecision, ToolApprovalRequestEvent, ToolApprovalResolutionReceipt } from "../../shared/types";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { importNativeJsonValue } from "../daemon/native-json-transfer";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { NATIVE_MAIN_PREPARATION_POLICY, NATIVE_DAEMON_INVOCATION_POLICY, NATIVE_APPROVAL_OBSERVATION_POLICY } from "../daemon/native-invocation-policy";

type Channel = object & { dispatch(method: string, params: unknown): Promise<unknown>; onClose(listener: () => void): () => void };
type Capture = Readonly<{ chatId: string; runId: string; nativeCustody: "released" | "retained" }>;
type Approval = { chatId: string; runId: string; descriptor: unknown; retainedBytes: number; request?: ToolApprovalRequestEvent; read?: Promise<void>; readSettled?: boolean; readFailed?: boolean; decision?: { actionId: string; promise: Promise<ToolApprovalResolutionReceipt>; settled?: boolean; known?: boolean }; receipt?: ToolApprovalResolutionReceipt };
export class NativeGuiControlError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new NativeGuiControlError(code); }
function exact(v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const own = Object.keys(v); return keys.every(k => Object.hasOwn(v, k)) && own.every(k => keys.includes(k) || optional.includes(k));
}
function id(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\u0000-\u001f]/.test(v); }
function decision(v: unknown): v is ToolApprovalDecision { return ["allow_once", "allow_session", "allow_always", "deny"].includes(String(v)); }
function receipt(v: unknown, requestId: string): ToolApprovalResolutionReceipt {
  if (!exact(v, ["ok", "receiptVersion", "requestId", "requestedDecision", "resolvedDecision", "actionId", "status", "pending", "decidedAt"], ["durableConsent"])
    || typeof v.ok !== "boolean" || v.receiptVersion !== 1 || v.requestId !== requestId || typeof v.pending !== "boolean"
    || (v.requestedDecision !== null && !decision(v.requestedDecision)) || (v.resolvedDecision !== null && !decision(v.resolvedDecision))
    || (v.actionId !== null && (typeof v.actionId !== "string" || v.actionId.length > 512)) || (v.decidedAt !== null && typeof v.decidedAt !== "string")
    || !["resolved", "replayed", "pending", "expired", "conflict", "not_found", "invalid_action"].includes(String(v.status))) fail("native_gui_approval_receipt_invalid");
  if (v.durableConsent !== undefined && (!exact(v.durableConsent, ["status"], ["code"])
    || !["persisted", "failed", "unavailable"].includes(String(v.durableConsent.status))
    || (v.durableConsent.code !== undefined && !["missing-binding", "missing-persister", "storage-failure", "storage-receipt-missing"].includes(String(v.durableConsent.code))))) fail("native_gui_approval_receipt_invalid");
  return v as unknown as ToolApprovalResolutionReceipt;
}
function card(v: unknown, requestId: string, chatId: string): ToolApprovalRequestEvent {
  if (!exact(v, ["id", "runtime", "tool", "mode", "requestedAt"], ["detail", "cwd", "deniedBy", "expiresAt", "chatId", "capability", "agentId", "consentBinding"])
    || v.id !== requestId || typeof v.runtime !== "string" || typeof v.tool !== "string" || !["live", "post-denial"].includes(String(v.mode))
    || typeof v.requestedAt !== "string" || (v.chatId !== undefined && v.chatId !== chatId)
    || ["detail", "cwd", "expiresAt", "capability", "agentId"].some(k => v[k] !== undefined && typeof v[k] !== "string")
    || (v.deniedBy !== undefined && !["runtime-headless", "sandbox"].includes(String(v.deniedBy)))) fail("native_gui_approval_card_invalid");
  if (v.consentBinding !== undefined && (!exact(v.consentBinding, ["userIdentity", "workspaceIdentity", "requesterIdentity", "credentialResourceIdentity", "permissionScope"])
    || ["userIdentity", "workspaceIdentity", "requesterIdentity", "credentialResourceIdentity"].some(k => typeof (v.consentBinding as Record<string, unknown>)[k] !== "string")
    || !["read", "write", "full"].includes(String(v.consentBinding.permissionScope)))) fail("native_gui_approval_card_invalid");
  return v as unknown as ToolApprovalRequestEvent;
}
function broadcast(channel: string, payload: unknown) { for (const window of BrowserWindow.getAllWindows()) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
  try { window.webContents.send(channel, payload); } catch { /* Viewer loss does not cancel custody. */ }
} }
let configured: ReturnType<typeof createNativeGuiControls> | undefined;
/** Native Main-only. Captures readonly source snapshot; never creates a private
 * preparation handle, reissues starts, or treats a missing row as no execution. */
export function createNativeGuiControls(ports: { authorizeRenderer(event: object): object; onRecoveryChatIds(chatIds: string[]): void; onUnavailable?(channel: Channel, identity: NativeAuthenticatedIdentity): void; observationPolicy?: Readonly<{ maxRecords: number; maxRetainedBytes: number }> }) {
  const observationPolicy = ports.observationPolicy ?? { maxRecords: NATIVE_APPROVAL_OBSERVATION_POLICY.maxRecords, maxRetainedBytes: NATIVE_MAIN_PREPARATION_POLICY.maxRetainedBytes };
  if (![observationPolicy.maxRecords, observationPolicy.maxRetainedBytes].every(v => Number.isSafeInteger(v) && v > 0)) fail("native_gui_observation_policy_invalid");
  let retainedApprovalBytes = 0;
  let channel: Channel | undefined, identity: NativeAuthenticatedIdentity | undefined;
  const controller = new AbortController(), captures = new Map<string, Capture>(), activeRuns = new Set<string>(), approvals = new Map<string, Approval>();
  const stops = new Map<string, { promise: Promise<"requested" | "already-requested" | "not-found">; acknowledged: boolean }>();
  let refreshPromise: Promise<void> | undefined, snapshotKnown = false, routeUnavailable = false;
  function current(): Channel { if (!channel || !identity || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable"); return channel; }
  function human(event: object): void { if (!ports.authorizeRenderer(event)) fail("native_gui_original_renderer_required"); current(); }
  async function call(method: string, params: unknown): Promise<unknown> { const original = current(), captured = identity; const result = await original.dispatch(method, params); if (current() !== original || identity !== captured) fail("native_gui_original_channel_unavailable"); return result; }
  function unavailable(): void { routeUnavailable = true; const original = current(); ports.onUnavailable?.(original, identity!); }
  function pruneApprovals(requiredBytes = 0): void {
    for (const [requestId, record] of approvals) {
      if (approvals.size < observationPolicy.maxRecords && requiredBytes <= observationPolicy.maxRetainedBytes - retainedApprovalBytes) break;
      if (record.readSettled && !record.readFailed && record.receipt?.ok && !record.receipt.pending
        && record.receipt.resolvedDecision !== null && ["resolved", "replayed"].includes(record.receipt.status)
        && (!record.decision || (record.decision.settled && record.decision.known))) { approvals.delete(requestId); retainedApprovalBytes -= record.retainedBytes; }
    }
  }
  function pruneStops(): void {
    for (const [runId, record] of stops) if (record.acknowledged && captures.get(runId)?.nativeCustody === "released") stops.delete(runId);
  }
  function bind(actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity): void {
    if (channel || configured || nativeGuiChannelIdentity(actualChannel) !== actualIdentity) fail("native_gui_original_channel_required");
    channel = actualChannel; identity = actualIdentity; configured = control;
    actualChannel.onClose(() => controller.abort(new NativeGuiControlError("native_gui_original_channel_unavailable")));
  }
  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    const originalIdentity = identity;
    const operation = (async () => {
      const value = await call("native.attach", { version: "agentlas.native-recovery.v1" });
      if (!exact(value, ["version", "bootId", "activeRunIds", "activeChatIds", "captures"]) || value.version !== "agentlas.native-recovery.v1" || value.bootId !== originalIdentity?.bootId
        || !Array.isArray(value.activeRunIds) || !Array.isArray(value.activeChatIds) || !Array.isArray(value.captures)
        || value.captures.length > NATIVE_DAEMON_INVOCATION_POLICY.maxRecords || !value.activeRunIds.every(id) || !value.activeChatIds.every(id)
        || new Set(value.activeRunIds).size !== value.activeRunIds.length || new Set(value.activeChatIds).size !== value.activeChatIds.length) fail("native_gui_recovery_snapshot_invalid");
      const next = new Map<string, Capture>();
      for (const record of value.captures) {
        if (!exact(record, ["chatId", "runId", "nativeCustody"]) || !id(record.chatId) || !id(record.runId) || !["released", "retained"].includes(String(record.nativeCustody)) || next.has(record.runId)) fail("native_gui_recovery_snapshot_invalid");
        next.set(record.runId, Object.freeze({ ...record }) as Capture);
      }
      const nextActiveRuns = value.activeRunIds as string[], nextActiveChats = value.activeChatIds as string[];
      if (nextActiveRuns.some(runId => !next.has(runId)) || nextActiveChats.some(chatId => !nextActiveRuns.some(runId => next.get(runId)?.chatId === chatId))) fail("native_gui_recovery_snapshot_invalid");
      // Absence in a bounded later snapshot is not no-execution proof. Keep
      // original retained custody until source explicitly reports released.
      for (const [runId, value] of captures) if (value.nativeCustody === "retained" && !next.has(runId)) next.set(runId, value);
      captures.clear(); for (const [runId, value] of next) captures.set(runId, value);
      activeRuns.clear(); for (const runId of value.activeRunIds) activeRuns.add(runId);
      snapshotKnown = true; pruneStops(); ports.onRecoveryChatIds([...value.activeChatIds]);
    })(); refreshPromise = operation;
    void operation.finally(() => { if (refreshPromise === operation) refreshPromise = undefined; }).catch(() => {});
    return operation;
  }
  function approvalReady(value: unknown): void {
    current(); if (!exact(value, ["version", "requestId", "runId", "chatId", "transfer"]) || value.version !== "agentlas.native-approval.v1" || !id(value.requestId) || !id(value.runId) || !id(value.chatId)) fail("native_gui_approval_ready_invalid");
    if (approvals.has(value.requestId)) fail("native_gui_approval_ready_replayed");
    const transfer = value.transfer;
    if (!exact(transfer, ["version", "transferId", "kind", "byteLength", "digest"]) || transfer.version !== "agentlas.native-json.v1"
      || transfer.kind !== "checkpoint-value" || typeof transfer.transferId !== "string" || !/^[a-f0-9-]{36}$/.test(transfer.transferId)
      || typeof transfer.digest !== "string" || !/^[a-f0-9]{64}$/.test(transfer.digest) || !Number.isSafeInteger(transfer.byteLength)
      || Number(transfer.byteLength) < 1 || Number(transfer.byteLength) > NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes) fail("native_gui_approval_descriptor_invalid");
    const bytes = Number(transfer.byteLength); pruneApprovals(bytes);
    if (approvals.size >= observationPolicy.maxRecords || bytes > observationPolicy.maxRetainedBytes - retainedApprovalBytes) { unavailable(); fail("native_gui_approval_capacity_reached"); }
    const record: Approval = { runId: value.runId, chatId: value.chatId, descriptor: transfer, retainedBytes: bytes };
    retainedApprovalBytes += bytes; approvals.set(value.requestId, record);
    const read = (async () => {
      const raw = await importNativeJsonValue(record.descriptor, { kind: "checkpoint-value", maxBytes: NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes,
        signal: controller.signal, assertCurrent: () => { current(); }, read: (transferId, offset) => call("native.attach", { version: "agentlas.native-approval-read.v1", read: { requestId: value.requestId, transferId, offset } }) });
      current();
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > record.retainedBytes) fail("native_gui_approval_size_invalid");
      record.request = card(raw, value.requestId as string, record.chatId);
      if (!record.receipt || record.receipt.pending) broadcast("runtime:toolApprovalRequest", record.request);
    })(); record.read = read;
    void read.then(() => { record.readSettled = true; }, error => { record.readSettled = true; record.readFailed = true; console.warn("[native-invocation] approval card unavailable", error); try { unavailable(); } catch { /* Original unavailable state retained. */ } });
  }
  function accept(method: string, value: unknown): void {
    if (method === "invocation.approval.unavailable") {
      try { const original = current(); if (!exact(value, ["version", "code"]) || value.version !== "agentlas.native-approval.v1" || typeof value.code !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(value.code)) fail("native_gui_approval_unavailable_invalid"); ports.onUnavailable?.(original, identity!); } catch (error) { console.warn("[native-invocation] approval stream unavailable", error); try { unavailable(); } catch { /* No current channel can restore readiness. */ } }
    }
    if (method === "invocation.approval.ready") { try { approvalReady(value); } catch (error) { console.warn("[native-invocation] approval stream unavailable", error); try { unavailable(); } catch { /* No current channel can restore readiness. */ } } }
    if (method === "invocation.approval.resolved") {
      try { current(); if (!exact(value, ["version", "requestId", "receipt"]) || value.version !== "agentlas.native-approval.v1" || !id(value.requestId)) fail("native_gui_approval_receipt_invalid");
        const record = approvals.get(value.requestId); if (!record) fail("native_gui_original_approval_required");
        record.receipt = receipt(value.receipt, value.requestId); broadcast("runtime:toolApprovalResolution", record.receipt);
      } catch (error) { console.warn("[native-invocation] approval resolution unavailable", error); try { unavailable(); } catch { /* No current channel can restore readiness. */ } }
    }
  }
  async function approvalReceipt(event: object, requestId: string): Promise<ToolApprovalResolutionReceipt> {
    human(event); const record = approvals.get(requestId); if (!record) fail("native_gui_original_approval_required");
    const value = receipt(await call("native.attach", { version: "agentlas.native-approval-receipt.v1", requestId }), requestId);
    record.receipt = value; return value;
  }
  function resolveApproval(event: object, requestId: string, value: ToolApprovalDecision, actionId: string): Promise<ToolApprovalResolutionReceipt> {
    human(event); const record = approvals.get(requestId); if (!record?.request) fail("native_gui_original_approval_required");
    if (!decision(value) || actionId !== toolApprovalActionId(requestId, value)) fail("native_gui_approval_action_invalid");
    if (record.decision) { if (record.decision.actionId !== actionId) fail("native_gui_approval_action_conflict"); return record.decision.promise; }
    let resolve!: (value: ToolApprovalResolutionReceipt) => void, reject!: (error: unknown) => void;
    const pending = new Promise<ToolApprovalResolutionReceipt>((yes, no) => { resolve = yes; reject = no; });
    record.decision = { actionId, promise: pending }; // BEFORE actual signed dispatch/reentry.
    try {
      void call("native.approvalReply", { version: "agentlas.native-approval-reply.v1", requestId, decision: value, actionId }).then(raw => {
        try { const result = receipt(raw, requestId); if (result.requestedDecision !== value || (result.ok && result.actionId !== actionId)) fail("native_gui_approval_receipt_invalid"); record.receipt = result; record.decision!.known = true; resolve(result); } catch (error) { reject(error); }
      }, reject);
    } catch (error) { reject(error); }
    void pending.finally(() => { record.decision!.settled = true; }).catch(() => {}); return pending;
  }
  function cancel(event: object, runId: string): Promise<"requested" | "already-requested" | "not-found"> {
    human(event); const record = captures.get(runId); if (!record) fail("native_gui_observed_run_required");
    const prior = stops.get(runId); if (prior) return prior.promise;
    let resolve!: (value: "requested" | "already-requested" | "not-found") => void, reject!: (error: unknown) => void;
    const pending = new Promise<"requested" | "already-requested" | "not-found">((yes, no) => { resolve = yes; reject = no; });
    const stop = { promise: pending, acknowledged: false };
    stops.set(runId, stop); // BEFORE signed dispatch; ACK loss never re-sends.
    if (stops.size >= NATIVE_DAEMON_INVOCATION_POLICY.maxRecords) { try { unavailable(); } catch { /* Stop remains unconditional. */ } }
    try {
      void call("invoke.cancel", { version: "agentlas.native-owner-stop.v1", chatId: record.chatId, runId }).then(raw => {
        try {
          if (!exact(raw, ["version", "chatId", "runId", "status"]) || raw.version !== "agentlas.native-owner-stop.v1" || raw.runId !== runId || raw.chatId !== record.chatId || !["requested", "already-requested", "not-found"].includes(String(raw.status))) fail("native_gui_stop_ack_invalid");
          stop.acknowledged = true; resolve(raw.status as "requested" | "already-requested" | "not-found");
          pruneStops();
        } catch (error) { reject(error); }
      }, reject);
    } catch (error) { reject(error); }
    void pending.catch(() => {}); return pending;
  }
  function textReceipt(raw: unknown, binding: NativeOwnerTextBinding, intentId: string, expected?: {text:string;kind:NativeOwnerTextKind}): NativeOwnerTextReceipt | null {
    if (raw === null) return null;
    if (!exact(raw, ["version", "chatId", "runId", "inputDigest", "intentId", "deliveryKind", "promptHash", "messageId", "sourceStatus", "result"], ["code"])
      || raw.version !== "agentlas.native-owner-text.v1" || raw.chatId !== binding.chatId || raw.runId !== binding.runId || raw.inputDigest !== binding.inputDigest || raw.intentId !== intentId
      || !["current", "queue", "interrupt"].includes(String(raw.deliveryKind)) || !["queued", "dispatching", "applied", "rejected", "uncertain"].includes(String(raw.sourceStatus))
      || typeof raw.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.promptHash) || !id(raw.messageId) || (raw.code !== undefined && typeof raw.code !== "string")
      || !raw.result || typeof raw.result !== "object" || Array.isArray(raw.result)) fail("native_gui_text_receipt_invalid");
    const result = raw.result as Record<string, unknown>;
    if (result.accepted !== true || result.chatId !== binding.chatId || result.activeRunId !== binding.runId || result.queuedRequestId !== `native-owner:${intentId}`
      || result.intentId !== intentId || result.promptHash !== raw.promptHash || typeof result.queued !== "boolean" || typeof result.interruptsCurrent !== "boolean") fail("native_gui_text_receipt_invalid");
    if (expected && (raw.deliveryKind !== expected.kind || raw.promptHash !== createHash("sha256").update(expected.text).digest("hex"))) fail("native_gui_text_receipt_identity_conflict");
    return raw as unknown as NativeOwnerTextReceipt;
  }
  async function ownerText(event: object, binding: NativeOwnerTextBinding, intentId: string, text: string, kind: NativeOwnerTextKind): Promise<NativeOwnerTextReceipt> {
    human(event); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(intentId) || typeof text !== "string" || !text.trim()) fail("invocation_steer_invalid_text");
    if (Buffer.byteLength(text,"utf8") > 200000) fail("invocation_steer_text_too_large");
    const raw = await call("native.attach", {version:"agentlas.native-owner-text.v1",...binding,intentId,deliveryKind:kind,text});
    const result = textReceipt(raw,binding,intentId,{text,kind});if(!result)fail("native_gui_text_receipt_missing");return result;
  }
  async function ownerTextReceipt(event: object, binding: NativeOwnerTextBinding, intentId: string, expected?:{text:string;kind:NativeOwnerTextKind}) {
    human(event);return textReceipt(await call("native.attach",{version:"agentlas.native-owner-text-receipt.v1",...binding,intentId}),binding,intentId,expected);
  }
  function observedTextBinding(event: object, chatId: string): NativeOwnerTextBinding {
    human(event);const matches=[...captures.values()].filter(r=>r.chatId===chatId&&r.nativeCustody==="retained");
    if(matches.length!==1)fail("native_gui_observed_text_parent_required");const r=matches[0],row=getInvocationAdmission(r.runId);
    if(!row||row.chatId!==chatId||row.ownerProcessEpoch!==identity!.bootId)fail("native_gui_original_text_context_required");
    return Object.freeze({chatId,runId:r.runId,inputDigest:row.inputDigest});
  }
  async function recoveredTextBinding(event:object,request:McpInvocationRequest):Promise<NativeOwnerTextBinding>{
    const binding=observedTextBinding(event,request.chatId);
    for(const key of ["images","fileGroupId","oneMemoryUseOnceRef","oneBriefingActionRef","oneTeamPreflightRef","oneAttachmentRef","oneRecurrenceSelection","preflightSubmissionId"] as const)if(request[key]!==undefined)fail("native_gui_text_input_requires_new_preparation");
    if(await call("native.attach",{version:"agentlas.native-owner-text-compatible.v1",...binding,choices:nativeOwnerTextChoices(request)})!==true)fail("native_gui_text_input_context_changed");
    return binding;
  }
  async function ownerTextUnsteer(event: object, binding: NativeOwnerTextBinding, position:number,text:string):Promise<boolean>{human(event);const raw=await call("native.attach",{version:"agentlas.native-owner-text-unsteer.v1",...binding,position,text});if(typeof raw!=="boolean")fail("native_gui_text_unsteer_invalid");return raw;}
  async function recoveryValue(event:object,binding:NativeOwnerTextBinding,method:string,extra:Record<string,unknown>={}){
    human(event);const wire=await call("native.attach",{version:method,...binding,...extra});
    if(!exact(wire,["version","method","chatId","runId","transfer"])||wire.version!=="agentlas.native-recovery-value.v1"||wire.method!==method||wire.chatId!==binding.chatId||wire.runId!==binding.runId)fail("native_gui_recovery_value_invalid");
    const value=await importNativeJsonValue(wire.transfer,{kind:"checkpoint-value",maxBytes:NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes,signal:controller.signal,assertCurrent:()=>{current()},read:(transferId,offset)=>call("native.attach",{version:"agentlas.native-recovery-read.v1",read:{transferId,offset}})});
    const d=wire.transfer as {transferId:unknown;digest:unknown};if(await call("native.attach",{version:"agentlas.native-recovery-ack.v1",ack:{transferId:d.transferId,digest:d.digest}})!==null)fail("native_gui_recovery_ack_invalid");return value;
  }
  const control = Object.freeze({ bind, refresh, accept, cancel, resolveApproval, approvalReceipt, ownerText, ownerTextReceipt, observedTextBinding, recoveredTextBinding, ownerTextUnsteer,
    ownerTextAttach:(event:object,binding:NativeOwnerTextBinding,includeEvents:boolean)=>recoveryValue(event,binding,"agentlas.native-owner-text-attach.v1",{includeEvents}),
    ownerTextRecovery:(event:object,binding:NativeOwnerTextBinding)=>recoveryValue(event,binding,"agentlas.native-owner-text-recovery.v1"),
    hasRun: (runId: string) => captures.has(runId), hasChat: (chatId: string) => [...captures.values()].some(r => r.chatId === chatId && r.nativeCustody === "retained"), hasApproval: (requestId: string) => approvals.has(requestId),
    listApprovals: () => [...approvals.values()].filter(r => r.request && (!r.receipt || r.receipt.pending)).map(r => r.request!),
    retainedChatIds: () => [...new Set([...captures.values()].filter(r => r.nativeCustody === "retained").map(r => r.chatId))],
    activeChatIds: () => [...new Set([...activeRuns].map(runId => captures.get(runId)!.chatId))],
    async receipt(event: object, runId: string) {
      human(event); const r = captures.get(runId); if (!r) fail("native_gui_observed_run_required");
      const wire = await call("invoke.receipt", { chatId: r.chatId, runId });
      if (!exact(wire, ["version", "method", "chatId", "runId", "transfer"]) || wire.version !== "agentlas.native-recovery-value.v1" || wire.method !== "invoke.receipt" || wire.chatId !== r.chatId || wire.runId !== runId) fail("native_gui_recovery_value_invalid");
      const result = await importNativeJsonValue(wire.transfer, { kind: "checkpoint-value", maxBytes: NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes, signal: controller.signal,
        assertCurrent: () => { current(); }, read: (transferId, offset) => call("native.attach", { version: "agentlas.native-recovery-read.v1", read: { transferId, offset } }) });
      if (result !== null && (!result || typeof result !== "object" || Array.isArray(result) || (result as {runId?:unknown}).runId !== runId || (result as {chatId?:unknown}).chatId !== r.chatId)) fail("native_gui_recovery_value_invalid");
      const descriptor = wire.transfer as { transferId?: unknown; digest?: unknown };
      if (await call("native.attach", { version: "agentlas.native-recovery-ack.v1", ack: { transferId: descriptor.transferId, digest: descriptor.digest } }) !== null) fail("native_gui_recovery_ack_invalid");
      return result;
    },
    async currentTurn(event: object, chatId: string) { human(event); await refresh(); for (const runId of activeRuns) if (captures.get(runId)?.chatId === chatId) { const value = await call("invoke.currentTurn", { chatId, runId }); if (value !== null) { if (!exact(value, ["runId"]) || value.runId !== runId) fail("native_gui_current_turn_invalid"); return value; } } return null; },
    observationCounts() { return Object.freeze({ approvals: approvals.size, retainedApprovalBytes, stops: stops.size, captures: captures.size }); },
    get available() { return snapshotKnown && !routeUnavailable && !!channel && nativeGuiChannelIdentity(channel) === identity; },
    async quiesce() { await Promise.all([...approvals.values()].map(r => r.read?.catch(() => {}))); },
  }); return control;
}
export function configuredNativeGuiControls() { return configured; }
