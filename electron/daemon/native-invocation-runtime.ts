import { createDaemonOneSupervisorHost } from "./one-supervisor-host";
import { ALIVE_DECISION_PROTOCOL, createDaemonAliveDecisionPort } from "./alive-decision-port";
import { getDb } from "../store/db";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { withAgentContext } from "../runtime/agent-context";
import { detectRuntimes } from "../runtime/detect";
import { pickRunner } from "../runtime/selection";
import { runAliveServingDecision } from "../alive-organisms/serving-wake";
import { ONE_SUPERVISOR_RUNTIME_PROTOCOL } from "../../shared/one-supervisor-runtime";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { randomUUID } from "node:crypto";
import { createNativeJsonTransfers, type NativeJsonTransferDescriptor } from "./native-json-transfer";
import { NATIVE_PUBLIC_EVENT_POLICY, NATIVE_APPROVAL_OBSERVATION_POLICY } from "./native-invocation-policy";
import type { HostSessionHandoff } from "../auth";
import type { InvocationService } from "../invocation/service";
import type { ControlSocketPeer } from "./control-socket";
import { assertNativeAuthBinding, type NativeAuthBinding, type NativeCredential } from "./native-auth-credentials";
import { startNativeAuthChannel } from "./native-auth-channel";
import { createDaemonNativeInvocationHost } from "./native-invocation-host";
import { nativeStartDescriptor, type NativeStartDescriptor } from "./native-start-protocol";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { createNativeInvocationPublicPublisher, nativePublicAttachmentOperation } from "../invocation/native-public-events";
import { createNativeInvocationApprovalChannel } from "./native-invocation-approvals";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { getCurrentTurnSteer } from "../store/current-turn-steers";
import type { NativeInvocationResources } from "./native-invocation-config";

