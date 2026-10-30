import { setAttachedDaemonBootId, clearAttachedDaemonBootId } from "./attached-daemon-boot";
import { createHash } from "node:crypto";
import { getInvocationAdmission, getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { getCurrentTurnSteer } from "../store/current-turn-steers";
import { getDb } from "../store/db";
import { nativeOwnerTextChoices } from "./native-owner-text";
import type { NativeOwnerTextBinding, NativeOwnerTextKind, NativeOwnerTextReceipt } from "./native-owner-text";
import type { McpInvocationRequest } from "../../shared/types";
import { BrowserWindow } from "electron";
import type { ToolApprovalDecision, ToolApprovalRequestEvent, ToolApprovalResolutionReceipt } from "../../shared/types";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { importNativeJsonValue } from "../daemon/native-json-transfer";
import { publishNativeGuiApprovalRequested } from "./native-gui-events";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { NATIVE_MAIN_PREPARATION_POLICY, NATIVE_DAEMON_INVOCATION_POLICY, NATIVE_APPROVAL_OBSERVATION_POLICY } from "../daemon/native-invocation-policy";

type Channel = object & { dispatch(method: string, params: unknown): Promise<unknown>; onClose(listener: () => void): () => void };
type Capture = Readonly<{ chatId: string; runId: string; nativeCustody: "released" | "retained" }>;
type Approval = { chatId: string; runId: string; descriptor: unknown; observedDescriptor?: unknown; retainedBytes: number; request?: ToolApprovalRequestEvent; historical?: WeakRef<ToolApprovalRequestEvent>; sourceMode?: "live" | "post-denial"; hydrate?: () => Promise<ToolApprovalRequestEvent>; read?: Promise<void>; readSettled?: boolean; readFailed?: boolean; decision?: { actionId: string; promise: Promise<ToolApprovalResolutionReceipt>; settled?: boolean; known?: boolean }; receipt?: ToolApprovalResolutionReceipt };
/** Main-owned port. This object and its authorizer never cross IPC or Mobile JSON. */
export interface NativeMobileApprovalSelection {
  readonly sourceKey: string;
  request(): ToolApprovalRequestEvent | undefined;
  resolve(context: object, decision: ToolApprovalDecision, actionId: string): Promise<ToolApprovalResolutionReceipt>;
}
export interface NativeMobileApprovalSource {
  list(): ToolApprovalRequestEvent[];
  owns(requestId: string): boolean;
  select(requestId: string): NativeMobileApprovalSelection | undefined;
  subscribe(listener: () => void): () => void;
}
export type NativeMobileApprovalAuthorizer = (context: object, request: ToolApprovalRequestEvent) => void;
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
  let historicalReads: Promise<unknown> = Promise.resolve();
  const liveCount = () => [...approvals.values()].filter(record => record.sourceMode !== "post-denial" && !record.readFailed).length;
  let channel: Channel | undefined, identity: NativeAuthenticatedIdentity | undefined;
  let controller = new AbortController();
  const closedChatSources = new Map<string, { runId: string; epoch: string }>();
  const captureEpochs = new Map<string, string>();
  const captures = new Map<string, Capture>(), activeRuns = new Set<string>(), approvals = new Map<string, Approval>();
  const stops = new Map<string, { promise: Promise<"requested" | "already-requested" | "not-found">; acknowledged: boolean }>();
  let refreshPromise: Promise<void> | undefined, snapshotKnown = false, routeUnavailable = false;
  const approvalListeners = new Set<() => void>();
  const mobilePorts = new WeakMap<NativeMobileApprovalAuthorizer, NativeMobileApprovalSource>();
  function approvalChanged(): void { for (const listener of approvalListeners) { try { listener(); } catch { /* One observer cannot change source custody. */ } } }
  function decodedApproval(record: Approval): ToolApprovalRequestEvent | undefined {
    // Match the peer's successfully observed current descriptor; explicit re-hydration
    // can succeed after the original read failed, so stale read flags are not authority.
    if (record.observedDescriptor !== record.descriptor) return undefined;
    try { current(); return record.request ?? record.historical?.deref(); } catch { return undefined; }
  }
  function availableApproval(record: Approval): ToolApprovalRequestEvent | undefined {
    return record.receipt && !record.receipt.pending ? undefined : decodedApproval(record);
  }
  function current(): Channel { if (!channel || !identity || nativeGuiChannelIdentity(channel) !== identity) fail("native_gui_original_channel_unavailable"); return channel; }
  function human(event: object): void { if (!ports.authorizeRenderer(event)) fail("native_gui_original_renderer_required"); current(); }
  async function call(method: string, params: unknown): Promise<unknown> { const original = current(), captured = identity; const result = await original.dispatch(method, params); if (current() !== original || identity !== captured) fail("native_gui_original_channel_unavailable"); return result; }
  function unavailable(): void { routeUnavailable = true; const original = current(); ports.onUnavailable?.(original, identity!); }
  function pruneApprovals(requiredBytes = 0): void {
    for (const [requestId, record] of approvals) {
      if (liveCount() < observationPolicy.maxRecords && requiredBytes <= observationPolicy.maxRetainedBytes - retainedApprovalBytes) break;
      if (record.readSettled && !record.readFailed && record.receipt?.ok && !record.receipt.pending
        && record.receipt.resolvedDecision !== null && ["resolved", "replayed"].includes(record.receipt.status)
        && (!record.decision || (record.decision.settled && record.decision.known))) { approvals.delete(requestId); retainedApprovalBytes -= record.retainedBytes; }
    }
  }
  function pruneStops(): void {
    for (const [runId, record] of stops) if (record.acknowledged && captures.get(runId)?.nativeCustody === "released") stops.delete(runId);
  }
  /** Rebindable: a new generation replaces a CLOSED one; a live channel is never replaced.
   * Old captures keep their (now unavailable) custody and stay in the start fence until resolved;
   * Stop for them is re-sent over the new channel by chat/run id. Old approvals/stop ACK state
   * cannot be carried over and are dropped. */
  function bind(actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity): void {
    if (nativeGuiChannelIdentity(actualChannel) !== actualIdentity) fail("native_gui_original_channel_required");
    if (channel === actualChannel || (channel && nativeGuiChannelIdentity(channel) !== undefined)) fail("native_gui_original_channel_required");
    if (channel) {
      controller.abort(new NativeGuiControlError("native_gui_original_channel_unavailable"));
      controller = new AbortController();
      approvals.clear(); retainedApprovalBytes = 0;
      for (const [runId, record] of stops) if (!record.acknowledged) stops.delete(runId);
      activeRuns.clear(); refreshPromise = undefined; snapshotKnown = false; routeUnavailable = false;
    }
    channel = actualChannel; identity = actualIdentity; configured = control;
    setAttachedDaemonBootId(actualIdentity.bootId);
    const mine = controller;
    actualChannel.onClose(() => { clearAttachedDaemonBootId(actualIdentity.bootId); mine.abort(new NativeGuiControlError("native_gui_original_channel_unavailable")); approvalChanged(); });
    approvalChanged();
  }
  function resetObservation(actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity): void {
    if (channel !== actualChannel || identity !== actualIdentity || nativeGuiChannelIdentity(actualChannel) !== actualIdentity) fail("native_gui_original_channel_required");
    controller.abort(new NativeGuiControlError("native_gui_observation_replaced"));
    controller = new AbortController(); refreshPromise = undefined; snapshotKnown = false; routeUnavailable = false;
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
        if (!captureEpochs.has(record.runId)) captureEpochs.set(record.runId, originalIdentity!.bootId);
        next.set(record.runId, Object.freeze({ ...record }) as Capture);
      }
      const nextActiveRuns = value.activeRunIds as string[], nextActiveChats = value.activeChatIds as string[];
      if (nextActiveRuns.some(runId => !next.has(runId)) || nextActiveChats.some(chatId => !nextActiveRuns.some(runId => next.get(runId)?.chatId === chatId))) fail("native_gui_recovery_snapshot_invalid");
      // Absence in a bounded later snapshot is not no-execution proof. Keep
      // original retained custody until source explicitly reports released.
      for (const [runId, value] of captures) {
        const epoch = captureEpochs.get(runId);
        if (epoch && closedStoredSource(value.chatId, runId, epoch)) closedChatSources.set(value.chatId, { runId, epoch });
        if (value.nativeCustody === "retained" && activeCustody(value) && !next.has(runId)) next.set(runId, value);
      }
      captures.clear(); for (const [runId, value] of next) captures.set(runId, value);
      for (const runId of captureEpochs.keys()) if (!captures.has(runId)) captureEpochs.delete(runId);
      activeRuns.clear(); for (const runId of value.activeRunIds) activeRuns.add(runId);
      snapshotKnown = true; pruneStops(); ports.onRecoveryChatIds([...value.activeChatIds]);
    })(); refreshPromise = operation;
    void operation.finally(() => { if (refreshPromise === operation) refreshPromise = undefined; }).catch(() => {});
    return operation;
  }
  function approvalReady(value: unknown, sourceMode?: "live" | "post-denial"): void {
    current(); if (!exact(value, ["version", "requestId", "runId", "chatId", "transfer"]) || value.version !== "agentlas.native-approval.v1" || !id(value.requestId) || !id(value.runId) || !id(value.chatId)) fail("native_gui_approval_ready_invalid");
    const previous = approvals.get(value.requestId);
    if (previous && (previous.chatId !== value.chatId || previous.runId !== value.runId)) fail("native_gui_original_approval_required");
    const transfer = value.transfer;
    if (!exact(transfer, ["version", "transferId", "kind", "byteLength", "digest"]) || transfer.version !== "agentlas.native-json.v1"
      || transfer.kind !== "checkpoint-value" || typeof transfer.transferId !== "string" || !/^[a-f0-9-]{36}$/.test(transfer.transferId)
      || typeof transfer.digest !== "string" || !/^[a-f0-9]{64}$/.test(transfer.digest) || !Number.isSafeInteger(transfer.byteLength)
      || Number(transfer.byteLength) < 1 || Number(transfer.byteLength) > NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes) fail("native_gui_approval_descriptor_invalid");
    if (previous && (previous.descriptor as {transferId?:unknown}).transferId === transfer.transferId) return;
    const bytes = Number(transfer.byteLength), retainedBytes = sourceMode === "post-denial" ? 0 : bytes;
    pruneApprovals(retainedBytes - (previous?.retainedBytes ?? 0));
    if ((sourceMode !== "post-denial" && !previous && liveCount() >= observationPolicy.maxRecords) || retainedBytes > observationPolicy.maxRetainedBytes - retainedApprovalBytes + (previous?.retainedBytes ?? 0)) fail("native_gui_approval_capacity_reached");
    const mine = controller;
    const record: Approval = { ...previous, observedDescriptor: undefined, read: undefined, readFailed: undefined, readSettled: undefined, runId: value.runId, chatId: value.chatId, descriptor: transfer, sourceMode, retainedBytes };
    retainedApprovalBytes += retainedBytes - (previous?.retainedBytes ?? 0); approvals.set(value.requestId, record); approvalChanged();
    const hydrate = async () => {
      const raw = await importNativeJsonValue(record.descriptor, { kind: "checkpoint-value", maxBytes: NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes,
        signal: mine.signal, assertCurrent: () => { if (controller !== mine) fail("native_gui_observation_replaced"); current(); }, read: (transferId, offset) => call("native.attach", { version: "agentlas.native-approval-read.v1", read: { requestId: value.requestId, transferId, offset } }) });
      if (controller !== mine || approvals.get(value.requestId as string) !== record) fail("native_gui_observation_replaced"); current();
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > bytes) fail("native_gui_approval_size_invalid");
      const request = card(raw, value.requestId as string, record.chatId);
      if (sourceMode !== undefined && request.mode !== sourceMode) fail("native_gui_approval_mode_invalid");
      if (request.mode === "post-denial") {
        retainedApprovalBytes -= record.retainedBytes; record.retainedBytes = 0;
        record.sourceMode = "post-denial"; record.historical = new WeakRef(request); record.request = undefined;
      } else record.request = request;
      // Only this current descriptor passed import/digest/card and source checks.
      record.observedDescriptor = record.descriptor; approvalChanged();
      return request;
    };
    record.hydrate = hydrate;
    const run = async () => {
      const request = await hydrate();
      if (record.receipt && !record.receipt.pending) return;
      broadcast("runtime:toolApprovalRequest", request);
      // The phone bridge's approval push, too: Main's own onToolApprovalRequested never sees a daemon-hosted card (I-D4).
      if (request.mode === "live") publishNativeGuiApprovalRequested(request);
    };
    // At most one historical transport read is outstanding; fresh live reads
    // bypass that queue. Reset never opens another read behind a held old one.
    const read = sourceMode === "post-denial" ? historicalReads.then(run) : run();
    if (sourceMode === "post-denial") historicalReads = read.catch(() => {});
    record.read = read;
    void read.then(() => { record.readSettled = true; approvalChanged(); }, error => {
      record.readSettled = true; record.readFailed = true; approvalChanged();
      if (approvals.get(value.requestId as string) === record) { retainedApprovalBytes -= record.retainedBytes; record.retainedBytes = 0; }
      console.warn("[native-invocation] approval card unavailable", error);
    });
  }
  function closedStoredSource(chatId: string, runId: string, epoch: string): boolean {
    const a = getInvocationAdmission(runId);
    if (!a || a.runId !== runId || a.chatId !== chatId || a.ownerProcessEpoch !== epoch) return false;
    const owner = invocationRunOwners.getRunOwner(chatId, runId);
    if (owner && (owner.chatId !== chatId || owner.runId !== runId || owner.state !== "released" || owner.ownerKind !== "daemon" || owner.ownerId !== epoch)) return false;
    if (a.status === "admitted") return !!owner;
    return a.status === "rejected" && !!a.rejectionReasonCode
      && !getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(runId);
  }
  function activeCustody(r: Capture): boolean {
    if (r.nativeCustody !== "retained") return false;
    const epoch = captureEpochs.get(r.runId);
    return !epoch || !closedStoredSource(r.chatId, r.runId, epoch);
  }
  function closedChatIds(): string[] {
    const result = new Set([...captures.values()].filter(r => !activeCustody(r)).map(r => r.chatId));
    for (const [chatId, old] of closedChatSources) {
      if (closedStoredSource(chatId, old.runId, old.epoch)) result.add(chatId);
      else closedChatSources.delete(chatId);
    }
    return [...result];
  }
  function accept(method: string, value: unknown, fromIdentity?: NativeAuthenticatedIdentity, sourceMode?: "live" | "post-denial"): void {
    if (fromIdentity !== undefined && fromIdentity !== identity) return; // event from a previous generation
    if (method === "invocation.approval.unavailable") {
      try { const original = current(); if (!exact(value, ["version", "code"]) || value.version !== "agentlas.native-approval.v1" || typeof value.code !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(value.code)) fail("native_gui_approval_unavailable_invalid"); ports.onUnavailable?.(original, identity!); } catch (error) { console.warn("[native-invocation] approval stream unavailable", error); try { unavailable(); } catch { /* No current channel can restore readiness. */ } }
    }
    if (method === "invocation.approval.ready") { try { approvalReady(value, sourceMode); } catch (error) { console.warn("[native-invocation] approval card unavailable", error); /* Per-card uncertainty is not a future-input gate. */ } }
    if (method === "invocation.approval.resolved") {
      try { current(); if (!exact(value, ["version", "requestId", "receipt"]) || value.version !== "agentlas.native-approval.v1" || !id(value.requestId)) fail("native_gui_approval_receipt_invalid");
        const record = approvals.get(value.requestId); if (!record) fail("native_gui_original_approval_required");
        record.receipt = receipt(value.receipt, value.requestId); broadcast("runtime:toolApprovalResolution", record.receipt); approvalChanged();
      } catch (error) { console.warn("[native-invocation] approval resolution unavailable", error); /* Original per-card receipt uncertainty is not start authority. */ }
    }
  }
  async function approvalReceipt(event: object, requestId: string): Promise<ToolApprovalResolutionReceipt> {
    human(event); const record = approvals.get(requestId); if (!record) fail("native_gui_original_approval_required");
    const value = receipt(await call("native.attach", { version: "agentlas.native-approval-receipt.v1", requestId }), requestId);
    record.receipt = value; return value;
  }
  function resolveApproval(event: object, requestId: string, value: ToolApprovalDecision, actionId: string): Promise<ToolApprovalResolutionReceipt> {
    human(event); const record = approvals.get(requestId); if (!record) fail("native_gui_original_approval_required");
    if (!record.request && !record.historical?.deref()) {
      if (record.sourceMode !== "post-denial" || !record.hydrate) fail("native_gui_original_approval_required");
      return record.hydrate().then(request => { const actual = resolveApproval(event, requestId, value, actionId); void request; return actual; }, () => fail("native_gui_original_approval_observation_unavailable"));
    }
    return resolveCapturedApproval(record, requestId, value, actionId);
  }
  function resolveCapturedApproval(record: Approval, requestId: string, value: ToolApprovalDecision, actionId: string): Promise<ToolApprovalResolutionReceipt> {
    if (!decision(value) || actionId !== toolApprovalActionId(requestId, value)) fail("native_gui_approval_action_invalid");
    if (record.decision) { if (record.decision.actionId !== actionId) fail("native_gui_approval_action_conflict"); return record.decision.promise; }
    let resolve!: (value: ToolApprovalResolutionReceipt) => void, reject!: (error: unknown) => void;
    const pending = new Promise<ToolApprovalResolutionReceipt>((yes, no) => { resolve = yes; reject = no; });
    record.decision = { actionId, promise: pending }; // BEFORE actual signed dispatch/reentry.
    try {
      void call("native.approvalReply", { version: "agentlas.native-approval-reply.v1", requestId, decision: value, actionId }).then(raw => {
        try { const result = receipt(raw, requestId); if (result.requestedDecision !== value || (result.ok && result.actionId !== actionId)) fail("native_gui_approval_receipt_invalid"); record.receipt = result; record.decision!.known = true; approvalChanged(); resolve(result); } catch (error) { reject(error); }
      }, reject);
    } catch (error) { reject(error); }
    void pending.finally(() => { record.decision!.settled = true; }).catch(() => {}); return pending;
  }
  function mobileApprovalPort(authorize: NativeMobileApprovalAuthorizer): NativeMobileApprovalSource {
    const existing = mobilePorts.get(authorize); if (existing) return existing;
    const selections = new WeakMap<Approval, NativeMobileApprovalSelection>();
    const source: NativeMobileApprovalSource = Object.freeze({
      list: () => [...approvals.values()].flatMap(record => { const request = availableApproval(record); return request ? [request] : []; }),
      owns: (requestId: string) => approvals.has(requestId),
      select(requestId: string) {
        const record = approvals.get(requestId); if (!record) return undefined;
        const originalIdentity = identity;
        const prior = selections.get(record);
        if (!decodedApproval(record)) return undefined;
        // The native source supplies run/chat/attachment. Public labels cannot mint it.
        // Do not close over a materialized historical card; weak source observation stays weak.
        const sourceKeyNow = () => createHash("sha256").update(JSON.stringify([originalIdentity?.bootId, record.chatId, record.runId, decodedApproval(record)])).digest("hex");
        const sourceKey = sourceKeyNow();
        if (prior) { if (prior.sourceKey !== sourceKey) fail("native_mobile_approval_source_changed"); return prior; }
        const selection: NativeMobileApprovalSelection = Object.freeze({ sourceKey,
          request: () => approvals.get(requestId) === record && identity === originalIdentity ? decodedApproval(record) : undefined,
          resolve(context: object, value: ToolApprovalDecision, actionId: string) {
            current();
            if (approvals.get(requestId) !== record || identity !== originalIdentity) fail("native_mobile_approval_source_changed");
            const original = decodedApproval(record);
            if (!original) fail("native_mobile_approval_unavailable");
            if (sourceKeyNow() !== sourceKey) fail("native_mobile_approval_source_changed");
            if (original.mode !== "live") fail("native_mobile_approval_not_live");
            authorize(context, original);
            // Authorization is synchronous, reentrant host callbacks still cannot swap source custody.
            current(); if (approvals.get(requestId) !== record || identity !== originalIdentity || decodedApproval(record) !== original || sourceKeyNow() !== sourceKey) fail("native_mobile_approval_source_changed");
            return resolveCapturedApproval(record, requestId, value, actionId);
          },
        }); selections.set(record, selection); return selection;
      },
      subscribe(listener: () => void) { approvalListeners.add(listener); return () => { approvalListeners.delete(listener); }; },
    }); mobilePorts.set(authorize, source); return source;
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
  /** The window's answer to a daemon-hosted run's API-key request (I-D2): true when the service settled that exact request. */
  async function runKeyOutcome(chatId: string, runId: string, request: Readonly<{ requestId: string; expiresAt: number }>, outcome: "declined" | "provided"): Promise<boolean> {
    if (!id(chatId) || !id(runId) || (outcome !== "declined" && outcome !== "provided")) fail("native_gui_run_key_outcome_invalid");
    const raw = await call("invoke.runKeyOutcome", { version: "agentlas.native-run-key-outcome.v1", chatId, runId, requestId: request.requestId, expiresAt: request.expiresAt, outcome });
    if (!exact(raw, ["version", "chatId", "runId", "settled"]) || raw.version !== "agentlas.native-run-key-outcome.v1" || raw.chatId !== chatId || raw.runId !== runId
      || typeof raw.settled !== "boolean") fail("native_gui_run_key_outcome_invalid");
    return raw.settled;
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
  async function followupCustodyVersion(event: object, chatId: string, intentId: string, requestHash: string): Promise<{currentTurnCompatible:boolean}|null> {
    human(event);
    const raw = await call("native.attach",{version:"agentlas.followup-custody.v2",chatId,intentId,requestHash});
    return exact(raw,["version","bootId","chatId","intentId","requestHash","currentTurnCompatible"]) && raw.version === "agentlas.followup-custody.v2"
      && raw.bootId === identity!.bootId && raw.chatId === chatId && raw.intentId === intentId && raw.requestHash === requestHash
      && typeof raw.currentTurnCompatible === "boolean" ? {currentTurnCompatible:raw.currentTurnCompatible} : null;
  }
  async function ownerTextReceipt(event: object, binding: NativeOwnerTextBinding, intentId: string, expected?:{text:string;kind:NativeOwnerTextKind}) {
    human(event);return textReceipt(await call("native.attach",{version:"agentlas.native-owner-text-receipt.v1",...binding,intentId}),binding,intentId,expected);
  }
  function observedTextBinding(event: object, chatId: string): NativeOwnerTextBinding {
    human(event);const matches=[...captures.values()].filter(r=>r.chatId===chatId&&activeCustody(r));
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
  /* Single-execution-host stage 1: the chat's ACTIVE run is found by the durable run-owner row, not by a capture this
   * process happens to hold. A run the attached daemon owns (supervisor reply, goal-free One turn, daemon Work turn)
   * has an admission row (input digest) in the shared store, so the binding has exactly the shape a GUI capture has;
   * the daemon still verifies chat + run + input digest against its own source before it accepts any text. */
  function daemonOwnedRun(chatId: string, opts: { expectedRunId?: string; intentId?: string; isCaptured?(runId: string): boolean }): { chatId: string; runId: string } | null {
    const row = invocationRunOwners.getActiveOwner(chatId);
    if (!row || row.chatId !== chatId || row.ownerKind !== "daemon" || !identity || row.ownerId !== identity.bootId) return null;
    if (opts.isCaptured?.(row.runId)) return null; // started by this GUI: the capture path is unchanged
    if (opts.intentId !== undefined) { const saved = getCurrentTurnSteer(chatId, opts.intentId); if (saved && saved.runId !== row.runId) return null; }
    if (opts.expectedRunId !== undefined && opts.expectedRunId !== row.runId) fail("invocation_steer_stale_run");
    if (row.state !== "active") fail("native_gui_daemon_run_not_active");
    return { chatId, runId: row.runId };
  }
  function durableDaemonTextBinding(event: object, chatId: string, opts: { expectedRunId?: string; intentId?: string; isCaptured?(runId: string): boolean } = {}): NativeOwnerTextBinding | null {
    const run = daemonOwnedRun(chatId, opts); if (!run) return null;
    human(event);
    const row = getInvocationAdmission(run.runId);
    if (!row || row.chatId !== chatId || row.ownerProcessEpoch !== identity!.bootId) fail("native_gui_original_text_context_required");
    return Object.freeze({ chatId, runId: run.runId, inputDigest: row.inputDigest });
  }
  function supervisorStarted(runId: string): boolean {
    try { return !!getDb().prepare("SELECT 1 FROM one_supervisor_requests WHERE run_id = ?").get(runId); } catch { return false; }
  }
  /** Same rules as recoveredTextBinding. A supervisor-started run has no GUI request shape to compare (its own start is
   * system-originated), so only the reference/capability keys are refused there; the text still needs the exact binding. */
  async function durableDaemonTextBindingForRequest(event: object, request: McpInvocationRequest, opts: { isCaptured?(runId: string): boolean } = {}): Promise<NativeOwnerTextBinding | null> {
    const binding = durableDaemonTextBinding(event, request.chatId, opts); if (!binding) return null;
    for (const key of ["images","fileGroupId","oneMemoryUseOnceRef","oneBriefingActionRef","oneTeamPreflightRef","oneAttachmentRef","oneRecurrenceSelection","preflightSubmissionId"] as const) if (request[key] !== undefined) fail("native_gui_text_input_requires_new_preparation");
    if (supervisorStarted(binding.runId)) return binding;
    if (await call("native.attach", { version: "agentlas.native-owner-text-compatible.v1", ...binding, choices: nativeOwnerTextChoices(request) }) !== true) fail("native_gui_text_input_context_changed");
    return binding;
  }
  async function durableCurrentTurn(event: object, binding: NativeOwnerTextBinding) {
    human(event);
    const value = await call("invoke.currentTurn", { chatId: binding.chatId, runId: binding.runId });
    if (value === null) return null;
    if (!exact(value, ["runId"]) || value.runId !== binding.runId) fail("native_gui_current_turn_invalid");
    return value;
  }
  /** Receipt by run id for a run whose active owner row names the attached daemon (no capture needed). */
  function durableDaemonRunForReceipt(runId: string, isCaptured?: (runId: string) => boolean): { chatId: string; runId: string } | null {
    const row = invocationRunOwners.getOwnerByRunId(runId);
    if (!row || row.ownerKind !== "daemon" || !identity || row.ownerId !== identity.bootId || row.state === "released" || captures.has(runId) || isCaptured?.(runId)) return null;
    return { chatId: row.chatId, runId };
  }
  async function receiptFor(chatId: string, runId: string) {
    const wire = await call("invoke.receipt", { chatId, runId });
    if (!exact(wire, ["version", "method", "chatId", "runId", "transfer"]) || wire.version !== "agentlas.native-recovery-value.v1" || wire.method !== "invoke.receipt" || wire.chatId !== chatId || wire.runId !== runId) fail("native_gui_recovery_value_invalid");
    const result = await importNativeJsonValue(wire.transfer, { kind: "checkpoint-value", maxBytes: NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes, signal: controller.signal,
      assertCurrent: () => { current(); }, read: (transferId, offset) => call("native.attach", { version: "agentlas.native-recovery-read.v1", read: { transferId, offset } }) });
    if (result !== null && (!result || typeof result !== "object" || Array.isArray(result) || (result as {runId?:unknown}).runId !== runId || (result as {chatId?:unknown}).chatId !== chatId)) fail("native_gui_recovery_value_invalid");
    const descriptor = wire.transfer as { transferId?: unknown; digest?: unknown };
    if (await call("native.attach", { version: "agentlas.native-recovery-ack.v1", ack: { transferId: descriptor.transferId, digest: descriptor.digest } }) !== null) fail("native_gui_recovery_ack_invalid");
    return result;
  }
  async function durableReceipt(event: object, runId: string, isCaptured?: (runId: string) => boolean) {
    const run = durableDaemonRunForReceipt(runId, isCaptured); if (!run) return { routed: false as const };
    human(event); return { routed: true as const, value: await receiptFor(run.chatId, run.runId) };
  }
  async function ownerTextUnsteer(event: object, binding: NativeOwnerTextBinding, position:number,text:string):Promise<boolean>{human(event);const raw=await call("native.attach",{version:"agentlas.native-owner-text-unsteer.v1",...binding,position,text});if(typeof raw!=="boolean")fail("native_gui_text_unsteer_invalid");return raw;}
  async function recoveryValue(event:object,binding:NativeOwnerTextBinding,method:string,extra:Record<string,unknown>={}){
    human(event);const wire=await call("native.attach",{version:method,...binding,...extra});
    if(!exact(wire,["version","method","chatId","runId","transfer"])||wire.version!=="agentlas.native-recovery-value.v1"||wire.method!==method||wire.chatId!==binding.chatId||wire.runId!==binding.runId)fail("native_gui_recovery_value_invalid");
    const value=await importNativeJsonValue(wire.transfer,{kind:"checkpoint-value",maxBytes:NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes,signal:controller.signal,assertCurrent:()=>{current()},read:(transferId,offset)=>call("native.attach",{version:"agentlas.native-recovery-read.v1",read:{transferId,offset}})});
    const d=wire.transfer as {transferId:unknown;digest:unknown};if(await call("native.attach",{version:"agentlas.native-recovery-ack.v1",ack:{transferId:d.transferId,digest:d.digest}})!==null)fail("native_gui_recovery_ack_invalid");return value;
  }
  const control = Object.freeze({ bind, resetObservation, refresh, accept, cancel, runKeyOutcome, resolveApproval, approvalReceipt, mobileApprovalPort, ownerText, ownerTextReceipt, followupCustodyVersion, observedTextBinding, recoveredTextBinding, ownerTextUnsteer, durableDaemonTextBinding, durableDaemonTextBindingForRequest, durableCurrentTurn, durableReceipt,
    ownerTextAttach:(event:object,binding:NativeOwnerTextBinding,includeEvents:boolean)=>recoveryValue(event,binding,"agentlas.native-owner-text-attach.v1",{includeEvents}),
    ownerTextRecovery:(event:object,binding:NativeOwnerTextBinding)=>recoveryValue(event,binding,"agentlas.native-owner-text-recovery.v1"),
    hasRun: (runId: string) => captures.has(runId), hasChat: (chatId: string) => [...captures.values()].some(r => r.chatId === chatId && activeCustody(r)), hasApproval: (requestId: string) => approvals.has(requestId),
    listApprovals: () => [...approvals.values()].filter(r => !r.receipt || r.receipt.pending).map(r => {
      const request = r.request ?? r.historical?.deref(); if (!request) fail("native_gui_original_approval_observation_unavailable"); return request;
    }),
    /** UI recovery returns existing successfully observed originals, including
     * materialized historical consent. Unknown per-card reads remain uncertain
     * in the strict API and never hold unrelated available originals. */
    listAvailableApprovals: () => [...approvals.values()].flatMap(record => {
      if ((record.receipt && !record.receipt.pending) || record.observedDescriptor !== record.descriptor) return [];
      const request = record.request ?? record.historical?.deref();
      return request ? [request] : [];
    }),
    async listApprovalsHydrated() {
      const result: ToolApprovalRequestEvent[] = [];
      for (const record of approvals.values()) if (!record.receipt || record.receipt.pending) {
        let request = record.request ?? record.historical?.deref();
        if (!request) {
          if (record.read && !record.readSettled) await record.read.catch(() => {});
          try { request = record.request ?? record.historical?.deref() ?? await record.hydrate?.(); }
          catch { fail("native_gui_original_approval_observation_unavailable"); }
        }
        if (!request) fail("native_gui_original_approval_observation_unavailable"); result.push(request);
      }
      return result;
    },
    retainedChatIds: () => [...new Set([...captures.values()].filter(r => r.nativeCustody === "retained").map(r => r.chatId))],
    closedAuthorityChatIds: closedChatIds,
    hasOpenStoredAuthority: (chatId: string) => !!invocationRunOwners.getActiveOwner(chatId) || !!getPendingInvocationAdmissionForChat(chatId),
    activeAuthorityChatIds: () => [...new Set([...captures.values()].filter(activeCustody).map(r => r.chatId))],
    activeChatIds: () => [...new Set([...activeRuns].map(runId => captures.get(runId)!).filter(r => r && activeCustody(r)).map(r => r.chatId))],
    async receipt(event: object, runId: string) {
      human(event); const r = captures.get(runId); if (!r) fail("native_gui_observed_run_required");
      return receiptFor(r.chatId, runId);
    },
    async currentTurn(event: object, chatId: string) { human(event); await refresh(); for (const runId of activeRuns) if (captures.get(runId)?.chatId === chatId) { const value = await call("invoke.currentTurn", { chatId, runId }); if (value !== null) { if (!exact(value, ["runId"]) || value.runId !== runId) fail("native_gui_current_turn_invalid"); return value; } } return null; },
    observationCounts() { return Object.freeze({ approvals: approvals.size, liveApprovals: liveCount(), historicalApprovals: [...approvals.values()].filter(r => r.sourceMode === "post-denial").length, retainedApprovalBytes, stops: stops.size, captures: captures.size }); },
    get available() { return snapshotKnown && !routeUnavailable && !!channel && nativeGuiChannelIdentity(channel) === identity; },
    async quiesce() { await Promise.all([...approvals.values()].map(r => r.read?.catch(() => {}))); },
  }); return control;
}
export function configuredNativeGuiControls() { return configured; }
