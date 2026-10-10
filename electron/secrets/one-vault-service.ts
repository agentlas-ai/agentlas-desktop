import {createPrivateKey,randomBytes,randomUUID,verify,type KeyObject} from 'node:crypto';
import {OneVaultError,oneVaultCanonical,type OneVaultBinding,type OneVaultRequest,type OneVaultEnvelope,type OneVaultReceipt,type OneVaultStatusQuery,type OneVaultCancelQuery,type OneVaultCancelReceipt,type OneVaultErrorCode,type OneVaultRecoveryDescriptor,type OneVaultWindowBootstrap} from '../../shared/one-vault';
import {OneVaultBroker,type OneVaultAuthorityLease,type OneVaultTrust} from './one-vault-broker';
import {OneVaultJournal,type OneVaultSqlite} from './one-vault-journal';
import {authenticateOneVaultEnvelope,decodeOneVaultBase64,issueOneVaultRequest,oneVaultDigest,oneVaultPublicKey,oneVaultPublicPoint,signOneVault} from './one-vault-crypto';
export type {OneVaultWindowBootstrap} from '../../shared/one-vault';
export interface OneVaultApprovedHostMetadata {
 hostId:string;hostKeyId:string;signingKeyRef:string;signingPublicKey:string;
 recipientKeyId:string;recipientKeyRef:string;recipientPublicKey:string;generation:number;
 approvedNativeReceiptId:string;revokedAt:number|null;
}
export interface OneVaultApprovedSenderMetadata {
 hostId:string;senderId:string;senderKeyId:string;publicKey:string;generation:number;
 principalId:string;workspaceId:string;organizationId:string|null;approvedNativeReceiptId:string;revokedAt:number|null;
}
export interface OneVaultHostKeys {metadata:OneVaultApprovedHostMetadata;signingKey:KeyObject;recipientKey:KeyObject}
/** Read-only trusted enrollment port. Implementations read native-approved metadata and
 * encrypted OS-Vault key refs. This feature never silently creates/activates host/device identity. */
