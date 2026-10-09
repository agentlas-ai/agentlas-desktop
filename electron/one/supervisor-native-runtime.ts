import { getAuthenticatedActorIds } from "../auth";
import { STORE_SCHEMA_VERSION } from "../store/db";
import { ONE_SUPERVISOR_SCHEMA } from "../../shared/one-supervisor";
import { ONE_SUPERVISOR_JOURNAL_SCHEMA, ONE_SUPERVISOR_RUNTIME_PROTOCOL, sameSupervisorRuntimeCompatibility } from "../../shared/one-supervisor-runtime";
import { importNativeJsonValue } from "../daemon/native-json-transfer";
import { NATIVE_MAIN_PREPARATION_POLICY } from "../daemon/native-invocation-policy";
import type { OneSupervisorService } from "./supervisor-service";
import { randomUUID } from "node:crypto";
import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { canonicalInvocationRequestJson, createInvocationAdmission, getInvocationAdmission } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { createNativeGuiOwnerClient } from "../invocation/native-gui-owner";
import type { OneSupervisorOwner } from "./supervisor-owner";
import type { OneSupervisorStore, SupervisorRequestRow } from "./supervisor-store";

type NativeOwner = ReturnType<typeof createNativeGuiOwnerClient>;
type Channel = object & { dispatch(method: string, input: unknown): Promise<unknown> };
type Origin = { request: string; assert(): void; purpose?: SupervisorHostNoticePurpose };
const origins = new WeakMap<object, Origin>();
function fail(code: string): never { throw Object.assign(new Error(code),{code}); }
/** Bootstrap-only callbacks. An object copied from JSON has no entry here. */
export function authorizeSupervisorNativeOrigin(origin: object, request: Readonly<McpInvocationRequest>): object {
  const record = origins.get(origin);
  if (!record || record.request !== canonicalInvocationRequestJson(request)) fail("supervisor_native_original_command_required");
  record.assert(); return origin;
}
export async function dispatchSupervisorNativeCommand(origin:object,request:Readonly<McpInvocationRequest>,name:string,input:Record<string,unknown>):Promise<unknown> {
  authorizeSupervisorNativeOrigin(origin,request);
  if(!request.oneMode || !request.runId)fail('supervisor_native_personal_source_required');
  return (await import('./team-control-server')).dispatchOneSupervisorTool({chatId:request.chatId,supervisorReplyRunId:request.runId},name,input);
}
export function supervisorNativeNoticePurpose(origin: object, request: Readonly<McpInvocationRequest>): SupervisorHostNoticePurpose | undefined {
  authorizeSupervisorNativeOrigin(origin, request); return origins.get(origin)!.purpose;
}

/** Original durable command + exact identity/generation is the host producer.
 * This capability never crosses IPC and does not pretend to be a renderer. */
export function createSupervisorNativeOrigin(store: OneSupervisorStore, owner: OneSupervisorOwner,
  oneId: string, request: McpInvocationRequest, purpose?: SupervisorHostNoticePurpose): object {
  const token = owner.assert(oneId),actor=JSON.stringify(getAuthenticatedActorIds());
  const rows = store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'")
    .all(oneId, request.runId) as SupervisorRequestRow[];
  if (rows.length !== 1) fail("supervisor_native_exact_command_required");
  const row = rows[0], payload = JSON.parse(row.payload_json);
  let target: string | undefined;
  if (row.kind === "reply") target = row.origin_chat_id;
  else if (row.kind === "work") target = payload.workerChatId;
  else if (row.kind === "chat-send") target = payload.chatId;
  else if (row.kind === "follow-up") {
    const delegated = store.db.prepare("SELECT payload_json FROM one_supervisor_requests WHERE one_id=? AND task_id=? AND kind='work' ORDER BY rowid LIMIT 1")
      .get(oneId, row.task_id) as { payload_json: string } | undefined;
    if (delegated) target = JSON.parse(delegated.payload_json).workerChatId;
  }
  if (target !== request.chatId || payload.text !== request.userPrompt) fail("supervisor_native_command_binding_changed");
  if (row.source_reply_run_id && !store.db.prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind='reply'").get(oneId, row.source_reply_run_id)) {
    fail("supervisor_native_source_occurrence_missing");
  }
  const source = Object.freeze({});
  origins.set(source, { request: canonicalInvocationRequestJson(request), purpose, assert() {
    if(JSON.stringify(getAuthenticatedActorIds())!==actor)fail("supervisor_native_actor_changed");
    owner.assertToken(token);
    const current = store.get(row.command_id);
    if (!current || current.one_id !== oneId || current.run_id !== request.runId || current.payload_json !== row.payload_json
      || current.payload_hash !== row.payload_hash || current.source_reply_run_id !== row.source_reply_run_id
      || !["dispatching", "accepted"].includes(current.state)) fail("supervisor_native_command_fenced");
  } });
  return source;
}

