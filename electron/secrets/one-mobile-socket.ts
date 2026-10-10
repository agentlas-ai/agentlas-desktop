import {randomBytes,verify} from 'node:crypto';
import {oneVaultCanonical,OneVaultError,type OneVaultRequest} from '../../shared/one-vault';
import {oneVaultDigest,oneVaultPublicKey,decodeOneVaultBase64,validateOneVaultRequest,validateOneVaultBinding,verifyOneVault} from './one-vault-crypto';
import type {OneVaultNativeTrustPort} from './one-vault-service';
import type {MobileBridgeConnectionContext} from '../mobile-bridge/server';
import type {OneMobileSenderProof} from './one-mobile-secure';
import type {OneMobileNativeDelivery} from './one-mobile-main-producer';
export interface OneMobilePossessionSource {
 hostId:string;principalId:string;sessionId:string;workspaceId:string;organizationId:string|null;
 commandId:string;taskId:string;runId:string;controlVersion:string|null;
 /** Pending key source digest is NOT a Vault request digest or consent receipt. */
 pendingSourceDigest:string;requestDigest:string|null;currentRevision:string;senderId:string;
 stillCurrent():boolean;
}
export interface OneMobileSocketTransport {
 current():boolean;
 /** Exact accepted socket; completion is local write acknowledgement, NOT phone installation. */
 send(frame:unknown,stillCurrent:()=>boolean):Promise<void>;
 close():void;
}
export interface OneMobileSocketPorts {
 trust:OneVaultNativeTrustPort|null;
 /** Existing secure adapter's WeakMap epoch; absent before genuine server accept. */
 channelEpoch(context:MobileBridgeConnectionContext):string|null;
 /** Main-only original command/custody/current-grant owner, NOT RPC parameters. */
 source:((context:MobileBridgeConnectionContext,request:OneVaultRequest|null)=>OneMobilePossessionSource|null)|null;
 /** Existing approved host key signer. No enrollment or key loading in this module. */
 sign:((domain:'one-mobile-possession'|'one-mobile-admission',body:unknown)=>Promise<string>)|null;
 now?:()=>number;
}
/** Challenge AND resulting socket proof expire at this cutoff. Original Vault request
 * lifetime (120s) never extends possession. Refresh requires another signed one-use nonce. */
