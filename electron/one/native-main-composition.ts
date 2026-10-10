import {getAuthenticatedSessionBinding} from '../auth';
import type {BrowserWindow,IpcMainInvokeEvent} from 'electron';
import type {MobileBridgeConnectionContext} from '../mobile-bridge/server';
import {oneVaultDigest} from '../secrets/one-vault-crypto';
import {oneVaultMainMobileSources,prepareOneVaultMainReauthorization,clearOneVaultMainForReauthorization,finishOneVaultMainReauthorization,configureOneVaultMainPolicy,configureOneVaultMainPendingConsent,configureOneProviderMainDomain,invalidateOneVaultMainAuthority,type OneVaultMainPendingConsent} from '../secrets/one-vault-main';
import type {OneVaultRuntime,OneVaultRuntimePolicy} from '../secrets/one-vault-runtime';
import type {OneProviderDomainPorts} from '../secrets/one-provider-main';
import {createOneMobileMainProducer,type OneMobileMainLifetime,type OneMobileMainProducerPorts} from '../secrets/one-mobile-main-producer';
import {createOneMobileSocketOwner,configureOneMobileSocketOwner,currentOneMobileSocketOwner,type OneMobileSocketPorts} from '../secrets/one-mobile-socket';
import {installOneNativeStartup,type OneNativeStartupOwners} from './native-startup-installer';

export interface OneNativePersonalOwners {
 readonly policy:OneVaultRuntimePolicy;
 readonly pendingConsent:OneVaultMainPendingConsent;
 readonly credentialConsumer:(commandId:string,toolId:string,keyName:string)=>boolean;
 readonly provider?:OneProviderDomainPorts|null;
}
export type OneNativeMainOwners=({readonly scope:'personal';readonly personal:OneNativePersonalOwners}
 |{readonly scope:'organization';readonly startup:Omit<OneNativeStartupOwners,'signal'|'assertMainOwner'>})&{
 /** Independent original source/grant + native approved signer. Absence disables Mobile only. */
 readonly mobile:Pick<OneMobileSocketPorts,'source'|'sign'>|null;
 readonly providerReader:OneMobileMainProducerPorts['providerReader'];
 /** Owner-issued live revision/ACL/installation fence, never inferred from object presence. */
 stillCurrent():boolean;
};
export interface OneNativeReauthorizationScope {readonly installationEpoch:number;readonly sessionDigest:string;readonly nativeOwnerDigest:string}
 export interface OneNativeMainOwnerFactory {
 /** Genuine focused native review plus authenticated durable receipt/capability registry.
  * consume rejects unsigned, copied, replayed or stale receipts. No renderer boolean. */
 reviewReauthorization?(window:BrowserWindow,runtime:OneVaultRuntime,scope:Readonly<OneNativeReauthorizationScope>):Promise<object|null>;
 consumeReauthorization?(receipt:object,scope:Readonly<OneNativeReauthorizationScope>):OneNativeMainOwners|null;
 /** Only Main/native modules may supply this factory; RPC/renderer DTOs never reach it. */
 current(runtime:OneVaultRuntime):OneNativeMainOwners|null;
}
let ownerFactory:OneNativeMainOwnerFactory|null=null;
export function configureOneNativeMainOwnerFactory(value:OneNativeMainOwnerFactory):void {
 if(!value||typeof value.current!=='function'||ownerFactory&&ownerFactory!==value)throw Error('one_native_main_original_owner_required');ownerFactory=value;
}
export type OneNativeMainStatus={state:'ready'|'unavailable';reason:string|null;mobile:boolean;mobileBlocker?:string|null};
function denied(reason:string):never{throw Error(reason)}
/** Inert construction. start is the explicit Main lifecycle boundary; no login, trust,
 * consent, credentials, request engine or provider is created by this composition. */
