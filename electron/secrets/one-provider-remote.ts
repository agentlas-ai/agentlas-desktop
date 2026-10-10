import type {OneProviderResourceReadGrant,OneProviderReadProjection} from '../../shared/one-provider-read';
import {createHash} from 'node:crypto';
import {ONE_PROVIDER_REMOTE_QUERY,ONE_PROVIDER_REMOTE_PROJECTION,ONE_PROVIDER_REMOTE_AUDIO,OneProviderRemoteError,type OneProviderRemoteQuery,type OneProviderRemoteProjection,type OneProviderRemoteAudioAcquisition} from '../../shared/one-provider-remote';
import type {OneVaultBinding} from '../../shared/one-vault';
import type {OneProviderBootstrap,OneProviderPrepared} from '../../shared/one-provider-native';
import type {OneProviderReceipt} from '../../shared/one-provider';
import {decodeOneVaultBase64,oneVaultDigest,validateOneVaultBinding,verifyOneVault} from './one-vault-crypto';
import type {OneVaultNativeTrustPort} from './one-vault-service';
import {verifyOneWav} from './one-provider-broker';
/** Opaque native channel identity. JSON or relay bearer cannot mint this capability. */
export interface OneProviderRemoteOrigin {readonly __oneProviderRemoteOrigin?:never}
export interface OneProviderRemoteCurrent {
 hostId:string;hostKeyId:string;hostPublicKey:string;trustGeneration:number;
 senderId:string;senderKeyId:string;senderPublicKey:string;approvedSenderReceiptId:string;
 channelId:string;channelEpoch:string;oneId:string;binding:OneVaultBinding;projectionRevision:string;
 allowedOperations:Array<'projection'|'status'|'audio-acquisition'>;
}
export interface OneProviderRemotePorts {
 trust:OneVaultNativeTrustPort|null;
 /** Must use actual native channel WeakMap, persistent native-approved pair ledger and current
  * principal/session/host/owner. Missing origin/trust/current binding returns null. Never a bearer. */
 current(origin:OneProviderRemoteOrigin,commandId:string):OneProviderRemoteCurrent|null;
 authorize(origin:OneProviderRemoteOrigin,current:Readonly<OneProviderRemoteCurrent>,kind:OneProviderRemoteQuery['kind']):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent():boolean}>;
 /** Existing authenticated channel nonce CAS, durable or new unforgeable epoch on restart.
  * Called before any await/read. No query can consume this nonce twice, including failures. */
 consumeNonce(origin:OneProviderRemoteOrigin,channelEpoch:string,senderKeyId:string,nonce:string,expiresAt:number):boolean;
 /** SAME existing native provider read core/operation registry, never a fabricated Desktop IPC event.
  * Exposes no execute/prepare/readSecret/HTTP and must not mint a new operation. */
 readCurrent(origin:OneProviderRemoteOrigin,commandId:string,operationId:string|null):Promise<(OneProviderReadProjection&{stillCurrent():boolean})|null>;
 /** Existing approved host signing custody. No private key/ref is exposed here. */
 signHost<T extends {signature:string}>(current:Readonly<OneProviderRemoteCurrent>,value:T):Promise<T>;
 /** Separate native acquisition ACL and exact current artifact registry. Not called by status.
  * Must read only the existing approved native path; returns owned copy, never provider/file URL. */
 readPermittedAudio?(origin:OneProviderRemoteOrigin,prepared:Readonly<OneProviderPrepared>,receipt:Readonly<OneProviderReceipt>):Promise<{bytes:Uint8Array;resourceGrant:OneProviderResourceReadGrant;stillCurrent():boolean}|null>;
 now?:()=>number;
}
function fail(code:ConstructorParameters<typeof OneProviderRemoteError>[0]):never{throw new OneProviderRemoteError(code)}
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail('remote_query_invalid');}
function safeId(v:unknown):boolean{return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v)}
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Read-only remote projection and separate artifact descriptor. No remote dispatch API. */
export class OneProviderRemoteReader {
 constructor(private readonly p:OneProviderRemotePorts){}
 private now(){return this.p.now?.()??Date.now()}
 private query(raw:unknown):OneProviderRemoteQuery {
  exact(raw,['schema','kind','hostId','hostKeyId','trustGeneration','senderId','senderKeyId','channelId','channelEpoch','oneId','binding','projectionRevision','operationId','receiptDigest','artifactDigest','nonce','issuedAt','expiresAt','signature']);
  const q=raw as unknown as OneProviderRemoteQuery,n=this.now();
  if(q.schema!==ONE_PROVIDER_REMOTE_QUERY||!['projection','status','audio-acquisition'].includes(q.kind)||![q.hostId,q.hostKeyId,q.senderId,q.senderKeyId,q.channelId,q.channelEpoch,q.oneId,q.projectionRevision].every(safeId)||!Number.isSafeInteger(q.trustGeneration)||q.trustGeneration<1||!Number.isSafeInteger(q.issuedAt)||q.issuedAt>n+5000||q.issuedAt<n-120000||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=n||q.expiresAt>q.issuedAt+120000||q.expiresAt<=q.issuedAt)fail('remote_query_invalid');
  try{validateOneVaultBinding(q.binding);decodeOneVaultBase64(q.nonce,32);decodeOneVaultBase64(q.signature,64);}catch{fail('remote_query_invalid')}
  if(q.binding.hostId!==q.hostId||q.binding.trustGeneration!==q.trustGeneration||q.operationId!==null&&!safeId(q.operationId)||q.kind!=='projection'&&q.operationId===null||(q.kind==='audio-acquisition'?(!digest(q.receiptDigest)||!digest(q.artifactDigest)):(q.receiptDigest!==null||q.artifactDigest!==null)))fail('remote_query_invalid');
  return structuredClone(q);
 }
 private current(origin:OneProviderRemoteOrigin,q:OneProviderRemoteQuery):OneProviderRemoteCurrent{
  const c=this.p.current(origin,q.binding.commandId);if(!c||!Array.isArray(c.allowedOperations)||c.allowedOperations.some(k=>!['projection','status','audio-acquisition'].includes(k))||!safeId(c.approvedSenderReceiptId)||!c.allowedOperations.includes(q.kind)||!c.projectionRevision||!['hostId','hostKeyId','trustGeneration','senderId','senderKeyId','channelId','channelEpoch','oneId','projectionRevision'].every(k=>(c as unknown as Record<string,unknown>)[k]===(q as unknown as Record<string,unknown>)[k])||oneVaultDigest(c.binding)!==oneVaultDigest(q.binding))fail('remote_route_unavailable');
  const host=this.p.trust?.currentHostMetadata(),sender=this.p.trust?.approvedMobileSender(c.senderId);
  if(!host||!sender||host.revokedAt!==null||sender.revokedAt!==null||host.hostId!==c.hostId||host.hostKeyId!==c.hostKeyId||host.generation!==c.trustGeneration||host.signingPublicKey!==c.hostPublicKey||sender.hostId!==c.hostId||sender.senderId!==c.senderId||sender.senderKeyId!==c.senderKeyId||sender.publicKey!==c.senderPublicKey||sender.principalId!==c.binding.principalId||sender.workspaceId!==c.binding.workspaceId||sender.organizationId!==c.binding.organizationId||sender.approvedNativeReceiptId!==c.approvedSenderReceiptId||!this.p.trust!.nativeApprovalValid(host.approvedNativeReceiptId,oneVaultDigest(host))||!this.p.trust!.nativeApprovalValid(sender.approvedNativeReceiptId,oneVaultDigest(sender)))fail('remote_sender_untrusted');
  if(!verifyOneVault('status',q,c.senderPublicKey))fail('remote_sender_untrusted');return structuredClone(c);
 }
 private projection(c:OneProviderRemoteCurrent,q:OneProviderRemoteQuery,value:OneProviderBootstrap|null,resourceGrant:OneProviderResourceReadGrant|null):OneProviderBootstrap{
  if(!value)fail('remote_route_unavailable');const v=structuredClone(value);
  exact(v,['schema','state','commandId','bindingKey','binding','credentialGeneration','accountLabel','roleLabel','permittedModels','permittedVoices','permittedTextRefs','quote','retention','activeOperation','receipt','resourceGrant','pinnedHost','observedAt','expiresAt','errorCode']);
  if(!['key-missing','key-saved','verification-required','verified','audio-ready','outcome-unknown','unavailable'].includes(v.state)||v.schema!=='agentlas.one-provider-native.v1'||v.commandId!==q.binding.commandId||oneVaultDigest(v.binding)!==oneVaultDigest(c.binding)||v.bindingKey!==oneVaultDigest(c.binding)||v.pinnedHost?.hostId!==c.hostId||v.pinnedHost.hostKeyId!==c.hostKeyId||v.pinnedHost.publicKey!==c.hostPublicKey||v.pinnedHost.trustGeneration!==c.trustGeneration||v.credentialGeneration!==null&&v.credentialGeneration!==c.binding.expectedGeneration||v.expiresAt<=this.now()||v.observedAt>this.now()+5000||v.observedAt<this.now()-120000)fail('remote_scope_changed');
  for(const rows of [v.permittedModels,v.permittedVoices]){if(!Array.isArray(rows)||rows.length>200)fail('remote_scope_changed');for(const r of rows){exact(r,['id','label']);if(!safeId(r.id)||typeof r.label!=='string'||r.label.length>512)fail('remote_scope_changed')}}
  if(!Array.isArray(v.permittedTextRefs)||v.permittedTextRefs.length>200)fail('remote_scope_changed');for(const r of v.permittedTextRefs){exact(r,['ref','label','digest']);if(!safeId(r.ref)||typeof r.label!=='string'||r.label.length>512||!digest(r.digest))fail('remote_scope_changed')}
  exact(v.retention,['enableProviderLogging','disclosure']);if(typeof v.retention.enableProviderLogging!=='boolean'||typeof v.retention.disclosure!=='string'||v.retention.disclosure.length>2048)fail('remote_scope_changed');
  if(v.quote){exact(v.quote,['quoteId','currency','upperBoundMinor','payerId','consentRevision','expiresAt']);const cost=c.binding.cost;if(!cost||v.quote.payerId!==c.binding.payerId||v.quote.currency!==cost.currency||v.quote.consentRevision!==cost.consentRevision||!Number.isSafeInteger(v.quote.upperBoundMinor)||v.quote.upperBoundMinor<0||v.quote.upperBoundMinor>cost.maxMinor||v.quote.expiresAt<=this.now())fail('remote_scope_changed')}
  const prepared=v.activeOperation,r=v.receipt;
  if(prepared){exact(prepared.action,['schema','operationId','kind','binding','credentialGeneration','modelId','voiceId','outputFormat','textDigest','minDurationMs','maxDurationMs','expiresAt','enableProviderLogging']);exact(prepared.quote,['quoteId','currency','upperBoundMinor','payerId','consentRevision','expiresAt']);exact(prepared,['schema','commandId','bindingKey','operationId','action','quote']);if(prepared.schema!==v.schema||prepared.commandId!==v.commandId||prepared.bindingKey!==oneVaultDigest(prepared.action.binding)||prepared.action.operationId!==prepared.operationId||prepared.action.credentialGeneration!==prepared.action.binding.expectedGeneration)fail('remote_scope_changed')}
  if(q.operationId!==null&&prepared?.operationId!==q.operationId)fail('remote_scope_changed');
  if(r){exact(r,['schema','operationId','actionDigest','taskId','runId','controlVersion','authorityRevision','permissionRevision','hostId','principalId','organizationId','workspaceId','resourceId','provider','providerWorkspace','region','credentialGeneration','state','errorCode','audio','observedAt','hostKeyId','signature']);if(r.audio){exact(r.audio,['artifactId','sha256','sizeBytes','mime','container','codec','sampleRate','channels','decodedSamples','durationMs']);if(!digest(r.audio.sha256)||r.audio.artifactId!==`one-audio:${createHash('sha256').update(r.operationId).digest('hex')}:${r.audio.sha256}`)fail('remote_scope_changed');}if(r.schema!=='agentlas.one-provider.v1'||!['verified','audio_ready','failed','outcome_unknown'].includes(r.state))fail('remote_scope_changed');if(!prepared||r.operationId!==prepared.operationId||r.actionDigest!==oneVaultDigest(prepared.action)||r.hostKeyId!==c.hostKeyId||r.hostId!==c.hostId||r.observedAt>this.now()+5000||!verifyOneVault('receipt',r,c.hostPublicKey))fail('remote_scope_changed');for(const key of ['taskId','runId','controlVersion','authorityRevision','permissionRevision','principalId','organizationId','workspaceId','resourceId','provider','providerWorkspace','region'] as const)if(r[key]!==prepared.action.binding[key])fail('remote_scope_changed');if(r.credentialGeneration!==prepared.action.credentialGeneration)fail('remote_scope_changed')}
  if((v.state==='audio-ready'&&r?.state!=='audio_ready')||(v.state==='verified'&&r?.state!=='verified')||(v.state==='outcome-unknown'&&r?.state!=='outcome_unknown'))fail('remote_scope_changed');
  if(oneVaultDigest(v.resourceGrant)!==oneVaultDigest(resourceGrant))fail('remote_scope_changed');
  if(r){if(!prepared||!resourceGrant)fail('remote_route_unavailable');this.resourceGrant(c,prepared,r,resourceGrant,'status');}else if(resourceGrant)fail('remote_scope_changed');
  if(q.kind!=='projection'&&!r)fail('remote_route_unavailable');return v;
 }
 private resourceGrant(c:OneProviderRemoteCurrent,prepared:OneProviderPrepared,r:OneProviderReceipt,g:OneProviderResourceReadGrant,purpose:OneProviderResourceReadGrant['purpose']):void {
  exact(g,['schema','oneId','commandId','operationId','actionDigest','receiptDigest','currentBinding','revision','purpose','issuedAt','expiresAt']);
  const stable=['commandId','taskId','runId','hostId','principalId','scope','organizationId','workspaceId','resourceId','provider','providerWorkspace','region','payerId'] as const;
  if(g.schema!=='agentlas.one-provider-resource-read.v1'||g.oneId!==c.oneId||g.commandId!==c.binding.commandId||g.operationId!==prepared.operationId||g.actionDigest!==oneVaultDigest(prepared.action)||g.receiptDigest!==oneVaultDigest(r)||oneVaultDigest(g.currentBinding)!==oneVaultDigest(c.binding)||!stable.every(k=>prepared.action.binding[k]===c.binding[k])||!safeId(g.revision)||g.purpose!==purpose||!Number.isSafeInteger(g.issuedAt)||g.issuedAt>this.now()+5000||g.issuedAt<this.now()-30000||!Number.isSafeInteger(g.expiresAt)||g.expiresAt<=this.now()||g.expiresAt>g.issuedAt+30000)fail('remote_scope_changed');
 }
 async read(origin:OneProviderRemoteOrigin,raw:unknown):Promise<OneProviderRemoteProjection|OneProviderRemoteAudioAcquisition>{try{return await this.perform(origin,raw)}catch(e){throw e instanceof OneProviderRemoteError?e:new OneProviderRemoteError('remote_route_unavailable')}}
 private async perform(origin:OneProviderRemoteOrigin,raw:unknown):Promise<OneProviderRemoteProjection|OneProviderRemoteAudioAcquisition>{
  const q=this.query(raw),c=this.current(origin,q),held=oneVaultDigest(c);if(!this.p.consumeNonce(origin,q.channelEpoch,q.senderKeyId,q.nonce,q.expiresAt))fail('remote_replay');
  const current=()=>{try{return this.now()<q.expiresAt&&oneVaultDigest(this.current(origin,q))===held}catch{return false}};
  const lease=await this.p.authorize(origin,Object.freeze(structuredClone(c)),q.kind);if(lease.decision!=='allow'||lease.revision!==c.projectionRevision||!lease.stillCurrent()||!current())fail('remote_route_unavailable');
  let resourceCurrent:(()=>boolean)|null=null,acquisitionCurrent:(()=>boolean)|null=null;const fresh=()=>{if(!current()||!lease.stillCurrent()||resourceCurrent&&!resourceCurrent()||acquisitionCurrent&&!acquisitionCurrent())fail('remote_scope_changed')};
  const read=await this.p.readCurrent(origin,q.binding.commandId,q.operationId);fresh();if(!read||!read.stillCurrent())fail('remote_route_unavailable');resourceCurrent=read.stillCurrent;const v=this.projection(c,q,read.projection,read.resourceGrant);fresh();
  const projectionDigest=oneVaultDigest(v),preparedDigest=v.activeOperation?oneVaultDigest(v.activeOperation):null,receiptDigest=v.receipt?oneVaultDigest(v.receipt):null;
  const common={hostId:c.hostId,hostKeyId:c.hostKeyId,trustGeneration:c.trustGeneration,senderId:c.senderId,senderKeyId:c.senderKeyId,channelId:c.channelId,channelEpoch:c.channelEpoch,oneId:c.oneId,binding:structuredClone(c.binding),projectionRevision:c.projectionRevision,queryDigest:oneVaultDigest(q),responseNonce:q.nonce};
  let result:OneProviderRemoteProjection|OneProviderRemoteAudioAcquisition;
  if(q.kind==='audio-acquisition'){
   const r=v.receipt,a=r?.audio,prepared=v.activeOperation;if(!this.p.readPermittedAudio||!r||!a||!prepared||!preparedDigest||!receiptDigest||r.state!=='audio_ready'||receiptDigest!==q.receiptDigest||a.sha256!==q.artifactDigest)fail('remote_artifact_invalid');
   const given=await this.p.readPermittedAudio(origin,Object.freeze(prepared),Object.freeze(r));fresh();if(!given||!given.stillCurrent()||given.bytes.byteLength>32*1024*1024)fail('remote_artifact_invalid');this.resourceGrant(c,prepared,r,given.resourceGrant,'audio-acquisition');acquisitionCurrent=given.stillCurrent;const bytes=Buffer.from(given.bytes);
   try{verifyOneWav(bytes);if(bytes.length>32*1024*1024||sha(bytes)!==a.sha256||bytes.length!==a.sizeBytes||a.mime!=='audio/wav'||a.container!=='wav'||a.codec!=='pcm_s16le'||a.sampleRate!==24000||a.channels!==1||(bytes.length-44)/2!==a.decodedSamples||Math.round(a.decodedSamples*1000/24000)!==a.durationMs||a.artifactId!==`one-audio:${createHash('sha256').update(r.operationId).digest('hex')}:${a.sha256}`)fail('remote_artifact_invalid')}finally{bytes.fill(0);given.bytes.fill(0)}
   fresh();if(!given.stillCurrent())fail('remote_scope_changed');const now=this.now();result={resourceGrant:structuredClone(given.resourceGrant),schema:ONE_PROVIDER_REMOTE_AUDIO,state:'artifact-verified-for-acquisition',...common,acquisitionId:oneVaultDigest(['audio-acquisition',common.queryDigest,a.sha256]),operationId:r.operationId,actionDigest:r.actionDigest,preparedDigest,receiptDigest,artifact:structuredClone(a),allowedOperation:'audio-acquisition',maxUses:1,observedAt:now,expiresAt:Math.min(q.expiresAt,v.expiresAt,now+30000,given.resourceGrant.expiresAt),signature:''};
  }else{const now=this.now();result={resourceGrant:structuredClone(read.resourceGrant),schema:ONE_PROVIDER_REMOTE_PROJECTION,...common,allowedOperations:[...c.allowedOperations],projection:v,projectionDigest,preparedDigest,receiptDigest,observedAt:now,expiresAt:Math.min(q.expiresAt,v.expiresAt,now+30000,read.resourceGrant?.expiresAt??Infinity),signature:''}}
  const unsignedDigest=oneVaultDigest(result),signed=await this.p.signHost(Object.freeze(structuredClone(c)),structuredClone(result));fresh();if(this.now()>=result.expiresAt||oneVaultDigest({...signed,signature:''})!==unsignedDigest||!verifyOneVault('receipt',signed,c.hostPublicKey))fail('remote_scope_changed');return signed;
 }
}
/** Reference host-verifier checks for Mobile interoperability tests; Mobile uses its own vetted
 * P-256 implementation against the same canonical transcript and an already pinned key. */
