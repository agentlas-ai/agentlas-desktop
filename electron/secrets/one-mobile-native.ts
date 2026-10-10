import {pinOneMobileRecoveryProjection,pinOneMobileNativeProjection,type OneMobileNativeAdmissionProjection} from './one-mobile-projection';
import {OneVaultError,type OneVaultRequest} from '../../shared/one-vault';
import {oneVaultDigest} from './one-vault-crypto';
import {OneMobileSecureAdapter,installOneMobileSecureAdapter,type OneMobileOriginalAdmission,type OneMobileSenderProof} from './one-mobile-secure';
import type {OneVaultRuntime} from './one-vault-runtime';
import type {OneVaultMobileLease} from './one-vault-service';
import type {OneProviderRemoteReader} from './one-provider-remote';
import type {MobileBridgeConnectionContext} from '../mobile-bridge/server';
export interface OneMobileNativePorts {
 /** SAME Main Vault runtime; null never creates a new runtime/trust identity. */
 runtime():OneVaultRuntime|null;
 /** Independently enrolled P256 proof bound to exact native socket, pairing revocation,
  * native principal/session and channel epoch. Bearer-only producer MUST return null. */
 sender(context:MobileBridgeConnectionContext,epoch:string):OneMobileSenderProof|null;
 requestAuthenticated?(context:MobileBridgeConnectionContext,requestDigest:string):boolean;
 /** Must use SAME native provider read instance. Until Main supplies its read core and
  * current resource grant, null. No fake Electron event or provider dispatch fallback. */
 providerReader:OneProviderRemoteReader|null;
 now?():number;
}
interface Held {runtime:OneVaultRuntime;lease:OneVaultMobileLease;request:OneVaultRequest;reconcileOnly:boolean;proofDigest:string;bindProjection(check:()=>boolean):void;baseCurrent():boolean;projection?:ReturnType<typeof pinOneMobileNativeProjection>}
const proofDigest=(proof:OneMobileSenderProof)=>{const {stillCurrent:_,providerOrigin:__,...value}=proof;return oneVaultDigest(value)};
/** Main composition is inert: no keys, grant, request, provider or enrollment on construction.
 * admit() is the native pending-request producer hook. It is never called by request RPC. */
