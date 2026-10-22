import {randomUUID} from 'node:crypto';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import type {SupervisorRequestRow} from '../one/supervisor-store';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import {businessEmployeeAgentText} from '../../shared/business/employee-agent-report';

/** Local result custody, separate from Root's organization admission. No epoch or
 * organization permission is issued here. Original execution receipts are read,
 * never replayed; an explicit share acceptance has its own durable receipt. */
export interface NativeEmployeeResult {
 readonly nativeActor:{principalId:string;sessionId:string;workspaceId:string;hostId:string;oneId:string};
 readonly custodyGeneration:string;
 readonly commandId:string;readonly taskId:string;readonly runId:string;readonly chatId:string;readonly originChatId:string;
 readonly controlVersion:string;readonly leaseId:string;readonly payloadHash:string;readonly nativeInputDigest:string;
 readonly inputRevision:string;readonly resultReceiptId:string;readonly resultDigest:string;
 readonly profile:{oneId:string;version:number;displayName:string;role:string};
}
export interface NativeEmployeeAcceptedResult {
 readonly acceptanceId:string;readonly revision:number;readonly acceptedAt:string;readonly summary:string;
 readonly associationId:string;readonly associationRevision:number;readonly sourceRevision:string;readonly consentRevision:string;
 readonly original:NativeEmployeeResult;
}
function deny():never{throw Error('business_native_original_result_unavailable')}
/** Lazily load existing original readers only after the explicit focused action.
 * Construction opens no DB, starts no collection and reads no personal history. */
