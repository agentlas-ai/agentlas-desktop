import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import {retainHistoryWorkOrigin} from './history-work-dispatch';
import { withOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import { getAuthenticatedActorIds } from "../auth";
import { getDb, STORE_SCHEMA_VERSION } from "../store/db";
import { ONE_SUPERVISOR_SCHEMA } from "../../shared/one-supervisor";
import { ONE_SUPERVISOR_JOURNAL_SCHEMA, ONE_SUPERVISOR_RUNTIME_PROTOCOL, ONE_SUPERVISOR_EXTENSIONS_SCHEMA, sameSupervisorRuntimeCompatibility } from "../../shared/one-supervisor-runtime";
import { importNativeJsonValue } from "../daemon/native-json-transfer";
import { NATIVE_MAIN_PREPARATION_POLICY } from "../daemon/native-invocation-policy";
import type { OneSupervisorService } from "./supervisor-service";
import { createHash, randomUUID } from "node:crypto";
import { createFreshReservationFrontier } from "../runtime/fresh-reservation-frontier";
import type { InvocationRunReceipt, McpInvocationRequest } from "../../shared/types";
import type { SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { canonicalInvocationRequestJson, createInvocationAdmission, decideInvocationAdmission, getInvocationAdmission, invocationProvenNotStarted, rearmRejectedInvocationAdmission, INVOCATION_ADMISSION_DIGEST_VERSION } from "../store/invocation-admissions";
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
  return (await import('./team-control-server')).dispatchOneSupervisorTool({chatId:request.chatId,supervisorReplyRunId:request.runId,permission:effectiveInvocationPermission(request.permissions,request.planMode)},name,input);
}
export function supervisorNativeNoticePurpose(origin: object, request: Readonly<McpInvocationRequest>): SupervisorHostNoticePurpose | undefined {
  authorizeSupervisorNativeOrigin(origin, request); return origins.get(origin)!.purpose;
}

export { supervisorCommandBinding } from "./supervisor-command-binding";
import { supervisorCommandBinding } from "./supervisor-command-binding";

/** Original durable command + exact identity/generation is the host producer.
 * This capability never crosses IPC and does not pretend to be a renderer. */
export function createSupervisorNativeOrigin(store: OneSupervisorStore, owner: OneSupervisorOwner,
  oneId: string, request: McpInvocationRequest, purpose?: SupervisorHostNoticePurpose, assertOriginal?: () => void): object {
  assertOriginal?.();
  const token = owner.assert(oneId),actor=JSON.stringify(getAuthenticatedActorIds());
  const rows = store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'")
    .all(oneId, request.runId) as SupervisorRequestRow[];
  if (rows.length !== 1) fail("supervisor_native_exact_command_required");
  const row = rows[0], binding = supervisorCommandBinding(store, oneId, row);
  if (binding.target !== request.chatId || binding.prompt !== request.userPrompt) fail("supervisor_native_command_binding_changed");
  if (row.source_reply_run_id && !store.db.prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind='reply'").get(oneId, row.source_reply_run_id)) {
    fail("supervisor_native_source_occurrence_missing");
  }
  assertSupervisorStartNotStopped(store,row);
  const source = Object.freeze({});
  origins.set(source, { request: canonicalInvocationRequestJson(request), purpose, assert() {
    assertOriginal?.();
    if(JSON.stringify(getAuthenticatedActorIds())!==actor)fail("supervisor_native_actor_changed");
    owner.assertToken(token);
    const current = store.get(row.command_id);
    if (!current || current.one_id !== oneId || current.run_id !== request.runId || current.payload_json !== row.payload_json
      || current.payload_hash !== row.payload_hash || current.source_reply_run_id !== row.source_reply_run_id
      || !["dispatching", "accepted"].includes(current.state)) fail("supervisor_native_command_fenced");
  } });
  retainHistoryWorkOrigin(source,request);
  return source;
}

/** A fresh producer capability cannot revive an exact occurrence the owner stopped.
 * Failed, rejected controls did not apply a Stop; a settled terminal race did. */
function assertSupervisorStartNotStopped(store:OneSupervisorStore,row:SupervisorRequestRow):void {
  const stopped=store.db.prepare(`SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND run_id=?
    AND (kind='stop-reply' OR (kind='cancel' AND task_id=?
      AND (state<>'failed' OR json_extract(receipt_json,'$.control.phase')='settled'
        OR json_extract(receipt_json,'$.reason') IN ('cancel_raced_terminal_outcome','interrupted_requires_review')))) LIMIT 1`)
    .get(row.one_id,row.run_id,row.task_id);
  if(stopped)fail('supervisor_native_original_start_cancelled');
}

export interface SupervisorNativeRuntimeBootstrap { owner: NativeOwner; getChannel(): Channel | undefined; onHandoff?():void }
let bootstrap: SupervisorNativeRuntimeBootstrap | undefined;
let mode:'local'|'handoff'|'daemon'='local';
let handoffTimer:NodeJS.Timeout|undefined;
let handoffBusy=false;
let handoffProposal:{oneId:string;ownerEpoch:string;generation:number}|undefined;
export function supervisorRuntimeMode(){return mode;}
/** Positional arguments for the wire (JSON has no undefined): trailing undefined ones mean the same as absent. Both the supervisor proxy and the personal-data proxy send `{method,args}` here. */
function withWireArgs(input:unknown):unknown{
  const args=(input as {args?:unknown}|null)?.args;
  if(!Array.isArray(args))return input;
  const wire=args.slice();while(wire.length&&wire[wire.length-1]===undefined)wire.pop();
  return{...(input as object),args:wire};
}
export async function callOneSupervisorRuntime(op:'status'|'adopt'|'command'|'harness.result'|'harness.action'|'questions.list'|'questions.answer'|'personal.command',input?:unknown):Promise<any> {
  const channel=bootstrap?.getChannel(),identity=channel && nativeGuiChannelIdentity(channel);
  if(!channel || !identity)fail('supervisor_native_channel_unavailable');
  const assertCurrent=()=>{if(nativeGuiChannelIdentity(channel)!==identity)fail('supervisor_native_channel_changed');};
  const wire=await channel.dispatch('native.attach',{version:ONE_SUPERVISOR_RUNTIME_PROTOCOL,op,...(input!==undefined?{input:op==='command'||op==='personal.command'?withWireArgs(input):input}:{})}) as {version?:string;bootId?:string;transfer?:unknown};
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
    const compatibility={protocol:ONE_SUPERVISOR_RUNTIME_PROTOCOL,supervisorSchema:ONE_SUPERVISOR_SCHEMA,journalSchema:ONE_SUPERVISOR_JOURNAL_SCHEMA,extensionsSchema:ONE_SUPERVISOR_EXTENSIONS_SCHEMA,storeSchema:STORE_SCHEMA_VERSION,nativeAbi:process.versions.modules};
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
    await (await import('./checkin-admission')).loadCheckinGates().catch(()=>undefined);
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
  const starts = new Map<string,{digest:string;refused:boolean}>();
  const stops = new Map<string,Promise<string>>();
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
  /** A start with no admission row, a rejected one (owner-start-boundary-not-crossed), or one the service refused before the start
   * boundary (a typed refusal of a start this process saw fail), left no run behind. Its pending
   * entry must go, or attach() reports a run that does not exist and drain() never starts another owner message. An admission
   * that is pending/admitted stays: the original attempt may be live and is reconciled from its receipt and custody. */
  function releaseIfNeverStarted(runId: string): void {
    try {
      const admission=getInvocationAdmission(runId);
      // A start this process saw refused counts the service's typed refusal before the start boundary too (invocationProvenNotStarted):
      // its pending reservation alone kept One's conversation locked and the domain hand-over waiting for good .
      const refusedHere=starts.get(runId)?.refused===true;
      if ((!admission || admission.status === "rejected" || (refusedHere && invocationProvenNotStarted(runId))) && !options.receipt(runId)
        && !getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(runId)) {
        const owner=invocationRunOwners.getOwnerByRunId(runId);
        if(!owner || owner.state==='released')pending.delete(runId);
      }
    } catch { /* Unknown proof/receipt/custody keeps the pending barrier. */ }
  }

  function poll(): void {
    if(!bootstrap)return;
    for (const runId of [...pending.keys()]) releaseIfNeverStarted(runId);
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
  async function cancelExact(runId:string):Promise<string> {
    // Local original cancellation is unconditional on viewer connectivity.
    // A disconnected original caches its failed ACK; retry that exact Stop via
    // the re-enrolled source capture, never by issuing another native start.
    const original=bootstrap?.owner,retained=original?.inspect(runId).retained;
    let originalError:unknown,originalFailed=false;
    if(retained)try { return await original!.cancel(runId); }
    catch(error) {
      originalError=error;originalFailed=true;
      if(!original!.inspect(runId).unavailable)throw error;
    }
    const {channel,identity}=current(),receipt=options.receipt(runId);
    const admission=retained ? getInvocationAdmission(runId) : null;
    const chatId=receipt?.chatId ?? admission?.chatId;
    const custody=chatId && invocationRunOwners.getRunOwner(chatId,runId);
    const received=receipt?.runId===runId && custody && custody.ownerKind==='daemon' && custody.ownerId===identity.bootId;
    // Before invoke_started/lease, only this retained original and its exact
    // pending same-boot reservation may use the daemon's captured Stop path.
    const preparing=retained && starts.has(runId) && chatId && pending.get(runId)===chatId
      && admission?.status==='pending' && admission.ownerProcessEpoch===identity.bootId
      && admission.digestVersion===INVOCATION_ADMISSION_DIGEST_VERSION && admission.inputDigest===starts.get(runId)?.digest
      && (!custody || custody.ownerKind==='daemon' && custody.ownerId===identity.bootId);
    if(!chatId || (!received && !preparing)) {
      if(originalFailed)throw originalError;
      return 'not-found';
    }
    const response=await channel.dispatch("invoke.cancel",{version:"agentlas.native-owner-stop.v1",chatId,runId}) as {version?:string;chatId?:string;runId?:string;status?:string};
    if(bootstrap?.getChannel()!==channel || nativeGuiChannelIdentity(channel)!==identity
      || response?.version!=="agentlas.native-owner-stop.v1" || response.chatId!==chatId || response.runId!==runId
      || !["requested","already-requested","not-found"].includes(response.status ?? ""))fail("supervisor_native_stop_ack_invalid");
    return response.status!;
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
      if (!request.runId) fail("supervisor_native_start_replayed");
      const digest=createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION+"\0").update(canonicalInvocationRequestJson(request)).digest("hex"),prior=starts.get(request.runId);
      if(prior) {
        // A rejected promise alone is not proof. Lost ACK, live preparation and
        // admitted/retained custody never authorize a second start.
        if(!prior.refused || prior.digest!==digest)fail("supervisor_native_start_replayed");
        releaseIfNeverStarted(request.runId);
        if(pending.has(request.runId))fail("supervisor_native_start_replayed");
        const admission=getInvocationAdmission(request.runId);
        if(admission && admission.status!=="rejected")fail("supervisor_native_start_replayed");
        if(options.receipt(request.runId)
          || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(request.runId))fail("supervisor_native_start_replayed");
        const custody=invocationRunOwners.getOwnerByRunId(request.runId);
        if(custody && custody.state!=="released")fail("supervisor_native_start_replayed");
      }
      const origin = createSupervisorNativeOrigin(options.store, options.owner, options.identity(), request, purpose);
      const attempt={digest,refused:false};
      starts.set(request.runId,attempt); pending.set(request.runId, request.chatId);
      // Original owner has one admission and one actual start. A lost response
      // stays uncertain and is reconciled using exact durable custody/receipts.
      let actual: Promise<{ runId: string }>;
      // startHost refuses synchronously before it reserves anything (channel not ready, capacity, fenced command); only a
      // returned promise can describe an attempt, so a throw here must not leave the entry behind.
      try { actual = withOnePersonalNativeOriginal(origin,request,()=>value.owner.startHost(origin, request)); }
      catch (error) { attempt.refused=true;releaseIfNeverStarted(request.runId); throw error; }
      void actual.then(() => { if(starts.get(request.runId!)===attempt)pending.delete(request.runId!); poll(); }, () => {
        if(starts.get(request.runId!)!==attempt)return;
        attempt.refused=true;releaseIfNeverStarted(request.runId!);
      });
      return actual;
    },
    cancel(runId: string): Promise<string> {
      const prior=stops.get(runId);if(prior)return prior;
      let resolve!:(value:string)=>void,reject!:(error:unknown)=>void;
      const attempt=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});
      stops.set(runId,attempt); // Before local revoke or a reentrant transport callback.
      const clear=()=>{if(stops.get(runId)===attempt)stops.delete(runId);};
      void cancelExact(runId).then(value=>{clear();resolve(value);},error=>{clear();reject(error);});
      return attempt;
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
  const row=input.store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'").get(input.oneId,request.runId) as SupervisorRequestRow|undefined;
  if(!row)fail('supervisor_native_exact_command_required');
  assertSupervisorStartNotStopped(input.store,row);
  // Fresh issuer authorization above and the store CAS preserve the exact
  // canonical input, no-start receipt and released-lease requirements.
  if(getInvocationAdmission(admission.runId)?.status==='rejected') {
    if(rearmRejectedInvocationAdmission(admission).kind!=='created')fail('supervisor_native_admission_not_fresh');
  } else if(createInvocationAdmission(admission).kind!=='created')fail('supervisor_native_admission_not_fresh');
  const frontier=createFreshReservationFrontier({
    tryReject:()=>getDb().transaction(()=>{
      if(invocationRunOwners.getOwnerByRunId(admission.runId))return false;
      return decideInvocationAdmission({...admission,decision:"rejected",reasonCode:"supervisor_local_setup_refused",
        noStartProof:{kind:"owner-start-boundary-not-crossed",verifiedOwnerProcessEpoch:admission.ownerProcessEpoch}}).kind==="rejected";
    }).immediate(),
    schedule:(retry,delayMs)=>{setTimeout(retry,delayMs).unref();},
    onFailure:()=>console.warn("[one-supervisor] exact unstarted child reservation cleanup pending",{runId:admission.runId}),
  });
  try {
    const original=createRendererInvocationPreparation(admission);
    const port=createLocalInvocationPreparationPort({
      assertCurrent(binding){authorizeSupervisorNativeOrigin(origin,request);original.assertCurrent(binding);},
      judge:(value,signal)=>original.execute({chatId:request.chatId,runId:request.runId!,admission},{kind:'judge',payload:{request:value}},signal).then(()=>{}),
      cancel:binding=>original.cancel(binding),quiesce:(binding,status)=>original.quiesce(binding,status),finish:(binding,status)=>original.finish(binding,status),
    });
    const root=admitMainInvocation(request.chatId,request.runId);if(!root)fail('supervisor_native_root_required');
    return withOnePersonalNativeOriginal(origin,request,()=>frontier.enterSource(()=>invocationService.startNativePrepared(request,port,root,admission,undefined,undefined,input.purpose)));
  } catch(error) {
    frontier.closeBeforeSource();
    throw error;
  }
}
