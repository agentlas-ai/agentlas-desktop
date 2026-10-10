import {oneVaultSlot} from './one-vault-journal';
import {OneVaultError} from '../../shared/one-vault';
import {OneProviderError,type OneProviderAction,type OneProviderReceipt} from '../../shared/one-provider';
import {oneVaultDigest,signOneVault,verifyOneVault} from './one-vault-crypto';
import {loadOneVaultApprovedHost} from './one-vault-service';
import {OneProviderRuntime,type OneProviderRuntimePorts} from './one-provider-runtime';
import type {OneProviderLease} from './one-provider-broker';
import {OneVaultRuntime,type OneVaultRuntimeAnchor} from './one-vault-runtime';
/** Value-free native action record, minted by the existing Supervisor after current scope/cost consent. */
export interface OneProviderNativeAction {
 operationId:string;commandId:string;vaultRequestDigest:string;currentBindingDigest:string;
 kind:'verify'|'tts';modelId:string;voiceId:string;outputFormat:'pcm_24000';textDigest:string;textRef:string;
 artifactRootRef:string;minDurationMs:number;maxDurationMs:number;expiresAt:number;enableProviderLogging:boolean;
}
export interface OneProviderNativeRegistry {
 current(operationId:string):OneProviderNativeAction|null;
 readText(ref:string,anchor:Readonly<OneVaultRuntimeAnchor>):Promise<string>;
 approvedArtifactRoot(ref:string,anchor:Readonly<OneVaultRuntimeAnchor>):string|null;
 /** Existing live quote/provider/grant registry only. No absent cost or unknown Business policy fallback. */
 currentGrant(action:Readonly<OneProviderAction>,phase:'read'|'dispatch'|'publish'):Promise<{decision:'allow'|'deny'|'unknown';lease:OneProviderLease|null}>;
}
/** No IPC/key-read API. Root wires executeMainOperation only to a native minted action id. */
export class OneProviderNativeBridge {
 constructor(private readonly vault:OneVaultRuntime,private readonly registry:OneProviderNativeRegistry,private readonly factory:(ports:OneProviderRuntimePorts)=>Pick<OneProviderRuntime,'executeMainOperation'>=ports=>new OneProviderRuntime(ports)){}
 private action(id:string):OneProviderAction|null{
  try{const record=this.registry.current(id);if(!record||record.operationId!==id)return null;
   const context=this.vault.resolveCommand(record.commandId),reference=this.vault.currentStoredReference(record.commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'),
    metadata=reference?this.vault.metadata.read(reference.request.binding.commandId):this.vault.metadata.read(record.commandId),host=this.vault.trust.currentHostMetadata();
   if(metadata?.request.binding.commandId!==record.commandId&&(!reference||!reference.stillCurrent()||metadata?.operationId!==reference.operationId||oneVaultDigest(metadata.request)!==oneVaultDigest(reference.request)||!context||context.binding.expectedGeneration!==reference.generation||oneVaultSlot({binding:{...metadata.request.binding,...context.binding}} as import('../../shared/one-vault').OneVaultRequest)!==reference.slotId))return null;
   if(!context||!metadata||!host||oneVaultDigest(metadata.request)!==record.vaultRequestDigest||oneVaultDigest(context.binding)!==record.currentBindingDigest||metadata.request.hostKeyId!==host.hostKeyId||metadata.request.binding.hostId!==host.hostId||metadata.request.binding.trustGeneration!==host.generation)return null;
   const operation=metadata.operationId?this.vault.journal.get(metadata.operationId):null;if(!operation||operation.state!=='saved'||operation.requestDigest!==record.vaultRequestDigest||operation.generation!==context.binding.expectedGeneration)return null;
   const binding={...metadata.request.binding,...context.binding};
   return{schema:'agentlas.one-provider.v1',operationId:id,kind:record.kind,binding,credentialGeneration:operation.generation,modelId:record.modelId,voiceId:record.voiceId,outputFormat:record.outputFormat,textDigest:record.textDigest,minDurationMs:record.minDurationMs,maxDurationMs:record.maxDurationMs,expiresAt:record.expiresAt,enableProviderLogging:record.enableProviderLogging};
  }catch{return null;}
 }
 async executeMainOperation(operationId:string):Promise<OneProviderReceipt>{
  const action=this.action(operationId),record=this.registry.current(operationId);if(!action||!record)throw new OneProviderError('authority_unavailable');
  const host=await loadOneVaultApprovedHost(this.vault.sources.hostIdentity().hostId,this.vault.trust,this.vault.sources.vault);
  const stillCurrent=()=>{try{return oneVaultDigest(this.action(operationId))===oneVaultDigest(action)&&oneVaultDigest(this.registry.current(operationId))===oneVaultDigest(record)&&oneVaultDigest(this.vault.trust.currentHostMetadata())===oneVaultDigest(host.metadata);}catch{return false;}};
  if(!stillCurrent())throw new OneProviderError('authority_denied');
  const ports:OneProviderRuntimePorts={journal:this.vault.journal,vault:{readSecret:r=>this.vault.sources.vault.readSecret(r)},now:this.vault.sources.now,currentAction:id=>id===operationId&&stillCurrent()?action:null,
   currentDecision:async(a,phase)=>{try{const domain=await this.vault.authority(a.binding,`provider-${phase}`),reference=this.vault.currentStoredReference(record.commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'),readLease=reference?await reference.authorizeRead?.():null;if(reference&&!readLease)return{decision:'unknown',lease:null};const decision=await this.registry.currentGrant(Object.freeze(structuredClone(a)),phase);if(decision.decision!=='allow'||!decision.lease)return decision;const lease=decision.lease;return{decision:'allow',lease:{...lease,stillCurrent:()=>domain.stillCurrent()&&(!reference||!!readLease?.stillCurrent())&&lease.stillCurrent()&&stillCurrent()}};}catch(error){return{decision:error instanceof OneVaultError&&['authority_denied','revision_changed','generation_conflict'].includes(error.code)?'deny':'unknown',lease:null};}},
   text:async id=>{if(id!==operationId||!stillCurrent())throw new OneProviderError('authority_denied');const anchor=this.vault.anchor(record.commandId);if(!anchor)throw new OneProviderError('authority_denied');const value=await this.registry.readText(record.textRef,Object.freeze(anchor));if(!stillCurrent()||oneVaultDigest(this.vault.anchor(record.commandId))!==oneVaultDigest(anchor))throw new OneProviderError('authority_denied');return value;},
   approvedMediaPath:a=>{if(a.operationId!==operationId||!stillCurrent())return null;const anchor=this.vault.anchor(record.commandId);return anchor?this.registry.approvedArtifactRoot(record.artifactRootRef,Object.freeze(anchor)):null;},
   authenticateReceipt:r=>{if(oneVaultDigest(this.vault.trust.currentHostMetadata())!==oneVaultDigest(host.metadata)||(['verified','audio_ready'].includes(r.state)&&!stillCurrent())||r.operationId!==operationId||r.actionDigest!==oneVaultDigest(action))throw new OneProviderError('authority_denied');return signOneVault('receipt',{...r,hostKeyId:host.metadata.hostKeyId,signature:''},host.signingKey);},
   verifyReceipt:r=>stillCurrent()&&r.hostKeyId===host.metadata.hostKeyId&&verifyOneVault('receipt',r,host.metadata.signingPublicKey)};
  return this.factory(ports).executeMainOperation(operationId);
 }
}
let bridge:OneProviderNativeBridge|null=null;
export function configureOneProviderNativeBridge(vault:OneVaultRuntime,registry:OneProviderNativeRegistry):OneProviderNativeBridge{if(bridge)throw new OneProviderError('authority_unavailable');bridge=new OneProviderNativeBridge(vault,registry);return bridge;}
export function currentOneProviderNativeBridge():OneProviderNativeBridge|null{return bridge;}