export function createNativeEmployeeResultSource(runtime:OneVaultRuntime){
 let closed=false;const nativeReferences=[runtime.currentNativeOwner,runtime.sources,runtime.sources.db,runtime.sources.oneId];
 let readers:Promise<{read(commandId:string):NativeEmployeeResult;title(taskId:string):string|null}>|null=null;
 const capabilities=new WeakMap<object,{id:string;record:string}>(),listeners=new Set<(capability:object)=>void>();
 function schema(){runtime.sources.db.exec(`CREATE TABLE IF NOT EXISTS one_business_native_accepted_results(
  acceptance_id TEXT PRIMARY KEY,association_id TEXT NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL);`)}
 async function originalReaders(){
  if(!readers)readers=Promise.all([import('../store/db'),import('../store/one-profile'),import('../store/tasks'),import('../store/run-events'),import('../store/one-surface-results'),import('../one/accepted-result-value-closure'),import('../one/supervisor'),import('../store/invocation-run-owners'),import('../store/invocation-admissions')]).then(([store,profile,tasks,runs,surfaces,accepted,supervisor,owners,admissions])=>{const references=()=>[store.getDb,profile.getOneProfile,tasks.getCanonicalTask,tasks.hasPassedTaskForceExecutionVerification,runs.getInvocationRunReceipt,runs.ONE_SURFACE_SNAPSHOT_EVENT_KIND,surfaces.getDurableOneSurfaceResult,accepted.readExactAcceptedResultValueClosure,supervisor.currentOneNativeWorkControl,owners.invocationRunOwners,owners.invocationRunOwners.getRunOwner,admissions.getInvocationAdmission];const originals=references();return {read(commandId:string){
   if(references().some((v,i)=>v!==originals[i])||[runtime.currentNativeOwner,runtime.sources,runtime.sources.db,runtime.sources.oneId].some((v,i)=>v!==nativeReferences[i]))deny();
   if(closed||store.getDb()!==runtime.sources.db)deny();const owner=runtime.currentNativeOwner();if(!owner)deny();
   const one=profile.getOneProfile();if(one.oneId!==runtime.sources.oneId())deny();
   const row=runtime.sources.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=? AND one_id=?').get(commandId,one.oneId) as SupervisorRequestRow|undefined;
   if(!row||row.state!=='completed'||!row.task_id||!row.run_id||row.kind!=='work')deny();
   const task=tasks.getCanonicalTask(row.task_id),run=runs.getInvocationRunReceipt(row.run_id);
   if(!task||task.archivedAt||task.status!=='completed'||!task.originChatId||run?.status!=='completed'||run.chatId!==task.originChatId||!tasks.hasPassedTaskForceExecutionVerification(row.run_id))deny();
   let payload:{workerChatId?:unknown};try{payload=JSON.parse(row.payload_json)}catch{return deny()}
   const job=runtime.sources.db.prepare('SELECT * FROM one_supervisor_work_jobs WHERE command_id=?').get(row.command_id) as {one_id:string;task_id:string;run_id:string;chat_id:string;phase:string}|undefined;
   if(payload.workerChatId!==task.originChatId||!job||job.one_id!==one.oneId||job.task_id!==task.id||job.run_id!==row.run_id||job.chat_id!==task.originChatId||job.phase!=='completed')deny();
   const lease=owners.invocationRunOwners.getRunOwner(task.originChatId,row.run_id),input=admissions.getInvocationAdmission(row.run_id);
   if(lease?.state!=='released'||lease.chatId!==task.originChatId||lease.runId!==row.run_id||input?.runId!==row.run_id||input?.status!=='admitted'||input.chatId!==task.originChatId||input.ownerProcessEpoch!==lease.ownerId||input.digestVersion!=='main-canonical-json-v1'||!input.admittedAt)deny();
   const control=supervisor.currentOneNativeWorkControl(row,'result'),result=surfaces.getDurableOneSurfaceResult({taskId:task.id,chatId:task.originChatId,runId:row.run_id});
   if(!control)deny();
   // A malformed existing OneSurface must not turn into an absent-Surface
   // fallback. The original strict reader remains authoritative when present.
   if(!result&&runtime.sources.db.prepare('SELECT 1 FROM run_events WHERE run_id=? AND kind=? LIMIT 1').get(row.run_id,runs.ONE_SURFACE_SNAPSHOT_EVENT_KIND))deny();
   const exact=result?null:accepted.readExactAcceptedResultValueClosure(task.id,row.run_id);
   if(result&&(!result.manifest.taskId||result.manifest.taskId!==task.id||!result.manifest.manifestId))deny();
   if(!result&&!exact)deny();
   const next=runtime.currentNativeOwner();if(!next||digest(next)!==digest(owner))deny();
   return {nativeActor:{principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,hostId:owner.hostId,oneId:one.oneId},custodyGeneration:owner.custodyGeneration,
    commandId:row.command_id,taskId:task.id,runId:row.run_id,chatId:task.originChatId,originChatId:row.origin_chat_id,controlVersion:control,leaseId:lease.leaseId,payloadHash:row.payload_hash,nativeInputDigest:input.inputDigest,
    inputRevision:input.admittedAt,resultReceiptId:result?result.manifest.manifestId:exact!.record.closure.valueClosureId,
    resultDigest:result?digest(result.manifest):digest(exact),profile:{oneId:one.oneId,version:one.version,displayName:one.displayName,role:one.role}};
  },title(taskId:string){if(references().some((v,i)=>v!==originals[i]))deny();const title=tasks.getCanonicalTask(taskId)?.title;return businessEmployeeAgentText(title,120)?title:null;}}});return readers;
 }
 async function inspect(commandId:string){if(typeof commandId!=='string'||!commandId||commandId.length>256)deny();const original=await originalReaders();return runtime.sources.db.transaction(()=>structuredClone(original.read(commandId))).immediate();}
 function read(capability:object):NativeEmployeeAcceptedResult|null{
  try{if(closed)return null;const cap=capabilities.get(capability);if(!cap)return null;const row=runtime.sources.db.prepare("SELECT record_json FROM one_business_native_accepted_results WHERE acceptance_id=? AND state='accepted'").get(cap.id) as {record_json:string}|undefined;
   return row&&row.record_json===cap.record?JSON.parse(row.record_json):null;
  }catch{return null;}
 }
 /** Caller is the concrete focused native review owner. It supplies its retained
  * exact inspected original and approved disclosure, never a renderer approved flag. */
 async function accept(input:Omit<NativeEmployeeAcceptedResult,'acceptanceId'|'revision'|'acceptedAt'>,assertApproved:()=>void,checkpoint?:(record:Readonly<NativeEmployeeAcceptedResult>,capability:object)=>void){
  if(!businessEmployeeAgentText(input.summary))deny();const original=await originalReaders();schema();
  const capability=Object.freeze({});const record=runtime.sources.db.transaction(()=>{assertApproved();if(digest(original.read(input.original.commandId))!==digest(input.original))deny();
   const value:NativeEmployeeAcceptedResult={...structuredClone(input),acceptanceId:randomUUID(),revision:0,acceptedAt:new Date().toISOString()};
   runtime.sources.db.prepare("INSERT INTO one_business_native_accepted_results VALUES(?,?,'accepted',?)").run(value.acceptanceId,value.associationId,JSON.stringify(value));checkpoint?.(Object.freeze(structuredClone(value)),capability);assertApproved();if(digest(original.read(input.original.commandId))!==digest(input.original))deny();return value;
  }).immediate();capabilities.set(capability,{id:record.acceptanceId,record:JSON.stringify(record)});
  // Original durable reducer commits before notifications. Listeners receive only
  // opaque original handles; their exceptions cannot undo a completed acceptance.
  for(const listener of listeners)try{listener(capability)}catch{/* listener failure is reconciled by exact receipt lookup */}
  return capability;
 }
 async function restore(acceptanceId:string){
  schema();const original=await originalReaders();return runtime.sources.db.transaction(()=>{const row=runtime.sources.db.prepare("SELECT record_json FROM one_business_native_accepted_results WHERE acceptance_id=? AND state='accepted'").get(acceptanceId) as {record_json:string}|undefined;if(!row)deny();const value=JSON.parse(row.record_json) as NativeEmployeeAcceptedResult;
   if(digest(original.read(value.original.commandId))!==digest(value.original))deny();const capability=Object.freeze({});capabilities.set(capability,{id:acceptanceId,record:row.record_json});return capability;
  }).immediate();
 }
 async function withCurrent<T>(capability:object,reduce:(record:Readonly<NativeEmployeeAcceptedResult>)=>T):Promise<T>{const original=await originalReaders();return runtime.sources.db.transaction(()=>{const value=read(capability);if(!value||digest(original.read(value.original.commandId))!==digest(value.original))deny();const result=reduce(Object.freeze(structuredClone(value)));if(result&&typeof (result as {then?:unknown}).then==='function')deny();if(!read(capability)||digest(original.read(value.original.commandId))!==digest(value.original))deny();return result;}).immediate();}
 async function completedWork(){const original=await originalReaders();return runtime.sources.db.transaction(()=>{
  const rows=runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND kind='work' AND state='completed' ORDER BY updated_at DESC LIMIT 100").all(runtime.sources.oneId()) as Array<{command_id:string}>;
  return rows.flatMap(row=>{try{const value=original.read(row.command_id),title=original.title(value.taskId);if(digest(original.read(row.command_id))!==digest(value))deny();return[{commandId:value.commandId,taskId:value.taskId,runId:value.runId,title}]}catch{return[]}});
 }).immediate()}
 return Object.freeze({inspect,completedWork,accept,read,restore,withCurrent,
  subscribeAccepted(listener:(capability:object)=>void){if(closed)deny();listeners.add(listener);return()=>{listeners.delete(listener)}},
  revokeAssociation(associationId:string){schema();runtime.sources.db.prepare("UPDATE one_business_native_accepted_results SET state='revoked' WHERE association_id=?").run(associationId)},
  close(){closed=true;listeners.clear()},
 });
}