export function createOneNativeMainComposition(){
 let shutdown=new AbortController();const listeners=new Set<(r:'session'|'shutdown')=>void>();
 let reauthorizing=false,reauthorizationAllowed=false;let epoch=0,closed=false,cleanupUnknown=false,started=false,reason:string|null='one_native_main_owner_unbound';
 let originalReferences:unknown[]=[];
 const references=()=>owners?[owners.stillCurrent,owners.mobile,owners.mobile?.source,owners.mobile?.sign,owners.providerReader,...(owners.scope==='personal'?[owners.personal,owners.personal.policy,owners.personal.pendingConsent,owners.personal.credentialConsumer,owners.personal.provider]:[owners.startup])]:[];
 let runtime:OneVaultRuntime|null=null,owners:OneNativeMainOwners|null=null,originalFactory:OneNativeMainOwnerFactory|null=null,identity='';
 let startup:ReturnType<typeof installOneNativeStartup>|null=null;
 let mobile:ReturnType<typeof createOneMobileMainProducer>|null=null,socket:ReturnType<typeof createOneMobileSocketOwner>|null=null;
 function check(){
  if(closed||cleanupUnknown||!started||shutdown.signal.aborted)denied(cleanupUnknown?'one_native_main_cleanup_unknown':'one_native_main_unavailable');
  const session=getAuthenticatedSessionBinding(),sources=oneVaultMainMobileSources(),owner=runtime?.currentNativeOwner();
  if(!session||session.expiresAt!==null&&session.expiresAt<=Date.now()||!runtime||sources?.runtime()!==runtime||!owner||ownerFactory!==originalFactory||owners?.stillCurrent()!==true
   ||references().some((v,i)=>v!==originalReferences[i])||oneVaultDigest([session,owner])!==identity)denied('one_native_main_current_owner_changed');
  return runtime;
 }
 function current(){try{check();return true}catch{return false}}
 function makeLifetime():OneMobileMainLifetime{const pinned=epoch;return{signal:shutdown.signal,ready:()=>pinned===epoch&&current(),currentEpoch(){if(pinned!==epoch)denied('one_native_main_old_epoch');check();return epoch},onInvalidated(listener){if(pinned!==epoch)denied('one_native_main_old_epoch');check();listeners.add(listener);return()=>{listeners.delete(listener)}}}}
 let lifetime=makeLifetime();
 function fence<T extends object>(value:T):T{
  const pinned=epoch,methods=new Map<PropertyKey,{original:Function;wrapped:Function}>();
  const bound=()=>{if(pinned!==epoch)denied('one_native_main_old_epoch');check()};
  function read(key:PropertyKey){
   bound();let result;try{result=Reflect.get(value,key,value)}catch(error){bound();throw error}bound();if(typeof result!=='function')return result;
   const prior=methods.get(key);if(prior){if(prior.original!==result)denied('one_native_main_current_owner_changed');return prior.wrapped;}
   const wrapped=(...args:unknown[])=>{bound();if(Reflect.get(value,key,value)!==result)denied('one_native_main_current_owner_changed');const at=epoch;
    const finish=(v:unknown)=>{bound();if(at!==epoch||Reflect.get(value,key,value)!==result)denied('one_native_main_current_owner_changed');return v};let resultValue;try{resultValue=Reflect.apply(result,value,args)}catch(error){finish(undefined);throw error}return resultValue&&typeof resultValue.then==='function'?resultValue.then(finish,(error:unknown)=>{finish(undefined);throw error}):finish(resultValue)};
   methods.set(key,{original:result,wrapped});return wrapped;
  }
  // Accessor facade owns no original function value. Descriptor reads, spread,
  // and even freezing the facade keep the same fenced method and original receiver.
  const facade=Object.create(null);for(const key of Reflect.ownKeys(value)){const d=Reflect.getOwnPropertyDescriptor(value,key)!;Object.defineProperty(facade,key,{enumerable:d.enumerable,configurable:true,get:()=>read(key)});}
  return new Proxy(facade,{get(_target,key){return read(key)}}) as T;
 }

 function personal(input:OneNativePersonalOwners){
  const installedEpoch=epoch;const installedCurrent=()=>epoch===installedEpoch&&current();const installedCheck=()=>{if(!installedCurrent())denied('one_native_main_old_epoch')};
  if(!input?.policy||typeof input.policy.currentIntent!=='function'||typeof input.policy.personal?.current!=='function'||typeof input.policy.currentGrant!=='function'||typeof input.pendingConsent?.approveOriginalPending!=='function'||typeof input.credentialConsumer!=='function')denied('one_native_personal_owners_unbound');
  const original=fence(input.policy),isPersonal=(b:{scope:string;organizationId:string|null})=>b.scope==='personal'&&b.organizationId===null;
  const retained=(e:Parameters<NonNullable<OneVaultRuntimePolicy['currentRecovery']>>[0])=>{if(!isPersonal(e.request.binding))return null;const at=epoch,result=original.currentRecovery?.(e);return result?{...result,stillCurrent:()=>installedCurrent()&&at===epoch&&result.stillCurrent()===true}:null};
  const unavailable=()=>({decision:'unknown' as const,revision:'',stillCurrent:()=>false});
  const pinGrant=async(p:ReturnType<OneVaultRuntimePolicy['currentGrant']>)=>{const at=epoch,result=await p;installedCheck();return{...result,stillCurrent:()=>installedCurrent()&&at===epoch&&result.stillCurrent()===true}};
  // The existing authority router independently validates native session/host/One identity.
  // No Business adapter is configured by a personal installation.
  const policy:OneVaultRuntimePolicy={...original,personal:{current:q=>{installedCheck();if(!isPersonal(q))return{decision:'deny',revision:'',reason:'one_native_personal_scope_required'};const result=original.personal.current(q);installedCheck();return result}},
   currentIntent:(a,p)=>{const i=original.currentIntent(a,p);return i&&isPersonal(i)?i:null},
   currentGrant:(b,p)=>isPersonal(b)?pinGrant(original.currentGrant(b,p)):Promise.resolve(unavailable()),
   prepareAuthority:(b,p)=>isPersonal(b)?pinGrant(original.prepareAuthority?.(b,p)??original.currentGrant(b,p)):Promise.resolve(unavailable()),
   currentRecovery:retained,
   currentRecoveryGrant:(b,e)=>isPersonal(b)?pinGrant(original.currentRecoveryGrant?.(b,e)??Promise.resolve(unavailable())):Promise.resolve(unavailable()),
   prepareRecoveryAuthority:(b,e)=>isPersonal(b)?pinGrant(original.prepareRecoveryAuthority?.(b,e)??original.currentRecoveryGrant?.(b,e)??Promise.resolve(unavailable())):Promise.resolve(unavailable()),
   invalidateProviderReadiness:(s,g)=>original.invalidateProviderReadiness(s,g)};
  configureOneVaultMainPolicy(policy,(...args)=>{try{installedCheck();const result=input.credentialConsumer(...args);installedCheck();return result===true}catch{return false}});
  configureOneVaultMainPendingConsent(fence(input.pendingConsent));
  if(input.provider)configureOneProviderMainDomain(fence(input.provider));
 }
 function status():OneNativeMainStatus {return{state:current()?'ready':'unavailable',reason:current()?null:reason??'one_native_main_current_owner_changed',mobile:current()&&!!mobile&&!!socket,mobileBlocker:current()&&mobile&&socket?null:'one_native_mobile_source_signer_unbound'}}
 function start():OneNativeMainStatus {
  if(started||closed||cleanupUnknown)return status();
  const factory=ownerFactory;if(!factory)return{state:'unavailable',reason:'one_native_main_owner_unbound',mobile:false};
  const sources=oneVaultMainMobileSources(),session=getAuthenticatedSessionBinding();
  if(!session||session.expiresAt!==null&&session.expiresAt<=Date.now())return{state:'unavailable',reason:'one_native_main_session_unavailable',mobile:false};
  let r:OneVaultRuntime|null;try{r=sources?.runtime()??sources?.prepareRuntime()??null}catch{return{state:'unavailable',reason:'one_native_main_runtime_owner_unavailable',mobile:false}}if(!r?.currentNativeOwner())return{state:'unavailable',reason:'one_native_main_runtime_owner_unavailable',mobile:false};
  const before=oneVaultDigest([session,r.currentNativeOwner()]);let issued:OneNativeMainOwners|null;
  try{issued=factory.current(r);if(!issued||!['personal','organization'].includes(issued.scope)||issued.stillCurrent()!==true)return{state:'unavailable',reason:'one_native_main_source_owners_unbound',mobile:false}}catch{return{state:'unavailable',reason:'one_native_main_source_owners_unbound',mobile:false}};
  if(ownerFactory!==factory||sources?.runtime()!==r||oneVaultDigest([getAuthenticatedSessionBinding(),r.currentNativeOwner()])!==before)return{state:'unavailable',reason:'one_native_main_current_owner_changed',mobile:false};
  runtime=r;owners=issued;originalFactory=factory;identity=before;originalReferences=references();started=true;
  try{
   check();
   if(issued.scope==='personal')personal(issued.personal);
   else startup=installOneNativeStartup({...issued.startup,signal:shutdown.signal,assertMainOwner:()=>{check();}});
   check();
   if(issued.mobile){
    if(!issued.mobile.source||!issued.mobile.sign)denied('one_native_mobile_source_signer_unbound');
    let composition:ReturnType<ReturnType<typeof createOneMobileMainProducer>['activate']>|null=null;
    socket=createOneMobileSocketOwner({trust:r.trust,source:(c,q)=>{check();const result=issued.mobile!.source!(c,q);check();return result},sign:async(d,b)=>{check();const result=await issued.mobile!.sign!(d,b);check();return result},channelEpoch:c=>composition?.adapter.nativeChannelEpoch(c)??null,now:()=>r.sources.now?.()??Date.now()});
    const sameSocket=socket,pendingConsent=issued.scope==='personal'?issued.personal.pendingConsent:issued.startup.pendingConsent;
    mobile=createOneMobileMainProducer({runtime:()=>current()?r:null,lifetime,isNativeOwnerWindow:w=>!!oneVaultMainMobileSources()?.isNativeOwnerWindow(w),sender:{current:(c,e)=>sameSocket.current(c,e),requestAuthenticated:(c,d)=>sameSocket.requestAuthenticated(c,d)},pendingConsent,delivery:sameSocket,providerReader:issued.providerReader});
    composition=mobile.activate();configureOneMobileSocketOwner(sameSocket);
   }
   check();reason=null;return status();
  }catch(error){const failure=error instanceof Error?error.message:'one_native_main_install_unknown';invalidate('shutdown');if(!cleanupUnknown)reason=failure;return status();}
 }
 function invalidate(cause:'session'|'shutdown'){
  reauthorizationAllowed=cause==='session';epoch++;closed=true;reason=cause==='session'?'one_native_main_session_invalidated':'one_native_main_shutdown';
  for(const cleanup of [()=>shutdown.abort(),...Array.from(listeners,l=>()=>l(cause)),()=>mobile?.dispose(),()=>socket?.dispose(),()=>{if(socket&&currentOneMobileSocketOwner()===socket)configureOneMobileSocketOwner(null)},()=>startup?.invalidate(cause),()=>invalidateOneVaultMainAuthority()])try{cleanup()}catch{cleanupUnknown=true}
  listeners.clear();if(cleanupUnknown)reason='one_native_main_cleanup_unknown';
 }
 /** Explicit native top-frame action. No timer/session-restored handler calls this. */
 async function reauthorize(event:IpcMainInvokeEvent):Promise<OneNativeMainStatus>{
  if(reauthorizing||!closed||!reauthorizationAllowed||cleanupUnknown||!runtime||!owners||owners.scope!=='personal'||owners.personal.provider)denied('one_native_main_reauthorization_unavailable');
  const factory=ownerFactory,r=runtime,at=epoch;
  if(!factory||factory!==originalFactory||!factory.reviewReauthorization||!factory.consumeReauthorization)denied('one_native_main_reauthorization_owner_unbound');
  reauthorizing=true;let cleared=false;
  try{
   const prepared=await prepareOneVaultMainReauthorization(event),session=getAuthenticatedSessionBinding(),owner=r.currentNativeOwner();
   if(!session||!owner||epoch!==at||cleanupUnknown||ownerFactory!==factory)denied('one_native_main_current_owner_changed');
   const scope=Object.freeze({installationEpoch:at,sessionDigest:oneVaultDigest(session),nativeOwnerDigest:oneVaultDigest(owner)});
   const stillCurrent=()=>epoch===at&&!cleanupUnknown&&ownerFactory===factory&&oneVaultMainMobileSources()?.runtime()===r&&oneVaultDigest(getAuthenticatedSessionBinding())===scope.sessionDigest&&oneVaultDigest(r.currentNativeOwner())===scope.nativeOwnerDigest;
   const receipt=await factory.reviewReauthorization(prepared.window,r,scope);
   if(!receipt||!stillCurrent())denied('one_native_main_reauthorization_denied');
   const fresh=factory.consumeReauthorization(receipt,scope);
   if(!fresh||fresh.scope!=='personal'||fresh.personal.provider||fresh.stillCurrent()!==true||factory.current(r)!==fresh||!stillCurrent())denied('one_native_main_reauthorization_denied');
   clearOneVaultMainForReauthorization(event,prepared.ticket);cleared=true;
   epoch++;closed=false;started=false;reason=null;reauthorizationAllowed=false;shutdown=new AbortController();lifetime=makeLifetime();mobile=null;socket=null;startup=null;
   const result=start();if(result.state!=='ready'||owners!==fresh)denied('one_native_main_reauthorization_denied');
   finishOneVaultMainReauthorization(event,prepared.ticket);return status();
  }catch(error){if(cleared)invalidate('session');throw error}finally{reauthorizing=false}
 }
  async function openPending(window:BrowserWindow,context:MobileBridgeConnectionContext,runId:string){
  check();if(!mobile||!socket||!oneVaultMainMobileSources()?.isNativeOwnerWindow(window)||!window.isFocused())denied('one_native_mobile_owner_unavailable');
  const at=epoch;await socket.authenticate(context);check();if(at!==epoch)denied('one_native_main_current_owner_changed');return mobile.openPending(window,context,runId);
 }
 async function openRecovery(window:BrowserWindow,context:MobileBridgeConnectionContext,operationId:string){
  const r=check();if(!mobile||!socket||!oneVaultMainMobileSources()?.isNativeOwnerWindow(window)||!window.isFocused())denied('one_native_mobile_owner_unavailable');
  const rows=r.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND json_extract(one_vault_metadata_json,'$.operationId')=?").all(r.sources.oneId(),operationId) as Array<{command_id:string}>;
  const retained=rows.length===1?r.retainedOperation(rows[0].command_id):null;if(!retained||retained.evidence.operationId!==operationId)denied('one_native_mobile_retained_source_unavailable');
  const at=epoch;await socket.authenticateRecovery(context,retained.evidence.request);check();if(at!==epoch)denied('one_native_main_current_owner_changed');return mobile.openRecovery(window,context,operationId);
 }
 return Object.freeze({start,status,invalidate,reauthorizationRequired:()=>closed&&reauthorizationAllowed,reauthorize,openPending,openRecovery});
}
let main:ReturnType<typeof createOneNativeMainComposition>|null=null;
/** Actual Main registers once after the existing Vault host, never through IPC. */
export function registerOneNativeMainComposition(){if(main)throw Error('one_native_main_already_registered');return main=createOneNativeMainComposition()}
export function currentOneNativeMainComposition(){return main}