export interface OneVaultNativeTrustPort {
 approvedHost():Promise<OneVaultApprovedHostMetadata|null>;
 approvedMobileSender(senderId:string):OneVaultApprovedSenderMetadata|null;
 currentHostMetadata():OneVaultApprovedHostMetadata|null;
 nativeApprovalValid(receiptId:string,metadataDigest:string):boolean;
}
export interface OneVaultExistingOsVault {
 setSecret(ref:string,value:string):Promise<void>;readSecret(ref:string):Promise<string|null>;deleteSecret(ref:string):Promise<void>;
 retryCredentialReadFromUser(kind:'secret',ref:string):Promise<void>;
}
/** Only called on an explicit native user's open/status action; never background discovery. */
export async function loadOneVaultApprovedHost(configuredHostId:string,trust:OneVaultNativeTrustPort,vault:OneVaultExistingOsVault):Promise<OneVaultHostKeys> {
 const m=await trust.approvedHost();
 if(!m||m.hostId!==configuredHostId||m.revokedAt!==null||!trust.nativeApprovalValid(m.approvedNativeReceiptId,oneVaultDigest(m))||!Number.isSafeInteger(m.generation)||m.generation<1||!/^one-vault-trust:[A-Za-z0-9:._-]+$/.test(m.signingKeyRef)||!/^one-vault-trust:[A-Za-z0-9:._-]+$/.test(m.recipientKeyRef)||m.signingKeyRef===m.recipientKeyRef)throw new OneVaultError('secure_route_unavailable');
 try{
  const signing=await vault.readSecret(m.signingKeyRef),recipient=await vault.readSecret(m.recipientKeyRef);
  if(!signing||!recipient)throw new OneVaultError('secure_route_unavailable');
  const signingKey=createPrivateKey(signing),recipientKey=createPrivateKey(recipient);
  if(oneVaultPublicPoint(signingKey)!==m.signingPublicKey||oneVaultPublicPoint(recipientKey)!==m.recipientPublicKey||oneVaultDigest(trust.currentHostMetadata())!==oneVaultDigest(m))throw new OneVaultError('secure_route_unavailable');
  return {metadata:structuredClone(m),signingKey,recipientKey};
 }catch{throw new OneVaultError('secure_route_unavailable');}
}
interface Metadata {request:OneVaultRequest;senderKeyId:string;senderPublicKey:string|null;state:'register-required'|'entry-ready'|'cancelled';nativeSurfaceId:string;operationId:string|null;statusOnly:boolean}
/** Adds value-free metadata to the SAME Supervisor command, preserving existing queue state/payload hash. */
export class OneVaultCommandMetadata {
 constructor(private readonly db:OneVaultSqlite){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_requests'").get())throw new OneVaultError('secure_route_unavailable');
  if(!(db.prepare('PRAGMA table_info(one_supervisor_requests)').all() as Array<{name:string}>).some(x=>x.name==='one_vault_metadata_json'))db.exec('ALTER TABLE one_supervisor_requests ADD COLUMN one_vault_metadata_json TEXT');
 }
 read(commandId:string):Metadata|null {const row=this.db.prepare('SELECT one_vault_metadata_json AS value FROM one_supervisor_requests WHERE command_id=?').get(commandId) as {value:string|null}|undefined;if(!row?.value)return null;try{return JSON.parse(row.value) as Metadata;}catch{throw new OneVaultError('invalid_request');}}
 write(binding:OneVaultBinding,value:Metadata,expected:Metadata|null):void {
  const result=this.db.prepare("UPDATE one_supervisor_requests SET one_vault_metadata_json=? WHERE command_id=? AND COALESCE(task_id,'one:'||origin_chat_id)=? AND run_id=? AND one_vault_metadata_json IS ?").run(JSON.stringify(value),binding.commandId,binding.taskId,binding.runId,expected===null?null:JSON.stringify(expected));
  if(Number(result.changes)!==1)throw new OneVaultError('revision_changed');
 }
}
export interface OneVaultNativeContext {
 binding:Omit<OneVaultBinding,'requestId'|'requestRevision'|'hostId'|'senderId'|'trustGeneration'>;
 accountLabel:string;
}
export interface OneVaultSurface {
 /** Unforgeable Main-created object, never serialized to renderer. */
 id:string;ready():boolean;confirmSender(request:OneVaultRequest,statusOnly?:boolean):Promise<boolean>;changed():void;close():void;
}
export interface OneVaultServicePorts {
 configuredHostId():string;
 nativeSession():{userId:string;sessionId:string;workspaceId:string;expiresAt:number|null}|null;
 /** Derive from actual current Supervisor command/task/run/control and grant records. */
 resolveCommand(commandId:string,mode?:'entry'|'reconcile'):OneVaultNativeContext|null;
 authority(binding:OneVaultBinding,phase:'decrypt'|'store'|'commit'|'reconcile',mode?:'entry'|'reconcile'):Promise<OneVaultAuthorityLease>;
 exclusiveHost():boolean;
 trust:OneVaultNativeTrustPort;vault:OneVaultExistingOsVault;
 metadata:OneVaultCommandMetadata;journal:OneVaultJournal;
 invalidateProviderReadiness(slotId:string,generation:number):void;
 now?:()=>number;
}
export interface OneVaultMobileLease {readonly sender:Readonly<OneVaultApprovedSenderMetadata>;stillCurrent():boolean;}
interface Live {surface:OneVaultSurface|null;mobile?:OneVaultMobileLease;metadata:Metadata;host:OneVaultHostKeys;challenge:string;challengeExpiresAt:number;registering:boolean;cancelled:boolean;accountLabel:string;operationId:string|null}
export class OneVaultService {
 private authorityBlocked=false;private authorityEpoch=0;private authorityCleanupUnknown=false;
 private readonly authorityCalls=new Set<Promise<unknown>>();
 private async trackAuthority<T>(body:()=>Promise<T>):Promise<T>{
  if(this.authorityBlocked)throw new OneVaultError('authority_unavailable');
  const epoch=this.authorityEpoch,work=Promise.resolve().then(()=>{if(this.authorityBlocked||epoch!==this.authorityEpoch)throw new OneVaultError('authority_unavailable');return body()});
  this.authorityCalls.add(work);try{return await work}finally{this.authorityCalls.delete(work)}
 }
 /** Revoke transient custody only. No request cancellation, journal update or credential retry. */
 beginAuthorityDrain():Promise<void>{
  this.authorityBlocked=true;this.authorityEpoch++;
  const rows=[...this.live.values(),...this.mobileLive.values()];this.live.clear();this.mobileLive.clear();
  for(const l of rows)l.cancelled=true;
  for(const l of rows)try{l.surface?.close()}catch{this.authorityCleanupUnknown=true}
  return Promise.allSettled([...this.authorityCalls]).then(()=>{if(this.authorityCleanupUnknown||this.authorityCalls.size)throw new OneVaultError('authority_unavailable')});
 }
 authorityDrainState():{epoch:number;confirmed:boolean}{return{epoch:this.authorityEpoch,confirmed:this.authorityBlocked&&!this.authorityCleanupUnknown&&this.authorityCalls.size===0&&this.live.size===0&&this.mobileLive.size===0}}
 resumeDrainedAuthority(epoch:number):void{const state=this.authorityDrainState();if(!state.confirmed||state.epoch!==epoch)throw new OneVaultError('authority_unavailable');this.authorityBlocked=false;}
 private readonly live=new Map<string,Live>();
 private readonly mobileLive=new Map<string,Live>();
 private readonly broker:OneVaultBroker;
 constructor(private readonly p:OneVaultServicePorts){
  this.broker=new OneVaultBroker({journal:p.journal,request:id=>this.byRequest(id)?.metadata.request??null,trust:r=>this.trusted(r),authorize:async(r,phase)=>{const l=this.byRequest(r.binding.requestId);if(!l)throw new OneVaultError('not_found');const lease=await p.authority(this.authorizationBinding(l),phase,l.metadata.statusOnly?'reconcile':'entry');return{stillCurrent:()=>{try{this.assertLive(l,true);return lease.stillCurrent();}catch{return false;}}};},cancelRequest:r=>{const l=this.byRequest(r.binding.requestId);if(!l?.mobile)throw new OneVaultError('secure_route_unavailable');this.assertLive(l,true);const next:Metadata={...l.metadata,state:'cancelled'};p.metadata.write(r.binding,next,l.metadata);l.metadata=next;l.cancelled=true;this.mobileLive.delete(r.binding.requestId);},exclusiveHost:()=>p.exclusiveHost(),now:()=>this.now(),invalidateProviderReadiness:p.invalidateProviderReadiness,
   vault:{setSecret:(ref,value)=>p.vault.setSecret(ref,value),deleteSecret:ref=>p.vault.deleteSecret(ref),readSecret:async ref=>{await p.vault.retryCredentialReadFromUser('secret',ref);return p.vault.readSecret(ref);}}});
 }
 private now(){return this.p.now?.()??Date.now();}
 private byRequest(id:string):Live|undefined{return [...this.live.values(),...this.mobileLive.values()].find(x=>!x.cancelled&&x.metadata.request.binding.requestId===id);}
 private context(commandId:string,mode:'entry'|'reconcile'='entry'):OneVaultNativeContext {
  if(this.authorityBlocked)throw new OneVaultError('authority_unavailable');
  const c=this.p.resolveCommand(commandId,mode),session=this.p.nativeSession();
  if(!this.p.exclusiveHost()||!c||!session||session.expiresAt!==null&&session.expiresAt<=this.now()||c.binding.commandId!==commandId||c.binding.principalId!==session.userId||c.binding.sessionId!==session.sessionId||c.binding.workspaceId!==session.workspaceId)throw new OneVaultError('authority_denied');return c;
 }
 private authorizationBinding(l:Live):OneVaultBinding {
  return l.metadata.statusOnly?{...l.metadata.request.binding,...this.context(l.metadata.request.binding.commandId,'reconcile').binding}:l.metadata.request.binding;
 }
 /** Main-only current-owner recovery affordance; returns no credential or sender key. */
 recoveryRequestId(commandId:string):string {
  this.context(commandId,'reconcile');const m=this.p.metadata.read(commandId),op=m?.operationId?this.p.journal.get(m.operationId):null;
  if(!m||!op||op.requestDigest!==oneVaultDigest(m.request))throw new OneVaultError('not_found');return m.request.binding.requestId;
 }
 private recovery(l:Live):OneVaultRecoveryDescriptor|null {
  if(!l.metadata.statusOnly)return null;const op=l.metadata.operationId?this.p.journal.get(l.metadata.operationId):null;
  if(!op||op.requestDigest!==oneVaultDigest(l.metadata.request))throw new OneVaultError('not_found');
  return signOneVault<OneVaultRecoveryDescriptor>('recovery',{schema:'agentlas.one-vault-recovery.v1',hostId:l.host.metadata.hostId,hostKeyId:l.host.metadata.hostKeyId,requestDigest:op.requestDigest,operationId:op.operationId,envelopeDigest:op.envelopeDigest,action:op.action,expectedGeneration:op.expectedGeneration,senderKeyId:l.metadata.senderKeyId,currentAuthorityDigest:oneVaultDigest(this.authorizationBinding(l)),issuedAt:this.now(),expiresAt:this.now()+120000,signature:''},l.host.signingKey);
 }
 private assertLive(l:Live,allowExpired=false):void {
  if(l.cancelled||!(l.surface?l.surface.ready():l.mobile?.stillCurrent())||!this.p.exclusiveHost())throw new OneVaultError('secure_route_unavailable');
  if(l.mobile)this.checkMobileSender(l.mobile,l.metadata.request);
  const r=l.metadata.request,b=r.binding,c=this.context(b.commandId,l.metadata.statusOnly?'reconcile':'entry');
  const {requestId:_id,requestRevision:_revision,hostId:_host,senderId:_sender,trustGeneration:_trust,...original}=b;
  // A saved operation advances credential generation, but its pending form retains its exact signed request.
  if(c.binding.expectedGeneration!==original.expectedGeneration){
   const op=l.operationId?this.p.journal.get(l.operationId):null;
   if(!op||!['saved','deleted'].includes(op.state)||op.requestDigest!==oneVaultDigest(r)||op.generation!==c.binding.expectedGeneration)throw new OneVaultError('generation_conflict');
  }
  const current={...c.binding,expectedGeneration:original.expectedGeneration,...(l.metadata.statusOnly?{sessionId:original.sessionId,authorityRevision:original.authorityRevision,permissionRevision:original.permissionRevision}:{})};
  if(oneVaultDigest(current)!==oneVaultDigest(original)||b.hostId!==this.p.configuredHostId()||oneVaultDigest(this.p.trust.currentHostMetadata())!==oneVaultDigest(l.host.metadata)||!this.p.trust.nativeApprovalValid(l.host.metadata.approvedNativeReceiptId,oneVaultDigest(l.host.metadata))||oneVaultDigest(this.p.metadata.read(b.commandId))!==oneVaultDigest(l.metadata))throw new OneVaultError('revision_changed');
  if(!allowExpired&&r.expiresAt<=this.now())throw new OneVaultError('request_expired');
 }
 private trusted(r:OneVaultRequest):OneVaultTrust|null {
  const l=this.byRequest(r.binding.requestId);if(!l)return null;
  try{this.assertLive(l,true);}catch{return null;}
  const sender=l.metadata.senderPublicKey;if(!sender||l.metadata.state!=='entry-ready')return null;
  return {hostId:r.binding.hostId,hostKeyId:l.host.metadata.hostKeyId,hostSigningKey:l.host.signingKey,recipientKeyId:l.host.metadata.recipientKeyId,recipientPrivateKey:l.host.recipientKey,senderId:r.binding.senderId,senderKeyId:l.metadata.senderKeyId,senderPublicKey:sender,generation:l.host.metadata.generation};
 }
 /** Main-only native call. commandId is read from the owner-bound action, never generic caller run params. */
 async open(commandId:string,surface:OneVaultSurface,options:{reconcileOnly?:boolean}={}):Promise<OneVaultWindowBootstrap>{return this.trackAuthority(async()=>{
  if(this.live.has(surface.id))throw new OneVaultError('replay_conflict');
  const mode=options.reconcileOnly?'reconcile':'entry',c=this.context(commandId,mode),host=await loadOneVaultApprovedHost(this.p.configuredHostId(),this.p.trust,this.p.vault);
  if(oneVaultDigest(this.context(commandId,mode))!==oneVaultDigest(c)||!surface.ready())throw new OneVaultError('revision_changed');
  const old=this.p.metadata.read(commandId);
  if(options.reconcileOnly){
   if(!old?.operationId||this.byRequest(old.request.binding.requestId))throw new OneVaultError('request_consumed');
   const op=this.p.journal.get(old.operationId);
   if(!op||op.requestDigest!==oneVaultDigest(old.request)||old.request.hostKeyId!==host.metadata.hostKeyId||old.request.recipientKeyId!==host.metadata.recipientKeyId||old.request.binding.trustGeneration!==host.metadata.generation)throw new OneVaultError('secure_route_unavailable');
   const metadata:Metadata={...old,senderKeyId:randomUUID(),senderPublicKey:null,state:'register-required',nativeSurfaceId:surface.id,statusOnly:true};
   const l:Live={surface,metadata,host,challenge:randomBytes(32).toString('base64url'),challengeExpiresAt:this.now()+60000,registering:false,cancelled:false,accountLabel:c.accountLabel,operationId:op.operationId};
   const lease=await this.p.authority(this.authorizationBinding(l),'reconcile','reconcile');if(!lease.stillCurrent()||oneVaultDigest(this.context(commandId,mode))!==oneVaultDigest(c))throw new OneVaultError('authority_denied');
   this.p.metadata.write(old.request.binding,metadata,old);this.live.set(surface.id,l);
   try{this.assertLive(l,true);}catch(error){this.cancel(surface,old.request.binding.requestId,'cancelled');throw error;}
   return this.bootstrap(surface);
  }
  if(old&&old.state!=='cancelled'&&(old.operationId||this.byRequest(old.request.binding.requestId)))throw new OneVaultError('request_consumed');
  if(old?.operationId){const effect=this.p.journal.get(old.operationId);if(effect&&['reserved','store_unknown'].includes(effect.state))throw new OneVaultError('store_unknown');}
  const binding:OneVaultBinding={...c.binding,requestId:surface.id,requestRevision:(old?.request.binding.requestRevision??0)+1,hostId:host.metadata.hostId,senderId:`native-window:${randomUUID()}`,trustGeneration:host.metadata.generation};
  const lease=await this.p.authority(binding,'decrypt');if(!lease.stillCurrent()||oneVaultDigest(this.context(commandId,mode))!==oneVaultDigest(c))throw new OneVaultError('authority_denied');
  const request=issueOneVaultRequest(binding,{hostKeyId:host.metadata.hostKeyId,signingKey:host.signingKey,recipientKeyId:host.metadata.recipientKeyId,recipientKey:host.recipientKey},this.now());
  const metadata:Metadata={request,senderKeyId:randomUUID(),senderPublicKey:null,state:'register-required',nativeSurfaceId:surface.id,operationId:null,statusOnly:false};
  this.p.metadata.write(binding,metadata,old);
  const l:Live={surface,metadata,host,challenge:randomBytes(32).toString('base64url'),challengeExpiresAt:this.now()+60000,registering:false,cancelled:false,accountLabel:c.accountLabel,operationId:null};this.live.set(surface.id,l);
  return this.bootstrap(surface);
 });}
 private bound(surface:OneVaultSurface,requestId?:string|null):Live {
  const l=this.live.get(surface.id);if(!l||l.surface!==surface||requestId!==undefined&&requestId!==null&&l.metadata.request.binding.requestId!==requestId)throw new OneVaultError('not_found');return l;
 }
 bootstrap(surface:OneVaultSurface):OneVaultWindowBootstrap {
  let l:Live|undefined;try{l=this.bound(surface);this.assertLive(l,true);const r=l.metadata.request,m=l.host.metadata;return{state:l.metadata.state==='entry-ready'?'entry-ready':'register-required',request:structuredClone(r),recovery:this.recovery(l),pinnedHost:{hostId:m.hostId,hostKeyId:m.hostKeyId,publicKey:m.signingPublicKey,trustGeneration:m.generation},sender:{senderId:r.binding.senderId,keyId:l.metadata.senderKeyId,challengeNonce:l.challenge,challengeExpiresAt:l.challengeExpiresAt,requestId:r.binding.requestId,requestRevision:r.binding.requestRevision},accountLabel:l.accountLabel,bindingKey:oneVaultDigest(r.binding),sensitiveSurfaceReady:surface.ready(),errorCode:null};}
  catch(error){return{state:'blocked',request:null,recovery:null,pinnedHost:null,sender:null,accountLabel:'',bindingKey:'',sensitiveSurfaceReady:false,errorCode:error instanceof OneVaultError?error.code:'secure_route_unavailable'};}
 }
 async registerSender(surface:OneVaultSurface,input:{publicKey:string;challengeNonce:string;proof:string}):Promise<OneVaultWindowBootstrap>{return this.trackAuthority(async()=>{
  const l=this.bound(surface);this.assertLive(l,l.metadata.statusOnly);
  if(Object.keys(input).sort().join('|')!=='challengeNonce|proof|publicKey'||l.registering||l.metadata.state!=='register-required'||input.challengeNonce!==l.challenge||l.challengeExpiresAt<=this.now())throw new OneVaultError('sender_untrusted');
  const r=l.metadata.request,b=r.binding,transcript=oneVaultCanonical(['sender-register',{challengeNonce:l.challenge,publicKey:input.publicKey,requestId:b.requestId,requestRevision:b.requestRevision,hostId:b.hostId,senderId:b.senderId}]);
  let valid=false;try{valid=verify('sha256',Buffer.from(transcript),{key:oneVaultPublicKey(input.publicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(input.proof,64));}catch{}
  if(!valid)throw new OneVaultError('sender_untrusted');
  l.registering=true;
  try{
   if(!await surface.confirmSender(r,l.metadata.statusOnly))throw new OneVaultError('authority_denied');
   this.assertLive(l,l.metadata.statusOnly);const lease=await this.p.authority(this.authorizationBinding(l),l.metadata.statusOnly?'reconcile':'decrypt',l.metadata.statusOnly?'reconcile':'entry');this.assertLive(l,l.metadata.statusOnly);if(!lease.stillCurrent())throw new OneVaultError('authority_denied');
   const next:Metadata={...l.metadata,state:'entry-ready',senderPublicKey:input.publicKey};this.p.metadata.write(b,next,l.metadata);l.metadata=next;return this.bootstrap(surface);
  }finally{l.registering=false;}
 });}
 async submit(surface:OneVaultSurface,requestId:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt>{return this.trackAuthority(async()=>{const l=this.bound(surface,requestId);if(l.metadata.statusOnly)throw new OneVaultError('request_consumed');this.assertLive(l);const trust=this.trusted(l.metadata.request);if(!trust)throw new OneVaultError('sender_untrusted');authenticateOneVaultEnvelope(l.metadata.request,envelope,trust.senderPublicKey);if(l.metadata.operationId===null){const next={...l.metadata,operationId:envelope.operationId};this.p.metadata.write(l.metadata.request.binding,next,l.metadata);l.metadata=next;}l.operationId??=envelope.operationId;return this.broker.submit(requestId,envelope);});}
 async reconcile(surface:OneVaultSurface,requestId:string,query:OneVaultStatusQuery):Promise<OneVaultReceipt>{return this.trackAuthority(async()=>{const l=this.bound(surface,requestId);this.assertLive(l,true);if(l.metadata.statusOnly&&query.operationId!==l.metadata.operationId)throw new OneVaultError('replay_conflict');return this.broker.reconcile(requestId,query,{observeOnly:l.metadata.statusOnly});});}
 /** Local close is unconditional. It does not claim remote cancellation or undo native effects. */
 cancel(surface:OneVaultSurface,requestId:string|null,_reason:'cancelled'|'expired'|'background'):void {
  const l=this.live.get(surface.id);if(!l||l.surface!==surface){surface.close();return;}
  l.cancelled=true;this.live.delete(surface.id);
  try{if(requestId===null||requestId===l.metadata.request.binding.requestId){const next:Metadata={...l.metadata,state:'cancelled',senderPublicKey:null};this.p.metadata.write(l.metadata.request.binding,next,l.metadata);}}catch{}
  finally{surface.close();}
 }
 /** Main-only admission producer, never an RPC entry. Its native channel proof is independently
  * authenticated and continuously checked; this is not a OneVaultSurface/BrowserWindow. */
 async admitMobile(commandId:string,mobile:OneVaultMobileLease,options:{reconcileOnly?:boolean}={}):Promise<OneVaultRequest>{return this.trackAuthority(async()=>{
  if(!mobile.stillCurrent())throw new OneVaultError('secure_route_unavailable');
  const mode=options.reconcileOnly?'reconcile':'entry',c=this.context(commandId,mode),host=await loadOneVaultApprovedHost(this.p.configuredHostId(),this.p.trust,this.p.vault);
  if(!mobile.stillCurrent()||oneVaultDigest(this.context(commandId,mode))!==oneVaultDigest(c))throw new OneVaultError('revision_changed');
  const old=this.p.metadata.read(commandId);
  if(old&&this.byRequest(old.request.binding.requestId))throw new OneVaultError('request_consumed');
  let request:OneVaultRequest,operationId:string|null=null;
  if(options.reconcileOnly){
   const op=old?.operationId?this.p.journal.get(old.operationId):null;
   if(!old||!op||op.requestDigest!==oneVaultDigest(old.request)||old.request.binding.senderId!==mobile.sender.senderId||old.senderKeyId!==mobile.sender.senderKeyId||old.senderPublicKey!==mobile.sender.publicKey||old.request.hostKeyId!==host.metadata.hostKeyId||old.request.recipientKeyId!==host.metadata.recipientKeyId||old.request.binding.trustGeneration!==host.metadata.generation)throw new OneVaultError('secure_route_unavailable');
   request=old.request;operationId=op.operationId;
  }else{
   if(old?.operationId)throw new OneVaultError('request_consumed');
   const binding:OneVaultBinding={...c.binding,requestId:randomUUID(),requestRevision:(old?.request.binding.requestRevision??0)+1,hostId:host.metadata.hostId,senderId:mobile.sender.senderId,trustGeneration:host.metadata.generation};
   request=issueOneVaultRequest(binding,{hostKeyId:host.metadata.hostKeyId,signingKey:host.signingKey,recipientKeyId:host.metadata.recipientKeyId,recipientKey:host.recipientKey},this.now());
  }
  this.checkMobileSender(mobile,request);
  const metadata:Metadata={request,senderKeyId:mobile.sender.senderKeyId,senderPublicKey:mobile.sender.publicKey,state:'entry-ready',nativeSurfaceId:`mobile:${request.binding.requestId}`,operationId,statusOnly:!!options.reconcileOnly};
  const l:Live={surface:null,mobile,metadata,host,challenge:'',challengeExpiresAt:0,registering:false,cancelled:false,accountLabel:c.accountLabel,operationId};
  const lease=await this.p.authority(this.authorizationBinding(l),options.reconcileOnly?'reconcile':'decrypt',mode);
  this.checkMobileSender(mobile,request);
  if(!lease.stillCurrent()||oneVaultDigest(this.context(commandId,mode))!==oneVaultDigest(c))throw new OneVaultError('authority_denied');
  this.p.metadata.write(request.binding,metadata,old);this.mobileLive.set(request.binding.requestId,l);
  try{this.assertLive(l,!!options.reconcileOnly);}catch(e){this.mobileLive.delete(request.binding.requestId);throw e;}
  return structuredClone(request);
 });}
 private checkMobileSender(m:OneVaultMobileLease,r:OneVaultRequest):void{
  const approved=this.approvedMobileSender(r.binding);
  if(!m.stillCurrent()||oneVaultDigest(approved)!==oneVaultDigest(m.sender))throw new OneVaultError('sender_untrusted');
 }
 private boundMobile(mobile:OneVaultMobileLease,id:string):Live{
  const l=this.mobileLive.get(id);if(!l||l.mobile!==mobile)throw new OneVaultError('not_found');this.assertLive(l,true);return l;
 }
 mobileRequest(mobile:OneVaultMobileLease,id:string):OneVaultRequest{return structuredClone(this.boundMobile(mobile,id).metadata.request);}
 async mobileSubmit(mobile:OneVaultMobileLease,id:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt>{return this.trackAuthority(async()=>{
  const l=this.boundMobile(mobile,id);if(l.metadata.statusOnly)throw new OneVaultError('request_consumed');this.assertLive(l);
  if(envelope.action!=='store')throw new OneVaultError('authority_denied');
  authenticateOneVaultEnvelope(l.metadata.request,envelope,mobile.sender.publicKey);
  if(envelope.senderKeyId!==mobile.sender.senderKeyId)throw new OneVaultError('sender_untrusted');
  if(l.metadata.operationId!==null&&l.metadata.operationId!==envelope.operationId)throw new OneVaultError('replay_conflict');
  if(l.metadata.operationId===null){const next={...l.metadata,operationId:envelope.operationId};this.p.metadata.write(l.metadata.request.binding,next,l.metadata);l.metadata=next;}
  l.operationId??=envelope.operationId;return this.broker.submit(id,envelope);
 });}
 /** Native-only signed bootstrap for an already consumed operation. No request is minted,
  * no recipient key is changed and no credential value crosses this boundary. */
 async mobileRecoveryBootstrap(mobile:OneVaultMobileLease,id:string):Promise<{request:OneVaultRequest;recovery:OneVaultRecoveryDescriptor;currentBinding:OneVaultBinding;stillCurrent():boolean}>{return this.trackAuthority(async()=>{
  const l=this.boundMobile(mobile,id);if(!l.metadata.statusOnly)throw new OneVaultError('authority_denied');
  const currentBinding=this.authorizationBinding(l),lease=await this.p.authority(currentBinding,'reconcile','reconcile');
  this.assertLive(l,true);if(!lease.stillCurrent()||oneVaultDigest(currentBinding)!==oneVaultDigest(this.authorizationBinding(l)))throw new OneVaultError('revision_changed');
  const recovery=this.recovery(l);if(!recovery)throw new OneVaultError('not_found');
  const stillCurrent=()=>{try{return !l.cancelled&&this.now()<recovery.expiresAt&&lease.stillCurrent()&&oneVaultDigest({...this.authorizationBinding(l),expectedGeneration:currentBinding.expectedGeneration})===oneVaultDigest(currentBinding)}catch{return false}};
  return{request:structuredClone(l.metadata.request),recovery,currentBinding:structuredClone(currentBinding),stillCurrent};
 });}
 async mobileStatus(mobile:OneVaultMobileLease,id:string,query:OneVaultStatusQuery):Promise<OneVaultReceipt>{return this.trackAuthority(async()=>{
  const l=this.boundMobile(mobile,id);if(query.operationId!==l.metadata.operationId)throw new OneVaultError('replay_conflict');
  return this.broker.reconcile(id,query,{observeOnly:true});
 });}
 mobileCancel(mobile:OneVaultMobileLease,id:string,query:OneVaultCancelQuery):OneVaultCancelReceipt{
  this.boundMobile(mobile,id);return this.broker.cancel(id,query);
 }
 /** Disconnect only detaches transient channel custody; it never claims rollback or deletes a key. */
 detachMobile(mobile:OneVaultMobileLease):void{for(const [id,l] of this.mobileLive)if(l.mobile===mobile){l.cancelled=true;this.mobileLive.delete(id);}}

 /** No trust enrollment from a relay token. Parent's Mobile route must require this independent approval. */
 approvedMobileSender(binding:OneVaultBinding):OneVaultApprovedSenderMetadata {
  const m=this.p.trust.approvedMobileSender(binding.senderId);
  if(!m||m.revokedAt!==null||m.hostId!==this.p.configuredHostId()||m.hostId!==binding.hostId||m.generation!==binding.trustGeneration||m.principalId!==binding.principalId||m.workspaceId!==binding.workspaceId||m.organizationId!==binding.organizationId||!this.p.trust.nativeApprovalValid(m.approvedNativeReceiptId,oneVaultDigest(m)))throw new OneVaultError('secure_route_unavailable');oneVaultPublicKey(m.publicKey);return structuredClone(m);
 }
 notifyAuthorityChanged():void{for(const l of this.live.values())l.surface?.changed();}
}
