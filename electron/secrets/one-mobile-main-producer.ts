import {OneVaultError,type OneVaultBinding} from '../../shared/one-vault';
import type {OneActionAuthorityPort} from '../../shared/one-authority';
import type {MobileBridgeConnectionContext} from '../mobile-bridge/server';
import {oneVaultDigest} from './one-vault-crypto';
import {OneVaultPersonalAdapter,type OneVaultPersonalAdapterPorts,type OneVaultPersonalConsent,type OneVaultPersonalSource} from './one-vault-personal-adapter';
import type {OneVaultRuntime,OneVaultRuntimePolicy,OneVaultRecoveryEvidence,OneVaultOwnerWindow} from './one-vault-runtime';
import {configureOneMobileNativePorts,currentOneMobileNativeComposition,type OneMobileNativeComposition,type OneMobileNativePorts} from './one-mobile-native';

/** Original installed Main lifetime. Epoch detects invalidation; it is never a source grant. */
export interface OneMobileMainLifetime {
 readonly signal:AbortSignal;ready():boolean;currentEpoch():number;
 onInvalidated(listener:(reason:'session'|'shutdown')=>void):()=>void;
}
export interface OneMobileRetainedConsentPort {
 /** Native owner authenticates the ORIGINAL consent receipt/audit and immutable record.
  * A readonly SQL row, nativeReceiptId string or recomputed digest alone is insufficient. */
 original(evidence:Readonly<OneVaultRecoveryEvidence>):{record:OneVaultPersonalConsent;stillCurrent():boolean}|null;
}
export interface OneMobileRetainedSourcePort {
 /** Current retained-resource ACL owner; an allow applies only to this original effect. */
 current(evidence:Readonly<OneVaultRecoveryEvidence>,original:Readonly<OneVaultPersonalConsent>):{
  decision:'allow'|'deny'|'unknown';source:OneVaultPersonalSource;revision:string;permissionRevision:string;stillCurrent():boolean;
 }|null;
 grant(binding:Readonly<OneVaultBinding>,evidence:Readonly<OneVaultRecoveryEvidence>):ReturnType<NonNullable<OneVaultRuntimePolicy['currentRecoveryGrant']>>;
}
function immutable<T>(value:T):T{const v=structuredClone(value);const freeze=(x:unknown)=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}};freeze(v);return v;}
function denied(code:'authority_unavailable'|'authority_denied'|'revision_changed'|'secure_route_unavailable'='authority_unavailable'):never{throw new OneVaultError(code)}
/** Policy fragments for installer5100's EXISTING personalVault slot. This factory does not
 * install a policy, create a consent, enroll keys, query grants or activate a runtime. */
