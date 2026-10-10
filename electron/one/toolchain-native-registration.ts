import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { supervisorHash, type SupervisorRequestRow } from './supervisor-store';
import type { InvocationRunOwner } from '../store/invocation-owner-core';
import type { InvocationAdmission } from '../store/invocation-admissions';
import type { ToolchainAssetVersion, ToolchainCallReceipt } from '../../shared/toolchain-asset';
import type { BusinessOpaqueSource } from '../../shared/business/native-registry';
import type { BusinessToolchainNativeRequest, BusinessToolchainEffectIdentity, BusinessToolchainEffectExclusion, BusinessToolchainEffectResult, BusinessPreparedNativeAction } from '../../shared/business/native-action-ports';
import { sha256Value } from '../../shared/graph-execution-digest';
import { getToolchainAsset } from '../toolchains/assets';
import { getToolchainCall } from '../toolchains/calls';
import { getChat } from '../store/chats';

export type OneToolchainPhase='report'|'notice'|'read-reports'|'repair';
export interface OneToolchainNativeActor {principalId:string;sessionId:string;workspaceId:string;oneId:string;hostId:string}
/** This token is usable only by the issuing instance; copying JSON never creates custody. */
export interface OneToolchainOriginalWorkToken {readonly oneToolchainOriginalWork:true}
export interface OneToolchainOriginalWork {
  readonly actor:OneToolchainNativeActor;readonly kind:'task'|'reply';readonly commandId:string;readonly taskId:string|null;readonly runId:string;
  readonly controlVersion:string|null;readonly replyAuthorityRevision:string|null;readonly chatId:string;readonly originChatId:string;readonly leaseId:string;
  readonly payloadHash:string;readonly nativeInputDigest:string;readonly budgetId:string|null;readonly budgetRevision:number|null;
}
export interface OneToolchainReleaseRef {toolchainId:string;version:number;contentHash:string}
/** Native canonical ownership/consent registration, not a creator chat or local asset row.
 * The current owner supplies opaque revisions. This module never mints grants or generations. */
export interface OneToolchainResourceRegistration {
  readonly registrationId:string;readonly revision:string;readonly release:OneToolchainReleaseRef;
  readonly resourceId:string;readonly ownerPrincipalId:string;
  readonly scope:'personal'|'project'|'organization';readonly organizationId:string|null;readonly projectId:string|null;
  readonly sources:readonly BusinessOpaqueSource[];readonly permissionRevision:string;readonly consentRevision:string;
  readonly tombstoneRevision:string;readonly credentialGeneration:string|null;
}
export interface OneToolchainAudienceRegistration {
  readonly registrationId:string;readonly revision:string;readonly chatId:string;readonly resourceId:string;
  readonly principalId:string;readonly scope:'personal'|'project'|'organization';readonly organizationId:string|null;readonly projectId:string|null;
}
export type OneToolchainCallerCallMetadata=Pick<ToolchainCallReceipt,'schemaVersion'|'id'|'toolchainId'|'version'|'requestId'|'callerChatId'|'parentRunId'|'contentHash'|'inputHash'|'status'|'ok'|'runId'|'startedAt'|'completedAt'|'dryRun'>;
export interface OneToolchainRetainedCallRegistration {
  readonly registrationId:string;readonly revision:string;readonly call:OneToolchainCallerCallMetadata;
  readonly producer:OneToolchainOriginalWork;readonly assetRegistrationId:string;readonly assetRegistrationRevision:string;
}
export interface OneToolchainOwnedPhaseInput {
  readonly phase:OneToolchainPhase;readonly original:OneToolchainOriginalWork;readonly asset:OneToolchainResourceRegistration;
  readonly callerCall:OneToolchainCallerCallMetadata|null;readonly recipient:OneToolchainAudienceRegistration;readonly bodyDigest:string;
  readonly retainedCall:OneToolchainRetainedCallRegistration|null;
}
/** Structural mirror of parent's native-only async report admission port. No report bytes. */
export interface OneToolchainReportAdmissionRequest {
  readonly action:OneToolchainPhase;readonly callerChatId:string;readonly recipientChatId:string;readonly bodyDigest:string;
  readonly ref:OneToolchainReleaseRef&{callId:string|null;callInputHash:string|null;callRunId:string|null;sourceCallerChatId:string|null};
  readonly replacement?:{version:number;contentHash:string};
  readonly reportId?:string;readonly reportRevision?:string|null;
}
export interface OneToolchainReportExclusion {
  current():boolean;readonly reportId:string|null;readonly reportRevision:string|null;
}
export interface OneToolchainReportIntentRegistration {
  readonly registrationId:string;readonly revision:string;readonly request:BusinessToolchainNativeRequest;
  readonly reportId:string;readonly reportRevision:string|null;readonly effect:BusinessToolchainEffectIdentity;
}
export interface OneToolchainBusinessFacade {
  prepareCurrentAction(request:Readonly<BusinessToolchainNativeRequest>):Promise<BusinessPreparedNativeAction>;
  withCurrentExclusion<T>(requests:readonly Readonly<BusinessToolchainNativeRequest>[],reducer:(exclusion:Readonly<BusinessToolchainEffectExclusion>)=>T):Promise<BusinessToolchainEffectResult<T>>;
}
/** REQUIRED shipping owner port. Test callback implementations are synthetic/unbound proof.
 * registerProduced is called only from an actual producer callback inside original native
 * custody, after a real immutable version commit. No passive inventory migration/replay. */
