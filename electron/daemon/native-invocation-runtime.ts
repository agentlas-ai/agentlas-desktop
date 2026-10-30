import { createDaemonOneSupervisorHost } from "./one-supervisor-host";
import { createOwnedAskUserHost } from "../confirm/owned-ask-user-host";
import { mergePendingAskUserRequests } from "../confirm/ask-user";
import { ALIVE_DECISION_PROTOCOL, createDaemonAliveDecisionPort } from "./alive-decision-port";
import { ALIVE_RUNTIME_PROTOCOL } from "../alive-organisms/runtime-protocol";
import { getDb } from "../store/db";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { withAgentContext } from "../runtime/agent-context";
import { detectRuntimes } from "../runtime/detect";
import { pickRunner } from "../runtime/selection";
import { runAliveServingDecision } from "../alive-organisms/serving-wake";
import { ONE_SUPERVISOR_RUNTIME_PROTOCOL } from "../../shared/one-supervisor-runtime";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { daemonOwnedObservation as observeDaemonOwned } from "./daemon-owned-observation";
import { randomUUID } from "node:crypto";
import { createNativeJsonTransfers, type NativeJsonTransferDescriptor } from "./native-json-transfer";
import { NATIVE_PUBLIC_EVENT_POLICY, NATIVE_APPROVAL_OBSERVATION_POLICY } from "./native-invocation-policy";
import type { HostSessionHandoff } from "../auth";
import type { InvocationService } from "../invocation/service";
import type { ControlSocketPeer } from "./control-socket";
import { assertNativeAuthBinding, type NativeAuthBinding, type NativeCredential } from "./native-auth-credentials";
import { startNativeAuthChannel } from "./native-auth-channel";
import { daemonDeviceBridge, DeviceBridgeError, DEVICE_STATE_VERSION } from "./device-bridge";
import { handGoalIntakeToMain } from "../invocation/goal-intake-forward";
import { answerChatHandoverRequest, CHAT_HANDOVER_VERSION, registerChatHandoverPeer } from "../runtime/chat-host-handover";
import { createDaemonNativeInvocationHost } from "./native-invocation-host";
import { nativeStartDescriptor, type NativeStartDescriptor } from "./native-start-protocol";
import type { NativeAuthenticatedIdentity } from "./native-session-auth";
import { createNativeInvocationPublicPublisher, nativePublicAttachmentOperation, nativePublicKindsRequest, NATIVE_PUBLIC_KINDS_VERSION } from "../invocation/native-public-events";
import { createNativeInvocationApprovalChannel } from "./native-invocation-approvals";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { getCurrentTurnSteer } from "../store/current-turn-steers";
import { settleRunKeyElicitationFromWindow } from "../mcp/run-key-elicitation";
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
    async resolveRuntime(choice, signal, assertCurrent){
      const exact=(value: import("../../shared/types").RuntimeStatus)=>value.kind===choice.kind
        && (value.backend??null)===choice.backend && (value.source??null)===choice.source
        && (choice.kind!=="acp" || value.acpAgentId===choice.acpAgentId);
      assertCurrent();
      let status=(await detectRuntimes(false, signal)).find(exact);
      if(!status){
        assertCurrent();
        status=(await detectRuntimes(true, signal)).find(exact);
      }
      assertCurrent();
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
    recoveryRecords: Map<string, { descriptor: NativeJsonTransferDescriptor; complete: boolean }>;
    /** Optional public kinds this exact peer opted into (NATIVE_PUBLIC_KINDS_VERSION); empty for a 1.3.44 Main. */
    publicKinds: Set<string>;
    createSubscriptions(notify: (method: string, params: unknown, sourceMode?: "live" | "post-denial") => boolean): {publisher: ReturnType<typeof createNativeInvocationPublicPublisher>; approvals: ReturnType<typeof createNativeInvocationApprovalChannel>};
    activateObservation?: () => Array<{method: string; params: unknown; mode?: "live" | "post-denial"}> } ;
  const attached = new Map<ControlSocketPeer, Attached>();
  const questionActivity=new Set<(chatIds:string[])=>void>();
  const questions=createOwnedAskUserHost({ownerId:options.bootId,assertOwner:options.assertOwner,
    ownerKey:()=>JSON.stringify(agentContextOwnerBinding()),personalSource:(chatId,runId)=>!!supervisor.runBinding(chatId,runId),
    notify:()=>{if(!questionActivity.size)return false;
      for(const listener of questionActivity)listener(options.service.activeChatIds());
      return [...attached.keys()].some(peer=>{try{return current(peer).publisher.available;}catch{return false;}});}});
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
  const daemonOwnedObservation = (chatId: unknown, runId: unknown) => observeDaemonOwned(options.bootId, chatId, runId) as NativeStartDescriptor["binding"] | null;
  const observeCapture = (chatId: unknown, runId: unknown): NativeStartDescriptor["binding"] => {
    try { return capture(chatId, runId); }
    catch (error) { const observed = daemonOwnedObservation(chatId, runId); if (observed) return observed; throw error; }
  };
  const observationAvailable = (record: Attached) => record.publisher.available && record.approvals.available;
  const capabilities = (record?: Attached): NativeInvocationCapabilities => ({ start: !!host && accepting && (!record || observationAvailable(record)), stop: !!host,
    events: !!host && (!record || record.publisher.available),
    approvals: !!host && (!record || record.approvals.available), recovery: !!host });
  const status = (record?: Attached): NativeInvocationAttachReply => {
    const value = capabilities(record); return { version: "agentlas.native-attach.v1", bootId: options.bootId,
      serviceIdentity: options.binding.serviceIdentity, ready: Object.values(value).every(Boolean), capabilities: value };
  };
  function disposeAttachment(peer: ControlSocketPeer) { const record = attached.get(peer); if (!record) return;
    // Device bridge: this was the peer that carried the screen; pending device requests fail now, lock state unknown.
    daemonDeviceBridge().detach(peer);
    attached.delete(peer); record.publisher.dispose(); record.approvals.dispose(); for (const value of record.recoveryRecords.values()) record.recovery.release(value); record.recoveryRecords.clear(); }
  async function dispatch(method: string, params: unknown, peer: ControlSocketPeer): Promise<unknown> {
    options.assertOwner();
    if (method === "native.attach") {
      if (params && typeof params === "object" && (params as {version?:unknown}).version === "agentlas.followup-custody.v2") {
        current(peer);
        if (!exact(params,["version","chatId","intentId","requestHash"]) || typeof params.chatId !== "string"
          || typeof params.intentId !== "string" || typeof params.requestHash !== "string") fail("native_followup_custody_invalid");
        // A content-free challenge proves this exact authenticated owner sees
        // Main's original capture in the same SQLite authority as its intake.
        const row = getDb().prepare("SELECT request_hash,request_json,origin_run_id FROM invocation_followup_custody WHERE intent_id=? AND chat_id=?")
          .get(params.intentId,params.chatId) as {request_hash:string;request_json:string;origin_run_id:string}|undefined;
        if (!row || row.request_hash !== params.requestHash) fail("native_followup_custody_store_mismatch");
        return {version:"agentlas.followup-custody.v2",bootId:options.bootId,chatId:params.chatId,intentId:params.intentId,requestHash:row.request_hash,
          currentTurnCompatible:options.service.followupCurrentTurnMatches(params.chatId,row.origin_run_id,JSON.parse(row.request_json))};
      }
      if (params && typeof params === "object" && (params as {version?:unknown}).version === "agentlas.native-observation-reset.v1") {
        const record = current(peer);
        if (!exact(params, ["version"])) fail("native_observation_reset_invalid");
        // Only disposable observation buffers rotate. Original source/ledger,
        // recovery records, physical channel, callbacks and writers are untouched.
        record.publisher.dispose(); record.approvals.dispose();
        let paused = true;
        const notifications: Array<{method: string; params: unknown; mode?: "live" | "post-denial"}> = [];
        let liveNotifications = 0;
        const next = record.createSubscriptions((method, value, mode) => {
          if (!paused) {
            if (method.startsWith("invocation.approval.")) return peer.notify("invocation.approval.observation", {version: "agentlas.native-approval-observation.v1", stream: record.publisher.stream, method, params: value, ...(mode ? {mode} : {})});
            return peer.notify(method, value);
          }
          // Historical descriptor/receipt metadata never consumes live delivery
          // capacity. Its original registry and exact lazy transfers own history.
          if (mode !== "post-denial" && liveNotifications++ >= NATIVE_PUBLIC_EVENT_POLICY.maxItems + 2 * NATIVE_APPROVAL_OBSERVATION_POLICY.maxRecords) return false;
          notifications.push({method, params: value, ...(mode ? {mode} : {})}); return true;
        });
        record.publisher = next.publisher; record.approvals = next.approvals;
        record.activateObservation = () => { paused = false; return notifications.splice(0); };
        return {version: "agentlas.native-observation-reset.v1", stream: next.publisher.stream};
      }
      if (params && typeof params === "object" && (params as {version?:unknown}).version === "agentlas.native-observation-activate.v1") {
        const record = current(peer);
        if (!exact(params, ["version", "stream"]) || params.stream !== record.publisher.stream || !record.activateObservation) fail("native_observation_stream_changed");
        const notifications = record.activateObservation(); record.activateObservation = undefined;
        return {version: "agentlas.native-observation-activate.v1", stream: record.publisher.stream, notifications, status: status(record)};
      }
      // A newer Main says which optional live kinds (the plan checklist) its receiver accepts. Kept per peer, so an
      // observation reset's new publisher inherits it. A 1.3.44 Main never sends this and never receives those kinds.
      if (params && typeof params === "object" && (params as {version?:unknown}).version === NATIVE_PUBLIC_KINDS_VERSION) {
        const record = current(peer);
        for (const kind of nativePublicKindsRequest(params)) record.publicKinds.add(kind);
        return { version: NATIVE_PUBLIC_KINDS_VERSION, kinds: [...record.publicKinds] };
      }
      if(params && typeof params==="object" && (params as {version?:unknown}).version===ALIVE_DECISION_PROTOCOL){
        const attachment=current(peer),identity=attachment.identity;
        return alivePort().dispatch(params,{identity,
          assertCurrent(){if(current(peer).identity!==identity)fail("alive_decision_native_peer_changed");},
          onClose:listener=>peer.onClose(listener)});
      }
      // NH21: the service holds the Alive domain; the window forwards the owner's AGI edits here.
      if(params && typeof params==="object" && (params as {version?:unknown}).version===ALIVE_RUNTIME_PROTOCOL){
        current(peer);
        return (await import("../alive-organisms")).answerAliveRuntimeRequest(params,options.bootId);
      }
      // Chat host handover (1.3.0 A2): Desktop is about to run this chat's next turn and asks the service to release.
      if(params && typeof params==="object" && (params as {version?:unknown}).version===CHAT_HANDOVER_VERSION){
        current(peer);
        return answerChatHandoverRequest(params);
      }
      if(params && typeof params==="object" && (params as {version?:unknown}).version===DEVICE_STATE_VERSION){
        current(peer);
        const wire=params as Record<string,unknown>,bridge=daemonDeviceBridge();
        if(wire.op==="state" && exact(wire,["version","op","session","idleSeconds"])){
          const state=bridge.pushState(peer,{session:wire.session,idleSeconds:wire.idleSeconds});
          return {version:DEVICE_STATE_VERSION,session:state.session};
        }
        if(wire.op==="status" && exact(wire,["version","op"]))return {version:DEVICE_STATE_VERSION,attached:bridge.attached,pending:bridge.pendingCount,...bridge.state()};
        // Connectivity check: one idle-snapshot round trip service -> window process -> service.
        if(wire.op==="probe" && exact(wire,["version","op"])){
          try{const state=await bridge.idleSnapshot();return {version:DEVICE_STATE_VERSION,ok:true,session:state.session,idleSeconds:state.idleSeconds};}
          catch(error){return {version:DEVICE_STATE_VERSION,ok:false,error:error instanceof DeviceBridgeError?error.code:"device_bridge_unavailable"};}
        }
        // Goal intake handover check (2026-10-11): the service hands one owner message to Main exactly as a daemon-run turn would.
        if(wire.op==="goalIntake" && exact(wire,["version","op","runId","chatId","sourceMessageId","permission"])
          && typeof wire.runId==="string" && typeof wire.chatId==="string" && typeof wire.sourceMessageId==="string" && ["read","write","full"].includes(String(wire.permission))){
          const outcome=await handGoalIntakeToMain({runId:wire.runId,chatId:wire.chatId,sourceMessageId:wire.sourceMessageId,permission:wire.permission as "read"|"write"|"full"});
          return {version:DEVICE_STATE_VERSION,ok:true,outcome};
        }
        fail("device_state_invalid");
      }
      if(params && typeof params==='object' && (params as {version?:unknown}).version===ONE_SUPERVISOR_RUNTIME_PROTOCOL) {
        const attachment=current(peer);
        const wire=params as Record<string,unknown>;
        let observed:unknown;
        if(wire.op==="questions.list"&&exact(wire,["version","op"])){
          const shared=questions.list();
          const personal=supervisor.active?await supervisor.dispatch(params) as import("../../shared/types").AskUserRequestEvent[]:[];
          observed=mergePendingAskUserRequests(personal.filter(question=>shared.some(item=>item.requestId===question.requestId)),shared);
        }else if(wire.op==="questions.answer"&&exact(wire,["version","op","input"])){
          const input=wire.input;
          if(!exact(input,["requestId","answer"])||typeof input.requestId!=="string"
            ||!(input.answer===null||typeof input.answer==="string"&&input.answer.length<=100000))fail("supervisor_question_answer_invalid");
          const binding=questions.binding(input.requestId);
          if(binding&&binding.personal!==!!supervisor.runBinding(binding.chatId,binding.runId))fail("supervisor_question_source_fenced");
          // One retains its existing durable answer/replay contract. Other
          // admitted invocations use the same live broker and native channel.
          observed=binding&&!binding.personal
            ?questions.answer(input.requestId,input.answer as string|null)
            :supervisor.active?await supervisor.dispatch(params):false;
        }else observed=await supervisor.dispatch(params);
        options.assertOwner();current(peer);
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
        const readOnly = wire.version === "agentlas.native-owner-text-attach.v1" || wire.version === "agentlas.native-owner-text-recovery.v1";
        const record = readOnly ? observeCapture(wire.chatId,wire.runId) : capture(wire.chatId,wire.runId), binding = record;
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
          const attachedEvents = options.service.nativeOwnerTextAttach(value,wire.includeEvents);
          // Same rule as the live stream: an optional kind reaches only a Main that opted into it.
          observed = !attachedEvents || attachment.publicKinds.has("plan") ? attachedEvents
            : {...attachedEvents, events: attachedEvents.events.filter(event => event.kind !== "plan")};
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
        const captures=[...known.values()].filter(r=>!host?.executableAuthorityClosed(r.start)).map(r=>({chatId:r.start.binding.chatId,runId:r.start.binding.runId,nativeCustody:r.released?'released':'retained'}));
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
        const publicKinds = new Set<string>();
        const acceptsRun = (runId: string, chatId: string) => known.get(runId)?.start.binding.chatId === chatId || !!supervisor.runBinding(chatId,runId);
        // Progress stream only (events, active chats). Approvals keep the strict acceptsRun above.
        const observesRun = (runId: string, chatId: string) => acceptsRun(runId, chatId) || !!daemonOwnedObservation(chatId, runId);
        const observesChat = (chatId: string) => {
          if ([...known.values()].some(r => r.start.binding.chatId === chatId) || supervisor.captures().some(r => r.chatId === chatId)) return true;
          const active = invocationRunOwners.getActiveOwner(chatId);
          return !!active && !!daemonOwnedObservation(chatId, active.runId);
        };
        const createSubscriptions = (notify: (method: string, params: unknown, sourceMode?: "live" | "post-denial") => boolean) => {
        const questionAwareService={
          onEvent:options.service.onEvent.bind(options.service),onSettled:options.service.onSettled.bind(options.service),activeChatIds:()=>options.service.activeChatIds(),
          onActiveChats(listener:(chatIds:string[])=>void){questionActivity.add(listener);const stop=options.service.onActiveChats(listener);
            return()=>{questionActivity.delete(listener);stop();};}};
        const publisher = createNativeInvocationPublicPublisher({ service: questionAwareService, identity, getIdentity,
          notify, acceptsRun: observesRun,
          acceptsChat: observesChat,
          acceptsKind: kind => publicKinds.has(kind),
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
          notify, maxRetainedBytes: NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes,
          maxItems: NATIVE_APPROVAL_OBSERVATION_POLICY.maxRecords, onFault: error => console.warn("[native-invocation] approval delivery unavailable", (error as {code?:unknown})?.code) });
        return {publisher, approvals}; };
        const {publisher, approvals} = createSubscriptions((method, value) => peer.notify(method, value));
        const recoveryRecords = new Map<string, { descriptor: NativeJsonTransferDescriptor; complete: boolean }>();
        const recovery = createNativeJsonTransfers({ maxPending: NATIVE_PUBLIC_EVENT_POLICY.maxItems, maxRetainedBytes: NATIVE_PUBLIC_EVENT_POLICY.maxRetainedBytes,
          isCurrent: owner => server.authenticatedPeerIdentity(peer) === identity && [...recoveryRecords.values()].some(value => value === owner) });
        attached.set(peer, { identity, publisher, approvals, recovery, recoveryRecords, publicKinds, createSubscriptions }); peer.onClose(() => disposeAttachment(peer));
        daemonDeviceBridge().attach(peer, { request: frame => server.request(peer, "native.checkpoint", frame) });
      }
      return status(current(peer));
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
      if (!observationAvailable(attachment)) fail("native_invocation_observation_unavailable");
      const start = nativeStartDescriptor(params);
      if (owned.has(start.handle) || known.has(start.binding.runId)) fail("native_invocation_descriptor_replayed");
      const reservation = getInvocationAdmission(start.binding.runId);
      if (!reservation || reservation.status !== "pending" || reservation.chatId !== start.binding.chatId
        || reservation.inputDigest !== start.binding.inputDigest || reservation.ownerProcessEpoch !== options.bootId) fail("native_invocation_descriptor_replayed");
      for (const [handle, value] of owned) if (host.executableAuthorityClosed(value.start)) owned.delete(handle);
      if (owned.size >= options.resources.maxRecords) fail("native_invocation_runtime_busy");
      while (known.size >= options.resources.maxRecords) {
        const old = [...known.entries()].find(([, value]) => value.released || host!.executableAuthorityClosed(value.start));
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
    if (method === "invoke.runKeyOutcome") {
      // The window's answer to an API-key request of a run this service hosts (I-D2). Value-free: "provided" is Main's
      // receipt-gate verdict; only the exact pending request (requestId + expiry) of a run this service hosts settles.
      if (!exact(params, ["version", "chatId", "runId", "requestId", "expiresAt", "outcome"]) || params.version !== "agentlas.native-run-key-outcome.v1"
        || typeof params.requestId !== "string" || !Number.isSafeInteger(params.expiresAt) || (params.outcome !== "declined" && params.outcome !== "provided")) fail("native_invocation_control_invalid");
      const record = observeCapture(params.chatId, params.runId);
      const settled = settleRunKeyElicitationFromWindow(record.runId, { requestId: params.requestId as string, expiresAt: params.expiresAt as number },
        params.outcome as "declined" | "provided");
      return { version: "agentlas.native-run-key-outcome.v1", chatId: record.chatId, runId: record.runId, settled };
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
      const record = method === "invoke.currentTurn" ? capture(params.chatId, params.runId) : observeCapture(params.chatId, params.runId), { runId, chatId } = record;
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
  // The service asks the window process (device bridge reverse path) before it runs a chat Desktop ran last.
  const unregisterHandoverPeer = registerChatHandoverPeer("desktop", (chatId, deadlineMs) => daemonDeviceBridge().releaseChatSessions(chatId, deadlineMs));
  try { server = await startNativeAuthChannel({ address: options.address, binding: options.binding, credential: options.credential,
    bootId: options.bootId, consumeIngressNoStartProof: (peer, start, wire, proof) => {
      if (!host) return fail("native_invocation_host_not_ready"); return host.consumeIngressNoStartProof(peer, start, wire, proof); },
    consumeServiceObservationProof: (peer, start, wire, proof) => {
      if (!host) return fail("native_invocation_host_not_ready"); return host.consumeServiceObservationProof(peer, start, wire, proof); }, handle: dispatch }); }
  catch(error){questions.close();unregisterHandoverPeer();throw error;}
  try { options.assertOwner(); host = createDaemonNativeInvocationHost({ binding: options.binding, bootId: options.bootId,
    service: options.service, transport: server, assertSocketFence: options.assertOwner, ...options.resources,
    onCustodyReleased: start => { const record = owned.get(start.handle) ?? known.get(start.binding.runId);
      if (!record) return; // Original physical cleanup may finish after its sealed metadata was compacted.
      if (record.start.handle !== start.handle || record.start.binding.runId !== start.binding.runId || record.start.binding.chatId !== start.binding.chatId
        || record.start.binding.inputDigest !== start.binding.inputDigest) throw new Error("native_invocation_release_binding_changed");
      record.released = true; owned.delete(start.handle); } }); }
  catch (error) { questions.close(); unregisterHandoverPeer(); await server.close(); throw error; }
  try{await supervisor.recover();}catch(error){console.warn("[one-supervisor] domain recovery held",(error as Error).message);}
  return { address: server.address, status, get supervisorActive(){return supervisor.active;}, closeAdmission() { accepting = false; supervisor.closeAdmission(); },
    get pendingCount() { return host?.retainedRecordCount ?? 0; },
    async close() { accepting = false; questions.close(); unregisterHandoverPeer(); alive?.close(); for (const peer of [...attached.keys()]) disposeAttachment(peer); await server.close(); },
    settleDispatched: () => server.settleDispatched() };
}
