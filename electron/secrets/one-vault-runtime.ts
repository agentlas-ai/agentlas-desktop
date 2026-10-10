import {inspectOneVaultStoredReference,type OneVaultStoredReferenceProof,type OneVaultStoredReferenceLease} from './one-vault-stored-reference';
import type {OneMobileEnrollmentHandle,OneMobileEnrollmentCandidate} from './one-mobile-enrollment';
import {randomUUID} from 'node:crypto';
import type {OneActionAuthorityRequest,OneActionAuthorityDecision,OneActionAuthorityPort} from '../../shared/one-authority';
import type {SupervisorRequestRow} from '../one/supervisor-store';
import {OneVaultError,type OneVaultBinding,type OneVaultRequest} from '../../shared/one-vault';
import {oneVaultDigest,verifyOneVault} from './one-vault-crypto';
import {OneVaultJournal,oneVaultSlot,type OneVaultSqlite} from './one-vault-journal';
import {OneVaultService,OneVaultCommandMetadata,type OneVaultExistingOsVault,type OneVaultNativeContext,type OneVaultApprovedHostMetadata} from './one-vault-service';
import {OneVaultNativeTrustLedger,type OneVaultNativeOwner,type OneVaultNativeOwnerAction,type OneVaultTrustDisclosure} from './one-vault-native-trust';
import type {OneVaultAuthorityLease} from './one-vault-broker';
export interface OneVaultPendingKeyRequest {requestId:string;runId:string;expiresAt:number;tools:Array<{id:string;envKeys:Array<{key:string}>}>}
interface Domain {one_id:string;owner_epoch:string;owner_kind:'desktop-main'|'work-daemon';owner_pid:number;generation:number;phase:string;lease_until:number}
interface Session {userId:string;sessionId:string;workspaceId:string;expiresAt:number|null}
interface Custody {chatId:string;runId:string;ownerId:string;ownerKind:string;leaseId:string;state:string}
interface Admission {runId:string;chatId:string;inputDigest:string;ownerProcessEpoch:string;status:string}
export interface OneVaultRuntimeAnchor {commandId:string;oneId:string;taskId:string;runId:string;chatId:string;controlVersion:string|null;replyAuthorityRevision:string|null;payloadHash:string;custodyDigest:string}
/** Native registered owner window, not a renderer-supplied id or boolean. */
export interface OneVaultOwnerWindow {id:number;isDestroyed():boolean;isFocused():boolean}
export interface OneVaultRuntimeSources {
 db:OneVaultSqlite;vault:OneVaultExistingOsVault;now?():number;
 /** Independently approved native producer; must use opaque handle identity, never RPC/bearer input. */
 mobileSenderEnrollment?(handle:OneMobileEnrollmentHandle):OneMobileEnrollmentCandidate|null;
 hostIdentity():{hostId:string;label:string;pairedIdentityAvailable:boolean};nativeSession():Session|null;oneId():string;
 hasSingleInstanceLock():boolean;desktopOwnerEpoch():string;supervisorMode():'local'|'handoff'|'daemon';
 processOwner():{ownerId:string;ownerKind:string};runOwner(runId:string):Custody|null;admission(runId:string):Admission|null;
 /** Main original task/current snapshot opaque string; absence never invents a counter/hash. */
 currentControl(row:Readonly<SupervisorRequestRow>):string|null;
 /** Separate native reply registry: immutable original admission plus live lease/Stop authority. */
 currentNativeReplyAuthority?(row:Readonly<SupervisorRequestRow>):{revision:string;admissionDigest:string;stillCurrent():boolean}|null;
 runReceipt?(runId:string):{runId:string;chatId:string;status:string;startedAt:string;updatedAt:string;finishedAt?:string}|null;
 pendingRunKeyElicitation(runId:string):OneVaultPendingKeyRequest|null;
 currentActionAuthority(request:OneActionAuthorityRequest,personal:OneActionAuthorityPort):OneActionAuthorityDecision;
 isNativeOwnerWindow(window:OneVaultOwnerWindow):boolean;
 showNativeApproval(window:OneVaultOwnerWindow,disclosure:Readonly<OneVaultTrustDisclosure>):Promise<boolean>;
 /** Optional exact sticky daemon/channel attestation. No bearer or PID-only proof. */
 approvedDaemonCustody?(domain:Readonly<Domain>,run:Readonly<Custody>|null):{identity:string;stillCurrent():boolean}|null;
}
export interface OneVaultNativeIntent {
 /** Main-sealed persistent request registry digest, never model/renderer metadata. */
 intentDigest:string;pendingRequestDigest:string;principalId:string;sessionId:string;toolId:string;envKey:string;accountLabel:string;
 scope:'personal'|'organization';organizationId:string|null;workspaceId:string;resourceId:string;purpose:string;payerId:string;
 provider:'elevenlabs-audio';providerWorkspace:string;region:'global'|'eu'|'in'|'sg';operations:string[];
 permissionRevision:string;authorityRevision:string;replyAuthorityRevision:string|null;cost:OneVaultBinding['cost'];
}
export interface OneVaultRecoveryEvidence {
 recoveryKind:'expired-live'|'released-terminal';custodyDigest:string;
 request:OneVaultRequest;commandId:string;oneId:string;taskId:string;runId:string;executionChatId:string;
 operationId:string;envelopeDigest:string;action:'store'|'delete';expectedGeneration:number;generation:number;operationState:string;
 payloadHash:string;commandIdentity:string;commandState:string;commandReceiptDigest:string;runReceiptDigest:string;
 admissionDigest:string;originalOwnerId:string;originalOwnerKind:string;originalLeaseId:string;
}
export interface OneVaultRecoveryAuthority {
 /** Exact original native intent digest from retained immutable admission storage. Required
  * for expired-live recovery; never supplied by RPC, pending form, or canonical Chat DTO. */
 originalIntentDigest?:string;
 decision:'allow'|'deny'|'unknown';requestDigest:string;sourceDigest:string;principalId:string;sessionId:string;workspaceId:string;
 authorityRevision:string;permissionRevision:string;accountLabel:string;stillCurrent():boolean;
}
export interface OneVaultRuntimePolicy {
 /** Genuine native read-admission + installed scoped reader proof. Never key presence. */
 currentStoredReference?(commandId:string,toolId:string,keyName:string):OneVaultStoredReferenceProof|null;
 /** Current native registry read; null fails closed. Retained metadata may authorize status after expiry. */
 currentIntent(anchor:Readonly<OneVaultRuntimeAnchor>,pending:Readonly<OneVaultPendingKeyRequest>|null):OneVaultNativeIntent|null;
 /** Current retained-source/ACL registry, solely for read-only same-effect status after terminal custody. */
 currentRecovery?(evidence:Readonly<OneVaultRecoveryEvidence>):OneVaultRecoveryAuthority|null;
 currentRecoveryGrant?(binding:Readonly<OneVaultBinding>,evidence:Readonly<OneVaultRecoveryEvidence>):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent():boolean}>;
 personal:OneActionAuthorityPort;
 /** Organization admission is asynchronously pinned before each synchronous native decision. */
 prepareAuthority?(binding:Readonly<OneVaultBinding>,phase:Parameters<OneVaultRuntimePolicy['currentGrant']>[1]):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent():boolean}>;
 /** Terminal reconciliation has its own retained-source authority, never the active-run admission. */
 prepareRecoveryAuthority?(binding:Readonly<OneVaultBinding>,evidence:Readonly<OneVaultRecoveryEvidence>):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent():boolean}>;
 /** Existing Business/current grant adapter; separate async grant lookup with a sync revocation fence. */
 currentGrant(binding:Readonly<OneVaultBinding>,phase:'decrypt'|'store'|'commit'|'reconcile'|'provider-read'|'provider-dispatch'|'provider-publish'):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent():boolean}>;
 invalidateProviderReadiness(slotId:string,generation:number):void;
}
const ENDPOINTS={global:'https://api.elevenlabs.io',eu:'https://api.eu.residency.elevenlabs.io',in:'https://api.in.residency.elevenlabs.io',sg:'https://api.sg.residency.elevenlabs.io'} as const;
/** Existing Supervisor rows are read-only authority. This module owns no engine/queue. */
export class OneVaultRuntime {
 currentStoredReference(commandId:string,toolId:string,keyName:string):OneVaultStoredReferenceLease|null{
  try{const policy=this.policy;if(!policy?.currentStoredReference)return null;
   const lease=inspectOneVaultStoredReference(this,policy.currentStoredReference(commandId,toolId,keyName));
   if(!lease||lease.commandId!==commandId)return null;
   return{...lease,stillCurrent:()=>this.policy===policy&&lease.stillCurrent()&&!!inspectOneVaultStoredReference(this,policy.currentStoredReference!(commandId,toolId,keyName))};
  }catch{return null;}
 }
 readonly journal:OneVaultJournal;readonly metadata:OneVaultCommandMetadata;readonly trust:OneVaultNativeTrustLedger;readonly service:OneVaultService;
 private policy:OneVaultRuntimePolicy|null=null;
 private readonly policyRebinds=new WeakMap<object,{policy:OneVaultRuntimePolicy;owner:string;drainEpoch:number;cleared:boolean}>();
 /** Opaque local capability, never a DTO/SQL receipt. Drains only this existing service. */
 async preparePolicyRebind(expected:OneVaultRuntimePolicy):Promise<object>{
  const owner=this.currentNativeOwner();if(!owner||this.policy!==expected)throw new OneVaultError('authority_unavailable');
  const digest=oneVaultDigest(owner);await this.service.beginAuthorityDrain();
  const drain=this.service.authorityDrainState();if(!drain.confirmed||this.policy!==expected||oneVaultDigest(this.currentNativeOwner())!==digest)throw new OneVaultError('authority_unavailable');
  const ticket=Object.freeze({});this.policyRebinds.set(ticket,{policy:expected,owner:digest,drainEpoch:drain.epoch,cleared:false});return ticket;
 }
 clearPolicyForRebind(ticket:object,expected:OneVaultRuntimePolicy):void{
  const held=this.policyRebinds.get(ticket),drain=this.service.authorityDrainState();
  if(!held||held.cleared||held.policy!==expected||this.policy!==expected||!drain.confirmed||drain.epoch!==held.drainEpoch||oneVaultDigest(this.currentNativeOwner())!==held.owner)throw new OneVaultError('authority_unavailable');
  held.cleared=true;this.policy=null;
 }
 finishPolicyRebind(ticket:object,expected:OneVaultRuntimePolicy):void{
  const held=this.policyRebinds.get(ticket);if(!held||!held.cleared||this.policy!==expected||oneVaultDigest(this.currentNativeOwner())!==held.owner)throw new OneVaultError('authority_unavailable');
  this.policyRebinds.delete(ticket);this.service.resumeDrainedAuthority(held.drainEpoch);
 }
 private readonly enrollmentHandles=new WeakSet<object>();
 private readonly actions=new WeakMap<object,{window:OneVaultOwnerWindow;owner:OneVaultNativeOwner;expiresAt:number;enrollment?:OneMobileEnrollmentCandidate}>();
 constructor(readonly sources:OneVaultRuntimeSources){
  this.journal=new OneVaultJournal(sources.db);this.metadata=new OneVaultCommandMetadata(sources.db);
  sources.db.exec(`CREATE TABLE IF NOT EXISTS one_vault_native_approvals(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,owner_json TEXT NOT NULL,metadata_digest TEXT NOT NULL,disclosure_json TEXT NOT NULL,approved_at INTEGER NOT NULL,revoked_at INTEGER);`);
  this.trust=new OneVaultNativeTrustLedger({db:sources.db,vault:sources.vault,currentOwner:()=>this.currentNativeOwner(),senderEnrollment:a=>this.actions.get(a)?.enrollment??null,approve:(a,d)=>this.approve(a,d),approvalStillValid:(id,o,d)=>this.approvalValid(id,o,d),audit:()=>{/* Durable trust record is the safe local audit; external logging is intentionally absent. */},now:()=>this.now()});
  this.service=new OneVaultService({configuredHostId:()=>sources.hostIdentity().hostId,nativeSession:()=>sources.nativeSession(),resolveCommand:(id,mode)=>this.resolveCommand(id,mode),authority:(b,p,mode)=>this.authority(b,p,mode),exclusiveHost:()=>this.currentNativeOwner()!==null,trust:this.trust,vault:sources.vault,metadata:this.metadata,journal:this.journal,invalidateProviderReadiness:(s,g)=>this.policy?.invalidateProviderReadiness(s,g),now:()=>this.now()});
 }
 configurePolicy(policy:OneVaultRuntimePolicy):void{if(this.policy&&this.policy!==policy)throw new OneVaultError('authority_unavailable');this.policy=policy;}
 private now(){return this.sources.now?.()??Date.now();}
 private domain():Domain|null{try{return this.sources.db.prepare("SELECT * FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as Domain??null;}catch{return null;}}
 currentNativeOwner():OneVaultNativeOwner|null{
  try{const d=this.domain(),s=this.sources.nativeSession();if(!d||!s||!this.sources.hasSingleInstanceLock()||d.one_id!==this.sources.oneId()||d.phase!=='active'||d.lease_until<=this.now()||s.expiresAt!==null&&s.expiresAt<=this.now())return null;
   if(d.owner_kind==='desktop-main'){if(this.sources.supervisorMode()!=='local'||d.owner_epoch!==this.sources.desktopOwnerEpoch()||d.owner_pid!==process.pid)return null;}
   else {const proof=this.sources.approvedDaemonCustody?.(Object.freeze({...d}),null);if(this.sources.supervisorMode()!=='daemon'||!proof?.identity||!proof.stillCurrent())return null;}
   return{hostId:this.sources.hostIdentity().hostId,principalId:s.userId,sessionId:s.sessionId,workspaceId:s.workspaceId,custodyGeneration:`${d.owner_epoch}:${d.generation}`};
  }catch{return null;}
 }
 private originalTarget(row:Readonly<SupervisorRequestRow>):{target:string;commandIdentity:string}|null{
   // Match createSupervisorNativeOrigin: origin_chat_id attributes the One request;
   // execution chat comes from the host-sealed target for delegated/send operations.
   const payload=JSON.parse(row.payload_json) as Record<string,unknown>;if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
   let target:unknown,delegatedIdentity:string|null=null;
   if(row.kind==='reply')target=row.origin_chat_id;
   else if(row.kind==='work'){if(!row.task_id)return null;target=payload.workerChatId;}
   else if(row.kind==='chat-send')target=payload.chatId;
   else if(row.kind==='follow-up'){
    if(!row.task_id)return null;
    const delegated=this.sources.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND task_id=? AND kind='work' ORDER BY rowid LIMIT 1").get(row.one_id,row.task_id) as SupervisorRequestRow|undefined;
    if(!delegated)return null;const original=JSON.parse(delegated.payload_json) as Record<string,unknown>;if(!original||typeof original!=='object'||Array.isArray(original))return null;
    target=original.workerChatId;delegatedIdentity=oneVaultDigest([delegated.command_id,delegated.payload_hash,delegated.payload_json,delegated.source_reply_run_id]);
   }
   if(typeof target!=='string'||!target||target.length>256||target.trim()!==target||/[\u0000-\u001f]/.test(target)||row.kind==='chat-send'&&row.task_id!==`chat:${target}`)return null;
   if(row.source_reply_run_id&&!this.sources.db.prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND origin_chat_id=? AND run_id=? AND kind='reply'").get(row.one_id,row.origin_chat_id,row.source_reply_run_id))return null;
   const commandIdentity=oneVaultDigest([row.payload_json,row.source_reply_run_id,target,delegatedIdentity]);
   return{target,commandIdentity};
 }
 anchor(commandId:string):OneVaultRuntimeAnchor|null{
  try{if(!this.currentNativeOwner())return null;const row=this.sources.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(commandId) as SupervisorRequestRow|undefined;
   if(!row||row.one_id!==this.sources.oneId()||!row.run_id||!['reply','work','follow-up','chat-send'].includes(row.kind)||!['dispatching','accepted'].includes(row.state))return null;
   const rows=this.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(row.run_id);if(rows.length!==1)return null;
   const original=this.originalTarget(row);if(!original)return null;const {target,commandIdentity}=original;
   const owner=this.sources.runOwner(row.run_id),admission=this.sources.admission(row.run_id),domain=this.domain(),processOwner=this.sources.processOwner();
   if(!domain||!owner||owner.state!=='active'||owner.runId!==row.run_id||owner.chatId!==target||!admission||admission.runId!==row.run_id||admission.status!=='admitted'||admission.chatId!==owner.chatId||admission.ownerProcessEpoch!==owner.ownerId)return null;
   let channelIdentity:string|null=null;
   if(owner.ownerKind==='desktop'){if(domain.owner_kind!=='desktop-main'||owner.ownerKind!==processOwner.ownerKind||owner.ownerId!==processOwner.ownerId)return null;}
   else {const proof=this.sources.approvedDaemonCustody?.(Object.freeze({...domain}),Object.freeze({...owner}));if(owner.ownerKind!=='daemon'||domain.owner_kind!=='work-daemon'||owner.ownerId!==domain.owner_epoch||!proof?.identity||!proof.stillCurrent())return null;channelIdentity=proof.identity;}
   if(this.sources.db.prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('cancel','stop-reply') AND state<>'failed' LIMIT 1").get(row.one_id,row.run_id))return null;
   const naturalReply=row.kind==='reply'&&row.task_id===null;let replyAuthorityRevision:string|null=null;
   const control=naturalReply?null:this.sources.currentControl(Object.freeze({...row}));
   if(naturalReply){const reply=this.sources.currentNativeReplyAuthority?.(Object.freeze({...row}));if(!reply||!reply.revision||reply.admissionDigest!==admission.inputDigest||!reply.stillCurrent())return null;replyAuthorityRevision=reply.revision;}
   else if(typeof control!=='string'||!control||control.length>256)return null;
   return{commandId:row.command_id,oneId:row.one_id,taskId:row.task_id??`one:${row.origin_chat_id}`,runId:row.run_id,chatId:target,controlVersion:control,replyAuthorityRevision,payloadHash:row.payload_hash,custodyDigest:oneVaultDigest([owner.leaseId,owner.ownerId,owner.ownerKind,admission.inputDigest,domain.owner_epoch,domain.generation,channelIdentity,row.state,replyAuthorityRevision,commandIdentity])};
  }catch{return null;}
 }
 /** Entry only for a currently pending original native run. Caller supplies no scope/provider metadata. */
 commandForPendingRun(runId:string,mode:'entry'|'consumer'='entry'):string{
  const pending=this.sources.pendingRunKeyElicitation(runId);if(!pending||pending.runId!==runId||pending.requestId!==runId||pending.expiresAt<=this.now())throw new OneVaultError('request_expired');
  const rows=this.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runId) as Array<{command_id:string}>;
  if(rows.length!==1)throw new OneVaultError('authority_denied');const commandId=rows[0].command_id;
  if(!this.resolveCommand(commandId)&&(mode!=='consumer'||!this.anchor(commandId)||!pending.tools.length||!pending.tools.every(tool=>tool.envKeys.length>0&&tool.envKeys.every(key=>!!this.currentStoredReference(commandId,tool.id,key.key)))))throw new OneVaultError('authority_denied');return commandId;
 }
 private recoveryContext(commandId:string):{context:OneVaultNativeContext;evidence:OneVaultRecoveryEvidence;proof:OneVaultRecoveryAuthority}|null{
  try{const policy=this.policy,owner=this.currentNativeOwner(),session=this.sources.nativeSession(),host=this.trust.currentHostMetadata(),m=this.metadata.read(commandId);
   if(!policy?.currentRecovery||!policy.currentRecoveryGrant||!owner||!session||!host||!m?.operationId)return null;
   const r=m.request,b=r.binding,op=this.journal.get(m.operationId),row=this.sources.db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(commandId) as SupervisorRequestRow|undefined;
   if(!row||row.command_id!==b.commandId||row.one_id!==this.sources.oneId()||row.run_id!==b.runId||(row.task_id??`one:${row.origin_chat_id}`)!==b.taskId||!['reply','work','follow-up','chat-send'].includes(row.kind)||!['dispatching','accepted','held','completed','cancelled','failed'].includes(row.state)||b.principalId!==session.userId||b.workspaceId!==session.workspaceId||b.hostId!==owner.hostId||r.hostKeyId!==host.hostKeyId||r.recipientKeyId!==host.recipientKeyId||b.trustGeneration!==host.generation||!verifyOneVault('request',r,host.signingPublicKey))return null;
   if(b.controlVersion===null&&(row.kind!=='reply'||row.task_id!==null||b.taskId!==`one:${row.origin_chat_id}`))return null;
   if(this.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(b.runId).length!==1)return null;
   const original=this.originalTarget(row),custody=this.sources.runOwner(b.runId),admission=this.sources.admission(b.runId),receipt=this.sources.runReceipt?.(b.runId),commandReceipt=JSON.parse(row.receipt_json) as Record<string,unknown>;
   if(!original||!custody||custody.runId!==b.runId||custody.chatId!==original.target||!['desktop','daemon'].includes(custody.ownerKind)||!admission||admission.runId!==b.runId||admission.chatId!==original.target||admission.status!=='admitted'||admission.ownerProcessEpoch!==custody.ownerId||!commandReceipt||commandReceipt.commandId!==commandId||commandReceipt.kind!==row.kind||commandReceipt.runId!==b.runId||commandReceipt.taskId!==row.task_id||commandReceipt.state!==row.state)return null;
   let recoveryKind:OneVaultRecoveryEvidence['recoveryKind'],custodyDigest:string;
   if(custody.state==='released'){
    if(!receipt||receipt.runId!==b.runId||receipt.chatId!==original.target||!['completed','cancelled','failed','interrupted'].includes(receipt.status)||!receipt.startedAt||!receipt.updatedAt||!receipt.finishedAt)return null;
    recoveryKind='released-terminal';custodyDigest=oneVaultDigest(custody);
   }else{
    // An expired live run is not a new entry grant. It still needs the independent
    // retained-source proof below, and cannot borrow a new control/admission identity.
    const a=this.anchor(commandId);
    if(custody.state!=='active'||r.expiresAt>this.now()||!a||a.taskId!==b.taskId||a.runId!==b.runId||a.chatId!==original.target||a.controlVersion!==b.controlVersion)return null;
    recoveryKind='expired-live';custodyDigest=a.custodyDigest;
   }
   if(!op||op.requestId!==b.requestId||op.requestDigest!==oneVaultDigest(r)||op.operationId!==m.operationId||op.expectedGeneration!==b.expectedGeneration||op.generation!==op.expectedGeneration+1||op.slotId!==oneVaultSlot(r)||!['reserved','store_unknown','saved','deleted','failed'].includes(op.state))return null;
   const slot=this.journal.current(op.slotId),settled=['saved','deleted'].includes(op.state);
   if(settled?(slot.generation!==op.generation||slot.pendingOperation!==null||slot.credentialRef!==(op.state==='saved'?op.credentialRef:null)):(slot.generation!==op.expectedGeneration||op.state!=='failed'&&slot.pendingOperation!==op.operationId))return null;
   const evidence:OneVaultRecoveryEvidence={recoveryKind,custodyDigest,request:structuredClone(r),commandId,oneId:row.one_id,taskId:b.taskId,runId:b.runId,executionChatId:original.target,operationId:op.operationId,envelopeDigest:op.envelopeDigest,action:op.action,expectedGeneration:op.expectedGeneration,generation:op.generation,operationState:op.state,payloadHash:row.payload_hash,commandIdentity:original.commandIdentity,commandState:row.state,commandReceiptDigest:oneVaultDigest(row.receipt_json),runReceiptDigest:oneVaultDigest(receipt?[receipt.runId,receipt.chatId,receipt.status,receipt.startedAt,receipt.updatedAt,receipt.finishedAt??null]:null),admissionDigest:admission.inputDigest,originalOwnerId:custody.ownerId,originalOwnerKind:custody.ownerKind,originalLeaseId:custody.leaseId};
   const proof=policy.currentRecovery(Object.freeze(structuredClone(evidence)));
   if(!proof||proof.decision!=='allow'||proof.requestDigest!==op.requestDigest||proof.sourceDigest!==oneVaultDigest(evidence)||proof.principalId!==b.principalId||proof.sessionId!==session.sessionId||proof.workspaceId!==b.workspaceId||!proof.authorityRevision||!proof.permissionRevision||!proof.stillCurrent())return null;
   if(recoveryKind==='expired-live'&&(!proof.originalIntentDigest||!/^[a-f0-9]{64}$/.test(proof.originalIntentDigest)||oneVaultDigest([row.payload_hash,proof.originalIntentDigest,custodyDigest])!==b.intentDigest))return null;
   const {requestId:_id,requestRevision:_revision,hostId:_host,senderId:_sender,trustGeneration:_trust,...originalBinding}=b;
   // Historical task control and signed intent remain unchanged. New revision is status authority only.
   const binding={...originalBinding,sessionId:session.sessionId,authorityRevision:proof.authorityRevision,permissionRevision:proof.permissionRevision,expectedGeneration:slot.generation};
   return{context:{binding,accountLabel:proof.accountLabel},evidence,proof};
  }catch{return null;}
 }
 /** Read-only native producer snapshot. A JSON copy is not admission: the service must
  * still acquire the asynchronous recovery grant and each delivery rechecks this source. */
 retainedOperation(commandId:string):{context:OneVaultNativeContext;evidence:OneVaultRecoveryEvidence}|null{
  const r=this.recoveryContext(commandId);return r?structuredClone({context:r.context,evidence:r.evidence}):null;
 }
 private recoveryIdentity(value:{context:OneVaultNativeContext;evidence:OneVaultRecoveryEvidence}):string{
  const {operationState:_,...evidence}=value.evidence;
  // Only the same broker's validated settlement state/slot generation may advance.
  // recoveryContext independently checks the exact operation/slot CAS on every read.
  return oneVaultDigest({evidence,context:{...value.context,binding:{...value.context.binding,expectedGeneration:value.evidence.expectedGeneration}}});
 }
 private async recoveryAuthority(binding:OneVaultBinding):Promise<OneVaultAuthorityLease>{
  const held=this.recoveryContext(binding.commandId),policy=this.policy,owner=this.currentNativeOwner();if(!held||!policy?.currentRecoveryGrant||!owner)throw new OneVaultError('authority_unavailable');
  const {requestId:_id,requestRevision:_revision,hostId:_host,senderId:_sender,trustGeneration:_trust,...base}=binding;
  if(binding.requestId!==held.evidence.request.binding.requestId||binding.hostId!==owner.hostId||oneVaultDigest(base)!==oneVaultDigest(held.context.binding))throw new OneVaultError('revision_changed');
  if(binding.scope==='organization'&&!policy.prepareRecoveryAuthority)throw new OneVaultError('authority_unavailable');
  if(policy.prepareRecoveryAuthority){
   const prepared=await policy.prepareRecoveryAuthority(Object.freeze(structuredClone(binding)),Object.freeze(structuredClone(held.evidence)));
   const latest=this.recoveryContext(binding.commandId);
   if(prepared.decision!=='allow'||prepared.revision!==binding.authorityRevision||!prepared.stillCurrent()||this.policy!==policy||!held.proof.stillCurrent()||oneVaultDigest(this.currentNativeOwner())!==oneVaultDigest(owner)||!latest||oneVaultDigest(latest.context)!==oneVaultDigest(held.context)||oneVaultDigest(latest.evidence)!==oneVaultDigest(held.evidence))throw new OneVaultError(prepared.decision==='unknown'?'authority_unavailable':'authority_denied');
  }
  const request:OneActionAuthorityRequest={principalId:binding.principalId,sessionId:binding.sessionId,oneId:held.evidence.oneId,hostId:binding.hostId,scope:binding.scope,organizationId:binding.organizationId,workspaceId:binding.workspaceId,projectId:null,resourceId:binding.resourceId,purpose:binding.purpose,payerId:binding.payerId,action:'vault-status-only',taskId:binding.taskId,runId:binding.runId,controlVersion:binding.controlVersion,permissionRevision:binding.permissionRevision,credentialGeneration:String(binding.expectedGeneration),sourceRefs:[binding.commandId,held.evidence.operationId,held.evidence.envelopeDigest,held.proof.sourceDigest],audience:binding.scope==='organization'?'organization':'owner'};
  const current=()=>this.sources.currentActionAuthority(request,policy.personal),decision=current();if(decision.decision!=='allow'||!decision.revision)throw new OneVaultError(decision.decision==='deny'?'authority_denied':'authority_unavailable');
  const grant=await policy.currentRecoveryGrant(Object.freeze(structuredClone(binding)),Object.freeze(structuredClone(held.evidence)));
  if(grant.decision!=='allow'||grant.revision!==binding.authorityRevision)throw new OneVaultError(grant.decision==='deny'?'authority_denied':'authority_unavailable');
  const stillCurrent=()=>{try{const latest=this.recoveryContext(binding.commandId),d=current();return this.policy===policy&&held.proof.stillCurrent()&&grant.stillCurrent()&&oneVaultDigest(this.currentNativeOwner())===oneVaultDigest(owner)&&!!latest&&this.recoveryIdentity(latest)===this.recoveryIdentity(held)&&d.decision==='allow'&&d.revision===decision.revision;}catch{return false;}};
  if(!stillCurrent())throw new OneVaultError('authority_denied');return{stillCurrent};
 }
 resolveCommand(commandId:string,mode:'entry'|'reconcile'='entry'):OneVaultNativeContext|null{
  if(mode==='reconcile'){const retained=this.recoveryContext(commandId);if(retained)return retained.context;return this.resolveCommand(commandId,'entry');}
  try{const anchor=this.anchor(commandId),session=this.sources.nativeSession();if(!anchor||!session||!this.policy)return null;
   const pending=this.sources.pendingRunKeyElicitation(anchor.runId),intent=this.policy.currentIntent(Object.freeze(anchor),pending?Object.freeze(structuredClone(pending)):null);
   if(!intent||intent.principalId!==session.userId||intent.sessionId!==session.sessionId||intent.replyAuthorityRevision!==anchor.replyAuthorityRevision||intent.workspaceId!==session.workspaceId||intent.provider!=='elevenlabs-audio'||!Object.hasOwn(ENDPOINTS,intent.region)||!/^[a-f0-9]{64}$/.test(intent.intentDigest)||!intent.providerWorkspace||!intent.permissionRevision||!intent.authorityRevision||intent.scope==='personal'&&intent.organizationId!==null||intent.scope==='organization'&&!intent.organizationId)return null;
   const old=this.metadata.read(commandId);
   if(pending){if(pending.runId!==anchor.runId||pending.expiresAt<=this.now()||intent.pendingRequestDigest!==oneVaultDigest(pending)||!pending.tools.some(t=>t.id===intent.toolId&&t.envKeys.some(e=>e.key===intent.envKey)))return null;}
   else if((!old?.operationId||!this.journal.get(old.operationId))&&!this.currentStoredReference(commandId,intent.toolId,intent.envKey))return null;
   const binding:OneVaultNativeContext['binding']={commandId,intentDigest:oneVaultDigest([anchor.payloadHash,intent.intentDigest,anchor.custodyDigest]),principalId:session.userId,sessionId:session.sessionId,scope:intent.scope,organizationId:intent.organizationId,workspaceId:intent.workspaceId,resourceId:intent.resourceId,purpose:intent.purpose,payerId:intent.payerId,taskId:anchor.taskId,runId:anchor.runId,controlVersion:anchor.controlVersion,authorityRevision:intent.authorityRevision,provider:intent.provider,providerWorkspace:intent.providerWorkspace,region:intent.region,endpoint:ENDPOINTS[intent.region],operations:[...intent.operations],permissionRevision:intent.permissionRevision,storage:'os-vault',expectedGeneration:0,cost:intent.cost?structuredClone(intent.cost):null};
   binding.expectedGeneration=this.journal.current(oneVaultSlot({binding} as OneVaultRequest)).generation;
   return{binding,accountLabel:intent.accountLabel};
  }catch{return null;}
 }
 async authority(binding:OneVaultBinding,phase:Parameters<OneVaultRuntimePolicy['currentGrant']>[1],mode:'entry'|'reconcile'='entry'):Promise<OneVaultAuthorityLease>{
  if(mode==='reconcile'){if(phase!=='reconcile')throw new OneVaultError('authority_denied');if(this.recoveryContext(binding.commandId)||!this.resolveCommand(binding.commandId,'entry'))return this.recoveryAuthority(binding);}
  const policy=this.policy,anchor=this.anchor(binding.commandId),context=this.resolveCommand(binding.commandId),owner=this.currentNativeOwner();if(!policy||!anchor||!context||!owner)throw new OneVaultError('authority_unavailable');
  const {requestId:_r,requestRevision:_v,hostId:_h,senderId:_s,trustGeneration:_g,...base}=binding;
  if(base.expectedGeneration!==context.binding.expectedGeneration&&!phase.startsWith('provider-')){const m=this.metadata.read(binding.commandId),op=m?.operationId?this.journal.get(m.operationId):null;if(!m||m.request.binding.requestId!==binding.requestId||!op||!['saved','deleted'].includes(op.state)||op.requestDigest!==oneVaultDigest(m.request)||op.expectedGeneration!==base.expectedGeneration||op.generation!==context.binding.expectedGeneration)throw new OneVaultError('generation_conflict');base.expectedGeneration=context.binding.expectedGeneration;}
  if(binding.hostId!==owner.hostId||oneVaultDigest(base)!==oneVaultDigest(context.binding))throw new OneVaultError('revision_changed');
  if(binding.scope==='organization'&&!policy.prepareAuthority)throw new OneVaultError('authority_unavailable');
  if(policy.prepareAuthority){
   const prepared=await policy.prepareAuthority(Object.freeze(structuredClone(binding)),phase),latest=this.resolveCommand(binding.commandId);
   if(prepared.decision!=='allow'||prepared.revision!==binding.authorityRevision||!prepared.stillCurrent()||this.policy!==policy||oneVaultDigest(this.anchor(binding.commandId))!==oneVaultDigest(anchor)||oneVaultDigest(this.currentNativeOwner())!==oneVaultDigest(owner)||!latest||oneVaultDigest(latest.binding)!==oneVaultDigest(base))throw new OneVaultError(prepared.decision==='unknown'?'authority_unavailable':'authority_denied');
  }
  const request:OneActionAuthorityRequest={principalId:binding.principalId,sessionId:binding.sessionId,oneId:anchor.oneId,hostId:binding.hostId,scope:binding.scope,organizationId:binding.organizationId,workspaceId:binding.workspaceId,projectId:null,resourceId:binding.resourceId,purpose:binding.purpose,payerId:binding.payerId,action:phase.startsWith('provider-')?phase:`vault-${phase}`,taskId:binding.taskId,runId:binding.runId,controlVersion:binding.controlVersion,permissionRevision:binding.permissionRevision,credentialGeneration:String(binding.expectedGeneration),sourceRefs:[binding.commandId,anchor.payloadHash,binding.intentDigest],audience:binding.scope==='organization'?'organization':'owner'};
  const decision=this.sources.currentActionAuthority(request,policy.personal);if(decision.decision!=='allow'||!decision.revision)throw new OneVaultError(decision.decision==='deny'?'authority_denied':'authority_unavailable');
  const grant=await policy.currentGrant(Object.freeze(structuredClone(binding)),phase);
  if(grant.decision!=='allow'||grant.revision!==binding.authorityRevision)throw new OneVaultError(grant.decision==='deny'?'authority_denied':'authority_unavailable');
  const stillCurrent=()=>{try{const current=this.resolveCommand(binding.commandId),latest=this.sources.currentActionAuthority(request,policy.personal);return this.policy===policy&&grant.stillCurrent()&&oneVaultDigest(this.anchor(binding.commandId))===oneVaultDigest(anchor)&&oneVaultDigest(this.currentNativeOwner())===oneVaultDigest(owner)&&!!current&&oneVaultDigest(current.binding)===oneVaultDigest(base)&&latest.decision==='allow'&&latest.revision===decision.revision;}catch{return false;}};
  if(!stillCurrent())throw new OneVaultError('authority_denied');return{stillCurrent};
 }
 private approvalValid(id:string,owner:Readonly<OneVaultNativeOwner>,digest:string):boolean{try{const r=this.sources.db.prepare('SELECT owner_json,metadata_digest,revoked_at FROM one_vault_native_approvals WHERE id=?').get(id) as {owner_json:string;metadata_digest:string;revoked_at:number|null}|undefined;return !!r&&r.revoked_at===null&&r.metadata_digest===digest&&oneVaultDigest(JSON.parse(r.owner_json))===oneVaultDigest(owner)&&oneVaultDigest(this.currentNativeOwner())===oneVaultDigest(owner);}catch{return false;}}
 private async approve(action:OneVaultNativeOwnerAction,d:Readonly<OneVaultTrustDisclosure>):Promise<{approved:boolean;interactionId:string}>{
  const held=this.actions.get(action);this.actions.delete(action);const valid=()=>!!held&&held.expiresAt>this.now()&&!held.window.isDestroyed()&&held.window.isFocused()&&this.sources.isNativeOwnerWindow(held.window)&&oneVaultDigest(this.currentNativeOwner())===oneVaultDigest(held.owner)&&oneVaultDigest(d.owner)===oneVaultDigest(held.owner);
  if(!valid()||!await this.sources.showNativeApproval(held!.window,d)||!valid())return{approved:false,interactionId:''};
  const id=`native-approval:${randomUUID()}`;
  if(d.operation==='enroll-sender'){const c=d.challenge,m={hostId:d.owner.hostId,senderId:c.senderId,senderKeyId:c.senderKeyId,publicKey:c.publicKey,generation:d.generation,principalId:d.owner.principalId,workspaceId:d.owner.workspaceId,organizationId:c.organizationId,approvedNativeReceiptId:id,revokedAt:null};this.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,d.operationId,JSON.stringify(d.owner),oneVaultDigest(m),JSON.stringify(d),this.now());return{approved:true,interactionId:id};}
  const m:OneVaultApprovedHostMetadata={hostId:d.owner.hostId,hostKeyId:`native-sign:${d.operationId}`,signingKeyRef:`one-vault-trust:${d.operationId}:signing`,signingPublicKey:d.signingPublicKey,recipientKeyId:`native-seal:${d.operationId}`,recipientKeyRef:`one-vault-trust:${d.operationId}:recipient`,recipientPublicKey:d.recipientPublicKey,generation:d.generation,approvedNativeReceiptId:id,revokedAt:null};
  this.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,d.operationId,JSON.stringify(d.owner),oneVaultDigest(m),JSON.stringify(d),this.now());return{approved:true,interactionId:id};
 }
 /** Main-only native enrollment review. Missing independent source cannot open the dialog. */
 async approveMobileSenderFromWindow(window:OneVaultOwnerWindow,handle:OneMobileEnrollmentHandle){
  if(!handle||typeof handle!=='object'||this.enrollmentHandles.has(handle))throw new OneVaultError('authority_denied');
  this.enrollmentHandles.add(handle);
  const owner=this.currentNativeOwner(),enrollment=this.sources.mobileSenderEnrollment?.(handle);
  if(!owner||!enrollment||!enrollment.stillCurrent()||window.isDestroyed()||!window.isFocused()||!this.sources.isNativeOwnerWindow(window))throw new OneVaultError('secure_route_unavailable');
  if(this.sources.db.prepare("SELECT 1 FROM one_vault_native_approvals WHERE json_extract(disclosure_json,'$.operation')='enroll-sender' AND json_extract(disclosure_json,'$.challenge.senderId')=? AND json_extract(disclosure_json,'$.challenge.channelEpoch')=? AND json_extract(disclosure_json,'$.challenge.revision')=? LIMIT 1").get(enrollment.senderId,enrollment.channelEpoch,enrollment.revision))throw new OneVaultError('replay_conflict');
  const action=Object.freeze({});this.actions.set(action,{window,owner,enrollment,expiresAt:Math.min(this.now()+120000,enrollment.expiresAt)});
  try{return await this.trust.enrollMobileSender(action);}finally{this.actions.delete(action);}
 }
 /** Root calls only from its registered native owner UI command. No token is exposed across IPC. */
 async approveHostFromWindow(window:OneVaultOwnerWindow,mode:'initialize-or-rotate'|'reconcile'|'reauthorize'='initialize-or-rotate'):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedHostMetadata|null}>{
  const owner=this.currentNativeOwner();if(!owner||window.isDestroyed()||!window.isFocused()||!this.sources.isNativeOwnerWindow(window))throw new OneVaultError('authority_denied');
  const action=Object.freeze({});this.actions.set(action,{window,owner,expiresAt:this.now()+120000});return mode==='reauthorize'?this.trust.reauthorizeExisting(action):mode==='reconcile'?this.trust.reconcile(action):this.trust.initializeOrRotate(action);
 }
 /** Native logout/change hook: revoke durable approvals and invalidate every live form. */
 invalidateApprovals():void{this.sources.db.prepare('UPDATE one_vault_native_approvals SET revoked_at=? WHERE revoked_at IS NULL').run(this.now());this.service.notifyAuthorityChanged();}
}
/** Call only after Main has opened the existing store and established its current Supervisor owner.
 * Importing this module itself touches neither profile, OSVault nor Electron UI. */
export function existingOneVaultRuntimeSources(input:Pick<OneVaultRuntimeSources,'currentControl'|'isNativeOwnerWindow'> & Pick<Partial<OneVaultRuntimeSources>,'approvedDaemonCustody'|'currentNativeReplyAuthority'|'mobileSenderEnrollment'>):OneVaultRuntimeSources{
 const electron=require('electron') as typeof import('electron'),db=require('../store/db') as {getDb():OneVaultSqlite},auth=require('../auth') as {getAuthenticatedSessionBinding():Session|null},profile=require('../store/one-profile') as {getOneProfile():{oneId:string}},host=require('../one/host-identity') as {oneNativeHostIdentity:OneVaultRuntimeSources['hostIdentity']},runtime=require('../one/supervisor-native-runtime') as {supervisorRuntimeMode:OneVaultRuntimeSources['supervisorMode']},appRuntime=require('../long-run/app-runtime-coordinator') as {desktopAppInstanceId():string},owners=require('../store/invocation-run-owners') as {invocationProcessOwner:OneVaultRuntimeSources['processOwner'];invocationRunOwners:{getOwnerByRunId:OneVaultRuntimeSources['runOwner']}},admissions=require('../store/invocation-admissions') as {getInvocationAdmission:OneVaultRuntimeSources['admission']},authority=require('../one/action-authority') as {currentOneActionAuthority:OneVaultRuntimeSources['currentActionAuthority']},vault=require('./vault') as OneVaultExistingOsVault,events=require('../store/run-events') as {getInvocationRunReceipt:NonNullable<OneVaultRuntimeSources['runReceipt']>},keyElicitation=require('../mcp/run-key-elicitation') as {pendingRunKeyElicitation:OneVaultRuntimeSources['pendingRunKeyElicitation']};
 return{...input,runReceipt:events.getInvocationRunReceipt,pendingRunKeyElicitation:keyElicitation.pendingRunKeyElicitation,db:db.getDb(),vault,hostIdentity:host.oneNativeHostIdentity,nativeSession:auth.getAuthenticatedSessionBinding,oneId:()=>profile.getOneProfile().oneId,hasSingleInstanceLock:()=>electron.app.hasSingleInstanceLock(),desktopOwnerEpoch:appRuntime.desktopAppInstanceId,supervisorMode:runtime.supervisorRuntimeMode,processOwner:owners.invocationProcessOwner,runOwner:id=>owners.invocationRunOwners.getOwnerByRunId(id),admission:admissions.getInvocationAdmission,currentActionAuthority:authority.currentOneActionAuthority,showNativeApproval:async(window,d)=>{
  const native=electron.BrowserWindow.fromId(window.id);if(native!==window||!native.isFocused()||!input.isNativeOwnerWindow(window))return false;
  if(d.operation==='enroll-sender'){
   const c=d.challenge,result=await electron.dialog.showMessageBox(native,{type:'question',title:'Approve paired credential sender',message:'Compare this code on the independently approved phone and approve this exact sender.',detail:`Comparison code: ${d.sas}\nHost: ${d.owner.hostId}\nAccount: ${d.owner.principalId}\nWorkspace: ${d.owner.workspaceId}\nOrganization: ${c.organizationId??'personal'}\nDevice: ${c.deviceId}\nSender key: ${c.publicKey}\nHost key: ${c.hostPublicKey}\nPermission: credential submission only; each request requires its own current grant\nStorage: operating-system credential vault\nCharge: none\nTrust generation: ${d.generation}\nNative Mobile confirmation: ${d.mobileInteractionId}`,buttons:['Cancel','Approve'],defaultId:0,cancelId:0,noLink:true});return result.response===1;
  }
  const result=await electron.dialog.showMessageBox(native,{type:'question',title:'Approve secure credential storage',message:d.operation==='reauthorize'?'Reauthorize the same secure storage keys for this native session?':d.operation==='reconcile'?'Check the previously approved secure storage setup?':'Approve secure storage keys for this host?',detail:`Host: ${d.owner.hostId}\nAccount: ${d.owner.principalId}\nWorkspace: ${d.owner.workspaceId}\nStorage: operating-system credential vault\nCharge: none\nTrust generation: ${d.generation}\nSigning public key: ${d.signingPublicKey}\nEncryption public key: ${d.recipientPublicKey}`,buttons:['Cancel','Approve'],defaultId:0,cancelId:0,noLink:true});return result.response===1;
 }};
}
let current:OneVaultRuntime|null=null;
export function configureOneVaultRuntime(sources:OneVaultRuntimeSources):OneVaultRuntime{if(current)throw new OneVaultError('secure_route_unavailable');current=new OneVaultRuntime(sources);return current;}
export function currentOneVaultRuntime():OneVaultRuntime|null{return current;}