export interface SupervisorNativeRuntimeBootstrap { owner: NativeOwner; getChannel(): Channel | undefined; onHandoff?():void }
let bootstrap: SupervisorNativeRuntimeBootstrap | undefined;
let mode:'local'|'handoff'|'daemon'='local';
let handoffTimer:NodeJS.Timeout|undefined;
let handoffBusy=false;
let handoffProposal:{oneId:string;ownerEpoch:string;generation:number}|undefined;
export function supervisorRuntimeMode(){return mode;}
export async function callOneSupervisorRuntime(op:'status'|'adopt'|'command'|'harness.result'|'harness.action'|'questions.list'|'questions.answer',input?:unknown):Promise<any> {
  const channel=bootstrap?.getChannel(),identity=channel && nativeGuiChannelIdentity(channel);
  if(!channel || !identity)fail('supervisor_native_channel_unavailable');
  const assertCurrent=()=>{if(nativeGuiChannelIdentity(channel)!==identity)fail('supervisor_native_channel_changed');};
  const wire=await channel.dispatch('native.attach',{version:ONE_SUPERVISOR_RUNTIME_PROTOCOL,op,...(input!==undefined?{input}:{})}) as {version?:string;bootId?:string;transfer?:unknown};
  assertCurrent();
  if(wire?.version!==ONE_SUPERVISOR_RUNTIME_PROTOCOL || wire.bootId!==identity.bootId || !wire.transfer)fail('supervisor_native_rpc_reply_invalid');
  const result=await importNativeJsonValue(wire.transfer,{kind:'checkpoint-value',maxBytes:NATIVE_MAIN_PREPARATION_POLICY.maxCheckpointBytes,signal:new AbortController().signal,assertCurrent,
    read:(transferId,offset)=>channel.dispatch('native.attach',{version:'agentlas.native-recovery-read.v1',read:{transferId,offset}})});
  const descriptor=wire.transfer as {transferId:string;digest:string};
  if(await channel.dispatch('native.attach',{version:'agentlas.native-recovery-ack.v1',ack:{transferId:descriptor.transferId,digest:descriptor.digest}})!==null)fail('supervisor_native_rpc_ack_invalid');
  assertCurrent();return result;
}
async function tryHandoff():Promise<void>{
  if(handoffBusy || mode==='daemon')return;handoffBusy=true;
  try{
    const status=await callOneSupervisorRuntime('status');
    const compatibility={protocol:ONE_SUPERVISOR_RUNTIME_PROTOCOL,supervisorSchema:ONE_SUPERVISOR_SCHEMA,journalSchema:ONE_SUPERVISOR_JOURNAL_SCHEMA,storeSchema:STORE_SCHEMA_VERSION,nativeAbi:process.versions.modules};
    if(!sameSupervisorRuntimeCompatibility(status?.compatibility,compatibility))fail('supervisor_daemon_version_mismatch');
    if(status.active && status.authorityCurrent && status.owner?.ownerEpoch===status.bootId && status.owner?.ownerKind==='work-daemon' && status.owner?.phase==='active'){
      if(status.owner.oneId!==(await import('../store/one-profile')).getOneProfile().oneId)fail('supervisor_daemon_identity_changed');
      mode='daemon';if(handoffTimer)clearInterval(handoffTimer);bootstrap?.onHandoff?.();return;
    }
    if(!handoffProposal){const proposal=(await import('./supervisor')).prepareOneSupervisorDaemonHandoff();if(!proposal)return;handoffProposal=proposal;mode='handoff';}
    const adopted=await callOneSupervisorRuntime('adopt',{compatibility,...handoffProposal});
    if(!adopted?.adopted || adopted.bootId!==status.bootId || adopted.owner?.ownerEpoch!==status.bootId || adopted.owner?.ownerKind!=='work-daemon'
      || adopted.owner?.oneId!==handoffProposal.oneId || adopted.owner?.generation!==handoffProposal.generation+1 || adopted.owner?.phase!=='active')fail('supervisor_daemon_handoff_unconfirmed');
    mode='daemon';if(handoffTimer)clearInterval(handoffTimer);bootstrap?.onHandoff?.();
  }catch(error){console.warn('[one-supervisor] daemon handoff deferred',error instanceof Error?error.message:'unknown');}
  finally{handoffBusy=false;}
}
export function oneSupervisorEndpoint():{[K in keyof OneSupervisorService]:OneSupervisorService[K] extends (...args:infer A)=>infer R ? (...args:A)=>Promise<Awaited<R>> : never} {
  return new Proxy({} as any,{get(_target,method:string){return async(...args:unknown[])=>{
    if(mode==='handoff')fail('supervisor_runtime_handoff_pending');
    if(mode==='daemon')return callOneSupervisorRuntime('command',{method,args});
    const service=(await import('./supervisor')).oneSupervisor();
    return (service[method as keyof OneSupervisorService] as (...args:unknown[])=>unknown).apply(service,args);
  };}});
}
/** Sticky: losing a native channel cannot downgrade an issued command to Main. */
export function configureOneSupervisorNativeRuntime(value: SupervisorNativeRuntimeBootstrap): void {
  if (bootstrap && bootstrap.owner !== value.owner) fail("supervisor_native_runtime_already_configured");
  bootstrap = value;
  if(!handoffTimer){handoffTimer=setInterval(()=>{void tryHandoff();},1500);handoffTimer.unref?.();}
  void tryHandoff();
}
export function oneSupervisorNativeRuntime() { return bootstrap; }