export function createOneMobilePersonalPolicy(runtime:OneVaultRuntime,ports:{
 personal:OneActionAuthorityPort;active:OneVaultPersonalAdapterPorts;
 retainedConsent:OneMobileRetainedConsentPort|null;retainedSource:OneMobileRetainedSourcePort|null;
 invalidateProviderReadiness:OneVaultRuntimePolicy['invalidateProviderReadiness'];
}){
 const adapter=new OneVaultPersonalAdapter(runtime,ports.active);
 const retained=(e:Readonly<OneVaultRecoveryEvidence>)=>{
  try{
   if(!ports.retainedConsent||!ports.retainedSource)return null;
   const owner=runtime.currentNativeOwner(),original=ports.retainedConsent.original(immutable(e)),record=original?.record,b=e.request.binding;
   if(!owner||!original?.stillCurrent()||!record||record.revoked||!record.nativeReceiptId||!record.revision||!record.permissionRevision||b.scope!=='personal'||b.organizationId!==null)return null;
   const i=record.input,s=i.source;
   if(i.commandId!==e.commandId||i.runId!==e.runId||i.toolId!=='elevenlabs-audio'||i.envKey!=='ELEVENLABS_API_KEY'||i.storage!=='os-vault'||i.cost!==null||oneVaultDigest(i.operations)!==oneVaultDigest(['store'])||i.sourceDigest!==oneVaultDigest(s)
    ||b.authorityRevision!==record.revision||b.permissionRevision!==record.permissionRevision||b.principalId!==s.principalId||b.sessionId!==s.sessionId||b.workspaceId!==s.workspaceId||b.resourceId!==s.resourceId||b.payerId!==s.payerId||b.providerWorkspace!==s.providerWorkspace||b.region!==s.region||b.purpose!=='store-credential'||oneVaultDigest(b.operations)!==oneVaultDigest(i.operations)
    ||owner.principalId!==b.principalId||owner.workspaceId!==b.workspaceId||owner.hostId!==b.hostId)return null;
   const current=ports.retainedSource.current(immutable(e),immutable(record)),source=current?.source;
   if(!current||current.decision!=='allow'||!current.stillCurrent()||!source||source.scope!=='personal'||source.organizationId!==null||source.principalId!==owner.principalId||source.sessionId!==owner.sessionId||source.workspaceId!==owner.workspaceId
    ||source.resourceId!==b.resourceId||source.payerId!==b.payerId||source.providerWorkspace!==b.providerWorkspace||source.region!==b.region||!source.sourceRevision||!source.accountLabel||!current.revision||!current.permissionRevision)return null;
   const originalDigest=oneVaultDigest(record),sourceDigest=oneVaultDigest(source),ownerDigest=oneVaultDigest(owner);
   const stillCurrent=()=>{try{const latest=ports.retainedConsent!.original(immutable(e)),next=latest&&ports.retainedSource!.current(immutable(e),immutable(latest.record));return original.stillCurrent()&&current.stillCurrent()&&oneVaultDigest(runtime.currentNativeOwner())===ownerDigest&&!!latest&&latest.stillCurrent()&&oneVaultDigest(latest.record)===originalDigest&&!!next&&next.decision==='allow'&&next.stillCurrent()&&next.revision===current.revision&&next.permissionRevision===current.permissionRevision&&oneVaultDigest(next.source)===sourceDigest}catch{return false}};
   return{decision:'allow' as const,requestDigest:oneVaultDigest(e.request),sourceDigest:oneVaultDigest(e),principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,authorityRevision:current.revision,permissionRevision:current.permissionRevision,accountLabel:source.accountLabel,originalIntentDigest:oneVaultDigest([i,record.nativeReceiptId]),stillCurrent};
  }catch{return null;}
 };
 const policy:OneVaultRuntimePolicy={personal:ports.personal,currentIntent:adapter.currentIntent,currentGrant:adapter.currentGrant,
  currentRecovery:retained,currentRecoveryGrant:async(b,e)=>{
   const proof=retained(e);if(!proof||!ports.retainedSource||proof.authorityRevision!==b.authorityRevision||proof.permissionRevision!==b.permissionRevision)return{decision:'unknown',revision:'',stillCurrent:()=>false};
   const lease=await ports.retainedSource.grant(immutable(b),immutable(e));
   if(!proof.stillCurrent()||lease.decision!=='allow'||lease.revision!==b.authorityRevision||!lease.stillCurrent())return{decision:'unknown',revision:'',stillCurrent:()=>false};
   return{decision:'allow',revision:lease.revision,stillCurrent:()=>proof.stillCurrent()&&lease.stillCurrent()};
  },invalidateProviderReadiness:(slot,generation)=>ports.invalidateProviderReadiness(slot,generation)};
 return Object.freeze({policy,approveOriginalPending:adapter.approveOriginalPending.bind(adapter),consumerReady:adapter.consumerReady});
}
export type OneMobileNativeDelivery=Awaited<ReturnType<OneMobileNativeComposition['admitProjection']>>|Awaited<ReturnType<OneMobileNativeComposition['admitRecoveryProjection']>>;
export interface OneMobileMainProducerPorts {
 runtime():OneVaultRuntime|null;readonly lifetime:OneMobileMainLifetime;
 isNativeOwnerWindow(window:OneVaultOwnerWindow):boolean;
 /** Independent P256 proof of possession on the actual accepted socket; null is unavailable. */
 sender:{current:OneMobileNativePorts['sender'];requestAuthenticated:NonNullable<OneMobileNativePorts['requestAuthenticated']>}|null;
 pendingConsent:{approveOriginalPending(window:OneVaultOwnerWindow,runId:string):Promise<{state:'approved';commandId:string}>}|null;
 /** Native admissions delivery, never ordinary chat/outbox JSON. Implementations consume
  * stillCurrent before AND after native delivery, and revoke their native admission on close. */
 delivery:{publish(context:MobileBridgeConnectionContext,value:OneMobileNativeDelivery):Promise<void>;revoke(context:MobileBridgeConnectionContext):void}|null;
 providerReader:OneMobileNativePorts['providerReader'];
}
/** Main-only callable hookup. Construction is inert; activate is explicit and cannot install
 * absent native producers. Original command selection is read from the SAME runtime/SQL. */
