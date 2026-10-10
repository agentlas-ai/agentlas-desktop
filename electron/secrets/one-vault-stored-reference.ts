import {verify} from 'node:crypto';
import {oneVaultCanonical,type OneVaultRequest} from '../../shared/one-vault';
import {oneVaultDigest,verifyOneVault,oneVaultPublicKey,decodeOneVaultBase64} from './one-vault-crypto';
import {oneVaultSlot} from './one-vault-journal';
import type {OneVaultRuntime} from './one-vault-runtime';
import type {OneVaultPersonalAdapterPorts,OneVaultScopedConsumerReceipt} from './one-vault-personal-adapter';
/** Main-only handle issued after the native producer verifies its original/source/ACL,
 * signed reference admission and actual scoped consumer installation. Never a DTO. */
export interface OneVaultStoredReferenceProof {readonly kind:'one-vault-stored-reference'}
export interface OneVaultStoredReferenceReadAuthority {
 authorizeCredentialRead(binding:Readonly<OneVaultScopedConsumerReceipt>):Promise<{decision:'allow'|'deny'|'unknown';bindingDigest:string;revision:string;stillCurrent():boolean}>;
}
export interface OneVaultStoredReferenceLease {
 readonly commandId:string;readonly request:Readonly<OneVaultRequest>;readonly operationId:string;
 readonly slotId:string;readonly credentialRef:string;readonly generation:number;readonly installationRevision:string;
 stillCurrent():boolean;
 authorizeRead?():Promise<{stillCurrent():boolean}|null>;
}
const proofs=new WeakMap<object,{runtime:OneVaultRuntime;lease:OneVaultStoredReferenceLease}>();
export function inspectOneVaultStoredReference(runtime:OneVaultRuntime,proof:OneVaultStoredReferenceProof|null):OneVaultStoredReferenceLease|null {
 const held=proof&&proofs.get(proof);return held?.runtime===runtime&&held.lease.stillCurrent()?held.lease:null;
}
/** Construction is inert. The consumer port MUST be the genuine owner's
 * activePorts.consumer, not a boolean key-present or consumer-ready adapter. */