export interface OneToolchainResourceOwnerPort {
  registerProduced(input:Readonly<{original:OneToolchainOriginalWork;release:OneToolchainReleaseRef;sourceManifest:readonly BusinessOpaqueSource[]}>):Promise<OneToolchainResourceRegistration|null>;
  resolveAsset(ref:Readonly<OneToolchainReleaseRef>):Promise<OneToolchainResourceRegistration|null>;
  resolveAudience(input:Readonly<{original:OneToolchainOriginalWork;asset:OneToolchainResourceRegistration;chatId:string}>):Promise<OneToolchainAudienceRegistration|null>;
  /** Only the actual native call producer registers this before its receipt is returned.
   * A model-supplied callId, passive inventory or later viewer cannot mint this custody. */
  registerCall(input:Readonly<{original:OneToolchainOriginalWork;asset:OneToolchainResourceRegistration;call:OneToolchainCallerCallMetadata}>):Promise<OneToolchainRetainedCallRegistration|null>;
  resolveCall(input:Readonly<{original:OneToolchainOriginalWork;asset:OneToolchainResourceRegistration;call:OneToolchainCallerCallMetadata}>):Promise<OneToolchainRetainedCallRegistration|null>;
  currentCall(registration:Readonly<OneToolchainRetainedCallRegistration>,asset:Readonly<OneToolchainResourceRegistration>,original:Readonly<OneToolchainOriginalWork>):boolean;
  /** Existing owner selects/looks up originalWorkRef, canonical report resource,
   * reportId/revision, effectId/domain, purpose/payer and full actual Business request.
   * No id is inferred from model input, provenance, body hash or a random UUID here. */
  resolveReportIntent(input:Readonly<{phase:OneToolchainOwnedPhaseInput;request:OneToolchainReportAdmissionRequest}>):Promise<OneToolchainReportIntentRegistration|null>;
  currentReportIntent(intent:Readonly<OneToolchainReportIntentRegistration>,phase:Readonly<OneToolchainOwnedPhaseInput>):boolean;
  ownerConversation(actor:Readonly<OneToolchainNativeActor>):string|null;
  currentAsset(registration:Readonly<OneToolchainResourceRegistration>,original:Readonly<OneToolchainOriginalWork>):boolean;
  currentAudience(registration:Readonly<OneToolchainAudienceRegistration>,original:Readonly<OneToolchainOriginalWork>):boolean;
}
export interface OneToolchainOriginalWorkPorts {
  db:Database.Database;actor():OneToolchainNativeActor;assertOwner():void;
  canonicalTask(taskId:string):{id:string;originChatId:string|null}|null;
  processOwner():Pick<InvocationRunOwner,'ownerId'|'ownerKind'>;
  getRunOwner(chatId:string,runId:string):InvocationRunOwner|null;
  getAdmission(runId:string):InvocationAdmission|null;
  currentControl(row:Readonly<SupervisorRequestRow>):string|null;
  currentReply(row:Readonly<SupervisorRequestRow>):{revision:string;admissionDigest:string;stillCurrent():boolean}|null;
  currentBudget(commandId:string,budgetId:string):{admitted:boolean;revision:number|null}|null;
  /** Exact budget binding comes from the existing command owner, not caller arguments. */
  commandBudget(row:Readonly<SupervisorRequestRow>):string|null;
  owners:OneToolchainResourceOwnerPort|null;
  business?:OneToolchainBusinessFacade|null;
}
function fail(reason:string):never {throw new Error(reason);}
const digest=(value:unknown)=>sha256Value(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
function callMetadata(call:ToolchainCallReceipt):OneToolchainCallerCallMetadata {
  const {schemaVersion,id,toolchainId,version,requestId,callerChatId,parentRunId,contentHash,inputHash,status,ok,runId,startedAt,completedAt,dryRun}=call;
  return {schemaVersion,id,toolchainId,version,requestId,callerChatId,parentRunId,contentHash,inputHash,status,ok,runId,startedAt,completedAt,dryRun};
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Actual replyAuthority producer predicate factored from one-vault-main.ts42–57.
 * Its hash is an issued native identity, never a canonical Business permission counter. */
export function createOneToolchainNativeReplyAuthority(ports:Pick<OneToolchainOriginalWorkPorts,'db'|'getAdmission'|'getRunOwner'>) {
  return (row:Readonly<SupervisorRequestRow>)=>{
    if(row.kind!=='reply'||row.task_id!==null||!row.run_id)return null;
    const admission=ports.getAdmission(row.run_id),custody=ports.getRunOwner(row.origin_chat_id,row.run_id);
    if(!admission||admission.status!=='admitted'||admission.chatId!==row.origin_chat_id||!custody||custody.state!=='active'||custody.ownerId!==admission.ownerProcessEpoch)return null;
    const revision=supervisorHash(['native-reply-authority.v1',row.command_id,row.run_id,row.payload_hash,row.payload_json,admission.inputDigest,custody.leaseId,custody.ownerId]);
    const stillCurrent=()=>{
      const current=ports.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(row.command_id) as SupervisorRequestRow|undefined;
      const currentAdmission=ports.getAdmission(row.run_id!),currentOwner=ports.getRunOwner(row.origin_chat_id,row.run_id!);
      return !!current&&current.kind==='reply'&&current.task_id===null&&current.run_id===row.run_id&&current.payload_hash===row.payload_hash&&current.payload_json===row.payload_json
        &&['dispatching','accepted'].includes(current.state)&&currentAdmission?.status==='admitted'&&currentAdmission.inputDigest===admission.inputDigest
        &&currentOwner?.state==='active'&&currentOwner.leaseId===custody.leaseId&&currentOwner.ownerId===custody.ownerId
        &&!ports.db.prepare("SELECT 1 FROM one_supervisor_requests WHERE run_id=? AND kind IN ('cancel','stop-reply') AND state<>'failed'").get(row.run_id);
    };return stillCurrent()?{revision,admissionDigest:admission.inputDigest,stillCurrent}:null;
  };
}

/** No schema, queue, budget reservation, provider, automatic repair or original command is created. */
export function createOneToolchainNativeRegistration(ports:OneToolchainOriginalWorkPorts) {
  const resourceOwners=ports.owners,businessFacade=ports.business??null;
  const tokens=new WeakMap<object,{original:OneToolchainOriginalWork;rowDigest:string;lease:InvocationRunOwner}>();
  type CallerScope={readonly token:OneToolchainOriginalWorkToken;readonly identity:symbol};
  const currentOriginal=new AsyncLocalStorage<CallerScope>();
  const nativeOwners=()=>resourceOwners??fail('toolchain_native_resource_owner_unbound');
  const lookup=(selector:{commandId:string;runId:string;chatId:string})=>{
    ports.assertOwner();const actor=ports.actor();
    if(!Object.values(actor).every(id)||![selector.commandId,selector.runId,selector.chatId].every(id))fail('toolchain_native_original_work_required');
    const row=ports.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(selector.commandId) as SupervisorRequestRow|undefined;
    if(!row||!['reply','work'].includes(row.kind)||!['dispatching','accepted'].includes(row.state)||row.one_id!==actor.oneId||row.run_id!==selector.runId)fail('toolchain_native_original_work_required');
    if(row.kind==='work'){
      const job=ports.db.prepare('SELECT * FROM one_supervisor_work_jobs WHERE command_id=?').get(selector.commandId) as {one_id:string;task_id:string;run_id:string;chat_id:string;phase:string}|undefined;
      if(!job||!['starting','running'].includes(job.phase)||job.one_id!==actor.oneId||row.task_id!==job.task_id||row.run_id!==job.run_id||job.chat_id!==selector.chatId||!row.task_id)fail('toolchain_native_original_work_required');
      let payload:{workerChatId?:unknown};try{payload=JSON.parse(row.payload_json);}catch{fail('toolchain_native_original_work_required');}
      if(payload.workerChatId!==selector.chatId||ports.canonicalTask(row.task_id)?.originChatId!==selector.chatId)fail('toolchain_native_original_work_required');
    }else if(row.task_id!==null||row.origin_chat_id!==selector.chatId)fail('toolchain_native_original_work_required');
    const lease=ports.getRunOwner(selector.chatId,selector.runId),process=ports.processOwner();
    if(!lease||lease.state!=='active'||lease.chatId!==selector.chatId||lease.runId!==selector.runId||lease.ownerId!==process.ownerId||lease.ownerKind!==process.ownerKind)fail('toolchain_native_invocation_custody_required');
    const admission=ports.getAdmission(selector.runId);
    if(!admission||admission.status!=='admitted'||admission.runId!==selector.runId||admission.chatId!==selector.chatId
      ||admission.ownerProcessEpoch!==lease.ownerId||admission.digestVersion!=='main-canonical-json-v1'||!id(admission.inputDigest))fail('toolchain_native_actual_admission_required');
    let controlVersion:string|null=null,replyAuthorityRevision:string|null=null,budgetId:string|null=null,budgetRevision:number|null=null;
    if(row.kind==='work'){
      controlVersion=ports.currentControl(row);budgetId=ports.commandBudget(row);
      const budget=budgetId?ports.currentBudget(row.command_id,budgetId):null;
      if(!controlVersion||!budgetId||budget?.admitted!==true||!Number.isSafeInteger(budget.revision)||budget.revision===null)fail('toolchain_native_admitted_control_budget_required');budgetRevision=budget.revision;
    }else{
      const authority=ports.currentReply(row);if(!authority||!id(authority.revision)||authority.admissionDigest!==admission.inputDigest||authority.stillCurrent()!==true)fail('toolchain_native_reply_authority_required');replyAuthorityRevision=authority.revision;
      // Passive native reply is not a budgeted model/repair grant. Never invent a budget.
      const reserved=ports.commandBudget(row),budget=reserved?ports.currentBudget(row.command_id,reserved):null;
      if(reserved&&budget?.admitted===true&&Number.isSafeInteger(budget.revision)&&budget.revision!==null){budgetId=reserved;budgetRevision=budget.revision;}
    }
    const original:OneToolchainOriginalWork=freeze({actor:{...actor},kind:row.kind==='reply'?'reply':'task',commandId:row.command_id,taskId:row.task_id,runId:selector.runId,controlVersion,replyAuthorityRevision,chatId:selector.chatId,
      originChatId:row.origin_chat_id,leaseId:lease.leaseId,payloadHash:row.payload_hash,nativeInputDigest:admission.inputDigest,budgetId,budgetRevision});
    return {original,rowDigest:digest([row.command_id,row.kind,row.one_id,row.task_id,row.run_id,row.origin_chat_id,row.payload_json,row.payload_hash]),lease};
  };
  const assertToken=(token:OneToolchainOriginalWorkToken):OneToolchainOriginalWork=>{
    const w=tokens.get(token);if(!w)fail('toolchain_native_original_work_capability_required');
    const fresh=lookup(w.original);if(digest(fresh.original)!==digest(w.original)||fresh.rowDigest!==w.rowDigest||fresh.lease.leaseId!==w.lease.leaseId)fail('toolchain_native_original_work_changed');
    return w.original;
  };
  const release=(ref:OneToolchainReleaseRef):ToolchainAssetVersion=>{
    const asset=getToolchainAsset(ref.toolchainId),version=asset?.versions.find(v=>v.version===ref.version);
    if(!version||version.contentHash!==ref.contentHash)fail('toolchain_native_immutable_release_changed');
    if(!version.provenance||!id(version.provenance.sourceAutomationId)||!/^sha256:[a-f0-9]{64}$/.test(version.provenance.sourceDefinitionDigest))fail('toolchain_native_source_provenance_required');
    return version;
  };
  const validateAsset=(a:OneToolchainResourceRegistration|null,ref:OneToolchainReleaseRef,work:OneToolchainOriginalWork)=>{
    if(!a||digest(a.release)!==digest(ref)||![a.registrationId,a.revision,a.resourceId,a.ownerPrincipalId,a.permissionRevision,a.consentRevision,a.tombstoneRevision].every(id)
      ||!Array.isArray(a.sources)||!a.sources.length||a.sources.some(s=>![s.resourceId,s.revision,s.sourceAuthorityId].every(id))
      ||new Set(a.sources.map(s=>s.resourceId)).size!==a.sources.length
      ||!['personal','project','organization'].includes(a.scope)
      ||a.scope==='personal'&&(a.ownerPrincipalId!==work.actor.principalId||a.organizationId!==null||a.projectId!==null)
      ||a.scope==='organization'&&!id(a.organizationId)||a.scope==='project'&&!id(a.projectId)
      ||nativeOwners().currentAsset(a,work)!==true)fail('toolchain_native_canonical_resource_required');return freeze(structuredClone(a));
  };
  const bindRun=(selector:{commandId:string;runId:string;chatId:string}):OneToolchainOriginalWorkToken=>{
    if(ports.db.inTransaction)fail('toolchain_native_uncommitted_original_work');
    const w=lookup(selector),token=Object.freeze({oneToolchainOriginalWork:true as const});tokens.set(token,w);return token;
  };
  /** Caller passes the genuine source manifest captured by its authenticated producer,
   * never source refs parsed out of an asset description or renderer/model JSON. */
  const registerProduced=async(token:OneToolchainOriginalWorkToken,ref:OneToolchainReleaseRef,sourceManifest:readonly BusinessOpaqueSource[])=>{
    const original=assertToken(token),frozenRef=freeze(structuredClone(ref)),manifest=freeze(structuredClone(sourceManifest));
    if(!manifest.length||manifest.some(s=>![s.resourceId,s.revision,s.sourceAuthorityId].every(id)))fail('toolchain_native_source_manifest_required');
    const version=release(frozenRef);if(version.provenance.creatorChatId!==original.chatId)fail('toolchain_native_producer_caller_changed');
    const registered=await nativeOwners().registerProduced(freeze({original,release:frozenRef,sourceManifest:manifest}));
    assertToken(token);release(frozenRef);return validateAsset(registered,frozenRef,original);
  };
  /** Read an existing immutable release through its canonical current owner; reuse
   * never claims the existing creator's producer custody or registers new sources. */
  const resolveRelease=async(token:OneToolchainOriginalWorkToken,ref:Readonly<OneToolchainReleaseRef>):Promise<OneToolchainResourceRegistration>=>{
    assertToken(token);const frozenRef=freeze(structuredClone(ref));release(frozenRef);
    const resolved=await nativeOwners().resolveAsset(frozenRef);
    const original=assertToken(token);release(frozenRef);
    const registered=validateAsset(resolved,frozenRef,original);
    assertToken(token);release(frozenRef);return registered;
  };
  const validateCall=(registration:OneToolchainRetainedCallRegistration|null,call:ToolchainCallReceipt,asset:OneToolchainResourceRegistration,original:OneToolchainOriginalWork)=>{
    if(!registration||![registration.registrationId,registration.revision].every(id)||digest(registration.call)!==digest(callMetadata(call))
      ||registration.producer.runId!==call.parentRunId||registration.producer.chatId!==call.callerChatId
      ||registration.assetRegistrationId!==asset.registrationId||registration.assetRegistrationRevision!==asset.revision
      ||nativeOwners().currentCall(registration,asset,original)!==true)fail('toolchain_native_retained_call_owner_required');return freeze(structuredClone(registration));
  };
  const registerCall=async(token:OneToolchainOriginalWorkToken,actualCall:Readonly<ToolchainCallReceipt>)=>{
    const original=assertToken(token),stored=getToolchainCall(actualCall.id);
    if(!stored||stored.schemaVersion!=='agentlas.toolchain-call.v1'||digest(stored)!==digest(actualCall)||stored.callerChatId!==original.chatId||stored.parentRunId!==original.runId)fail('toolchain_native_actual_call_producer_required');
    const ref={toolchainId:stored.toolchainId,version:stored.version,contentHash:stored.contentHash};release(ref);
    const asset=validateAsset(await nativeOwners().resolveAsset(ref),ref,assertToken(token));
    if(typeof nativeOwners().registerCall!=='function'||typeof nativeOwners().currentCall!=='function')fail('toolchain_native_retained_call_owner_unbound');
    const captured=await nativeOwners().registerCall(freeze({original,asset,call:callMetadata(stored)}));assertToken(token);
    if(digest(getToolchainCall(stored.id))!==digest(stored))fail('toolchain_native_caller_call_binding_changed');release(ref);validateAsset(asset,ref,assertToken(token));return validateCall(captured,stored,asset,original);
  };
  const resolvePhase=async(token:OneToolchainOriginalWorkToken,input:{phase:OneToolchainPhase;release:OneToolchainReleaseRef;callId:string|null;bodyDigest:string})=>{
    if(!['report','notice','read-reports','repair'].includes(input.phase)||! /^[a-f0-9]{64}$/.test(input.bodyDigest))fail('toolchain_native_phase_input_invalid');
    const selection=freeze(structuredClone(input)),original=assertToken(token),version=release(selection.release);
    if(selection.phase==='repair'&&(original.budgetId===null||original.budgetRevision===null))fail('toolchain_native_admitted_repair_budget_required');
    const call=selection.callId?getToolchainCall(selection.callId):null;
    if(selection.phase!=='repair'&&!call)fail('toolchain_native_caller_call_required');
    if(call&&(call.schemaVersion!=='agentlas.toolchain-call.v1'||(selection.phase==='report'&&call.callerChatId!==original.chatId)||!call.parentRunId||call.id!==selection.callId||call.toolchainId!==selection.release.toolchainId||call.version!==selection.release.version||call.contentHash!==selection.release.contentHash))fail('toolchain_native_caller_call_binding_changed');
    const asset=validateAsset(await nativeOwners().resolveAsset(selection.release),selection.release,assertToken(token));
    let retainedCall:OneToolchainRetainedCallRegistration|null=null;
    if(call){if(typeof nativeOwners().resolveCall!=='function'||typeof nativeOwners().currentCall!=='function')fail('toolchain_native_retained_call_owner_unbound');retainedCall=validateCall(await nativeOwners().resolveCall(freeze({original,asset,call:callMetadata(call)})),call,asset,assertToken(token));}
    const maker=version.provenance.creatorChatId?getChat(version.provenance.creatorChatId):null;
    const recipientId=maker&&!maker.archivedAt?maker.id:nativeOwners().ownerConversation(original.actor);
    if(!recipientId||!getChat(recipientId)||getChat(recipientId)!.archivedAt)fail('toolchain_native_current_recipient_required');
    const recipient=await nativeOwners().resolveAudience(freeze({original,asset,chatId:recipientId}));
    if(!recipient||recipient.chatId!==recipientId||![recipient.registrationId,recipient.revision,recipient.resourceId,recipient.principalId].every(id)
      ||recipient.scope!==asset.scope||recipient.organizationId!==asset.organizationId||recipient.projectId!==asset.projectId
      ||asset.scope==='personal'&&recipient.principalId!==asset.ownerPrincipalId
      ||nativeOwners().currentAudience(recipient,assertToken(token))!==true)fail('toolchain_native_current_recipient_required');
    if(selection.phase==='notice'&&original.chatId!==call?.callerChatId&&original.chatId!==recipient.chatId)fail('toolchain_native_notice_owner_required');
    // Only the verified current recipient establishes the maker conversation.
    // Its own result follows the repair path, without an upward self-report.
    if(selection.phase==='report'&&recipient.chatId===original.chatId)fail('toolchain_report_own_graph');
    const phase=freeze({phase:selection.phase,original,asset,callerCall:call?callMetadata(call):null,retainedCall,recipient:structuredClone(recipient),bodyDigest:selection.bodyDigest});
    return {selection,original,call,asset,retainedCall,recipient,phase};
  };
  const wireHash=(value:string)=>{const m=/^sha256:([a-f0-9]{64})$/.exec(value);return m?m[1]:fail('toolchain_native_canonical_hash_encoding_required');};
  type BoundPhase=Awaited<ReturnType<typeof resolvePhase>>;
  const currentBinding=(token:OneToolchainOriginalWorkToken,b:BoundPhase)=>{
    assertToken(token);release(b.selection.release);
    if(nativeOwners().currentAsset(b.asset,b.original)!==true||nativeOwners().currentAudience(b.recipient,b.original)!==true
      ||b.retainedCall&&nativeOwners().currentCall(b.retainedCall,b.asset,b.original)!==true)fail('toolchain_native_owner_registration_changed');
    if(b.call&&digest(getToolchainCall(b.call.id))!==digest(b.call))fail('toolchain_native_caller_call_binding_changed');
    const v=release(b.selection.release),maker=v.provenance.creatorChatId?getChat(v.provenance.creatorChatId):null;
    if((maker&&!maker.archivedAt?maker.id:nativeOwners().ownerConversation(b.original.actor))!==b.recipient.chatId)fail('toolchain_native_current_recipient_required');
  };
  const phaseNames={report:'report',notice:'passive-notice','read-reports':'report-read',repair:'repair-draft'} as const;
  const resolveIntent=async(token:OneToolchainOriginalWorkToken,raw:Readonly<OneToolchainReportAdmissionRequest>)=>{
    const request=freeze(structuredClone(raw)),original=assertToken(token);
    if(request.callerChatId!==original.chatId)fail('toolchain_native_report_caller_changed');
    const call=request.ref.callId?getToolchainCall(request.ref.callId):null;
    if(!call||call.inputHash!==request.ref.callInputHash||call.runId!==request.ref.callRunId||call.callerChatId!==request.ref.sourceCallerChatId)fail('toolchain_native_caller_call_binding_changed');
    const b=await resolvePhase(token,{phase:request.action,release:{toolchainId:request.ref.toolchainId,version:request.ref.version,contentHash:request.ref.contentHash},callId:request.ref.callId,bodyDigest:request.bodyDigest});
    if(b.recipient.chatId!==request.recipientChatId)fail('toolchain_native_current_recipient_required');
    if(typeof nativeOwners().resolveReportIntent!=='function'||typeof nativeOwners().currentReportIntent!=='function')fail('toolchain_native_report_intent_owner_unbound');
    const resolved=await nativeOwners().resolveReportIntent(freeze({phase:b.phase,request}));
    currentBinding(token,b);
    if(!resolved||![resolved.registrationId,resolved.revision,resolved.reportId].every(id)||resolved.reportRevision!==null&&!id(resolved.reportRevision)
      ||nativeOwners().currentReportIntent(resolved,b.phase)!==true)fail('toolchain_native_report_intent_owner_required');
    const intent=freeze(structuredClone(resolved)),r=intent.request,a=original.actor;
    if(r.schema!=='agentlas.business.toolchain-native-request.v1'||r.phase!==phaseNames[request.action]||r.principalId!==a.principalId||r.sessionId!==a.sessionId||r.hostId!==a.hostId||r.workspaceId!==a.workspaceId
      ||r.callerChatId!==original.chatId||r.sourceCallCallerChatId!==call.callerChatId||r.assetId!==call.toolchainId||r.assetVersion!==call.version||r.assetContentHash!==wireHash(call.contentHash)
      ||r.callerCallId!==call.id||r.callerParentRunId!==call.parentRunId||r.callerCallRunId!==call.runId||r.callerInputHash!==wireHash(call.inputHash)
      ||r.recipientChatId!==request.recipientChatId||r.bodyDigest!==request.bodyDigest||r.reportId!==intent.reportId||r.reportRevision!==intent.reportRevision
      ||request.reportId!==undefined&&request.reportId!==intent.reportId||request.reportRevision!==undefined&&request.reportRevision!==intent.reportRevision
      ||![r.originalWorkRef,r.purpose,r.payerId,intent.effect.authorityId,intent.effect.domainId,intent.effect.effectId,intent.effect.revision].every(id))fail('toolchain_native_report_intent_binding_changed');
    if(b.asset.scope==='personal'&&(r.scope.kind!=='personal'||r.scope.principalId!==a.principalId)
      ||b.asset.scope==='organization'&&(r.scope.kind!=='organization'||r.scope.organizationId!==b.asset.organizationId)
      ||b.asset.scope==='project'&&(b.asset.organizationId!==null?r.scope.kind!=='organization'||r.scope.organizationId!==b.asset.organizationId:r.scope.kind!=='personal'||r.scope.principalId!==a.principalId)
      ||r.projectId!==b.asset.projectId)fail('toolchain_native_report_intent_scope_changed');
    return {token,request,b,intent};
  };
  type ResolvedReport=Awaited<ReturnType<typeof resolveIntent>>;
  type Borrower={caller:CallerScope;released:boolean;inFlight:boolean;entry:PreparedReport};
  type PreparedReport={key:string;resolved:ResolvedReport;approval:BusinessPreparedNativeAction;
    borrowers:Set<Borrower>;inFlight:boolean;consumed:boolean;invalidated:boolean;closed:boolean;releaseUnknown:boolean;current():boolean};
  const pendingReports=new Map<string,PreparedReport>();
  const preparingReports=new Map<string,{token:OneToolchainOriginalWorkToken;promise:Promise<PreparedReport>}>();
  const closeEntry=(entry:PreparedReport):boolean=>{
    if(entry.inFlight)return !entry.releaseUnknown;
    if(!entry.closed){entry.closed=true;try{entry.approval.release();}catch{entry.releaseUnknown=true;}}
    // A release exception retains the uncertain original admission. No implicit retry.
    if(!entry.releaseUnknown&&pendingReports.get(entry.key)===entry)pendingReports.delete(entry.key);
    return !entry.releaseUnknown;
  };
  const releaseBorrower=(borrower:Borrower):boolean=>{
    if(!borrower.released){borrower.released=true;borrower.entry.borrowers.delete(borrower);}
    const entry=borrower.entry;
    return entry.borrowers.size||entry.inFlight?!entry.releaseUnknown:closeEntry(entry);
  };
  const refusal=(decision:'deny'|'unknown',entry?:PreparedReport)=>Object.freeze({decision,revision:'',current:()=>false,release:()=>{},reportId:entry?.resolved.intent.reportId??null,reportRevision:entry?.resolved.intent.reportRevision??null});
  const borrow=(entry:PreparedReport,caller:CallerScope)=>{
    if(entry.resolved.token!==caller.token||entry.releaseUnknown||!entry.current())return refusal(entry.approval.decision==='deny'?'deny':'unknown',entry);
    const borrower:Borrower={caller,released:false,inFlight:false,entry};entry.borrowers.add(borrower);
    return Object.freeze({decision:'allow' as const,revision:entry.approval.revision,
      current:()=>!borrower.released&&entry.current(),
      release:()=>{if(!releaseBorrower(borrower))fail('toolchain_native_admission_release_unconfirmed');},
      reportId:entry.resolved.intent.reportId,reportRevision:entry.resolved.intent.reportRevision});
  };
  const selectReportIdentity=async(request:Readonly<OneToolchainReportAdmissionRequest>)=>{
    const caller=currentOriginal.getStore();if(!caller)fail('toolchain_native_original_work_capability_required');const r=await resolveIntent(caller.token,request);
    return Object.freeze({reportId:r.intent.reportId,reportRevision:r.intent.reportRevision});
  };
  const reportAdmissionPort={
    ownerConversation():string|null{const caller=currentOriginal.getStore();if(!caller)fail('toolchain_native_original_work_capability_required');return nativeOwners().ownerConversation(assertToken(caller.token).actor);},
    selectReportIdentity,prepareIdentity:selectReportIdentity,
    async prepare(raw:Readonly<OneToolchainReportAdmissionRequest>){
      const caller=currentOriginal.getStore();if(!caller)fail('toolchain_native_original_work_capability_required');assertToken(caller.token);
      const business=businessFacade??fail('toolchain_native_business_effect_domain_unbound'),request=freeze(structuredClone(raw)),key=digest(request);
      const existing=pendingReports.get(key);
      if(existing)return borrow(existing,caller); // Never reprepare/close the shared original pin.
      let creating=preparingReports.get(key);
      if(creating&&creating.token!==caller.token)return refusal('unknown');
      if(!creating){
        if(pendingReports.size+preparingReports.size>=128)fail('toolchain_native_report_admission_capacity');
        const promise=(async()=>{
          const resolved=await resolveIntent(caller.token,request),approval=await business.prepareCurrentAction(resolved.intent.request);
          const entry:PreparedReport={key,resolved,approval,borrowers:new Set(),inFlight:false,consumed:false,invalidated:false,closed:false,releaseUnknown:false,current:()=>false};
          entry.current=()=>{try{return !entry.closed&&!entry.consumed&&!entry.invalidated&&!entry.releaseUnknown&&approval.decision==='allow'&&id(approval.revision)&&approval.stillCurrent()===true
            &&(currentBinding(caller.token,resolved.b),nativeOwners().currentReportIntent(resolved.intent,resolved.b.phase)===true);}catch{return false;}};
          pendingReports.set(key,entry);
          if(!entry.current())closeEntry(entry);
          return entry;
        })();
        creating={token:caller.token,promise};preparingReports.set(key,creating);
      }
      try{return borrow(await creating.promise,caller);}finally{if(preparingReports.get(key)===creating)preparingReports.delete(key);}
    },
    async withCurrentExclusion<T>(requests:readonly Readonly<OneToolchainReportAdmissionRequest>[],reducer:(scope:Readonly<OneToolchainReportExclusion>)=>T):Promise<BusinessToolchainEffectResult<T>>{
      const denied=(state:'denied'|'unknown',reason:string):BusinessToolchainEffectResult<T>=>({state,reason,value:null});
      const entries=requests.map(r=>pendingReports.get(digest(r))),business=businessFacade,caller=currentOriginal.getStore();
      if(!business||!entries.length||entries.some(e=>!e)||!caller)return denied('unknown','toolchain_native_business_effect_domain_unbound');
      const owned=entries as PreparedReport[],borrowers=owned.flatMap(e=>[...e.borrowers].filter(b=>b.caller===caller&&!b.released&&!b.inFlight));
      // A competing reducer owns no part of the first effect; release only its free borrowers.
      if(owned.some(e=>e.inFlight)){
        let released=true;for(const b of borrowers)released=releaseBorrower(b)&&released;
        return denied('unknown',released?'toolchain_native_effect_in_flight':'toolchain_native_admission_release_unconfirmed');
      }
      let claimed=false,dispatched=false,releaseUnknown=false;
      try{
        if(new Set(owned).size!==owned.length||owned.some(e=>e.resolved.token!==caller.token||!e.current()||!borrowers.some(b=>b.entry===e)))return denied('denied','toolchain_native_original_effect_changed');
        const identity=(e:PreparedReport)=>digest({reportId:e.resolved.intent.reportId,reportRevision:e.resolved.intent.reportRevision,effect:e.resolved.intent.effect,original:e.resolved.b.original,asset:e.resolved.b.asset,predecessor:e.resolved.b.retainedCall,recipient:e.resolved.b.recipient});
        if(owned.some(e=>identity(e)!==identity(owned[0])))return denied('denied','toolchain_native_effect_identity_changed');
        if(ports.db.inTransaction||['AsyncFunction','GeneratorFunction','AsyncGeneratorFunction'].includes(reducer.constructor.name))return denied('denied','toolchain_native_sync_owner_effect_required');
        for(const e of owned)e.inFlight=true;for(const b of borrowers)b.inFlight=true;claimed=true;
        let attempts=0,invalid=false,produced=false,producedValue:T|null=null;
        dispatched=true;
        const result=await business.withCurrentExclusion(owned.map(e=>e.resolved.intent.request),exclusion=>{
          attempts++;if(attempts!==1){invalid=true;fail('toolchain_native_owner_reducer_repeated');}
          let open=true;
          const current=()=>{
            if(!open||invalid){invalid=true;return false;}
            try{const valid=ports.db.inTransaction===true&&exclusion.protocol==='agentlas.business.serialized-toolchain-effect.v1'
              &&digest(exclusion.effect)===digest(owned[0].resolved.intent.effect)&&exclusion.current()===true&&owned.every(e=>e.current())&&borrowers.every(b=>!b.released);
              if(!valid)invalid=true;return valid;
            }catch{invalid=true;return false;}
          };
          try{
            if(!current())fail('toolchain_native_same_owner_sql_exclusion_required');
            const scope=Object.freeze({current,reportId:owned[0].resolved.intent.reportId,reportRevision:owned[0].resolved.intent.reportRevision});
            const value=reducer(scope);
            if(value&&(typeof value==='object'||typeof value==='function')&&'then' in value)fail('toolchain_native_sync_effect_required');
            if(!current())fail('toolchain_native_same_owner_sql_exclusion_required');produced=true;producedValue=value;return value;
          }catch(error){invalid=true;throw error;}finally{open=false;}
        });
        // The Business composition releases its original pins after commit. Revalidate
        // native provenance before exposing any returned bytes, not those closed pins.
        try{for(const e of owned){currentBinding(caller.token,e.resolved.b);if(nativeOwners().currentReportIntent(e.resolved.intent,e.resolved.b.phase)!==true)fail('toolchain_native_report_intent_owner_required');}}catch{return denied('unknown','toolchain_native_effect_current_changed');}
        if(invalid||attempts>1||result.state==='committed'&&(attempts!==1||!produced||result.value!==producedValue))return denied('unknown','toolchain_native_effect_unconfirmed');
        return result.state==='committed'?result:denied(result.state==='denied'?'denied':'unknown',result.reason);
      }catch{return denied('unknown','toolchain_native_effect_unconfirmed');}
      finally{
        if(claimed)for(const e of owned){e.inFlight=false;if(dispatched)e.consumed=true;}
        for(const b of borrowers){b.inFlight=false;releaseUnknown=!releaseBorrower(b)||releaseUnknown;}
        if(dispatched)for(const e of owned)releaseUnknown=!closeEntry(e)||releaseUnknown;
        if(releaseUnknown)return denied('unknown','toolchain_native_admission_release_unconfirmed');
      }
    },
  };
  return {bindRun,assertToken,registerProduced,resolveRelease,registerCall,reportAdmissionPort,
    /** Only the native capability WeakMap may call this with its original token. It
     * accepts no serialized actor/context flag and preserves token custody across await. */
    withOriginalWork<T>(token:OneToolchainOriginalWorkToken,body:()=>Promise<T>|T):Promise<T>{assertToken(token);return currentOriginal.run(Object.freeze({token,identity:Symbol('native-toolchain-caller')}),async()=>{const value=await body();assertToken(token);return value;});},
    forget(token:OneToolchainOriginalWorkToken){tokens.delete(token);let unknown=[...preparingReports.values()].some(entry=>entry.token===token);for(const entry of pendingReports.values())if(entry.resolved.token===token){unknown=entry.inFlight||unknown;entry.invalidated=true;for(const b of [...entry.borrowers])unknown=!releaseBorrower(b)||unknown;if(!entry.inFlight)unknown=!closeEntry(entry)||unknown;}return {state:unknown?'unknown' as const:'released' as const};}};
}

/** Actual existing native dependencies, loaded only on explicit native owner composition.
 * Missing current owner/phase/budget bindings refuse BEFORE any DB/profile import. */
export async function createDefaultOneToolchainNativeRegistration(input:{owners:OneToolchainResourceOwnerPort|null;business:OneToolchainBusinessFacade|null}) {
  if(!input.owners||!input.business)fail('toolchain_native_shipping_owner_ports_unbound');
  const [db,auth,profile,host,tasks,owners,supervisor,admissions]=await Promise.all([import('../store/db'),import('../auth'),import('../store/one-profile'),import('./host-identity'),import('../store/tasks'),import('../store/invocation-run-owners'),import('./supervisor'),import('../store/invocation-admissions')]);
  return createOneToolchainNativeRegistration({...input,db:db.getDb(),
    actor:()=>{const s=auth.getAuthenticatedSessionBinding();if(!s||s.expiresAt!==null&&s.expiresAt<=Date.now())fail('toolchain_native_session_required');return {principalId:s.userId,sessionId:s.sessionId,workspaceId:s.workspaceId,oneId:profile.getOneProfile().oneId,hostId:host.oneNativeHostIdentity().hostId};},
    assertOwner:()=>supervisor.oneSupervisor().assertHostWriteAuthority(profile.getOneProfile().oneId),canonicalTask:tasks.getCanonicalTask,
    processOwner:owners.invocationProcessOwner,getRunOwner:owners.invocationRunOwners.getRunOwner,
    getAdmission:admissions.getInvocationAdmission,
    commandBudget:row=>{const reserved=db.getDb().prepare('SELECT budget_id FROM one_budget_reservations WHERE command_id=? AND one_id=? AND task_id IS ? AND run_id=?').get(row.command_id,row.one_id,row.task_id,row.run_id) as {budget_id:string|null}|undefined;return reserved?.budget_id??null;},
    currentReply:createOneToolchainNativeReplyAuthority({db:db.getDb(),getAdmission:admissions.getInvocationAdmission,getRunOwner:owners.invocationRunOwners.getRunOwner}),
    currentControl:row=>supervisor.currentOneNativeWorkControl(row),currentBudget:supervisor.currentOneNativeWorkBudget});
}