export interface NativeInvocationCapabilities { start: boolean; stop: boolean; events: boolean; approvals: boolean; recovery: boolean }
export interface NativeInvocationAttachReply { version: "agentlas.native-attach.v1"; bootId: string; serviceIdentity: string; ready: boolean; capabilities: NativeInvocationCapabilities }
export interface NativeInvocationRuntimeOptions {
  address: string; binding: NativeAuthBinding; credential: NativeCredential; bootId: string;
  service: InvocationService; assertOwner(): void; resources: NativeInvocationResources;
  adoptSession(session: HostSessionHandoff | null): boolean;
  clearDetectCache(): void;
  science?:Pick<import("../science-host/daemon-client").ScienceDaemonClient,"commandObserved">;
}
// Main's recoveryValue() accepts exactly {version,method,chatId,runId,transfer}. The owner-text binding
// also carries inputDigest (a daemon-side auth input); it must never ride on this wire reply.
export function nativeRecoveryValueWire(method: string, value: { chatId: string; runId: string }, transfer: NativeJsonTransferDescriptor) {
  return { version: "agentlas.native-recovery-value.v1" as const, method, chatId: value.chatId, runId: value.runId, transfer };
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const own = Object.keys(value); return own.length === keys.length && own.every(key => keys.includes(key));
}
function session(value: unknown): HostSessionHandoff | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("native_invocation_session_invalid");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["cookieValue", "userId", "workspaceId", "expiresAt"].includes(key))
    || typeof v.cookieValue !== "string" || !v.cookieValue || v.cookieValue.length > 16384 || /[\s;]/.test(v.cookieValue)
    || ["userId", "workspaceId"].some(key => v[key] !== undefined && (typeof v[key] !== "string" || (v[key] as string).length > 16384))
    || (v.expiresAt !== undefined && (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)))) return fail("native_invocation_session_invalid");
  return { cookieValue: v.cookieValue, ...(v.userId !== undefined ? { userId: v.userId as string } : {}),
    ...(v.workspaceId !== undefined ? { workspaceId: v.workspaceId as string } : {}), ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt as number } : {}) };
}
export async function createNativeInvocationRuntime(options: NativeInvocationRuntimeOptions) {
  assertNativeAuthBinding(options.binding); options.assertOwner();
  let accepting = true;
  const supervisor=createDaemonOneSupervisorHost({bootId:options.bootId,assertOwner:options.assertOwner,science:options.science});
  // Created after the original GUI session is adopted; an unauthenticated
  // startup snapshot cannot bind a later account's context lifetime.
  let alive:ReturnType<typeof createDaemonAliveDecisionPort>|undefined;
  let aliveOwnerBinding:string|undefined;
  const alivePort=()=>{
    const binding=JSON.stringify(agentContextOwnerBinding());
    if(aliveOwnerBinding!==binding){alive?.close();alive=undefined;aliveOwnerBinding=binding;}
    return alive??(alive=createDaemonAliveDecisionPort({db:getDb(),bootId:options.bootId,
    assertOwner:options.assertOwner,ownerBinding:agentContextOwnerBinding,now:Date.now,
    async resolveRuntime(choice){
      const status=(await detectRuntimes()).find(value=>value.kind===choice.kind
        && (value.backend??null)===choice.backend && (value.source??null)===choice.source);
      if(!status)return null;
      const selected={...status,model:choice.model};
      const picked=selected.kind==="agentlas"?{runner:withAgentContext(runAliveServingDecision,{kind:"agentlas"}),label:"Agentlas"}:pickRunner(selected);
      return picked?{...picked,status:selected}:null;
    },
  }));
  };
  let host: ReturnType<typeof createDaemonNativeInvocationHost> | undefined;
  type Captured = { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; released: boolean };
  type Attached = { identity: NativeAuthenticatedIdentity; publisher: ReturnType<typeof createNativeInvocationPublicPublisher>;
    approvals: ReturnType<typeof createNativeInvocationApprovalChannel>;
    recovery: ReturnType<typeof createNativeJsonTransfers>;
    recoveryRecords: Map<string, { descriptor: NativeJsonTransferDescriptor; complete: boolean }> };
  const attached = new Map<ControlSocketPeer, Attached>();
  const owned = new Map<string, Captured>(), known = new Map<string, Captured>();
  let server!: Awaited<ReturnType<typeof startNativeAuthChannel>>;
  const current = (peer: ControlSocketPeer) => {
    options.assertOwner(); const identity = server.authenticatedPeerIdentity(peer), record = attached.get(peer);
    if (!identity || !record || record.identity !== identity || identity.bootId !== options.bootId) fail("native_invocation_attachment_required");
    return record;
  };
  const capture = (chatId: unknown, runId: unknown): NativeStartDescriptor["binding"] => {
    if (typeof chatId !== "string" || typeof runId !== "string") fail("native_invocation_control_binding_changed");
    const record = known.get(runId as string);
    if (record?.start.binding.chatId === chatId) return record.start.binding;
    const binding=supervisor.runBinding(String(chatId),String(runId));
    if(!binding)fail("native_invocation_control_binding_changed");
    return binding!;
  };
  const observationAvailable = () => [...attached.values()].every(r => r.publisher.available && r.approvals.available);
  const capabilities = (): NativeInvocationCapabilities => ({ start: !!host && accepting && observationAvailable(), stop: !!host,
    events: !!host && [...attached.values()].every(r => r.publisher.available),
    approvals: !!host && [...attached.values()].every(r => r.approvals.available), recovery: !!host });
  const status = (): NativeInvocationAttachReply => {
    const value = capabilities(); return { version: "agentlas.native-attach.v1", bootId: options.bootId,
      serviceIdentity: options.binding.serviceIdentity, ready: Object.values(value).every(Boolean), capabilities: value };
  };
  function disposeAttachment(peer: ControlSocketPeer) { const record = attached.get(peer); if (!record) return;
    attached.delete(peer); record.publisher.dispose(); record.approvals.dispose(); for (const value of record.recoveryRecords.values()) record.recovery.release(value); record.recoveryRecords.clear(); }
  async function dispatch(method: string, params: unknown, peer: ControlSocketPeer): Promise<unknown> {
    options.assertOwner();
    if (method === "native.attach") {
      if(params && typeof params==="object" && (params as {version?:unknown}).version===ALIVE_DECISION_PROTOCOL){
        const attachment=current(peer),identity=attachment.identity;
        return alivePort().dispatch(params,{identity,
          assertCurrent(){if(current(peer).identity!==identity)fail("alive_decision_native_peer_changed");},
          onClose:listener=>peer.onClose(listener)});
      }
      if(params && typeof params==='object' && (params as {version?:unknown}).version===ONE_SUPERVISOR_RUNTIME_PROTOCOL) {
        const attachment=current(peer);
        const observed=await supervisor.dispatch(params);options.assertOwner();current(peer);
        const snapshot={descriptor:undefined as unknown as NativeJsonTransferDescriptor,complete:false};
        const slot=randomUUID();attachment.recoveryRecords.set(slot,snapshot);
        try{snapshot.descriptor=attachment.recovery.issue(snapshot,'checkpoint-value',observed ?? null,NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes);}
        catch(error){attachment.recoveryRecords.delete(slot);throw error;}
        attachment.recoveryRecords.delete(slot);attachment.recoveryRecords.set(snapshot.descriptor.transferId,snapshot);
        return {version:ONE_SUPERVISOR_RUNTIME_PROTOCOL,bootId:options.bootId,transfer:snapshot.descriptor};
      }
      if (params && typeof params === "object" && "version" in params && typeof (params as {version:unknown}).version === "string"
        && (params as {version:string}).version.startsWith("agentlas.native-owner-text")) {
        const attachment = current(peer), wire = params as Record<string,unknown>;
        const record = capture(wire.chatId,wire.runId), binding = record;
        if (wire.inputDigest !== binding.inputDigest) fail("native_owner_text_binding_changed");
        const value = {chatId:binding.chatId,runId:binding.runId,inputDigest:binding.inputDigest};
        if (wire.version === "agentlas.native-owner-text-compatible.v1" && exact(wire,["version","chatId","runId","inputDigest","choices"])) {
          return options.service.nativeOwnerTextCompatible(value,wire.choices);
        }
        if (wire.version === "agentlas.native-owner-text.v1" && exact(wire,["version","chatId","runId","inputDigest","intentId","deliveryKind","text"])) {
          if (typeof wire.intentId !== "string" || typeof wire.text !== "string" || !["current","queue","interrupt"].includes(String(wire.deliveryKind))) fail("native_owner_text_invalid");
          return options.service.nativeOwnerText({...value,intentId:wire.intentId,text:wire.text,deliveryKind:wire.deliveryKind as "current"|"queue"|"interrupt"});
        }
        if (wire.version === "agentlas.native-owner-text-receipt.v1" && exact(wire,["version","chatId","runId","inputDigest","intentId"]) && typeof wire.intentId === "string") {
          return options.service.nativeOwnerTextReceipt(value,wire.intentId);
        }
        if (wire.version === "agentlas.native-owner-text-unsteer.v1" && exact(wire,["version","chatId","runId","inputDigest","position","text"]) && typeof wire.text === "string" && Number.isSafeInteger(wire.position)) {
          return options.service.nativeOwnerTextUnsteer(value,Number(wire.position),wire.text);
        }
        let observed: unknown;
        if (wire.version === "agentlas.native-owner-text-attach.v1" && exact(wire,["version","chatId","runId","inputDigest","includeEvents"]) && typeof wire.includeEvents === "boolean") {
          observed = options.service.nativeOwnerTextAttach(value,wire.includeEvents);
        } else if (wire.version === "agentlas.native-owner-text-recovery.v1" && exact(wire,["version","chatId","runId","inputDigest"])) {
          observed = options.service.nativeOwnerTextRecovery(value);
        } else fail("native_owner_text_invalid");
        const snapshot = {descriptor:undefined as unknown as NativeJsonTransferDescriptor,complete:false}, slot = randomUUID();
        attachment.recoveryRecords.set(slot,snapshot);
        try { snapshot.descriptor = attachment.recovery.issue(snapshot,"checkpoint-value",observed,NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes); }
        catch (error) {attachment.recoveryRecords.delete(slot);throw error;}
        attachment.recoveryRecords.delete(slot);attachment.recoveryRecords.set(snapshot.descriptor.transferId,snapshot);
        return nativeRecoveryValueWire(wire.version,value,snapshot.descriptor);
      }

      if (exact(params, ["version", "read"]) && params.version === "agentlas.native-recovery-read.v1") {
        const record = current(peer), input = params.read;
        if (!exact(input, ["transferId", "offset"]) || typeof input.transferId !== "string" || !Number.isSafeInteger(input.offset)) fail("native_recovery_read_invalid");
        const retained = record.recoveryRecords.get(input.transferId); if (!retained) fail("native_recovery_snapshot_required");
        const chunk = record.recovery.read(retained, input.transferId, Number(input.offset));
        if (chunk.done) retained.complete = true; return chunk;
      }
      if (exact(params, ["version", "ack"]) && params.version === "agentlas.native-recovery-ack.v1") {
        const record = current(peer), input = params.ack;
        if (!exact(input, ["transferId", "digest"]) || typeof input.transferId !== "string" || typeof input.digest !== "string") fail("native_recovery_ack_invalid");
        const retained = record.recoveryRecords.get(input.transferId);
        if (!retained?.complete || retained.descriptor.digest !== input.digest) fail("native_recovery_snapshot_required");
        // Each readonly snapshot has one private owner, so ACK retires only it.
        record.recovery.release(retained); record.recoveryRecords.delete(input.transferId); return null;
      }
      const operation = nativePublicAttachmentOperation(params);
      if (operation) { const record = current(peer); if (operation.version === "agentlas.native-public-read.v1") return record.publisher.read(record.identity, operation.read);
        record.publisher.ack(record.identity, operation.ack); return null; }
      if (exact(params, ["version", "read"]) && params.version === "agentlas.native-approval-read.v1") {
        const record = current(peer); return record.approvals.read(record.identity, params.read); }
      if (exact(params, ["version", "requestId"]) && params.version === "agentlas.native-approval-receipt.v1" && typeof params.requestId === "string") {
        const record = current(peer); return record.approvals.receipt(record.identity, params.requestId); }
      if (exact(params, ["version"]) && params.version === "agentlas.native-recovery.v1") {
        current(peer);
        const captures=[...known.values()].map(r=>({chatId:r.start.binding.chatId,runId:r.start.binding.runId,nativeCustody:r.released?'released':'retained'}));
        for(const value of supervisor.captures())if(!captures.some(row=>row.runId===value.runId))captures.push(value);
        const activeRunIds=options.service.activeRunIds().filter(runId=>captures.some(row=>row.runId===runId));
        return { version: "agentlas.native-recovery.v1", bootId: options.bootId,
          activeRunIds, activeChatIds: [...new Set(captures.filter(row=>activeRunIds.includes(row.runId)).map(row=>row.chatId))],captures };
      }
      const identity = server.authenticatedPeerIdentity(peer);
      if (!identity || identity.bootId !== options.bootId || identity.serviceIdentity !== options.binding.serviceIdentity) fail("native_invocation_attachment_required");
      if (!accepting) fail("daemon_shutting_down");
      if (!exact(params, ["version", "session"]) || params.version !== "agentlas.native-attach.v1") fail("native_invocation_attach_invalid");
      options.adoptSession(session(params.session)); options.clearDetectCache(); options.assertOwner();
      try{await supervisor.recover();}catch(error){console.warn("[one-supervisor] domain recovery held",(error as Error).message);}
      if (server.authenticatedPeerIdentity(peer) !== identity) fail("native_invocation_channel_changed");
      if (!attached.has(peer)) {
        const getIdentity = () => server.authenticatedPeerIdentity(peer) ?? null;
        const acceptsRun = (runId: string, chatId: string) => known.get(runId)?.start.binding.chatId === chatId || !!supervisor.runBinding(chatId,runId);
        const publisher = createNativeInvocationPublicPublisher({ service: options.service, identity, getIdentity,
          notify: (method, value) => peer.notify(method, value), acceptsRun,
          acceptsChat: chatId => [...known.values()].some(r => r.start.binding.chatId === chatId) || supervisor.captures().some(r=>r.chatId===chatId),
          ...NATIVE_PUBLIC_EVENT_POLICY,
          onFault: error => console.warn("[native-invocation] public stream unavailable", error.code) });
        const approvals = createNativeInvocationApprovalChannel({ identity, getIdentity,
          accepts: owner => {
            if (owner.ownerId !== options.bootId) return false;
            if (acceptsRun(owner.runId, owner.chatId)) return true;
            // An original consent-only source card can outlive the bounded
            // runtime presentation cache. Exact historical custody validates
            // its source observation; it grants no active/native control lease.
            if (owner.mode !== "post-denial") return false;
            const original = invocationRunOwners.getRunOwner(owner.chatId, owner.runId);
            return original?.ownerId === options.bootId && original.ownerKind === "daemon" && original.leaseId === owner.leaseId;
          },
          notify: (method, value) => peer.notify(method, value), maxRetainedBytes: NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes,
          maxItems: NATIVE_APPROVAL_OBSERVATION_POLICY.maxRecords, onFault: error => console.warn("[native-invocation] approval delivery unavailable", (error as {code?:unknown})?.code) });
        const recoveryRecords = new Map<string, { descriptor: NativeJsonTransferDescriptor; complete: boolean }>();
        const recovery = createNativeJsonTransfers({ maxPending: NATIVE_PUBLIC_EVENT_POLICY.maxItems, maxRetainedBytes: NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes,
          isCurrent: owner => server.authenticatedPeerIdentity(peer) === identity && [...recoveryRecords.values()].some(value => value === owner) });
        attached.set(peer, { identity, publisher, approvals, recovery, recoveryRecords }); peer.onClose(() => disposeAttachment(peer));
      }
      return status();
    }
    if (method === "native.detach") {
      current(peer); if (!exact(params, ["version"]) || params.version !== "agentlas.native-detach.v1") fail("native_invocation_detach_invalid");
      disposeAttachment(peer); return { version: "agentlas.native-detach.v1", detached: true };
    }
    const attachment = current(peer);
    if (!host) fail("native_invocation_host_not_ready");
    if (method === "native.approvalReply") return attachment.approvals.reply(attachment.identity, params);
    if (method === "invoke.nativeStart") {
      if (!accepting) fail("daemon_shutting_down");
      if (!observationAvailable()) fail("native_invocation_observation_unavailable");
      const start = nativeStartDescriptor(params);
      if (owned.has(start.handle) || known.has(start.binding.runId)) fail("native_invocation_descriptor_replayed");
      if (owned.size >= options.resources.maxRecords) fail("native_invocation_runtime_busy");
      while (known.size >= options.resources.maxRecords) {
        const old = [...known.entries()].find(([, value]) => value.released);
        if (!old) fail("native_invocation_runtime_busy"); known.delete(old![0]);
      }
      const record = { peer, identity: attachment.identity, start, released: false };
      owned.set(start.handle, record); known.set(start.binding.runId, record);
      return host.start(peer, start);
    }
    if (method === "invoke.cancel") {
      if (exact(params, ["version", "chatId", "runId"]) && params.version === "agentlas.native-owner-stop.v1") {
        const record = capture(params.chatId, params.runId);
        // Enrollment/service/boot + original captured memory authorizes owner
        // Stop even logged out and before lease. No custody release is implied.
        const result = options.service.cancel(record.runId);
        return { version: "agentlas.native-owner-stop.v1", chatId: record.chatId,
          runId: record.runId, status: result };
      }
      const start = nativeStartDescriptor(params), record = owned.get(start.handle);
      if (!record || record.peer !== peer || record.identity !== attachment.identity
        || JSON.stringify(record.start) !== JSON.stringify(start)) fail("native_invocation_control_binding_changed");
      return host.cancelCaptured(peer, start);
    }
    if (method === "invoke.steerCurrentTurn") {
      if (!exact(params, ["chatId", "intentId", "expectedRunId", "text"])) fail("native_invocation_control_invalid");
      capture(params.chatId, params.expectedRunId);
      return options.service.steerCurrentTurn(params as unknown as Parameters<InvocationService["steerCurrentTurn"]>[0]);
    }
    if (method === "invoke.currentTurnSteerReceipt") {
      if (!exact(params, ["chatId", "runId", "intentId"]) || typeof params.intentId !== "string") fail("native_invocation_control_invalid");
      const record = capture(params.chatId, params.runId), receipt = getCurrentTurnSteer(record.chatId, params.intentId);
      if (receipt && receipt.runId !== record.runId) fail("native_invocation_control_binding_changed");
      return options.service.currentTurnSteerReceipt(record.chatId, params.intentId);
    }
    if (["invoke.admission", "invoke.receipt", "invoke.currentTurn"].includes(method)) {
      if (!exact(params, ["chatId", "runId"])) fail("native_invocation_control_invalid");
      const record = capture(params.chatId, params.runId), { runId, chatId } = record;
      if (method === "invoke.receipt") {
        // Register the private observation before serializing, then retain the
        // complete public value. It carries no original issuer authority.
        const snapshot = { descriptor: undefined as unknown as NativeJsonTransferDescriptor, complete: false };
        const slot = randomUUID(); attachment.recoveryRecords.set(slot, snapshot);
        try { snapshot.descriptor = attachment.recovery.issue(snapshot, "checkpoint-value", options.service.receipt(runId), NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes); }
        catch (error) { attachment.recoveryRecords.delete(slot); throw error; }
        attachment.recoveryRecords.delete(slot); attachment.recoveryRecords.set(snapshot.descriptor.transferId, snapshot);
        return { version: "agentlas.native-recovery-value.v1", method, chatId, runId, transfer: snapshot.descriptor };
      }
      if (method === "invoke.currentTurn") { const turn = options.service.currentTurn(chatId); return turn?.runId === runId ? turn : null; }
      const admission = getInvocationAdmission(runId);
      if (!admission || admission.chatId !== chatId) return null;
      return { runId, chatId, status: admission.status, inputDigest: admission.inputDigest,
        ownerProcessEpoch: admission.ownerProcessEpoch, rejectionReasonCode: admission.rejectionReasonCode };
    }
    return fail("native_invocation_method_unavailable");
  }
  server = await startNativeAuthChannel({ address: options.address, binding: options.binding, credential: options.credential,
    bootId: options.bootId, consumeIngressNoStartProof: (peer, start, wire, proof) => {
      if (!host) return fail("native_invocation_host_not_ready"); return host.consumeIngressNoStartProof(peer, start, wire, proof); },
    consumeServiceObservationProof: (peer, start, wire, proof) => {
      if (!host) return fail("native_invocation_host_not_ready"); return host.consumeServiceObservationProof(peer, start, wire, proof); }, handle: dispatch });
  try { options.assertOwner(); host = createDaemonNativeInvocationHost({ binding: options.binding, bootId: options.bootId,
    service: options.service, transport: server, assertSocketFence: options.assertOwner, ...options.resources,
    onCustodyReleased: start => { const record = owned.get(start.handle);
      if (!record || record.start.binding.runId !== start.binding.runId || record.start.binding.chatId !== start.binding.chatId
        || record.start.binding.inputDigest !== start.binding.inputDigest) throw new Error("native_invocation_release_binding_changed");
      record.released = true; owned.delete(start.handle); } }); }
  catch (error) { await server.close(); throw error; }
  try{await supervisor.recover();}catch(error){console.warn("[one-supervisor] domain recovery held",(error as Error).message);}
  return { address: server.address, status, get supervisorActive(){return supervisor.active;}, closeAdmission() { accepting = false; supervisor.closeAdmission(); },
    get pendingCount() { return host?.retainedRecordCount ?? 0; },
    async close() { accepting = false; alive?.close(); for (const peer of [...attached.keys()]) disposeAttachment(peer); await server.close(); },
    settleDispatched: () => server.settleDispatched() };
}