export const ONE_MOBILE_POSSESSION_TTL_MS=30_000;
export interface OneMobilePossessionChallenge {
 schema:'agentlas.one-mobile-possession.v1';phase:'pending-source'|'vault-request';
 hostId:string;hostKeyId:string;principalId:string;sessionId:string;workspaceId:string;organizationId:string|null;
 commandId:string;taskId:string;runId:string;controlVersion:string|null;pendingSourceDigest:string;requestDigest:string|null;
 currentRevision:string;senderId:string;senderKeyId:string;trustGeneration:number;approvedSenderReceiptId:string;
 connectionId:string;channelEpoch:string;nonce:string;issuedAt:number;expiresAt:number;
}
function deny():never{throw new OneVaultError('secure_route_unavailable')}
function unsignedSource(s:OneMobilePossessionSource){return {hostId:s.hostId,principalId:s.principalId,sessionId:s.sessionId,workspaceId:s.workspaceId,organizationId:s.organizationId,commandId:s.commandId,taskId:s.taskId,runId:s.runId,controlVersion:s.controlVersion,pendingSourceDigest:s.pendingSourceDigest,requestDigest:s.requestDigest,currentRevision:s.currentRevision,senderId:s.senderId};}
function signature(domain:string,body:unknown,sig:string,key:string):boolean{try{return verify('sha256',Buffer.from(oneVaultCanonical([domain,body])),{key:oneVaultPublicKey(key),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(sig,64))}catch{return false}}
/** Authentication state only. Construction has no effects. No business grant, credential,
 * dispatch, durable receipt, replay outbox or enrollment is created here. */
export function createOneMobileSocketOwner(p:OneMobileSocketPorts){
 type Entry={transport:OneMobileSocketTransport;contextDigest:string;closed:boolean;unknown:boolean;proof:OneMobileSenderProof|null;proofExpiresAt:number;authentication:null|{scope:string;requestDigest:string|null};delivered:null|{digest:string;current:()=>boolean};pending:null|{body:OneMobilePossessionChallenge;current:()=>boolean;finish:(ok:boolean)=>void}};
 const entries=new WeakMap<MobileBridgeConnectionContext,Entry>(),live=new Set<MobileBridgeConnectionContext>();let disposed=false,cleanupUnknown=false;
 const proofDeadlines=new WeakMap<OneMobileSenderProof,number>();
 const now=()=>p.now?.()??Date.now();
 async function signed(domain:'one-mobile-possession'|'one-mobile-admission',body:unknown){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>p.sign?p.sign(domain,body):deny()),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OneVaultError('secure_route_unavailable')),30000)})])}finally{if(timer)clearTimeout(timer)}
 }
 function entry(c:MobileBridgeConnectionContext){const e=entries.get(c);if(disposed||cleanupUnknown||!e||e.closed||e.unknown||e.contextDigest!==oneVaultDigest(c)||!e.transport.current())deny();return e}
 function close(c:MobileBridgeConnectionContext){const e=entries.get(c);if(!e)return;if(e.unknown)deny();if(e.closed)return;e.closed=true;live.delete(c);e.proof=null;e.delivered=null;e.pending?.finish(false);e.pending=null;try{e.transport.close()}catch{e.unknown=true;cleanupUnknown=true;deny()}}
 function accepted(c:MobileBridgeConnectionContext,t:OneMobileSocketTransport){if(disposed||cleanupUnknown||entries.has(c)||c.devBootstrap||!['ios','android'].includes(c.devicePlatform)||!p.channelEpoch(c))deny();entries.set(c,{transport:t,contextDigest:oneVaultDigest(c),closed:false,unknown:false,proof:null,proofExpiresAt:0,authentication:null,delivered:null,pending:null});live.add(c)}
 function source(c:MobileBridgeConnectionContext,r:OneVaultRequest|null){
  if(!p.sign||!p.source)deny();const e=entry(c),s=p.source(c,r),h=p.trust?.currentHostMetadata(),epoch=p.channelEpoch(c),a=s&&p.trust?.approvedMobileSender(s.senderId);
  if(!s||!s.stillCurrent()||!h||!a||!epoch||h.revokedAt!==null||a.revokedAt!==null||h.hostId!==s.hostId||a.hostId!==s.hostId||a.principalId!==s.principalId||a.workspaceId!==s.workspaceId||a.organizationId!==s.organizationId||a.generation!==h.generation||!p.trust!.nativeApprovalValid(h.approvedNativeReceiptId,oneVaultDigest(h))||!p.trust!.nativeApprovalValid(a.approvedNativeReceiptId,oneVaultDigest(a)))deny();
  oneVaultPublicKey(a.publicKey);oneVaultPublicKey(h.signingPublicKey);
  if(!s.sessionId||!s.currentRevision||!s.commandId||!s.taskId||!s.runId||!/^[a-f0-9]{64}$/.test(s.pendingSourceDigest)||s.controlVersion!==null&&(!s.controlVersion||typeof s.controlVersion!=='string')||s.controlVersion===null&&!s.taskId.startsWith('one:'))deny();
  if(r){const b=r.binding;validateOneVaultRequest(r,now(),true);if(s.requestDigest!==oneVaultDigest(r)||b.hostId!==s.hostId||b.commandId!==s.commandId||b.taskId!==s.taskId||b.runId!==s.runId||b.controlVersion!==s.controlVersion||b.principalId!==s.principalId||b.workspaceId!==s.workspaceId||b.organizationId!==s.organizationId||b.senderId!==s.senderId||b.trustGeneration!==h.generation||!verifyOneVault('request',r,h.signingPublicKey))deny()}else if(s.requestDigest!==null)deny();
  const digest=oneVaultDigest([unsignedSource(s),h,a,epoch]);
  const current=()=>{try{const n=p.source?.(c,r),hh=p.trust?.currentHostMetadata(),aa=p.trust?.approvedMobileSender(s.senderId);return entry(c)===e&&s.stillCurrent()&&!!n&&n.stillCurrent()&&!!hh&&!!aa&&p.trust!.nativeApprovalValid(hh.approvedNativeReceiptId,oneVaultDigest(hh))&&p.trust!.nativeApprovalValid(aa.approvedNativeReceiptId,oneVaultDigest(aa))&&oneVaultDigest([unsignedSource(n),hh,aa,p.channelEpoch(c)])===digest}catch{return false}};
  return{e,s,h,a,epoch,current};
 }
 async function prove(c:MobileBridgeConnectionContext,r:OneVaultRequest|null):Promise<OneMobileSenderProof>{
  const {e,s,h,a,epoch,current}=source(c,r);if(e.pending)deny();
  const prior=e.proof,priorAuthentication=e.authentication,{requestDigest:_,...originalSource}=unsignedSource(s);
  const scope=oneVaultDigest([originalSource,h,a,epoch]);
  // Renewal cannot change native source, current grant revision, identity, host, key,
  // epoch or the already bound original request. A changed source needs its own native flow.
  if(priorAuthentication&&(priorAuthentication.scope!==scope||priorAuthentication.requestDigest!==null&&priorAuthentication.requestDigest!==s.requestDigest))deny();
  const issuedAt=now(),body:OneMobilePossessionChallenge={schema:'agentlas.one-mobile-possession.v1',phase:r?'vault-request':'pending-source',...unsignedSource(s),hostKeyId:h.hostKeyId,senderKeyId:a.senderKeyId,trustGeneration:h.generation,approvedSenderReceiptId:a.approvedNativeReceiptId,connectionId:c.connectionId,channelEpoch:epoch,nonce:randomBytes(32).toString('base64url'),issuedAt,expiresAt:issuedAt+ONE_MOBILE_POSSESSION_TTL_MS};
  const valid=()=>current()&&now()<body.expiresAt;
  let finish!:(ok:boolean)=>void;
  const response=new Promise<boolean>(resolve=>{finish=resolve});
  e.pending={body,current:valid,finish};
  const timer=setTimeout(()=>{if(e.pending?.body===body){e.pending=null;finish(false)}},30000);
  try{const sig=await signed('one-mobile-possession',body);if(!valid()||!signature('one-mobile-possession',body,sig,h.signingPublicKey))deny();await e.transport.send({v:1,type:'one.native.challenge',body,signature:sig},valid);if(!await response||!valid())deny();
   const proof:OneMobileSenderProof={hostId:s.hostId,senderId:s.senderId,senderKeyId:a.senderKeyId,senderPublicKey:a.publicKey,trustGeneration:h.generation,approvedSenderReceiptId:a.approvedNativeReceiptId,principalId:s.principalId,sessionId:s.sessionId,workspaceId:s.workspaceId,organizationId:s.organizationId,channelId:c.connectionId,channelEpoch:epoch,proofRevision:oneVaultDigest(body),stillCurrent:valid};
   // CAS after signature + consumed nonce + current-source verification. Keep a LIVE
   // proof stable for the native admission that already pins it; replace an expired proof.
   if(e.proof!==prior||e.authentication!==priorAuthentication)deny();
   proofDeadlines.set(proof,body.expiresAt);
   e.authentication={scope,requestDigest:s.requestDigest??priorAuthentication?.requestDigest??null};
   if(!prior||!prior.stillCurrent()){e.proof=proof;e.proofExpiresAt=body.expiresAt;e.delivered=null;}
   return proof;
  }catch{try{close(c)}catch{/* sticky unknown */}return deny()}finally{clearTimeout(timer);if(e.pending?.body===body){e.pending=null;finish(false)}}
 }
 function respond(c:MobileBridgeConnectionContext,raw:unknown):boolean{
  if(!raw||typeof raw!=='object'||(raw as {type?:unknown}).type!=='one.native.proof')return false;
  try{const e=entry(c),v=raw as Record<string,unknown>,q=e.pending;if(!q)deny();e.pending=null; // consume before verification, including malformed responses
   let ok=false;
   try{ok=Object.keys(v).sort().join('|')==='challengeDigest|signature|type|v'&&v.v===1&&v.challengeDigest===oneVaultDigest(q.body)&&typeof v.signature==='string'&&q.current()&&signature('one-mobile-possession-response',q.body,v.signature,p.trust!.approvedMobileSender(q.body.senderId)!.publicKey)}finally{q.finish(ok)}
   if(!ok)close(c);
  }catch{try{close(c)}catch{/* sticky unknown */}}return true;
 }
 function current(c:MobileBridgeConnectionContext,epoch:string):OneMobileSenderProof|null{try{const e=entry(c),proof=e.proof;return proof&&proof.channelEpoch===epoch&&proof.stillCurrent()?proof:null}catch{return null}}
 async function publish(c:MobileBridgeConnectionContext,v:OneMobileNativeDelivery){
  const e=entry(c),r=v.request,pinned=oneVaultDigest(r);if(!e.proof?.stillCurrent()||!v.stillCurrent())deny();
  const proof=await prove(c,r),proofCutoff=proofDeadlines.get(proof);if(proofCutoff===undefined)deny();const valid=()=>{try{return entry(c)===e&&!!e.proof&&e.proof.stillCurrent()&&now()<Math.min(v.expiresAt,proofCutoff,e.proofExpiresAt)&&v.stillCurrent()&&proof.stillCurrent()&&oneVaultDigest(v.request)===pinned}catch{return false}};
  try{if(!valid())deny();const host=p.trust!.currentHostMetadata()!;
   // Explicit whitelist: no extra caller object properties or internal callback enters wire.
   const x=v.projection,projection={hostId:x.hostId,chatId:x.chatId,commandId:x.commandId,taskId:x.taskId,runId:x.runId,controlVersion:x.controlVersion,requestDigest:x.requestDigest,chatProjection:{taskId:x.chatProjection.taskId,taskVersion:x.chatProjection.taskVersion}};
   if(projection.requestDigest!==pinned||projection.hostId!==r.binding.hostId||projection.commandId!==r.binding.commandId||projection.taskId!==r.binding.taskId||projection.runId!==r.binding.runId||projection.controlVersion!==r.binding.controlVersion)deny();
   const recovery='recovery' in v?structuredClone(v.recovery):null,currentBinding='currentBinding' in v?structuredClone(v.currentBinding):null;
   if(recovery&&(!verifyOneVault('recovery',recovery,host.signingPublicKey)||recovery.requestDigest!==pinned))deny();if(currentBinding)validateOneVaultBinding(currentBinding);
   const body={schema:'agentlas.one-mobile-admission.v1',connectionId:c.connectionId,channelEpoch:proof.channelEpoch,proofRevision:proof.proofRevision,request:structuredClone(r),projection,recovery,currentBinding,expiresAt:Math.min(v.expiresAt,proofCutoff,e.proofExpiresAt)};
   const sig=await signed('one-mobile-admission',body);if(!valid()||!signature('one-mobile-admission',body,sig,host.signingPublicKey))deny();await e.transport.send({v:1,type:'one.native.admission',body,signature:sig},valid);if(!valid())deny();e.delivered={digest:pinned,current:valid};
  }catch{try{close(c)}catch{/* sticky unknown */}deny()}
 }
 function dispose(){disposed=true;for(const c of live)try{close(c)}catch{cleanupUnknown=true}if(cleanupUnknown)deny()}
 return Object.freeze({dispose,accepted,respond,closed:close,authenticate:(c:MobileBridgeConnectionContext)=>prove(c,null),authenticateRecovery:(c:MobileBridgeConnectionContext,r:OneVaultRequest)=>prove(c,r),current,requestAuthenticated:(c:MobileBridgeConnectionContext,digest:string)=>{try{const d=entry(c).delivered;return !!d&&d.digest===digest&&d.current()}catch{return false}},publish,revoke:close});
}
export type OneMobileSocketOwner=ReturnType<typeof createOneMobileSocketOwner>;
let installed:OneMobileSocketOwner|null=null;
/** Main explicit composition only. Cannot be configured by an RPC or instantiate trust. */
export function configureOneMobileSocketOwner(owner:OneMobileSocketOwner|null):void{if(installed&&owner&&installed!==owner)deny();if(installed&&!owner)installed.dispose();installed=owner}
export function currentOneMobileSocketOwner():OneMobileSocketOwner|null{return installed}