export function createOneVaultStoredReferenceBridge(runtime:OneVaultRuntime,consumer:NonNullable<OneVaultPersonalAdapterPorts['consumer']>,readAuthority?:OneVaultStoredReferenceReadAuthority){
 function snapshot(commandId:string,toolId:string,keyName:string){
  try{
   if(toolId!=='elevenlabs-audio'||keyName!=='ELEVENLABS_API_KEY'||runtime.metadata.read(commandId)?.operationId)return null;
   const anchor=runtime.anchor(commandId),owner=runtime.currentNativeOwner(),host=runtime.trust.currentHostMetadata();
   if(!anchor||!owner||!host||owner.hostId!==host.hostId)return null;
   const installed=consumer.current(commandId,toolId,keyName);if(!installed||!installed.installationRevision)return null;
   const pending=runtime.sources.pendingRunKeyElicitation(anchor.runId);
   if(pending&&(pending.requestId!==anchor.runId||pending.runId!==anchor.runId||pending.expiresAt<=(runtime.sources.now?.()??Date.now())||!pending.tools.some(t=>t.id===toolId&&t.envKeys.some(k=>k.key===keyName))))return null;
   const row=runtime.sources.db.prepare('SELECT id,owner_json,metadata_digest,disclosure_json,revoked_at FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get('personal-vault-reference:'+commandId) as {id:string;owner_json:string;metadata_digest:string;disclosure_json:string;revoked_at:number|null}|undefined;
   if(!row||row.revoked_at!==null)return null;const value=JSON.parse(row.disclosure_json),{signature,...body}=value;
   if(value.schema!=='agentlas.one-personal-reference-consent.v1'||value.id!==row.id||value.commandId!==commandId||value.anchorDigest!==oneVaultDigest(anchor)||oneVaultDigest(value)!==row.metadata_digest||oneVaultDigest(value.owner)!==oneVaultDigest(owner)||oneVaultDigest(JSON.parse(row.owner_json))!==oneVaultDigest(owner)||value.hostKeyId!==host.hostKeyId||value.trustGeneration!==host.generation
    ||!verify('sha256',Buffer.from(oneVaultCanonical(['personal-reference-consent',body])),{key:oneVaultPublicKey(host.signingPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64)))return null;
   const ref=value.reference,source=value.source,op=ref&&runtime.journal.get(ref.operationId),m=ref&&runtime.metadata.read(ref.priorCommandId);
   if(!op||!m||m.operationId!==op.operationId||op.state!=='saved'||op.action!=='store'||op.generation!==op.expectedGeneration+1||op.requestDigest!==oneVaultDigest(m.request)||!verifyOneVault('request',m.request,host.signingPublicKey))return null;
   const b=m.request.binding,slotId=oneVaultSlot(m.request),slot=runtime.journal.current(slotId);
   if(oneVaultDigest(ref)!==oneVaultDigest({slotId,operationId:op.operationId,requestDigest:op.requestDigest,priorCommandId:b.commandId,credentialRef:op.credentialRef,generation:op.generation})||slot.pendingOperation!==null||slot.generation!==op.generation||slot.credentialRef!==op.credentialRef||b.expectedGeneration!==op.expectedGeneration||b.requestId!==op.requestId||op.slotId!==slotId
    ||b.scope!=='personal'||b.organizationId!==null||b.principalId!==owner.principalId||b.workspaceId!==owner.workspaceId||b.hostId!==host.hostId||b.trustGeneration!==host.generation||m.request.hostKeyId!==host.hostKeyId||m.request.recipientKeyId!==host.recipientKeyId||b.provider!==toolId||b.storage!=='os-vault'
    ||source.scope!=='personal'||source.organizationId!==null||source.principalId!==owner.principalId||source.sessionId!==owner.sessionId||source.workspaceId!==owner.workspaceId||source.resourceId!==b.resourceId||source.providerWorkspace!==b.providerWorkspace||source.region!==b.region)return null;
   const exact={commandId,toolId,keyName,requestDigest:op.requestDigest,slotId,credentialRef:op.credentialRef,generation:op.generation,principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,hostId:owner.hostId,installationRevision:installed.installationRevision};
   if(oneVaultDigest(installed)!==oneVaultDigest(exact))return null;
   return{anchor,owner,host,pending,installed,row,op,m,slot,exact};
  }catch{return null;}
 }
 return Object.freeze({current(commandId:string,toolId:string,keyName:string):OneVaultStoredReferenceProof|null{
  const state=snapshot(commandId,toolId,keyName);if(!state)return null;const digest=oneVaultDigest(state);
  const stillCurrent=()=>oneVaultDigest(snapshot(commandId,toolId,keyName))===digest;
  const authorizeRead=readAuthority?async()=>{if(!stillCurrent())return null;const grant=await readAuthority.authorizeCredentialRead(Object.freeze(structuredClone(state.installed)));const allowed=()=>stillCurrent()&&grant.decision==='allow'&&typeof grant.revision==='string'&&grant.revision.length>0&&grant.revision.length<=512&&grant.bindingDigest===oneVaultDigest(state.installed)&&grant.stillCurrent();return allowed()?{stillCurrent:allowed}:null}:undefined;
  const lease:OneVaultStoredReferenceLease=Object.freeze({commandId,request:structuredClone(state.m.request),operationId:state.op.operationId,slotId:state.op.slotId,credentialRef:state.op.credentialRef,generation:state.op.generation,installationRevision:state.installed.installationRevision,stillCurrent,authorizeRead});
  const proof=Object.freeze({kind:'one-vault-stored-reference' as const});proofs.set(proof,{runtime,lease});return proof;
 }});
}

/** Exact existing producer contract. No renderer-supplied scope/approval is accepted. */
export interface OneVaultStoredReferenceOwner {
 policy:import('./one-vault-runtime').OneVaultRuntimePolicy;
 activePorts:OneVaultPersonalAdapterPorts;
 /** Same installed consumer owner's current read authority; absent blocks Provider key reads. */
 readAuthority?:OneVaultStoredReferenceReadAuthority;
 admitStoredReference(window:import('./one-vault-runtime').OneVaultOwnerWindow,commandId:string):Promise<unknown>;
 installScopedConsumer(commandId:string):Promise<unknown>;
}
/** Main-native wiring only. Constructor does not invoke approval or install a reader. */
export function composeOneVaultStoredReferenceOwner(runtime:OneVaultRuntime,owner:OneVaultStoredReferenceOwner){
 const consumer=owner.activePorts.consumer;if(!consumer)return null;
 const bridge=createOneVaultStoredReferenceBridge(runtime,consumer,owner.readAuthority);
 return Object.freeze({policy:{...owner.policy,currentStoredReference:bridge.current},
  async approveOriginalReference(window:import('./one-vault-runtime').OneVaultOwnerWindow,runId:string):Promise<{commandId:string;runId:string}>{
   const allowed=()=>!window.isDestroyed()&&window.isFocused()&&owner.activePorts.isNativeOwnerWindow(window);
   const pending=runtime.sources.pendingRunKeyElicitation(runId),rows=runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runtime.sources.oneId(),runId) as Array<{command_id:string}>;
   const commandId=rows.length===1?rows[0].command_id:null,anchor=commandId&&runtime.anchor(commandId),principal=runtime.currentNativeOwner();
   if(!allowed()||!commandId||!anchor||anchor.runId!==runId||!principal||!pending||pending.runId!==runId||pending.requestId!==runId||pending.expiresAt<=(runtime.sources.now?.()??Date.now())||!pending.tools.length||!pending.tools.every(t=>t.id==='elevenlabs-audio'&&t.envKeys.length>0&&t.envKeys.every(k=>k.key==='ELEVENLABS_API_KEY')))throw new Error('one_vault_reference_owner_unavailable');
   const identity=oneVaultDigest([anchor,principal,pending]);
   const current=()=>allowed()&&oneVaultDigest([runtime.anchor(commandId),runtime.currentNativeOwner(),runtime.sources.pendingRunKeyElicitation(runId)])===identity;
   await owner.admitStoredReference(window,commandId);if(!current())throw new Error('one_vault_reference_owner_changed');
   await owner.installScopedConsumer(commandId);
   if(!current()||!inspectOneVaultStoredReference(runtime,bridge.current(commandId,'elevenlabs-audio','ELEVENLABS_API_KEY')))throw new Error('one_vault_reference_installation_unconfirmed');
   return{commandId,runId};
  }});
}
