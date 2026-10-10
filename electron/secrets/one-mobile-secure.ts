import {randomUUID} from 'node:crypto';
import {OneVaultError,type OneVaultBinding,type OneVaultRequest,type OneVaultEnvelope,type OneVaultStatusQuery,type OneVaultCancelQuery} from '../../shared/one-vault';
import {OneProviderRemoteError} from '../../shared/one-provider-remote';
import {oneVaultDigest,validateOneVaultBinding,validateOneVaultRequest,verifyOneVault,authenticateOneVaultEnvelope,validateOneVaultStatus,validateOneVaultCancel} from './one-vault-crypto';
import type {OneVaultBroker} from './one-vault-broker';
import type {OneVaultNativeTrustPort} from './one-vault-service';
import type {OneProviderRemoteReader,OneProviderRemoteOrigin} from './one-provider-remote';
import type {MobileBridgeConnectionContext} from '../mobile-bridge/server';

export const ONE_MOBILE_SECURE_METHODS=['one.vault.request','one.vault.submit','one.vault.status','one.vault.cancel','one.provider.remote.read'] as const;
export type OneMobileSecureMethod=typeof ONE_MOBILE_SECURE_METHODS[number];
export const isOneMobileSecureMethod=(v:unknown):v is OneMobileSecureMethod=>typeof v==='string'&&(ONE_MOBILE_SECURE_METHODS as readonly string[]).includes(v);
export interface OneMobileSenderProof {
 /** From native proof-of-possession of an independently approved sender key on THIS socket.
  * deviceId or relay/bearer possession alone must never implement this port. */
 hostId:string;senderId:string;senderKeyId:string;senderPublicKey:string;trustGeneration:number;
 approvedSenderReceiptId:string;principalId:string;sessionId:string;workspaceId:string;organizationId:string|null;
 channelId:string;channelEpoch:string;proofRevision:string;stillCurrent():boolean;
 /** Same capability recognized by the existing provider reader's native current() port. */
 providerOrigin?:OneProviderRemoteOrigin;
}
export interface OneMobileOriginalAdmission {
 /** Existing signed persisted request; do not mint it from these RPC selectors. */
 request:OneVaultRequest;
 /** Current source/ACL grant. Original signed request is never rewritten for recovery. */
 currentBinding:OneVaultBinding;currentRevision:string;
 mode:'active'|'status-only';allowed:Array<'request'|'submit'|'status'|'cancel'>;
 /** Same broker instance/custody and existing journal, never another credential queue.
  * Main MUST intersect sender/channel and this admission's current lease in the broker's
  * authorize/current checks at decrypt/store/commit/reconcile, not merely at this wrapper.
  * Current local-surface-only service cannot supply this port; leave original() null. */
 broker:Pick<OneVaultBroker,'submit'|'reconcile'|'cancel'>;
 stillCurrent():boolean;
}
export interface OneMobileSecurePorts {
 trust:OneVaultNativeTrustPort|null;
 /** Current native owner, current session, pairing revocation and actual channel proof. */
 sender(context:MobileBridgeConnectionContext,epoch:string):OneMobileSenderProof|null;
 /** Actual original Supervisor row + custody/admission/pending request/control/current grant.
  * This must return null when Mobile metadata/shared broker custody has not been implemented. */
 original(context:MobileBridgeConnectionContext,proof:OneMobileSenderProof,selector:{commandId?:string;requestId:string},phase:'request'|'submit'|'status'|'cancel'):Promise<OneMobileOriginalAdmission|null>;
 requestAuthenticated?(context:MobileBridgeConnectionContext,requestDigest:string):boolean;
 providerReader:OneProviderRemoteReader|null;
 connectionClosed?(context:MobileBridgeConnectionContext):void;
 disposed?():void;
 now?:()=>number;
}
function deny():never{throw new OneVaultError('secure_route_unavailable')}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw new OneVaultError('invalid_request')}
function id(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))throw new OneVaultError('invalid_request');return value}
/** Native socket lifecycle only; no Electron event, browser surface, key read, endpoint or execute API. */
export class OneMobileSecureAdapter {
 private enabled=true;
 private readonly channels=new WeakMap<MobileBridgeConnectionContext,{epoch:string;digest:string}>();
 constructor(private readonly p:OneMobileSecurePorts){}
 private now(){return this.p.now?.()??Date.now()}
 /** Called only by actual server.accept after pairing and before any request is dispatched. */
 connectionOpened(context:MobileBridgeConnectionContext):void{
  if(!this.enabled||context.devBootstrap||!['ios','android'].includes(context.devicePlatform)||!/^device_[a-f0-9]{32}$/.test(context.deviceId))return;
  if(this.channels.has(context))return;
  this.channels.set(context,{epoch:randomUUID(),digest:oneVaultDigest(context)});
 }
 connectionClosed(context:MobileBridgeConnectionContext):void{this.channels.delete(context);this.p.connectionClosed?.(context)}
 dispose():void{this.enabled=false;this.p.disposed?.()}
 /** Main-only accepted socket authentication identifier, never a grant. */
 nativeChannelEpoch(context:MobileBridgeConnectionContext):string|null{const c=this.channels.get(context);return this.enabled&&c&&c.digest===oneVaultDigest(context)?c.epoch:null}
 private sender(context:MobileBridgeConnectionContext):OneMobileSenderProof{
  if(!this.enabled)deny();
  const channel=this.channels.get(context);if(!channel||channel.digest!==oneVaultDigest(context))deny();
  const s=this.p.sender(context,channel.epoch),host=this.p.trust?.currentHostMetadata();
  if(!s||!s.stillCurrent()||s.channelEpoch!==channel.epoch||s.channelId!==context.connectionId||!s.proofRevision||!s.sessionId||!host||host.revokedAt!==null||host.hostId!==s.hostId||host.hostKeyId.length===0||host.generation!==s.trustGeneration||!this.p.trust!.nativeApprovalValid(host.approvedNativeReceiptId,oneVaultDigest(host)))deny();
  const sender=this.p.trust!.approvedMobileSender(s.senderId);
  if(!sender||sender.revokedAt!==null||sender.hostId!==s.hostId||sender.senderId!==s.senderId||sender.senderKeyId!==s.senderKeyId||sender.publicKey!==s.senderPublicKey||sender.generation!==s.trustGeneration||sender.principalId!==s.principalId||sender.workspaceId!==s.workspaceId||sender.organizationId!==s.organizationId||sender.approvedNativeReceiptId!==s.approvedSenderReceiptId||!this.p.trust!.nativeApprovalValid(sender.approvedNativeReceiptId,oneVaultDigest(sender)))deny();
  return s;
 }
 /** Main admission producer only; not an RPC method. */
 nativeSender(context:MobileBridgeConnectionContext):OneMobileSenderProof{return this.sender(context)}
 private proofDigest(s:OneMobileSenderProof){const {stillCurrent:_,providerOrigin:__,...v}=s;return oneVaultDigest(v)}
 async request(context:MobileBridgeConnectionContext,method:OneMobileSecureMethod,raw:unknown):Promise<unknown>{
  try{return await this.perform(context,method,raw)}catch(e){
   // No payload, private refs, upstream errors or stack messages cross this boundary.
   if(e instanceof OneVaultError||e instanceof OneProviderRemoteError)throw e;
   throw new OneVaultError('secure_route_unavailable');
  }
 }
 private async perform(context:MobileBridgeConnectionContext,method:OneMobileSecureMethod,raw:unknown):Promise<unknown>{
  if(!isOneMobileSecureMethod(method))throw new OneVaultError('invalid_request');
  const input=structuredClone(raw),s=this.sender(context),held=this.proofDigest(s);
  let authenticatedRequestDigest:string|null=null;
  const current=()=>{if(authenticatedRequestDigest&&!this.p.requestAuthenticated?.(context,authenticatedRequestDigest))deny();const next=this.sender(context);if(!s.stillCurrent()||this.proofDigest(next)!==held||next.providerOrigin!==s.providerOrigin)deny()};
  if(method==='one.provider.remote.read'){
   exact(input,['query']);if(!this.p.providerReader||!s.providerOrigin)throw new OneProviderRemoteError('remote_route_unavailable');
   const result=await this.p.providerReader.read(s.providerOrigin,input.query);current();return result;
  }
  const phase=method.slice('one.vault.'.length) as 'request'|'submit'|'status'|'cancel';
  exact(input,phase==='request'?['commandId','requestId','requestRevision']:phase==='submit'?['requestId','envelope']:['requestId','query']);
  const requestId=id(input.requestId),commandId=phase==='request'?id(input.commandId):undefined;
  if(phase==='request'&&(!Number.isSafeInteger(input.requestRevision)||Number(input.requestRevision)<1))throw new OneVaultError('invalid_request');
  const a=await this.p.original(context,s,{requestId,...(commandId?{commandId}:{})},phase);current();
  if(!a||!a.stillCurrent()||!a.allowed.includes(phase)||!a.currentRevision||a.currentRevision!==a.currentBinding.authorityRevision)deny();
  if(a.mode==='status-only'&&phase!=='status')deny();
  const r=structuredClone(a.request),b=r.binding,c=structuredClone(a.currentBinding),host=this.p.trust!.currentHostMetadata()!;
  authenticatedRequestDigest=oneVaultDigest(r);if(!this.p.requestAuthenticated?.(context,authenticatedRequestDigest))deny();
  validateOneVaultRequest(r,this.now(),phase==='status'||phase==='cancel');validateOneVaultBinding(c);
  if(b.requestId!==requestId||commandId&&b.commandId!==commandId||phase==='request'&&b.requestRevision!==input.requestRevision||r.hostKeyId!==host.hostKeyId||r.recipientKeyId!==host.recipientKeyId||r.recipientPublicKey!==host.recipientPublicKey||!verifyOneVault('request',r,host.signingPublicKey))deny();
  for(const v of [b,c])if(v.hostId!==s.hostId||v.senderId!==s.senderId||v.trustGeneration!==s.trustGeneration||v.principalId!==s.principalId||v.workspaceId!==s.workspaceId||v.organizationId!==s.organizationId)deny();
  if(c.sessionId!==s.sessionId)deny();
  // Current authority can change for terminal status; immutable original effect identity cannot.
  for(const key of ['commandId','requestId','requestRevision','taskId','runId','controlVersion','intentDigest','scope','resourceId','purpose','payerId','provider','providerWorkspace','region','endpoint','storage'] as const)if(b[key]!==c[key])deny();
  if(a.mode==='active'&&oneVaultDigest({...b,expectedGeneration:c.expectedGeneration})!==oneVaultDigest(c))deny();
  const fresh=()=>{current();if(!a.stillCurrent()||oneVaultDigest(a.request)!==oneVaultDigest(r)||oneVaultDigest(a.currentBinding)!==oneVaultDigest(c))deny()};fresh();
  if(phase==='request')return r;
  let result:unknown;
  if(phase==='submit'){
   const e=input.envelope as OneVaultEnvelope;authenticateOneVaultEnvelope(r,e,s.senderPublicKey);
   if(e.senderKeyId!==s.senderKeyId||e.action!=='store')deny(); // No remote credential deletion route.
   fresh();result=await a.broker.submit(requestId,e);
  }else if(phase==='status'){
   const q=input.query as OneVaultStatusQuery;validateOneVaultStatus(q,r,s.senderPublicKey,this.now());if(q.senderKeyId!==s.senderKeyId)deny();
   fresh();result=await a.broker.reconcile(requestId,q,{observeOnly:true});
  }else{
   const q=input.query as OneVaultCancelQuery;validateOneVaultCancel(q,r,s.senderPublicKey,this.now());if(q.senderKeyId!==s.senderKeyId)deny();
   fresh();result=a.broker.cancel(requestId,q);
  }
  if(phase==='cancel')current();else fresh();return result;
 }
}

let configured:OneMobileSecureAdapter|null=null;
/** Main composition only. Never called by RPC, enrollment discovery or renderer. */
export function configureOneMobileSecurePorts(ports:OneMobileSecurePorts|null):OneMobileSecureAdapter|null {
 return installOneMobileSecureAdapter(ports?new OneMobileSecureAdapter(ports):null);
}
export function currentOneMobileSecureAdapter():OneMobileSecureAdapter|null{return configured}

/** Main lifecycle composition only. Existing sockets must reconnect after replacement. */
export function installOneMobileSecureAdapter(value:OneMobileSecureAdapter|null):OneMobileSecureAdapter|null{configured?.dispose();configured=value;return configured}
