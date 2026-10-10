import {OneVaultError,type OneVaultBinding} from '../../shared/one-vault';
import {oneVaultDigest,verifyOneVault} from './one-vault-crypto';
import {oneVaultSlot} from './one-vault-journal';
import type {OneVaultRuntime,OneVaultRuntimeAnchor,OneVaultNativeIntent,OneVaultPendingKeyRequest,OneVaultOwnerWindow} from './one-vault-runtime';
/** Required authoritative source. No missing realm/provider/account field is inferred. */
export interface OneVaultPersonalSource {
 scope:'personal';organizationId:null;principalId:string;sessionId:string;workspaceId:string;
 resourceId:string;payerId:string;providerWorkspace:string;region:'global'|'eu'|'in'|'sg';
 accountLabel:string;sourceRevision:string;
}
export interface OneVaultPersonalConsentInput {
 commandId:string;runId:string;anchorDigest:string;pendingDigest:string;ownerDigest:string;hostDigest:string;
 source:OneVaultPersonalSource;sourceDigest:string;toolId:'elevenlabs-audio';envKey:'ELEVENLABS_API_KEY';
 storage:'os-vault';operations:['store'];cost:null;
}
/** Stored only in parent's existing original-command consent registry. No second queue/table here. */
export interface OneVaultPersonalConsent {
 input:OneVaultPersonalConsentInput;nativeReceiptId:string;revision:string;permissionRevision:string;revoked:boolean;
}
export interface OneVaultScopedConsumerReceipt {
 commandId:string;toolId:string;keyName:string;requestDigest:string;slotId:string;credentialRef:string;
 generation:number;principalId:string;sessionId:string;workspaceId:string;hostId:string;installationRevision:string;
}
export interface OneVaultPersonalAdapterPorts {
 /** Main known-window identity, never an arbitrary BrowserWindow id or caller boolean. */
 isNativeOwnerWindow(window:OneVaultOwnerWindow):boolean;
 currentSource(anchor:Readonly<OneVaultRuntimeAnchor>,pending:Readonly<OneVaultPendingKeyRequest>|null):OneVaultPersonalSource|null;
 confirmStorage(window:OneVaultOwnerWindow,disclosure:Readonly<OneVaultPersonalConsentInput>):Promise<boolean>;
 /** The parent owns durable receipt, atomic original-command CAS and native consent audit. */
 consent:{current(commandId:string):OneVaultPersonalConsent|null;approveExact(input:Readonly<OneVaultPersonalConsentInput>,expectedRevision:string|null):OneVaultPersonalConsent|null};
 /** Installed scoped native consumer registry. An absent consumer is not readiness. */
 consumer?:{current(commandId:string,toolId:string,keyName:string):OneVaultScopedConsumerReceipt|null};
}
/** Main-only adapter fragments to compose into the SINGLE existing RuntimePolicy.
 * It installs no policy by itself and grants no provider read/dispatch/publish or paid action.
 * The parent must also bind the existing live personal OneActionAuthorityPort. */
