import {oneVaultDigest,verifyOneVault} from './one-vault-crypto';
import {oneVaultSlot} from './one-vault-journal';
import {authorizeSupervisorNativeOrigin} from '../one/supervisor-native-runtime';
import type {OnePersonalNativeOriginal} from './one-personal-native-entry';
import type {OneVaultRuntime} from './one-vault-runtime';
import type {OnePersonalNativeMainOwnerPorts,OnePersonalNativeAccountChoice} from './one-personal-native-main-owner';
import type {OnePersonalNativeProviderSelectionOwner} from './one-personal-native-owners';
/** Read-only metadata catalog. Never reads a secret, admits a grant, or enrolls trust.
 * A prior signed personal storage request is a candidate, not current read permission. */
export function createOnePersonalNativeSavedAccountCatalog(runtime:OneVaultRuntime){
 const candidates=new Map<string,{handle:object;choice:OnePersonalNativeAccountChoice;selection:NonNullable<ReturnType<OnePersonalNativeProviderSelectionOwner['current']>>;proof:string}>();
 function snapshot(original:Readonly<OnePersonalNativeOriginal>){
  authorizeSupervisorNativeOrigin(original.origin,original.request);const owner=runtime.currentNativeOwner(),host=runtime.trust.currentHostMetadata();
  if(!owner||!host||owner.hostId!==host.hostId||!original.request.runId)return[];
  const rows=runtime.sources.db.prepare("SELECT command_id,one_vault_metadata_json FROM one_supervisor_requests WHERE one_id=? AND one_vault_metadata_json IS NOT NULL").all(runtime.sources.oneId()) as Array<{command_id:string;one_vault_metadata_json:string}>;
  return rows.flatMap(row=>{try{
   const m=JSON.parse(row.one_vault_metadata_json),request=m.request,b=request.binding,op=m.operationId&&runtime.journal.get(m.operationId);
   if(!op||op.state!=='saved'||op.action!=='store'||op.requestDigest!==oneVaultDigest(request)||op.requestId!==b.requestId||op.generation!==op.expectedGeneration+1||b.expectedGeneration!==op.expectedGeneration||b.commandId!==row.command_id||b.scope!=='personal'||b.organizationId!==null||b.principalId!==owner.principalId||b.sessionId!==owner.sessionId||b.workspaceId!==owner.workspaceId||b.hostId!==owner.hostId||b.provider!=='elevenlabs-audio'||b.storage!=='os-vault'||b.purpose!=='store-credential'||b.cost!==null||oneVaultDigest(b.operations)!==oneVaultDigest(['store'])||b.payerId!==owner.principalId||b.trustGeneration!==host.generation||request.hostKeyId!==host.hostKeyId||request.recipientKeyId!==host.recipientKeyId||!verifyOneVault('request',request,host.signingPublicKey))return[];
   const slotId=oneVaultSlot(request),slot=runtime.journal.current(slotId);if(op.slotId!==slotId||slot.pendingOperation!==null||slot.generation!==op.generation||slot.credentialRef!==op.credentialRef)return[];
   if(!['global','eu','in','sg'].includes(b.region)||typeof b.providerWorkspace!=='string'||!b.providerWorkspace)return[];
   const proof=oneVaultDigest([owner,host,m,op,slot]),key=op.operationId;
   return[{key,proof,workspace:b.providerWorkspace as string,region:b.region as 'global'|'eu'|'in'|'sg',label:b.providerWorkspace as string}];
  }catch{return[]}});
 }
 const accounts:NonNullable<OnePersonalNativeMainOwnerPorts['accounts']>={current(original){try{return snapshot(original).slice(0,16).map(value=>{
  const current=()=>{try{return snapshot(original).some(row=>row.key===value.key&&row.proof===value.proof)}catch{return false}};
  const prior=candidates.get(value.key);if(prior?.proof===value.proof)return prior.choice;
  const handle=Object.freeze({}),revision='saved-account:'+value.proof,selection=Object.freeze({provider:'elevenlabs-audio' as const,providerWorkspace:value.workspace,region:value.region,accountLabel:value.label,revision,stillCurrent:current}),choice=Object.freeze({handle,label:value.label+' / '+value.workspace+' / '+value.region,stillCurrent:current});
  candidates.set(value.key,{handle,selection,choice,proof:value.proof});return choice;
 })}catch{return[]}}};
 const providerSelections:OnePersonalNativeProviderSelectionOwner={current(handle){for(const row of candidates.values())if(row.handle===handle&&row.selection.stillCurrent())return row.selection;return null}};
 return Object.freeze({accounts,providerSelections});
}
