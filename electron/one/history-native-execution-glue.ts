import type Database from 'better-sqlite3';
import type { InvocationRunOwner } from '../store/invocation-owner-core';
import type { HistoryEvolutionCandidate, EvolutionEnvelope } from '../../shared/one-history-evolution';
import type { PersonalDataTarget } from '../../shared/one-personal-data';
import type { NativeHistoryActor, NativeHistoryEvolutionService } from './history-evolution-native';
import { personalDataHash, personalDataId, personalDataTarget, personalDataError } from './personal-data-store';

export interface HistoryNativeCommandBinding {
  commandId:string;candidateId:string;target:PersonalDataTarget;revision:number;envelopeDigest:string;purpose:'draft'|'run';
  taskId:string;runId:string;chatId:string;envelope:EvolutionEnvelope;
}
/** Opaque process-local custody. A JSON copy never becomes an execution capability. */
export interface HistoryNativeRunToken {readonly historyNativeRun: true}
export interface HistoryNativeExecutionPorts {
  db:Database.Database;actor():NativeHistoryActor;assertOwner():void;
  service():NativeHistoryEvolutionService|null;
  processOwner():Pick<InvocationRunOwner,'ownerId'|'ownerKind'>;
  getRunOwner(chatId:string,runId:string):InvocationRunOwner|null;
  canonicalTask(taskId:string):{id:string;originChatId:string|null}|null;
  /** At claim/dispatch check current admission eligibility; at provider/tool inspect the EXISTING reservation and current policy. Never reserve again. */
  assertCurrentBudget(binding:Readonly<HistoryNativeCommandBinding>,stage:'claim'|'dispatch'|'provider'|'tool'):void;
  /** Native registry/asset adapter resolves actual touched resources, including asset/version identity.
   * Null means unknown and denies. Model-provided resource lists are not authority. */
  resolveToolResources(input:{binding:Readonly<HistoryNativeCommandBinding>;toolRef:string;request:unknown}):readonly string[]|null;
}
type PersistedBinding=Pick<HistoryNativeCommandBinding,'commandId'|'candidateId'|'target'|'revision'|'envelopeDigest'|'purpose'>&{actor:NativeHistoryActor};
interface Witness {binding:HistoryNativeCommandBinding;bindingDigest:string;requestDigest:string;actorDigest:string;owner:InvocationRunOwner}
function fail(code:string):never{throw personalDataError(code);}
/** Reuses the original Supervisor records and invocation lease. Does not create a queue, timer or schema. */
export function createHistoryNativeExecution(ports:HistoryNativeExecutionPorts){
  const witnesses=new WeakMap<object,Witness>(),runs=new Map<string,HistoryNativeRunToken>();
  const hasTable=(name:string)=>Boolean(ports.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const configured=()=>ports.service()??fail('history_native_execution_adapter_required');
  const lookup=(selector:{commandId?:string;runId?:string},stage:'claim'|'dispatch'='dispatch'):{binding:HistoryNativeCommandBinding;requestDigest:string;bindingDigest:string}|null=>{
    if(!hasTable('one_history_native_bindings'))return null;
    let rows:Array<{value_json:string;command_id:string}>;
    if(selector.commandId)rows=ports.db.prepare('SELECT command_id,value_json FROM one_history_native_bindings WHERE command_id=?').all(personalDataId(selector.commandId)) as typeof rows;
    else {personalDataId(selector.runId);if(!hasTable('one_supervisor_requests'))fail('history_native_original_command_required');rows=ports.db.prepare(`SELECT b.command_id,b.value_json FROM one_history_native_bindings b JOIN one_supervisor_requests r ON r.command_id=b.command_id WHERE r.run_id=?`).all(selector.runId) as typeof rows;}
    if(!rows.length)return null;if(rows.length!==1)fail('history_native_ambiguous_original_command');
    ports.assertOwner();if(ports.db.inTransaction)fail('history_native_uncommitted_request');
    let b:PersistedBinding;try{b=JSON.parse(rows[0].value_json);personalDataTarget(b.target);personalDataId(b.candidateId);}catch{fail('history_native_binding_invalid');}
    const a=ports.actor();if(b.commandId!==rows[0].command_id||b.target.oneId!==a.oneId||b.target.deploymentId!==a.hostId||personalDataHash(b.actor)!==personalDataHash(a))fail('history_native_session_changed');
    configured().assertCommand(b.commandId);
    const request=ports.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(b.commandId) as {one_id:string;kind:string;state:string;task_id:string|null;run_id:string|null;payload_json:string;payload_hash:string}|undefined;
    if(!request||request.kind!=='work'||request.one_id!==a.oneId||!(stage==='claim'?['stored']:['dispatching','accepted']).includes(request.state)||!request.task_id||!request.run_id)fail('history_native_original_command_required');
    let chatId:string;try{chatId=JSON.parse(request.payload_json).workerChatId;personalDataId(chatId);}catch{fail('history_native_original_command_required');}
    if(selector.runId&&request.run_id!==selector.runId)fail('history_native_original_command_required');
    const task=ports.canonicalTask(request.task_id);if(task?.id!==request.task_id||task.originChatId!==chatId)fail('history_native_original_command_required');
    const row=ports.db.prepare('SELECT value_json FROM one_history_evolution_candidates WHERE candidate_id=?').get(b.candidateId) as {value_json:string}|undefined;
    if(!row)fail('history_native_candidate_missing');const candidate=JSON.parse(row.value_json) as HistoryEvolutionCandidate;
    if(candidate.revision!==b.revision||personalDataHash(candidate.target)!==personalDataHash(b.target)||personalDataHash(candidate.envelope)!==b.envelopeDigest||(b.purpose==='draft'?candidate.generationCommandId:candidate.runCommandId)!==b.commandId||!['draft','run'].includes(b.purpose))fail('history_native_execution_binding_changed');
    return {binding:{commandId:b.commandId,candidateId:b.candidateId,target:structuredClone(b.target),revision:b.revision,envelopeDigest:b.envelopeDigest,purpose:b.purpose,taskId:request.task_id,runId:request.run_id,chatId,envelope:structuredClone(candidate.envelope)},bindingDigest:personalDataHash(b),requestDigest:personalDataHash([request.payload_json,request.payload_hash,request.task_id,request.run_id])};
  };
  const assertCommand=(commandId:string,stage:'claim'|'dispatch'='dispatch'):HistoryNativeCommandBinding|null=>{const current=lookup({commandId},stage);if(!current)return null;ports.assertCurrentBudget(current.binding,stage);return current.binding;};
  const assertLease=(binding:HistoryNativeCommandBinding,expected?:InvocationRunOwner)=>{
    const lease=ports.getRunOwner(binding.chatId,binding.runId),process=ports.processOwner();
    if(!lease||lease.state!=='active'||lease.chatId!==binding.chatId||lease.runId!==binding.runId||lease.ownerId!==process.ownerId||lease.ownerKind!==process.ownerKind||expected&&lease.leaseId!==expected.leaseId)fail('history_native_invocation_custody_required');return lease;
  };
  const assertToken=(token:HistoryNativeRunToken,stage:'provider'|'tool'='provider'):HistoryNativeCommandBinding=>{
    const w=witnesses.get(token);if(!w)fail('history_native_run_capability_required');const current=lookup({commandId:w.binding.commandId,runId:w.binding.runId});
    if(!current||current.bindingDigest!==w.bindingDigest||current.requestDigest!==w.requestDigest||personalDataHash(current.binding)!==personalDataHash(w.binding)||personalDataHash(ports.actor())!==w.actorDigest)fail('history_native_execution_binding_changed');
    assertLease(current.binding,w.owner);ports.assertCurrentBudget(current.binding,stage);return current.binding;
  };
  /** Call AFTER existing native lease claim, before the invocation reaches any provider. */
  const bindRun=(input:{runId:string;chatId:string;commandId?:string}):HistoryNativeRunToken|null=>{
    const current=lookup({runId:input.runId});if(!current)return null;
    if(current.binding.chatId!==input.chatId||input.commandId&&current.binding.commandId!==input.commandId)fail('history_native_original_command_required');
    const existing=runs.get(input.runId);if(existing){assertToken(existing);return existing;}
    const owner=assertLease(current.binding);ports.assertCurrentBudget(current.binding,'provider');const token=Object.freeze({historyNativeRun:true as const});
    witnesses.set(token,{...current,actorDigest:personalDataHash(ports.actor()),owner:structuredClone(owner)});runs.set(input.runId,token);return token;
  };
  /** Every native provider/tool callback must pass through this, including callbacks inside builders. */
  const assertRun=(input:{runId:string;chatId:string}):HistoryNativeRunToken|null=>{
    const current=lookup({runId:input.runId});if(!current)return null;if(current.binding.chatId!==input.chatId)fail('history_native_original_command_required');
    const token=runs.get(input.runId);if(!token)fail('history_native_run_not_bound');assertToken(token);return token;
  };
  const assertTool=(token:HistoryNativeRunToken,input:{toolRef:string;request:unknown}):HistoryNativeCommandBinding=>{
    const b=assertToken(token,'tool');if(!b.envelope.toolRefs.includes(input.toolRef))fail('history_native_tool_outside_envelope');
    const resources=ports.resolveToolResources({binding:b,...input});if(!resources||resources.some(ref=>!b.envelope.resourceRefs.includes(ref)))fail('history_native_resource_outside_envelope');
    assertToken(token,'tool');return b;
  };
  const readBoundSource=(token:HistoryNativeRunToken)=>{const b=assertToken(token);return configured().readBoundObservations(b);};
  const withProvider=async<T>(token:HistoryNativeRunToken,execute:()=>Promise<T>):Promise<T>=>{assertToken(token);const result=await execute();assertToken(token);return result;};
  const withTool=async<T>(token:HistoryNativeRunToken,input:{toolRef:string;request:unknown},execute:()=>Promise<T>):Promise<T>=>{assertTool(token,input);const digest=personalDataHash(input);const result=await execute();if(personalDataHash(input)!==digest)fail('history_native_tool_request_changed');assertTool(token,input);return result;};
  const withProducer=async<T>(token:HistoryNativeRunToken,input:{kind:'skill'|'toolchain'|'agent';toolRef:string;request:unknown},execute:Parameters<NativeHistoryEvolutionService['withBoundBuilders']>[1]):Promise<T>=>{
    const digest=personalDataHash(input),b=assertTool(token,input);if(b.purpose!=='draft'||!b.envelope.allowedKinds.includes(input.kind))fail('history_native_asset_outside_envelope');
    const result=await configured().withBoundBuilders(b,async producers=>{assertTool(token,input);const value=await execute(producers);assertTool(token,input);return value;});assertTool(token,input);if(personalDataHash(input)!==digest)fail('history_native_tool_request_changed');return result as T;
  };
  return {assertCommand,bindRun,assertRun,assertToken,assertTool,readBoundSource,withProvider,withTool,withProducer,
    forgetRun(runId:string){const token=runs.get(runId);if(token)witnesses.delete(token);runs.delete(runId);},close(){for(const token of runs.values())witnesses.delete(token);runs.clear();}};
}

/** Reads only current native identity/store/custody. Construction never reads History or calls a provider. */
export async function createDefaultHistoryNativeExecution(input:Pick<HistoryNativeExecutionPorts,'service'|'assertCurrentBudget'|'resolveToolResources'>){
  const [db,auth,profile,host,tasks,owners,supervisor]=await Promise.all([import('../store/db'),import('../auth'),import('../store/one-profile'),import('./host-identity'),import('../store/tasks'),import('../store/invocation-run-owners'),import('./supervisor')]);
  return createHistoryNativeExecution({...input,db:db.getDb(),actor:()=>{const s=auth.getAuthenticatedSessionBinding();if(!s||s.expiresAt!==null&&s.expiresAt<=Date.now())fail('history_native_sign_in_required');return {principalId:s.userId,sessionId:s.sessionId,workspaceId:s.workspaceId,oneId:profile.getOneProfile().oneId,hostId:host.oneNativeHostIdentity().hostId};},
    assertOwner:()=>supervisor.oneSupervisor().assertHostWriteAuthority(profile.getOneProfile().oneId),canonicalTask:tasks.getCanonicalTask,processOwner:owners.invocationProcessOwner,getRunOwner:owners.invocationRunOwners.getRunOwner});
}