export class OneMobileNativeComposition {
 readonly adapter:OneMobileSecureAdapter;
 private readonly held=new Set<Held>();
 private readonly admissions=new WeakMap<MobileBridgeConnectionContext,Map<string,Held>>();
 constructor(private readonly p:OneMobileNativePorts){
  const trust={approvedHost:async()=>this.p.runtime()?.trust.approvedHost()??null,currentHostMetadata:()=>this.p.runtime()?.trust.currentHostMetadata()??null,approvedMobileSender:(id:string)=>this.p.runtime()?.trust.approvedMobileSender(id)??null,nativeApprovalValid:(id:string,digest:string)=>this.p.runtime()?.trust.nativeApprovalValid(id,digest)??false};
  this.adapter=new OneMobileSecureAdapter({trust,requestAuthenticated:(c,d)=>p.requestAuthenticated?.(c,d)??false,sender:(c,e)=>p.sender(c,e),original:(c,s,selector,phase)=>this.original(c,s,selector,phase),providerReader:p.providerReader,now:p.now,connectionClosed:c=>this.detach(c),disposed:()=>{for(const h of this.held)h.runtime.service.detachMobile(h.lease);this.held.clear();}});
 }
 connectionOpened(context:MobileBridgeConnectionContext):void{this.adapter.connectionOpened(context)}
 connectionClosed(context:MobileBridgeConnectionContext):void{this.adapter.connectionClosed(context)}
 private detach(context:MobileBridgeConnectionContext):void{
  for(const held of this.admissions.get(context)?.values()??[]){held.runtime.service.detachMobile(held.lease);this.held.delete(held);}
  this.admissions.delete(context);
 }
 async admit(context:MobileBridgeConnectionContext,commandId:string,options:{reconcileOnly?:boolean}={}):Promise<OneVaultRequest>{
  const runtime=this.p.runtime(),proof=this.adapter.nativeSender(context);if(!runtime)throw new OneVaultError('secure_route_unavailable');
  const original=runtime.resolveCommand(commandId,options.reconcileOnly?'reconcile':'entry');if(!original)throw new OneVaultError('authority_unavailable');
  if(!options.reconcileOnly){const anchor=runtime.anchor(commandId);if(!anchor||runtime.commandForPendingRun(anchor.runId)!==commandId)throw new OneVaultError('authority_denied');}
  const digest=proofDigest(proof),sender=runtime.trust.approvedMobileSender(proof.senderId);if(!sender)throw new OneVaultError('sender_untrusted');
  if(original.binding.principalId!==proof.principalId||original.binding.sessionId!==proof.sessionId||original.binding.workspaceId!==proof.workspaceId||original.binding.organizationId!==proof.organizationId)throw new OneVaultError('authority_denied');
  let projectionCurrent:(()=>boolean)|undefined;
  const lease:OneVaultMobileLease=Object.freeze({sender:Object.freeze(structuredClone(sender)),stillCurrent:()=>{try{return (!projectionCurrent||projectionCurrent())&&this.p.runtime()===runtime&&proof.stillCurrent()&&proofDigest(this.adapter.nativeSender(context))===digest;}catch{return false;}}});
  const request=await runtime.service.admitMobile(commandId,lease,options);
  if(!lease.stillCurrent()){runtime.service.detachMobile(lease);throw new OneVaultError('revision_changed');}
  let map=this.admissions.get(context);if(!map){map=new Map();this.admissions.set(context,map);}
  const held={runtime,lease,bindProjection:(check:()=>boolean)=>{projectionCurrent=check},baseCurrent:()=>this.p.runtime()===runtime&&proof.stillCurrent()&&proofDigest(this.adapter.nativeSender(context))===digest,request:structuredClone(request),reconcileOnly:!!options.reconcileOnly,proofDigest:digest};map.set(request.binding.requestId,held);this.held.add(held);
  return structuredClone(request); // Native secureAdmissions producer consumes this; ordinary event JSON is not approval.
 }
 /** Native-only producer. No request/JSON selector is promoted to authority. The returned
  * projection is delivered only through an independently approved native admissions port. */
 /** Explicit current native retained-source producer, never invoked by a request RPC.
  * The same independently approved socket/sender and existing operation are required.
  * Delivery must retain stillCurrent; serializing this result grants no authority. */
 async admitRecoveryProjection(context:MobileBridgeConnectionContext,commandId:string){
  const runtime=this.p.runtime(),retained=runtime?.retainedOperation(commandId),sender=this.adapter.nativeSender(context);
  if(!runtime||!retained)throw new OneVaultError('authority_unavailable');
  // Replace only this exact native socket's original admission. Other surfaces/channels
  // remain consumed; detachment is neither cancellation nor a claim of rolled-back storage.
  const old=this.admissions.get(context)?.get(retained.evidence.request.binding.requestId);
  if(old){
   if(old.runtime!==runtime||old.proofDigest!==proofDigest(sender)||oneVaultDigest(old.request)!==oneVaultDigest(retained.evidence.request))throw new OneVaultError('revision_changed');
   runtime.service.detachMobile(old.lease);this.held.delete(old);this.admissions.get(context)!.delete(old.request.binding.requestId);
  }
  const request=await this.admit(context,commandId,{reconcileOnly:true}),held=this.admissions.get(context)?.get(request.binding.requestId);
  if(!held)throw new OneVaultError('authority_denied');
  try{
   const bootstrap=await runtime.service.mobileRecoveryBootstrap(held.lease,request.binding.requestId);
   const current=()=>this.admissions.get(context)?.get(request.binding.requestId)===held&&(this.p.now?.()??Date.now())<bootstrap.recovery.expiresAt&&bootstrap.stillCurrent()&&held.baseCurrent();
   const projection=pinOneMobileRecoveryProjection(runtime,request,current);
   held.projection=projection;held.bindProjection(projection.stillCurrent);
   if(!projection.stillCurrent())throw new OneVaultError('revision_changed');
   return Object.freeze({...bootstrap,projection:projection.value,expiresAt:bootstrap.recovery.expiresAt,stillCurrent:projection.stillCurrent});
  }catch(e){runtime.service.detachMobile(held.lease);this.held.delete(held);this.admissions.get(context)?.delete(request.binding.requestId);throw e;}
 }
 async admitProjection(context:MobileBridgeConnectionContext,commandId:string):Promise<{request:OneVaultRequest;projection:Readonly<OneMobileNativeAdmissionProjection>;expiresAt:number;stillCurrent():boolean}>{
  const request=await this.admit(context,commandId),held=this.admissions.get(context)?.get(request.binding.requestId);
  if(!held)throw new OneVaultError('authority_denied');
  try{
   const current=()=>this.admissions.get(context)?.get(request.binding.requestId)===held&&(this.p.now?.()??Date.now())<request.expiresAt&&held.baseCurrent()&&this.p.runtime()===held.runtime;
   const projection=pinOneMobileNativeProjection(held.runtime,request,current);
   held.projection=projection;held.bindProjection(projection.stillCurrent);
   if(!projection.stillCurrent())throw new OneVaultError('revision_changed');
   return Object.freeze({request:structuredClone(request),projection:projection.value,expiresAt:request.expiresAt,stillCurrent:projection.stillCurrent});
  }catch(e){held.runtime.service.detachMobile(held.lease);this.held.delete(held);this.admissions.get(context)?.delete(request.binding.requestId);throw e;}
 }
 private async original(context:MobileBridgeConnectionContext,proof:OneMobileSenderProof,selector:{commandId?:string;requestId:string},phase:'request'|'submit'|'status'|'cancel'):Promise<OneMobileOriginalAdmission|null>{
  const held=this.admissions.get(context)?.get(selector.requestId);if(!held||held.projection&&!held.projection.stillCurrent()||proofDigest(proof)!==held.proofDigest||this.p.runtime()!==held.runtime||selector.commandId&&selector.commandId!==held.request.binding.commandId||!held.lease.stillCurrent())return null;
  const runtime=held.runtime,c=runtime.resolveCommand(held.request.binding.commandId,held.reconcileOnly?'reconcile':'entry');if(!c)return null;
  const request=runtime.service.mobileRequest(held.lease,selector.requestId),currentBinding={...request.binding,...c.binding};
  if(oneVaultDigest(request)!==oneVaultDigest(held.request))return null;
  const current=()=>{try{return (!held.projection||held.projection.stillCurrent())&&held.lease.stillCurrent()&&this.p.runtime()===runtime&&oneVaultDigest(runtime.service.mobileRequest(held.lease,selector.requestId))===oneVaultDigest(request)&&(()=>{const latest=runtime.resolveCommand(request.binding.commandId,held.reconcileOnly?'reconcile':'entry');return !!latest&&oneVaultDigest({...latest,binding:{...latest.binding,expectedGeneration:c.binding.expectedGeneration}})===oneVaultDigest(c)})()}catch{return false}};
  return {request,currentBinding,currentRevision:c.binding.authorityRevision,mode:held.reconcileOnly?'status-only':'active',allowed:held.reconcileOnly?['status']:['request','submit','status','cancel'],stillCurrent:current,broker:{submit:(id,e)=>runtime.service.mobileSubmit(held.lease,id,e),reconcile:(id,q)=>runtime.service.mobileStatus(held.lease,id,q),cancel:(id,q)=>runtime.service.mobileCancel(held.lease,id,q)}};
 }
}

let nativeComposition:OneMobileNativeComposition|null=null;
/** Explicit Main installation only; null is the production default. No identity is enrolled. */
export function configureOneMobileNativePorts(ports:OneMobileNativePorts|null):OneMobileNativeComposition|null{const value=ports?new OneMobileNativeComposition(ports):null;installOneMobileSecureAdapter(value?.adapter??null);nativeComposition=value;return value}
export function currentOneMobileNativeComposition():OneMobileNativeComposition|null{return nativeComposition}