export function createOneMobileMainProducer(p:OneMobileMainProducerPorts){
 let composition:OneMobileNativeComposition|null=null,closed=false,cleanupUnknown=false,remove:(()=>void)|null=null;
 const sockets=new Set<MobileBridgeConnectionContext>();
 const initial=[p.runtime,p.lifetime,p.sender,p.pendingConsent,p.delivery,p.providerReader,p.isNativeOwnerWindow];
 function check(){if(closed||cleanupUnknown||!p.lifetime.ready()||p.lifetime.signal.aborted||[p.runtime,p.lifetime,p.sender,p.pendingConsent,p.delivery,p.providerReader,p.isNativeOwnerWindow].some((v,i)=>v!==initial[i]))denied('secure_route_unavailable');const r=p.runtime();if(!r?.currentNativeOwner())denied('authority_denied');return r;}
 function witness(window?:OneVaultOwnerWindow){const r=check(),epoch=p.lifetime.currentEpoch(),owner=oneVaultDigest(r.currentNativeOwner());const current=()=>{try{return check()===r&&p.lifetime.currentEpoch()===epoch&&oneVaultDigest(r.currentNativeOwner())===owner&&(!window||!window.isDestroyed()&&window.isFocused()&&p.isNativeOwnerWindow(window))}catch{return false}};if(!current())denied('authority_denied');return{r,current};}
 function invalidate(){for(const context of sockets){try{composition?.connectionClosed(context)}catch{cleanupUnknown=true}try{p.delivery?.revoke(context)}catch{cleanupUnknown=true}}sockets.clear();if(cleanupUnknown)denied('secure_route_unavailable');}
 function activate(){check();if(composition)return composition;if(currentOneMobileNativeComposition())denied('secure_route_unavailable');if(!p.sender||!p.delivery)denied('secure_route_unavailable');
  composition=configureOneMobileNativePorts({requestAuthenticated:(c,d)=>p.sender!.requestAuthenticated(c,d),runtime:()=>{try{return check()}catch{return null}},sender:(c,e)=>{try{const {current}=witness(),proof=p.sender!.current(c,e);if(!proof||!proof.stillCurrent()||!current())return null;return{...proof,stillCurrent:()=>current()&&proof.stillCurrent()}}catch{return null}},providerReader:p.providerReader,now:()=>p.runtime()?.sources.now?.()??Date.now()});
  remove=p.lifetime.onInvalidated(()=>invalidate());p.lifetime.signal.addEventListener('abort',onAbort,{once:true});return composition!;
 }
 async function deliver(context:MobileBridgeConnectionContext,value:OneMobileNativeDelivery,current:()=>boolean){
  const valid=()=>current()&&value.stillCurrent();if(!valid())denied('revision_changed');
  sockets.add(context);try{await p.delivery!.publish(context,Object.freeze({...value,stillCurrent:valid}));if(!valid())denied('revision_changed');}
  catch(error){try{composition?.connectionClosed(context)}catch{cleanupUnknown=true}try{p.delivery!.revoke(context)}catch{cleanupUnknown=true}sockets.delete(context);throw error;}
  return{requestId:value.request.binding.requestId,expiresAt:value.expiresAt,mode:'recovery' in value?'status-only' as const:'active' as const};
 }
 async function openPending(window:OneVaultOwnerWindow,context:MobileBridgeConnectionContext,runId:string){
  const {r,current}=witness(window);if(!composition||!p.pendingConsent||!p.delivery)denied();composition.adapter.nativeSender(context);
  const pending=r.sources.pendingRunKeyElicitation(runId),rows=r.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(r.sources.oneId(),runId) as Array<{command_id:string}>;
  if(!pending||pending.runId!==runId||pending.requestId!==runId||rows.length!==1)denied();const commandId=rows[0].command_id,anchor=r.anchor(commandId);if(!anchor||anchor.runId!==runId)denied();
  const pinned=oneVaultDigest([anchor,pending]),stillCurrent=()=>current()&&oneVaultDigest([r.anchor(commandId),r.sources.pendingRunKeyElicitation(runId)])===pinned;
  const approved=await p.pendingConsent.approveOriginalPending(window,runId);
  if(!stillCurrent()||approved.state!=='approved'||approved.commandId!==commandId||r.commandForPendingRun(runId)!==commandId)denied('revision_changed');
  const value=await composition.admitProjection(context,commandId);return deliver(context,value,stillCurrent);
 }
 async function openRecovery(window:OneVaultOwnerWindow,context:MobileBridgeConnectionContext,operationId:string){
  const {r,current}=witness(window);if(!composition||!p.delivery)denied();composition.adapter.nativeSender(context);
  const rows=r.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND json_extract(one_vault_metadata_json,'$.operationId')=?").all(r.sources.oneId(),operationId) as Array<{command_id:string}>;
  if(rows.length!==1)denied();const retained=r.retainedOperation(rows[0].command_id);if(!retained||retained.evidence.operationId!==operationId)denied();
  const value=await composition.admitRecoveryProjection(context,rows[0].command_id);if(!('recovery' in value)||value.recovery.operationId!==operationId)denied('revision_changed');return deliver(context,value,current);
 }
 function dispose(){closed=true;for(const cleanup of [invalidate,()=>{remove?.();remove=null},()=>composition?.adapter.dispose(),()=>{if(currentOneMobileNativeComposition()===composition)configureOneMobileNativePorts(null)},()=>p.lifetime.signal.removeEventListener('abort',onAbort)])try{cleanup()}catch{cleanupUnknown=true}if(cleanupUnknown)denied('secure_route_unavailable');}
 function onAbort(){try{dispose()}catch{/* Sticky cleanup uncertainty remains visible to explicit owner calls. */}}
 return Object.freeze({activate,openPending,openRecovery,invalidate,dispose});
}