/** The authenticated daemon owns the run; Main observes its durable receipt and
 * exact custody. Disconnect never creates a replacement run or cancellation. */
export function createSupervisorNativeRuntime(options: {
  store: OneSupervisorStore; owner: OneSupervisorOwner; identity(): string;
  receipt(runId: string): InvocationRunReceipt | null;
}) {
  const pending = new Map<string, string>(), observed = new Map<string, InvocationRunReceipt>();
  const listeners = new Set<(event: { runId: string; chatId: string; receipt: InvocationRunReceipt }) => void>();
  const starts = new Set<string>();
  const terminal = (receipt: InvocationRunReceipt) => ["completed", "cancelled", "interrupted", "failed"].includes(receipt.status);
  function current() {
    const value = bootstrap, channel = value?.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
    if (!value || !channel || !identity) fail("supervisor_native_channel_unavailable");
    return { value, channel, identity };
  }
  function attach(chatId: string): { runId: string } | null {
    for (const [runId, target] of pending) if (target === chatId) return { runId };
    if (!bootstrap) return null;
    const owner = invocationRunOwners.getActiveOwner(chatId);
    // Durable retained custody remains a barrier even while the viewer is offline.
    return owner?.ownerKind === "daemon" && ["active", "settling"].includes(owner.state) ? { runId: owner.runId } : null;
  }
  function poll(): void {
    if(!bootstrap)return;
    for (const row of options.store.pending(options.identity())) {
      if (!row.run_id) continue;
      const receipt = options.receipt(row.run_id);
      if (!receipt || !terminal(receipt)) continue;
      const custody = invocationRunOwners.getRunOwner(receipt.chatId, receipt.runId);
      // A terminal status written before child cleanup is not a stopped process ACK.
      if (custody?.ownerKind !== "daemon" || custody.state !== "released") continue;
      const old = observed.get(receipt.runId);
      if (old?.status === receipt.status && old.updatedAt === receipt.updatedAt) continue;
      pending.delete(receipt.runId); observed.set(receipt.runId, receipt);
      for (const listener of listeners) listener({ runId: receipt.runId, chatId: receipt.chatId, receipt });
    }
  }
  const timer = setInterval(() => { try { poll(); } catch { /* Keep durable uncertain state until the next observation. */ } }, 750);
  timer.unref?.();
  return {
    get pendingCount(){return pending.size;}, attach, poll, ownsPending:(runId:string)=>pending.has(runId),
    receipt(runId: string): InvocationRunReceipt | null {
      const receipt=options.receipt(runId);if(!receipt || !bootstrap)return receipt;
      const custody=invocationRunOwners.getRunOwner(receipt.chatId,runId);
      if(terminal(receipt)&&custody?.ownerKind==='daemon'&&custody.state!=='released')return {...receipt,status:receipt.status==='cancelled'?'cancelling':'running'};
      return receipt;
    },
    start(request: McpInvocationRequest, purpose?: SupervisorHostNoticePurpose): Promise<{ runId: string }> {
      const { value } = current();
      if (!request.runId || starts.has(request.runId)) fail("supervisor_native_start_replayed");
      const origin = createSupervisorNativeOrigin(options.store, options.owner, options.identity(), request, purpose);
      starts.add(request.runId); pending.set(request.runId, request.chatId);
      // Original owner has one admission and one actual start. A lost response
      // stays uncertain and is reconciled using exact durable custody/receipts.
      const actual = value.owner.startHost(origin, request);
      void actual.then(() => { pending.delete(request.runId!); poll(); }, () => {
        const admission = getInvocationAdmission(request.runId!);
        if (admission?.status === "rejected") pending.delete(request.runId!);
      });
      return actual;
    },
    async cancel(runId: string): Promise<string> {
      const { value, channel, identity } = current();
      if (value.owner.inspect(runId).retained) return value.owner.cancel(runId);
      const receipt = options.receipt(runId), owner = receipt && invocationRunOwners.getRunOwner(receipt.chatId, runId);
      if (!receipt || owner?.ownerKind !== "daemon" || owner.ownerId !== identity.bootId) return "not-found";
      const response = await channel.dispatch("invoke.cancel", { version: "agentlas.native-owner-stop.v1", chatId: receipt.chatId, runId }) as { version?: string; chatId?: string; runId?: string; status?: string };
      if (nativeGuiChannelIdentity(channel) !== identity || response?.version !== "agentlas.native-owner-stop.v1" || response.chatId !== receipt.chatId
        || response.runId !== runId || !["requested", "already-requested", "not-found"].includes(response.status ?? "")) fail("supervisor_native_stop_ack_invalid");
      return response.status!;
    },
    async steer(request: McpInvocationRequest, runId: string) {
      const { channel, identity } = current(), admission = getInvocationAdmission(runId);
      if (!admission || admission.chatId !== request.chatId || admission.ownerProcessEpoch !== identity.bootId) fail("supervisor_native_steer_binding_changed");
      const intentId = randomUUID();
      const result = await channel.dispatch("native.attach", { version: "agentlas.native-owner-text.v1", chatId: request.chatId, runId,
        inputDigest: admission.inputDigest, intentId, deliveryKind: "queue", text: request.userPrompt }) as { intentId?: string; sourceStatus?: string; runId?: string; result?: {queued?:boolean; queuedRequestId?:string; activeRunId?:string} };
      if (nativeGuiChannelIdentity(channel) !== identity || result?.intentId !== intentId || result.runId !== runId
        || !["queued", "dispatching", "applied"].includes(result.sourceStatus ?? "")) fail("supervisor_native_steer_unconfirmed");
      if(!result.result?.queued || !result.result.queuedRequestId || result.result.activeRunId!==runId)fail("supervisor_native_steer_unconfirmed");
      return { queued: true, queuedRequestId: result.result.queuedRequestId, activeRunId: runId };
    },
    onSettled(listener: (event: { runId: string; chatId: string; receipt: InvocationRunReceipt }) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { clearInterval(timer); listeners.clear(); },
  };
}

/** Daemon domain host owns an authenticated handoff and the durable command.
 * Reuse the original native prepared generator and local checkpoint adapter;
 * never dispatch through a second unprepared InvocationService.start path. */
export async function startSupervisorPreparedInvocation(input:{store:OneSupervisorStore;owner:OneSupervisorOwner;oneId:string;request:McpInvocationRequest;purpose?:SupervisorHostNoticePurpose;epoch:string}):Promise<{runId:string}> {
  const {request}=input,origin=createSupervisorNativeOrigin(input.store,input.owner,input.oneId,request,input.purpose);
  const [{createRendererInvocationPreparation},{createLocalInvocationPreparationPort},{admitMainInvocation},{invocationService}]=await Promise.all([
    import('../invocation/renderer-preparation'),import('../invocation/native-start-checkpoints'),import('../runtime/scheduled-root-context'),import('../invocation/service')]);
  authorizeSupervisorNativeOrigin(origin,request);
  const admission={chatId:request.chatId,runId:request.runId!,canonicalRequestJson:canonicalInvocationRequestJson(request),ownerProcessEpoch:input.epoch};
  if(createInvocationAdmission(admission).kind!=='created')fail('supervisor_native_admission_not_fresh');
  const original=createRendererInvocationPreparation(admission);
  const port=createLocalInvocationPreparationPort({
    assertCurrent(binding){authorizeSupervisorNativeOrigin(origin,request);original.assertCurrent(binding);},
    judge:(value,signal)=>original.execute({chatId:request.chatId,runId:request.runId!,admission},{kind:'judge',payload:{request:value}},signal).then(()=>{}),
    cancel:binding=>original.cancel(binding),quiesce:(binding,status)=>original.quiesce(binding,status),finish:(binding,status)=>original.finish(binding,status),
  });
  const root=admitMainInvocation(request.chatId,request.runId);if(!root)fail('supervisor_native_root_required');
  return invocationService.startNativePrepared(request,port,root,admission,undefined,undefined,input.purpose);
}