export function verifyOneProviderRemoteResponse(value:OneProviderRemoteProjection|OneProviderRemoteAudioAcquisition,q:OneProviderRemoteQuery,pin:{hostId:string;hostKeyId:string;publicKey:string;trustGeneration:number},now:number):boolean{
 try{return value.hostId===pin.hostId&&value.hostKeyId===pin.hostKeyId&&value.trustGeneration===pin.trustGeneration&&value.hostId===q.hostId&&value.hostKeyId===q.hostKeyId&&value.senderId===q.senderId&&value.senderKeyId===q.senderKeyId&&value.channelId===q.channelId&&value.channelEpoch===q.channelEpoch&&value.oneId===q.oneId&&oneVaultDigest(value.binding)===oneVaultDigest(q.binding)&&value.projectionRevision===q.projectionRevision&&value.queryDigest===oneVaultDigest(q)&&value.responseNonce===q.nonce&&Number.isSafeInteger(value.observedAt)&&value.observedAt<=now+5000&&value.observedAt>=now-30000&&value.observedAt>=q.issuedAt-5000&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt<=q.expiresAt&&value.expiresAt<=value.observedAt+30000&&verifyOneVault('receipt',value,pin.publicKey)&&(!value.resourceGrant||(value.resourceGrant.oneId===q.oneId&&oneVaultDigest(value.resourceGrant.currentBinding)===oneVaultDigest(q.binding)&&value.resourceGrant.expiresAt>=value.expiresAt))&&(q.kind==='audio-acquisition'?value.schema===ONE_PROVIDER_REMOTE_AUDIO&&value.operationId===q.operationId&&value.receiptDigest===q.receiptDigest&&value.artifact.sha256===q.artifactDigest&&value.allowedOperation==='audio-acquisition'&&value.maxUses===1:value.schema===ONE_PROVIDER_REMOTE_PROJECTION&&value.projectionDigest===oneVaultDigest(value.projection)&&value.preparedDigest===(value.projection.activeOperation?oneVaultDigest(value.projection.activeOperation):null)&&value.receiptDigest===(value.projection.receipt?oneVaultDigest(value.projection.receipt):null));}catch{return false;}
}
