import {oneProviderUnsettled,type OneProviderReadMedia} from './one-provider-receipt-checkpoint';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {constants,promises as fs,realpathSync,lstatSync} from 'node:fs';
import {OneProviderError,type OneProviderReceipt} from '../../shared/one-provider';
import type {OneProviderResourceReadGrant,OneProviderReadSnapshot,OneProviderReadProjection} from '../../shared/one-provider-read';
import type {OneProviderCommandRegistry} from './one-provider-main';
import {oneVaultDigest,validateOneVaultBinding,verifyOneVault} from './one-vault-crypto';
import {verifyOneWav} from './one-provider-broker';
type RecordValue=NonNullable<ReturnType<OneProviderCommandRegistry['get']>>;
/** Main-only capability; ports must look it up in a native WeakMap. JSON cannot mint it. */
export interface OneProviderReadAccess {readonly __oneProviderReadAccess?:never}
export interface OneProviderReadOrigin {principalId:string;sessionId:string;workspaceId:string;hostId:string;oneId:string;originEpoch:string}
export interface OneProviderReadCorePorts {
 /** Desktop adapter checks exact registered native frame/focus; remote adapter independently checks approved pair/current channel. */
 origin(access:OneProviderReadAccess):OneProviderReadOrigin|null;
 /** SAME existing OneProviderCommandRegistry. Never a second registry or a caller-authored record. */
 records:Pick<OneProviderCommandRegistry,'get'>;
 media:{getMediaOperation(id:string):OneProviderReadMedia|null};
 /** Persist once in the SAME media-operation CAS checkpoint under the already validated read lease. */
 checkpointUnknown?(expected:Readonly<OneProviderReadMedia>,receipt:Readonly<OneProviderReceipt>,current:()=>boolean):OneProviderReadMedia;
 /** Existing approved host custody. Historical key lookup must explicitly remain approved for this retained result. */
 approvedSigningKey(hostId:string,keyId:string):string|null;
 /** Current original command/resource ACL and explicit read/acquisition grant. This is NOT valid(h), dispatch authority, or a cached old plan. */
 authorize(access:OneProviderReadAccess,record:Readonly<RecordValue>,receipt:Readonly<OneProviderReceipt>,purpose:OneProviderResourceReadGrant['purpose']):Promise<{grant:OneProviderResourceReadGrant;stillCurrent():boolean}|null>;
 /** Existing host signing path for an unresolved existing action; never calls execute, key consumer or HTTP. */
 unknownReceipt?(access:OneProviderReadAccess,record:Readonly<RecordValue>):Promise<OneProviderReceipt|null>;
 /** Exact original approved artifact directory, independently granted for acquisition. No caller path. */
 approvedArtifactRoot?(access:OneProviderReadAccess,record:Readonly<RecordValue>,grant:Readonly<OneProviderResourceReadGrant>):string|null;
 /** Current native storage/option projection with its own current read lease; never dispatches or mints an action. */
 storageProjection?(access:OneProviderReadAccess,commandId:string):Promise<{projection:OneProviderReadProjection['projection'];stillCurrent():boolean}|null>;
 now?:()=>number;
}
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function deny(code:ConstructorParameters<typeof OneProviderError>[0]='authority_unavailable'):never{throw new OneProviderError(code)}
/** Shared native read core: no Electron event, dispatch, prepare, credential read, provider, or network port. */
export class OneProviderReadCore {
 constructor(private readonly p:OneProviderReadCorePorts){}
 private now(){return this.p.now?.()??Date.now()}
 private original(commandId:string,operationId:string):RecordValue {
  const h=this.p.records.get(operationId);if(!h||h.prepared.commandId!==commandId||h.native.commandId!==commandId||h.plan.commandId!==commandId)deny();
  const {prepared:a,native:n,plan:p}=h,b=a.action.binding;validateOneVaultBinding(b);
  if(b.commandId!==commandId||a.operationId!==operationId||a.action.operationId!==operationId||n.operationId!==operationId||a.bindingKey!==oneVaultDigest(b)
   ||a.schema!=='agentlas.one-provider-native.v1'||a.action.schema!=='agentlas.one-provider.v1'||a.action.credentialGeneration!==b.expectedGeneration
   ||a.action.modelId!==n.modelId||a.action.voiceId!==n.voiceId||a.action.kind!==n.kind||a.action.outputFormat!==n.outputFormat||a.action.textDigest!==n.textDigest
   ||a.action.expiresAt!==n.expiresAt||a.action.expiresAt!==p.quote.expiresAt||oneVaultDigest(a.quote)!==oneVaultDigest(p.quote)
   ||a.action.enableProviderLogging!==n.enableProviderLogging||a.action.minDurationMs!==n.minDurationMs||a.action.maxDurationMs!==n.maxDurationMs)deny('operation_conflict');
  return structuredClone(h);
 }
 private receipt(h:RecordValue,r:OneProviderReceipt):void {
  const a=h.prepared.action,b=a.binding,key=this.p.approvedSigningKey(b.hostId,r.hostKeyId);
  const scope={taskId:b.taskId,runId:b.runId,controlVersion:b.controlVersion,authorityRevision:b.authorityRevision,permissionRevision:b.permissionRevision,hostId:b.hostId,principalId:b.principalId,organizationId:b.organizationId,workspaceId:b.workspaceId,resourceId:b.resourceId,provider:b.provider,providerWorkspace:b.providerWorkspace,region:b.region,credentialGeneration:a.credentialGeneration};
  if(!key||r.schema!=='agentlas.one-provider.v1'||r.operationId!==a.operationId||r.actionDigest!==oneVaultDigest(a)||!Object.entries(scope).every(([k,v])=>(r as unknown as Record<string,unknown>)[k]===v)
   ||!['verified','audio_ready','failed','outcome_unknown'].includes(r.state)||!Number.isSafeInteger(r.observedAt)||r.observedAt<0||r.observedAt>this.now()+5000||!verifyOneVault('receipt',r,key))deny('operation_conflict');
 }
 private grant(h:RecordValue,r:OneProviderReceipt,g:OneProviderResourceReadGrant,o:OneProviderReadOrigin,purpose:OneProviderResourceReadGrant['purpose']):void {
  const b=g.currentBinding,old=h.prepared.action.binding;validateOneVaultBinding(b);
  const stable=['commandId','taskId','runId','hostId','principalId','scope','organizationId','workspaceId','resourceId','provider','providerWorkspace','region','payerId'] as const;
  if(g.schema!=='agentlas.one-provider-resource-read.v1'||g.oneId!==o.oneId||g.commandId!==h.prepared.commandId||g.operationId!==h.prepared.operationId||g.actionDigest!==oneVaultDigest(h.prepared.action)||g.receiptDigest!==oneVaultDigest(r)||g.purpose!==purpose
   ||!g.revision||g.revision.length>200||!Number.isSafeInteger(g.issuedAt)||g.issuedAt>this.now()+5000||g.issuedAt<this.now()-30000||!Number.isSafeInteger(g.expiresAt)||g.expiresAt<=this.now()||g.expiresAt>g.issuedAt+30000
   ||!stable.every(k=>b[k]===old[k])||b.principalId!==o.principalId||b.sessionId!==o.sessionId||b.workspaceId!==o.workspaceId||b.hostId!==o.hostId)deny();
 }
 private async held(access:OneProviderReadAccess,commandId:string,operationId:string,purpose:OneProviderResourceReadGrant['purpose']) {
  const o=this.p.origin(access);if(!o||!o.originEpoch||!o.oneId)deny();const h=this.original(commandId,operationId),hd=oneVaultDigest(h),media=this.p.media.getMediaOperation(operationId);
  if(!media)deny('operation_conflict');
  if(media.inputDigest!==oneVaultDigest(h.prepared.action))deny('operation_conflict');
  let r=(media?.result?.receipt??(media?.providerCheckpoint as {oneProviderReceipt?:OneProviderReceipt}|null)?.oneProviderReceipt) as OneProviderReceipt|null;
  const unresolved=!r;let checkpointed=!unresolved;const mediaDigest=oneVaultDigest(media);
  if(!r){if(purpose!=='status'||!oneProviderUnsettled(media)||!this.p.checkpointUnknown)deny('operation_conflict');r=await this.p.unknownReceipt?.(access,Object.freeze(h))??null;if(!r||r.state!=='outcome_unknown'||r.audio!==null)deny();}
  this.receipt(h,r);if(['verified','audio_ready'].includes(r.state)&&media?.lifecycle!=='succeeded')deny('operation_conflict');
  const receipt=structuredClone(r),rd=oneVaultDigest(receipt),authorized=await this.p.authorize(access,Object.freeze(h),Object.freeze(receipt),purpose);if(!authorized)deny();
  const g=structuredClone(authorized.grant),gd=oneVaultDigest(g);
  const stillCurrent=()=>{try{const current=this.p.origin(access);if(!current||oneVaultDigest(current)!==oneVaultDigest(o)||oneVaultDigest(this.original(commandId,operationId))!==hd||!authorized.stillCurrent()||oneVaultDigest(authorized.grant)!==gd)return false;this.grant(h,receipt,g,current,purpose);this.receipt(h,receipt);const latest=this.p.media.getMediaOperation(operationId);if(latest&&latest.inputDigest!==oneVaultDigest(h.prepared.action))return false;const latestReceipt=latest?.result?.receipt??(latest?.providerCheckpoint as {oneProviderReceipt?:unknown}|null)?.oneProviderReceipt;if(checkpointed?(!latestReceipt||oneVaultDigest(latestReceipt)!==rd):oneVaultDigest(latest)!==mediaDigest)return false;return !['verified','audio_ready'].includes(receipt.state)||latest?.lifecycle==='succeeded';}catch{return false}};
  if(!stillCurrent())deny();
  if(unresolved){const authorityCurrent=()=>{try{const current=this.p.origin(access);if(!current||oneVaultDigest(current)!==oneVaultDigest(o)||oneVaultDigest(this.original(commandId,operationId))!==hd||!authorized.stillCurrent()||oneVaultDigest(authorized.grant)!==gd)return false;this.grant(h,receipt,g,current,purpose);this.receipt(h,receipt);return true}catch{return false}};this.p.checkpointUnknown!(Object.freeze(structuredClone(media)),Object.freeze(receipt),authorityCurrent);checkpointed=true;if(!stillCurrent())deny();}
  return {h,snapshot:{prepared:structuredClone(h.prepared),receipt,resourceGrant:g} satisfies OneProviderReadSnapshot,stillCurrent};
 }
 async readOperation(access:OneProviderReadAccess,commandId:string,operationId:string):Promise<OneProviderReadSnapshot>{try{return(await this.held(access,commandId,operationId,'status')).snapshot;}catch(e){throw e instanceof OneProviderError?e:new OneProviderError('provider_route_unavailable')}}
 /** Same fresh storage/options projection can carry a separately granted retained operation.
  * Historical quote/action/generation remain immutable; they do not enable prepare/execute. */
 async bootstrap(access:OneProviderReadAccess,commandId:string,operationId:string|null=null):Promise<OneProviderReadProjection&{stillCurrent():boolean}>{
  try{const o=this.p.origin(access);if(!o)deny();const loaded=await this.p.storageProjection?.(access,commandId);if(!loaded)deny();const v=structuredClone(loaded.projection),b=v.binding;
   const fresh=()=>{const current=this.p.origin(access);return !!current&&oneVaultDigest(current)===oneVaultDigest(o)&&loaded.stillCurrent()&&v.expiresAt>this.now()};
   if(!b||v.commandId!==commandId||b.commandId!==commandId||v.bindingKey!==oneVaultDigest(b)||b.principalId!==o.principalId||b.sessionId!==o.sessionId||b.workspaceId!==o.workspaceId||b.hostId!==o.hostId||!v.pinnedHost||v.pinnedHost.hostId!==b.hostId||this.p.approvedSigningKey(b.hostId,v.pinnedHost.hostKeyId)!==v.pinnedHost.publicKey||!fresh())deny();validateOneVaultBinding(b);if(v.pinnedHost.trustGeneration!==b.trustGeneration||v.credentialGeneration!==null&&v.credentialGeneration!==b.expectedGeneration||!Number.isSafeInteger(v.observedAt)||v.observedAt>this.now()+5000||v.observedAt<this.now()-30000)deny();
   const id=operationId??(v.activeOperation&&this.p.media.getMediaOperation(v.activeOperation.operationId)?v.activeOperation.operationId:null);if(!id){if(v.receipt)deny('operation_conflict');return {projection:{...v,resourceGrant:null},resourceGrant:null,stillCurrent:fresh};}
   const h=await this.held(access,commandId,id,'status');if(!fresh()||!h.stillCurrent()||oneVaultDigest(h.snapshot.resourceGrant.currentBinding)!==oneVaultDigest(b))deny();
   return {projection:{...v,resourceGrant:h.snapshot.resourceGrant,activeOperation:h.snapshot.prepared,receipt:h.snapshot.receipt,state:h.snapshot.receipt.state==='audio_ready'?'audio-ready':h.snapshot.receipt.state==='verified'?'verified':h.snapshot.receipt.state==='outcome_unknown'?'outcome-unknown':v.state},resourceGrant:h.snapshot.resourceGrant,stillCurrent:()=>fresh()&&h.stillCurrent()};
  }catch(e){throw e instanceof OneProviderError?e:new OneProviderError('provider_route_unavailable')}
 }
 /** Owned verified bytes stay native. Desktop player or separately approved encrypted transfer consumes them under the returned lease. */
 async acquireAudio(access:OneProviderReadAccess,commandId:string,operationId:string,receiptDigest:string):Promise<{snapshot:OneProviderReadSnapshot;bytes:Uint8Array;stillCurrent():boolean}>{try{return await this.audio(access,commandId,operationId,receiptDigest)}catch(e){throw e instanceof OneProviderError?e:new OneProviderError('provider_route_unavailable')}}
 private async audio(access:OneProviderReadAccess,commandId:string,operationId:string,receiptDigest:string):Promise<{snapshot:OneProviderReadSnapshot;bytes:Uint8Array;stillCurrent():boolean}> {
  const held=await this.held(access,commandId,operationId,'audio-acquisition'),{receipt:r,resourceGrant:g}=held.snapshot,a=r.audio;
  if(r.state!=='audio_ready'||!a||oneVaultDigest(r)!==receiptDigest)deny('audio_invalid');
  const root=this.p.approvedArtifactRoot?.(access,Object.freeze(held.h),Object.freeze(g));if(!root||!path.isAbsolute(root)||realpathSync(root)!==path.resolve(root)||!held.stillCurrent())deny();
  if(a.mime!=='audio/wav'||a.container!=='wav'||a.codec!=='pcm_s16le'||a.sampleRate!==24000||a.channels!==1||!/^[a-f0-9]{64}$/.test(a.sha256))deny('audio_invalid');
  const folder=path.join(root,'.one-provider-'+sha(operationId)),expected=path.join(folder,a.sha256+'.wav'),media=this.p.media.getMediaOperation(operationId);
  if(!media?.result||media.result.path!==expected||media.result.sha256!==a.sha256||realpathSync(folder)!==folder||lstatSync(folder).isSymbolicLink())deny('audio_invalid');
  const file=await fs.open(expected,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer|undefined;
  try{const stat=await file.stat();if(!stat.isFile()||stat.size!==a.sizeBytes||stat.size>32*1024*1024)deny('audio_invalid');bytes=await file.readFile();}finally{await file.close();}
  try{verifyOneWav(bytes);if(sha(bytes)!==a.sha256||a.artifactId!==`one-audio:${sha(operationId)}:${a.sha256}`||bytes.length!==a.sizeBytes||(bytes.length-44)/2!==a.decodedSamples||Math.round(a.decodedSamples*1000/24000)!==a.durationMs||!held.stillCurrent())deny('audio_invalid');return {snapshot:held.snapshot,bytes,stillCurrent:held.stillCurrent};}catch(e){bytes.fill(0);throw e;}
 }
}