export class OneVaultPersonalAdapter {
 constructor(private readonly runtime:OneVaultRuntime,private readonly p:OneVaultPersonalAdapterPorts){}
 private disclosure(commandId:string):OneVaultPersonalConsentInput|null {
  try{
   const r=this.runtime,anchor=r.anchor(commandId),owner=r.currentNativeOwner(),host=r.trust.currentHostMetadata();
   if(!anchor||!owner||!host)return null;
   const pending=r.sources.pendingRunKeyElicitation(anchor.runId),source=this.p.currentSource(Object.freeze(anchor),pending?Object.freeze(structuredClone(pending)):null);
   if(!pending||pending.runId!==anchor.runId||pending.requestId!==anchor.runId||pending.expiresAt<=(r.sources.now?.()??Date.now())
    ||!pending.tools.some(t=>t.id==='elevenlabs-audio'&&t.envKeys.some(e=>e.key==='ELEVENLABS_API_KEY'))
    ||!source||source.scope!=='personal'||source.organizationId!==null||source.principalId!==owner.principalId||source.sessionId!==owner.sessionId||source.workspaceId!==owner.workspaceId
    ||!['global','eu','in','sg'].includes(source.region)||![source.resourceId,source.payerId,source.providerWorkspace,source.accountLabel,source.sourceRevision].every(v=>typeof v==='string'&&v.length>0&&v.length<=512))return null;
   return{commandId,runId:anchor.runId,anchorDigest:oneVaultDigest(anchor),pendingDigest:oneVaultDigest(pending),ownerDigest:oneVaultDigest(owner),hostDigest:oneVaultDigest(host),source:structuredClone(source),sourceDigest:oneVaultDigest(source),toolId:'elevenlabs-audio',envKey:'ELEVENLABS_API_KEY',storage:'os-vault',operations:['store'],cost:null};
  }catch{return null;}
 }
 private current(commandId:string):OneVaultPersonalConsent|null {
  try{const input=this.disclosure(commandId),record=this.p.consent.current(commandId);
   return input&&record&&!record.revoked&&record.nativeReceiptId&&record.revision&&record.permissionRevision&&oneVaultDigest(input)===oneVaultDigest(record.input)?structuredClone(record):null;
  }catch{return null;}
 }
 /** Called by a trusted Main owner action before opening the dedicated form. No caller scope/key data. */
 async approveOriginalPending(window:OneVaultOwnerWindow,runId:string):Promise<{state:'approved';commandId:string}> {
  const validWindow=()=>!window.isDestroyed()&&window.isFocused()&&this.p.isNativeOwnerWindow(window);
  if(!validWindow())throw new OneVaultError('authority_denied');
  const rows=this.runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(this.runtime.sources.oneId(),runId) as Array<{command_id:string}>;
  const input=rows.length===1?this.disclosure(rows[0].command_id):null;if(!input)throw new OneVaultError('authority_unavailable');
  const prior=this.p.consent.current(input.commandId),expectedRevision=prior?.revision??null;
  if(!await this.p.confirmStorage(window,Object.freeze(structuredClone(input)))||!validWindow()||oneVaultDigest(this.disclosure(input.commandId))!==oneVaultDigest(input))throw new OneVaultError('authority_denied');
  const record=this.p.consent.approveExact(Object.freeze(structuredClone(input)),expectedRevision);
  if(!record||!validWindow()||oneVaultDigest(this.current(input.commandId))!==oneVaultDigest(record))throw new OneVaultError('revision_changed');
  return{state:'approved',commandId:input.commandId};
 }
 currentIntent=(anchor:Readonly<OneVaultRuntimeAnchor>,pending:Readonly<OneVaultPendingKeyRequest>|null):OneVaultNativeIntent|null=>{
  const record=this.current(anchor.commandId);if(!record||!pending||oneVaultDigest(anchor)!==record.input.anchorDigest||oneVaultDigest(pending)!==record.input.pendingDigest)return null;
  const i=record.input,s=i.source;
  return{intentDigest:oneVaultDigest([i,record.nativeReceiptId]),pendingRequestDigest:i.pendingDigest,principalId:s.principalId,sessionId:s.sessionId,toolId:i.toolId,envKey:i.envKey,accountLabel:s.accountLabel,scope:'personal',organizationId:null,workspaceId:s.workspaceId,resourceId:s.resourceId,purpose:'store-credential',payerId:s.payerId,provider:'elevenlabs-audio',providerWorkspace:s.providerWorkspace,region:s.region,operations:['store'],permissionRevision:record.permissionRevision,authorityRevision:record.revision,replyAuthorityRevision:anchor.replyAuthorityRevision,cost:null};
 };
 currentGrant=async(binding:Readonly<OneVaultBinding>,phase:string):Promise<{decision:'allow'|'deny'|'unknown';revision:string;stillCurrent:()=>boolean}>=>{
  if(!['decrypt','store','commit','reconcile'].includes(phase))return{decision:'deny',revision:'',stillCurrent:()=>false};
  const record=this.current(binding.commandId);
  if(!record||record.revision!==binding.authorityRevision||record.permissionRevision!==binding.permissionRevision)return{decision:'unknown',revision:'',stillCurrent:()=>false};
  const digest=oneVaultDigest(record);return{decision:'allow',revision:record.revision,stillCurrent:()=>oneVaultDigest(this.current(binding.commandId))===digest};
 };
 consumerReady=(commandId:string,toolId:string,keyName:string):boolean=>{
  try{
   if(toolId!=='elevenlabs-audio'||keyName!=='ELEVENLABS_API_KEY'||!this.p.consumer||!this.current(commandId))return false;
   const r=this.runtime,context=r.resolveCommand(commandId),m=r.metadata.read(commandId),host=r.trust.currentHostMetadata(),owner=r.currentNativeOwner();
   if(!context||!m?.operationId||!host||!owner||!verifyOneVault('request',m.request,host.signingPublicKey))return false;
   const op=r.journal.get(m.operationId),slotId=oneVaultSlot(m.request),slot=r.journal.current(slotId),receipt=this.p.consumer.current(commandId,toolId,keyName);
   if(!op||op.state!=='saved'||op.requestDigest!==oneVaultDigest(m.request)||op.slotId!==slotId||slot.pendingOperation!==null||slot.generation!==op.generation||slot.credentialRef!==op.credentialRef||context.binding.expectedGeneration!==op.generation||!receipt?.installationRevision)return false;
   const expected={commandId,toolId,keyName,requestDigest:op.requestDigest,slotId,credentialRef:op.credentialRef,generation:op.generation,principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,hostId:owner.hostId,installationRevision:receipt.installationRevision};
   return oneVaultDigest(receipt)===oneVaultDigest(expected);
  }catch{return false;}
 };
}
