/** Main-only personal Vault owner: original native capability, existing Page ACL and focused consent. */
import {randomUUID,sign,verify} from 'node:crypto';
import {BrowserWindow,dialog} from 'electron';
import type {OneOriginalMcpTransportOwners} from '../one/one-original-mcp-credential';
import type {McpInvocationRequest,InstalledMcpServer} from '../../shared/types';
import type {PersonalDataTarget} from '../../shared/one-personal-data';
import type {OneActionAuthorityPort,OneActionAuthorityRequest} from '../../shared/one-authority';
import {OneVaultError,oneVaultCanonical,type OneVaultRequest} from '../../shared/one-vault';
import {currentOnePersonalNativeOriginal} from './one-personal-native-entry';
import {authorizeSupervisorNativeOrigin} from '../one/supervisor-native-runtime';
import {personalDataTarget,personalDataHash} from '../one/personal-data-store';
import {oneVaultDigest,verifyOneVault,oneVaultPublicKey,decodeOneVaultBase64} from './one-vault-crypto';
import {loadOneVaultApprovedHost} from './one-vault-service';
import type {OneVaultNativeOwner} from './one-vault-native-trust';
import {oneVaultSlot} from './one-vault-journal';
import {OneVaultPersonalAdapter,type OneVaultPersonalAdapterPorts,type OneVaultPersonalConsent,type OneVaultPersonalConsentInput,type OneVaultPersonalSource,type OneVaultScopedConsumerReceipt} from './one-vault-personal-adapter';
import {inspectOnePersonalScopedConsumerOwner} from './one-personal-native-scoped-consumer';
import {createOneVaultStoredReferenceBridge,inspectOneVaultStoredReference,type OneVaultStoredReferenceProof} from './one-vault-stored-reference';
import type {OneVaultRuntime,OneVaultRuntimeAnchor,OneVaultOwnerWindow,OneVaultRuntimePolicy,OneVaultPendingKeyRequest} from './one-vault-runtime';
export type OnePersonalNativeResourceTarget=PersonalDataTarget|{kind:'ordinary-one-room';deploymentId:string;oneId:string;scope:'personal';organizationId:null;projectId:null;audience:'owner';chatId:string};
export interface OnePersonalNativeProviderSelectionOwner {
 /** Actual native opaque provider-account selection; never a caller label/JSON. */
 current(handle:object):Readonly<{provider:'elevenlabs-audio';providerWorkspace:string;region:'global'|'eu'|'in'|'sg';accountLabel:string;revision:string;stillCurrent():boolean}>|null;
}
export interface OnePersonalNativeConsumerInstallation {current():OneVaultScopedConsumerReceipt|null;revoke():void}
export interface OnePersonalNativeConsumerOwner {
 /** Actual original-run tool owner installs an exact scoped reader, not a global env key. */
 authorizeCredentialRead(binding:Readonly<OneVaultScopedConsumerReceipt>):Promise<{decision:'allow'|'deny'|'unknown';bindingDigest:string;revision:string;stillCurrent():boolean}>;
 /** Owner cleanup acknowledgment after a lost installation reply; false/absent remains unknown. */
 clearInstallation?(binding:Readonly<OneVaultScopedConsumerReceipt>):boolean;
 install(binding:Readonly<OneVaultScopedConsumerReceipt>,read:(consume:(secret:string)=>Promise<void>)=>Promise<void>):Promise<OnePersonalNativeConsumerInstallation>;
}
export interface OnePersonalNativeOwnerPorts {
 lifetime:{readonly signal:AbortSignal;ready():boolean;currentEpoch():number};
 isNativeOwnerWindow(window:OneVaultOwnerWindow):boolean;
 providerSelections:OnePersonalNativeProviderSelectionOwner|null;
 consumer:OnePersonalNativeConsumerOwner|null;
 invalidateProviderReadiness:OneVaultRuntimePolicy['invalidateProviderReadiness'];
}
interface Registration {origin:object;request:Readonly<McpInvocationRequest>;anchor:OneVaultRuntimeAnchor;target:OnePersonalNativeResourceTarget;selection:object;pending:OneVaultPendingKeyRequest;source:OneVaultPersonalSource;pageRevision:number;pageDigest:string;ownerDigest:string;epoch:number;closed:boolean}
interface StoredConsent {schema:'agentlas.one-personal-native-consent.v1';record:OneVaultPersonalConsent;target:OnePersonalNativeResourceTarget;pageRevision:number;pageDigest:string;owner:OneVaultNativeOwner;hostKeyId:string;trustGeneration:number;expectedRevision:string|null;signature:string}
function deny(code:'authority_unavailable'|'authority_denied'|'revision_changed'|'generation_conflict'='authority_denied'):never{throw new OneVaultError(code)}
const valid=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f]/.test(v);
const immutable=<T>(v:T):Readonly<T>=>Object.freeze(structuredClone(v));
interface NativeOwnerEvidence {runtime:OneVaultRuntime;current():Readonly<{anchor:OneVaultRuntimeAnchor;source:OneVaultPersonalSource;target:OnePersonalNativeResourceTarget;pageRevision:number;pageDigest:string;owner:OneVaultNativeOwner|null;host:NonNullable<ReturnType<OneVaultRuntime['trust']['currentHostMetadata']>>}>;window(w:BrowserWindow):boolean;cleanupConfirmed():boolean}
const nativeOwnerEvidence=new WeakMap<object,NativeOwnerEvidence>();
/** Inert construction. No table, queue, IPC, grant, key read or native dialog is created here. */
export function createOnePersonalNativeOwners(runtime:OneVaultRuntime,p:OnePersonalNativeOwnerPorts){
 const registrations=new Map<string,Registration>(),confirmations=new Map<string,{inputDigest:string;registration:Registration;epoch:number;value:StoredConsent}>(),installing=new Set<string>(),installations=new Map<string,{owner:OnePersonalNativeConsumerInstallation;binding:OneVaultScopedConsumerReceipt;registration:Registration}>();
 let closed=false,cleanupUnknown=false;
 const refs=[p.lifetime,p.isNativeOwnerWindow,p.providerSelections,p.consumer,p.invalidateProviderReadiness];
 function live(){if(closed||cleanupUnknown||[p.lifetime,p.isNativeOwnerWindow,p.providerSelections,p.consumer,p.invalidateProviderReadiness].some((v,i)=>v!==refs[i])||!p.lifetime.ready()||p.lifetime.signal.aborted)deny('authority_unavailable');return p.lifetime.currentEpoch();}
 function targetState(target:OnePersonalNativeResourceTarget,original?:{origin:object;request:Readonly<McpInvocationRequest>}){
  const owner=runtime.currentNativeOwner();if(!owner||target.scope!=='personal'||target.organizationId!==null||target.projectId!==null||target.audience!=='owner'||target.oneId!==runtime.sources.oneId()||target.deploymentId!==owner.hostId)deny();
  if('kind' in target){
   if(target.kind!=='ordinary-one-room'||!original||Object.keys(target).sort().join('|')!=='audience|chatId|deploymentId|kind|oneId|organizationId|projectId|scope')deny();
   authorizeSupervisorNativeOrigin(original.origin,original.request);if(target.chatId!==original.request.chatId||!original.request.runId)deny();
   const row=runtime.sources.db.prepare("SELECT rowid AS revision,* FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind='reply'").get(target.oneId,original.request.runId) as {command_id:string;origin_chat_id:string;user_message_id:string|null;payload_json:string;payload_hash:string;revision:number}|undefined;
   const anchor=row&&runtime.anchor(row.command_id),admission=runtime.sources.admission(original.request.runId),payload=row&&JSON.parse(row.payload_json);
   const message=row?.user_message_id&&runtime.sources.db.prepare('SELECT id,chat_id,role FROM chat_messages WHERE id=?').get(row.user_message_id) as {id:string;chat_id:string;role:string}|undefined;
   if(!row||!anchor||anchor.chatId!==target.chatId||row.origin_chat_id!==target.chatId||payload?.text!==original.request.userPrompt||payload?.ordinaryNative?.inputDigest!==admission?.inputDigest||admission?.status!=='admitted'||!message||message.id!==row.user_message_id||message.chat_id!==target.chatId||message.role!=='user')deny('authority_unavailable');
   return{revision:row.revision,digest:oneVaultDigest([target,anchor,admission.inputDigest,row.user_message_id,row.payload_hash]),owner};
  }
  const db=runtime.sources.db,key=personalDataHash(target),acl=db.prepare('SELECT target_json,principal_id FROM one_personal_data_acl WHERE target_key=?').get(key) as {target_json:string;principal_id:string}|undefined;
  if(!acl||acl.principal_id!==owner.principalId||personalDataHash(JSON.parse(acl.target_json))!==key)deny();
  const current=db.prepare('SELECT target_json,current_revision FROM one_personal_data_pages WHERE target_key=?').get(key) as {target_json:string;current_revision:number}|undefined;
  const row=current&&db.prepare('SELECT value_json FROM one_personal_data_revisions WHERE target_key=? AND revision=?').get(key,current.current_revision) as {value_json:string}|undefined;
  if(!current||!row||personalDataHash(JSON.parse(current.target_json))!==key)deny();const page=JSON.parse(row.value_json);
  if(page.revision!==current.current_revision||personalDataHash(page.target)!==key||page.digest!==personalDataHash({target:page.target,revision:page.revision,title:page.title,blocks:page.blocks,acceptedAnchor:page.acceptedAnchor,origin:page.origin}))deny();
  return{revision:current.current_revision,digest:page.digest as string,owner};
 }
 function currentRegistration(commandId:string,mode:'entry'|'consumer'='entry'):Registration {
  const epoch=live(),r=registrations.get(commandId);if(!r||r.closed||epoch!==r.epoch)deny('authority_unavailable');authorizeSupervisorNativeOrigin(r.origin,r.request);
  const anchor=runtime.anchor(commandId),pending=runtime.sources.pendingRunKeyElicitation(r.anchor.runId),page=targetState(r.target,r),selection=p.providerSelections?.current(r.selection);
  if(oneVaultDigest(anchor)!==oneVaultDigest(r.anchor)||oneVaultDigest(page.owner)!==r.ownerDigest||page.revision!==r.pageRevision||page.digest!==r.pageDigest
    ||(pending?oneVaultDigest(pending)!==oneVaultDigest(r.pending):mode!=='consumer')
    ||!selection||!selection.stillCurrent()||selection.provider!=='elevenlabs-audio'||selection.providerWorkspace!==r.source.providerWorkspace||selection.region!==r.source.region||selection.accountLabel!==r.source.accountLabel||selection.revision!==r.source.sourceRevision)deny('revision_changed');return r;
 }
 function latest(commandId:string){
  const row=runtime.sources.db.prepare('SELECT id,owner_json,metadata_digest,disclosure_json,revoked_at FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get('personal-vault-consent:'+commandId) as {id:string;owner_json:string;metadata_digest:string;disclosure_json:string;revoked_at:number|null}|undefined;
  if(!row)return null;const value=JSON.parse(row.disclosure_json) as StoredConsent;if(value.schema!=='agentlas.one-personal-native-consent.v1'||value.record.nativeReceiptId!==row.id||value.record.input.commandId!==commandId)deny('revision_changed');const host=runtime.trust.currentHostMetadata(),{signature,...body}=value;
  if(!host||value.hostKeyId!==host.hostKeyId||value.trustGeneration!==host.generation||oneVaultDigest(value)!==row.metadata_digest||oneVaultDigest(value.owner)!==oneVaultDigest(JSON.parse(row.owner_json))||oneVaultDigest(value.owner)!==oneVaultDigest(runtime.currentNativeOwner())
   ||!verify('sha256',Buffer.from(oneVaultCanonical(['personal-storage-consent',body])),{key:oneVaultPublicKey(host.signingPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64)))deny('revision_changed');return{...row,value};
 }
 function record(commandId:string):OneVaultPersonalConsent|null{const row=latest(commandId);return row?{...structuredClone(row.value.record),revoked:row.revoked_at!==null}:null;}
 function assertInput(input:Readonly<OneVaultPersonalConsentInput>,mode:'entry'|'consumer'='entry'){
  const r=currentRegistration(input.commandId,mode),host=runtime.trust.currentHostMetadata(),pending=runtime.sources.pendingRunKeyElicitation(r.anchor.runId)??(mode==='consumer'?r.pending:null);
  if(!host||input.runId!==r.anchor.runId||input.toolId!=='elevenlabs-audio'||input.envKey!=='ELEVENLABS_API_KEY'||input.storage!=='os-vault'||input.cost!==null||oneVaultDigest(input.operations)!==oneVaultDigest(['store'])
    ||input.anchorDigest!==oneVaultDigest(r.anchor)||input.ownerDigest!==r.ownerDigest||input.pendingDigest!==oneVaultDigest(pending)||input.hostDigest!==oneVaultDigest(host)||input.sourceDigest!==oneVaultDigest(r.source)||oneVaultDigest(input.source)!==oneVaultDigest(r.source))deny('revision_changed');return r;
 }
 function currentConsent(commandId:string,mode:'entry'|'consumer'='entry'){const r=currentRegistration(commandId,mode),c=record(commandId);if(!c||c.revoked)deny('authority_unavailable');assertInput(c.input,mode);const stored=latest(commandId)!;if(personalDataHash(stored.value.target)!==personalDataHash(r.target)||stored.value.pageRevision!==r.pageRevision||stored.value.pageDigest!==r.pageDigest)deny('revision_changed');return{r,c};}
 const activePorts:OneVaultPersonalAdapterPorts={
  isNativeOwnerWindow:w=>{try{live();return p.isNativeOwnerWindow(w)}catch{return false}},
  currentSource:(anchor,pending)=>{try{const r=currentRegistration(anchor.commandId);return pending&&oneVaultDigest(anchor)===oneVaultDigest(r.anchor)?structuredClone(r.source):null}catch{return null}},
  confirmStorage:async(window,input)=>{
   const r=assertInput(input),epoch=live(),native=BrowserWindow.fromId(window.id);if(native!==window||window.isDestroyed()||!window.isFocused()||!p.isNativeOwnerWindow(window))deny();
   const id=randomUUID(),inputDigest=oneVaultDigest(input),expectedRevision=latest(input.commandId)?.value.record.revision??null;confirmations.delete(input.commandId);
   const response=await dialog.showMessageBox(native,{type:'question',title:'One 개인 키 저장 확인',message:'이 원래 요청에만 사용할 키를 저장할까요?',detail:`계정: ${r.source.accountLabel}\n범위: 개인 / 소유자\n호스트: ${runtime.currentNativeOwner()!.hostId}\n원래 리소스: ${'kind' in r.target?r.target.chatId:r.target.pageId}\n원래 작업: ${r.anchor.taskId} / ${r.anchor.runId}\n제공자: elevenlabs-audio / ${r.source.region} / ${r.source.providerWorkspace}\n권한: 이 요청의 키 저장\n저장소: OS Vault\n지금 비용: 없음. 제공자 확인·사용 비용은 별도로 승인합니다.`,buttons:['취소','저장 입력으로 이동'],defaultId:0,cancelId:0,noLink:true});
   if(response.response!==1)return false;if(native!==BrowserWindow.fromId(window.id)||window.isDestroyed()||!window.isFocused()||!p.isNativeOwnerWindow(window)||live()!==epoch||assertInput(input)!==r)deny('revision_changed');
   const host=await loadOneVaultApprovedHost(runtime.currentNativeOwner()!.hostId,runtime.trust,runtime.sources.vault);
   if(!window.isFocused()||!p.isNativeOwnerWindow(window)||live()!==epoch||assertInput(input)!==r||(latest(input.commandId)?.value.record.revision??null)!==expectedRevision)deny('revision_changed');
   const c:OneVaultPersonalConsent={input:structuredClone(input),nativeReceiptId:id,revision:'native-personal-consent:'+id,permissionRevision:'native-personal-permission:'+id,revoked:false};
   const body={schema:'agentlas.one-personal-native-consent.v1' as const,record:c,target:structuredClone(r.target),pageRevision:r.pageRevision,pageDigest:r.pageDigest,owner:runtime.currentNativeOwner()!,hostKeyId:host.metadata.hostKeyId,trustGeneration:host.metadata.generation,expectedRevision};
   const value:StoredConsent={...body,signature:sign('sha256',Buffer.from(oneVaultCanonical(['personal-storage-consent',body])),{key:host.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
   confirmations.set(input.commandId,{inputDigest,registration:r,epoch,value});return true;
  },
  consent:{current:record,approveExact:(input,expectedRevision)=>runtime.sources.db.transaction(()=>{
   const r=assertInput(input),confirmation=confirmations.get(input.commandId);confirmations.delete(input.commandId);
   if(!confirmation||confirmation.registration!==r||confirmation.epoch!==live()||confirmation.inputDigest!==oneVaultDigest(input))deny();
   const prior=latest(input.commandId);if((prior?.value.record.revision??null)!==expectedRevision)deny('generation_conflict');
   const value=confirmation.value,c=value.record,id=c.nativeReceiptId;if(value.expectedRevision!==expectedRevision)deny('generation_conflict');
   runtime.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,'personal-vault-consent:'+input.commandId,JSON.stringify(value.owner),oneVaultDigest(value),JSON.stringify(value),runtime.sources.now?.()??Date.now());
   assertInput(input);if(oneVaultDigest(record(input.commandId))!==oneVaultDigest(c))deny('revision_changed');return c;
  }).immediate()},
  consumer:{current:(commandId,toolId,keyName)=>{try{const current=savedBinding(commandId),installed=installations.get(commandId);if(!installed||toolId!=='elevenlabs-audio'||keyName!=='ELEVENLABS_API_KEY'||installed.registration!==current.r||oneVaultDigest({...current.binding,installationRevision:installed.binding.installationRevision})!==oneVaultDigest(installed.binding))return null;const actual=installed.owner.current();return actual&&oneVaultDigest(actual)===oneVaultDigest(installed.binding)?structuredClone(actual):null}catch{return null}}},
 };
 const adapter=new OneVaultPersonalAdapter(runtime,activePorts);
 const personal:OneActionAuthorityPort={current:(q:Readonly<OneActionAuthorityRequest>)=>{try{if(q.action==='provider-read'){
   const current=readState(q.sourceRefs[0]);if(!current||q.principalId!==current.r.source.principalId||q.sessionId!==current.r.source.sessionId||q.workspaceId!==current.r.source.workspaceId||q.hostId!==runtime.currentNativeOwner()?.hostId||q.scope!=='personal'||q.organizationId!==null||q.projectId!==null||q.audience!=='owner'||q.oneId!==current.r.anchor.oneId||q.taskId!==current.r.anchor.taskId||q.runId!==current.r.anchor.runId||q.controlVersion!==current.r.anchor.controlVersion||q.resourceId!==current.r.source.resourceId||q.payerId!==current.r.source.payerId||q.purpose!==current.intent.purpose||q.permissionRevision!==current.intent.permissionRevision)return{decision:'deny',revision:'',reason:'one_personal_native_exact_read_source_required'};
   return{decision:'allow',revision:current.intent.authorityRevision,reason:'native_original_installed_read_source'};
  }
const {r,c}=currentConsent(q.sourceRefs[0],q.action==='vault-reconcile'?'consumer':'entry'),owner=runtime.currentNativeOwner()!;
  if(!['vault-decrypt','vault-store','vault-commit','vault-reconcile'].includes(q.action)||q.scope!=='personal'||q.organizationId!==null||q.projectId!==null||q.audience!=='owner'||q.principalId!==owner.principalId||q.sessionId!==owner.sessionId||q.workspaceId!==owner.workspaceId||q.hostId!==owner.hostId||q.oneId!==r.anchor.oneId||q.taskId!==r.anchor.taskId||q.runId!==r.anchor.runId||q.controlVersion!==r.anchor.controlVersion||q.resourceId!==r.source.resourceId||q.purpose!=='store-credential'||q.payerId!==r.source.payerId||q.permissionRevision!==c.permissionRevision)return{decision:'deny',revision:'',reason:'one_personal_native_exact_scope_required'};
  return{decision:'allow',revision:c.revision,reason:'current_focused_native_storage_consent'};
 }catch{return{decision:'unknown',revision:'',reason:'one_personal_native_source_or_consent_unbound'}}}};
 // Only an exact current saved slot retains the original signed intent after elicitation.
 function retainedIntent(anchor:Readonly<OneVaultRuntimeAnchor>){try{
  const {r,c}=currentConsent(anchor.commandId,'consumer'),m=runtime.metadata.read(anchor.commandId),host=runtime.trust.currentHostMetadata();
  if(!m?.operationId||!host||oneVaultDigest(anchor)!==oneVaultDigest(r.anchor)||!verifyOneVault('request',m.request,host.signingPublicKey))return null;
  const op=runtime.journal.get(m.operationId),b=m.request.binding,slotId=oneVaultSlot(m.request),slot=runtime.journal.current(slotId),i=c.input,s=i.source;
  const expectedIntent=oneVaultDigest([r.anchor.payloadHash,oneVaultDigest([i,c.nativeReceiptId]),r.anchor.custodyDigest]);
  if(!op||op.state!=='saved'||op.action!=='store'||op.requestDigest!==oneVaultDigest(m.request)||op.slotId!==slotId||op.generation!==op.expectedGeneration+1||slot.pendingOperation!==null||slot.generation!==op.generation||slot.credentialRef!==op.credentialRef||b.commandId!==anchor.commandId||b.intentDigest!==expectedIntent||b.principalId!==s.principalId||b.sessionId!==s.sessionId||b.workspaceId!==s.workspaceId||b.hostId!==runtime.currentNativeOwner()?.hostId||b.resourceId!==s.resourceId||b.providerWorkspace!==s.providerWorkspace||b.region!==s.region||b.authorityRevision!==c.revision||b.permissionRevision!==c.permissionRevision)return null;
  return{intentDigest:oneVaultDigest([i,c.nativeReceiptId]),pendingRequestDigest:i.pendingDigest,principalId:s.principalId,sessionId:s.sessionId,toolId:i.toolId,envKey:i.envKey,accountLabel:s.accountLabel,scope:'personal' as const,organizationId:null,workspaceId:s.workspaceId,resourceId:s.resourceId,purpose:'store-credential',payerId:s.payerId,provider:'elevenlabs-audio' as const,providerWorkspace:s.providerWorkspace,region:s.region,operations:['store'] as ['store'],permissionRevision:c.permissionRevision,authorityRevision:c.revision,replyAuthorityRevision:anchor.replyAuthorityRevision,cost:null};
 }catch{return null}}
 function referenceIntent(anchor:Readonly<OneVaultRuntimeAnchor>){try{
  const {r}=referenceBinding(anchor.commandId);if(oneVaultDigest(anchor)!==oneVaultDigest(r.anchor))return null;
  const row=runtime.sources.db.prepare('SELECT id FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get('personal-vault-reference:'+anchor.commandId) as {id:string}|undefined;if(!row)return null;
  const s=r.source;return{intentDigest:oneVaultDigest(['personal-reference-read',row.id,r.anchor,r.source]),pendingRequestDigest:oneVaultDigest(r.pending),principalId:s.principalId,sessionId:s.sessionId,toolId:'elevenlabs-audio',envKey:'ELEVENLABS_API_KEY',accountLabel:s.accountLabel,scope:'personal' as const,organizationId:null,workspaceId:s.workspaceId,resourceId:s.resourceId,purpose:'provider-credential-read',payerId:s.payerId,provider:'elevenlabs-audio' as const,providerWorkspace:s.providerWorkspace,region:s.region,operations:['source-read'],permissionRevision:'reference-read:'+row.id,authorityRevision:'reference-consent:'+row.id,replyAuthorityRevision:anchor.replyAuthorityRevision,cost:null};
 }catch{return null}}
 function readState(commandId:string){try{const r=currentRegistration(commandId,'consumer'),original=currentOnePersonalNativeOriginal();if(!original||original.origin!==r.origin||original.request.runId!==r.anchor.runId)return null;const intent=retainedIntent(r.anchor)??referenceIntent(r.anchor),receipt=activePorts.consumer!.current(commandId,'elevenlabs-audio','ELEVENLABS_API_KEY');return intent&&receipt?{r,intent,receipt}:null}catch{return null}}
 async function readGrant(binding:Readonly<import('../../shared/one-vault').OneVaultBinding>){const state=readState(binding.commandId);if(!state||!p.consumer||state.intent.authorityRevision!==binding.authorityRevision||state.intent.permissionRevision!==binding.permissionRevision)return{decision:'unknown' as const,revision:'',stillCurrent:()=>false};const digest=oneVaultDigest(state.receipt),grant=await p.consumer.authorizeCredentialRead(immutable(state.receipt));const current=()=>{try{const now=readState(binding.commandId);return !!now&&oneVaultDigest(now.receipt)===digest&&now.intent.authorityRevision===binding.authorityRevision&&now.intent.permissionRevision===binding.permissionRevision&&grant.decision==='allow'&&valid(grant.revision)&&grant.bindingDigest===digest&&grant.stillCurrent()}catch{return false}};if(!current())return{decision:'unknown' as const,revision:'',stillCurrent:()=>false};return{decision:'allow' as const,revision:binding.authorityRevision,stillCurrent:current}}
 const policy:OneVaultRuntimePolicy={currentIntent:(anchor,pending)=>pending?(adapter.currentIntent(anchor,pending)??referenceIntent(anchor)):(retainedIntent(anchor)??referenceIntent(anchor)),currentGrant:async(binding,phase)=>{if(phase==='provider-read')return readGrant(binding);if(phase!=='reconcile'||runtime.sources.pendingRunKeyElicitation(binding.runId))return adapter.currentGrant(binding,phase);try{const current=()=>{const {c}=currentConsent(binding.commandId,'consumer');if(!retainedIntent(runtime.anchor(binding.commandId)!)||c.revision!==binding.authorityRevision||c.permissionRevision!==binding.permissionRevision)deny();return c};const c=current(),digest=oneVaultDigest(c);return{decision:'allow',revision:c.revision,stillCurrent:()=>{try{return oneVaultDigest(current())===digest}catch{return false}}}}catch{return{decision:'unknown',revision:'',stillCurrent:()=>false}}},personal,invalidateProviderReadiness:p.invalidateProviderReadiness};
 function registerOriginal(origin:object,request:Readonly<McpInvocationRequest>,targetInput:OnePersonalNativeResourceTarget,providerSelection:object){
  const epoch=live();authorizeSupervisorNativeOrigin(origin,request);if(!request.oneMode||!request.runId)deny();if(!p.providerSelections||!p.consumer)deny('authority_unavailable');
  const rows=runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runtime.sources.oneId(),request.runId) as Array<{command_id:string}>;
  const anchor=rows.length===1?runtime.anchor(rows[0].command_id):null;if(!anchor||anchor.chatId!==request.chatId)deny();
  const target='kind' in targetInput?immutable(targetInput):personalDataTarget(targetInput),page=targetState(target,{origin,request}),selection=p.providerSelections.current(providerSelection);
  if(!selection||selection.provider!=='elevenlabs-audio'||!selection.stillCurrent()||!['global','eu','in','sg'].includes(selection.region)||![selection.providerWorkspace,selection.accountLabel,selection.revision].every(valid))deny('authority_unavailable');
  const source:OneVaultPersonalSource={scope:'personal',organizationId:null,principalId:page.owner.principalId,sessionId:page.owner.sessionId,workspaceId:page.owner.workspaceId,resourceId:'kind' in target?`one-room:${target.chatId}`:`${target.spaceId}:${target.pageId}`,payerId:page.owner.principalId,providerWorkspace:selection.providerWorkspace,region:selection.region,accountLabel:selection.accountLabel,sourceRevision:selection.revision};
  const pending=runtime.sources.pendingRunKeyElicitation(anchor.runId);if(!pending||pending.runId!==anchor.runId||pending.requestId!==anchor.runId||!pending.tools.some(t=>t.id==='elevenlabs-audio'&&t.envKeys.some(k=>k.key==='ELEVENLABS_API_KEY')))deny('authority_unavailable');
  const next:Registration={origin,request:immutable(request),pending:structuredClone(pending),anchor:structuredClone(anchor),target,selection:providerSelection,source,pageRevision:page.revision,pageDigest:page.digest,ownerDigest:oneVaultDigest(page.owner),epoch,closed:false},prior=registrations.get(anchor.commandId);
  if(prior){if(prior.closed||prior.origin!==origin||oneVaultDigest([prior.request,prior.anchor,prior.target,prior.source])!==oneVaultDigest([next.request,next.anchor,next.target,next.source]))deny('generation_conflict');currentRegistration(anchor.commandId);return;}
  registrations.set(anchor.commandId,next);try{currentRegistration(anchor.commandId)}catch(error){next.closed=true;throw error;}
 }
 function savedBinding(commandId:string){
  const m=runtime.metadata.read(commandId);if(!m?.operationId)return referenceBinding(commandId);
  const {r,c}=currentConsent(commandId,'consumer'),owner=runtime.currentNativeOwner(),host=runtime.trust.currentHostMetadata(),context=runtime.resolveCommand(commandId);
  if(!owner||!host||runtime.sources.pendingRunKeyElicitation(r.anchor.runId)&&!context||!verifyOneVault('request',m.request,host.signingPublicKey))deny('authority_unavailable');
  const op=runtime.journal.get(m.operationId),slotId=oneVaultSlot(m.request),slot=runtime.journal.current(slotId);
  if(!op||op.state!=='saved'||op.action!=='store'||op.requestDigest!==oneVaultDigest(m.request)||op.slotId!==slotId||slot.pendingOperation!==null||slot.generation!==op.generation||slot.credentialRef!==op.credentialRef||context&&context.binding.expectedGeneration!==op.generation)deny('authority_unavailable');
  const b=m.request.binding,expectedIntent=oneVaultDigest([r.anchor.payloadHash,oneVaultDigest([c.input,c.nativeReceiptId]),r.anchor.custodyDigest]);
  if(b.commandId!==commandId||b.taskId!==r.anchor.taskId||b.runId!==r.anchor.runId||b.controlVersion!==r.anchor.controlVersion||b.intentDigest!==expectedIntent||b.principalId!==owner.principalId||b.sessionId!==owner.sessionId||b.workspaceId!==owner.workspaceId||b.hostId!==owner.hostId||b.resourceId!==r.source.resourceId||b.providerWorkspace!==r.source.providerWorkspace||b.region!==r.source.region||b.authorityRevision!==c.revision||b.permissionRevision!==c.permissionRevision)deny('revision_changed');
  return{r,m,op,binding:{commandId,toolId:'elevenlabs-audio',keyName:'ELEVENLABS_API_KEY',requestDigest:op.requestDigest,slotId,credentialRef:op.credentialRef,generation:op.generation,principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,hostId:owner.hostId} satisfies Omit<OneVaultScopedConsumerReceipt,'installationRevision'>};
 }
 /** Value-free historical reference. A successful lookup is presence, not current read admission. */
 function lookupStoredReference(commandId:string,mode:'entry'|'consumer'='entry'){
  const r=currentRegistration(commandId,mode),host=runtime.trust.currentHostMetadata(),owner=runtime.currentNativeOwner();if(!host||!owner)deny('authority_unavailable');
  const slotId=oneVaultSlot({binding:{scope:'personal',organizationId:null,principalId:r.source.principalId,workspaceId:r.source.workspaceId,resourceId:r.source.resourceId,provider:'elevenlabs-audio',providerWorkspace:r.source.providerWorkspace,region:r.source.region,storage:'os-vault'}} as OneVaultRequest),slot=runtime.journal.current(slotId);
  if(slot.pendingOperation!==null||!slot.credentialRef||slot.generation<1)return null;
  const row=runtime.sources.db.prepare("SELECT operationId FROM one_vault_operations WHERE slotId=? AND generation=? AND credentialRef=? AND state='saved' AND action='store'").get(slotId,slot.generation,slot.credentialRef) as {operationId:string}|undefined;
  const op=row&&runtime.journal.get(row.operationId);if(!op||op.generation!==op.expectedGeneration+1)return null;
  const rows=runtime.sources.db.prepare("SELECT command_id,one_vault_metadata_json FROM one_supervisor_requests WHERE one_id=? AND json_extract(one_vault_metadata_json,'$.operationId')=?").all(r.anchor.oneId,op.operationId) as Array<{command_id:string;one_vault_metadata_json:string}>;
  if(rows.length!==1)return null;const metadata=JSON.parse(rows[0].one_vault_metadata_json),request=metadata.request as OneVaultRequest,b=request.binding;
  if(op.requestDigest!==oneVaultDigest(request)||op.requestId!==b.requestId||op.expectedGeneration!==b.expectedGeneration||oneVaultSlot(request)!==slotId||b.commandId!==rows[0].command_id||b.scope!=='personal'||b.organizationId!==null||b.principalId!==owner.principalId||b.workspaceId!==owner.workspaceId||b.hostId!==owner.hostId||b.resourceId!==r.source.resourceId||b.provider!=='elevenlabs-audio'||b.providerWorkspace!==r.source.providerWorkspace||b.region!==r.source.region||b.storage!=='os-vault'||request.hostKeyId!==host.hostKeyId||request.recipientKeyId!==host.recipientKeyId||b.trustGeneration!==host.generation||!verifyOneVault('request',request,host.signingPublicKey))return null;
  return{r,metadata,op,reference:{slotId,operationId:op.operationId,requestDigest:op.requestDigest,priorCommandId:b.commandId,credentialRef:op.credentialRef,generation:op.generation}};
 }
 async function admitStoredReference(window:OneVaultOwnerWindow,commandId:string){
  const current=lookupStoredReference(commandId);if(!current)deny('authority_unavailable');const {r,reference}=current,epoch=live(),native=BrowserWindow.fromId(window.id);
  if(native!==window||window.isDestroyed()||!window.isFocused()||!p.isNativeOwnerWindow(window))deny();
  const id=randomUUID(),operation='personal-vault-reference:'+commandId,old=runtime.sources.db.prepare('SELECT id FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operation) as {id:string}|undefined;
  const response=await dialog.showMessageBox(native,{type:'question',title:'One 저장된 개인 키 사용 확인',message:'이 원래 요청에 저장된 키 참조를 연결할까요?',detail:`계정: ${r.source.accountLabel}\n범위: 개인 / 소유자\n원래 리소스: ${'kind' in r.target?r.target.chatId:r.target.pageId}\n원래 작업: ${r.anchor.taskId} / ${r.anchor.runId}\n제공자: elevenlabs-audio / ${r.source.region} / ${r.source.providerWorkspace}\n저장 버전: ${reference.generation}\n권한: 원래 요청 전용 키 읽기 연결\n키 재입력·새 저장 없음. 제공자 확인·유료 사용은 별도로 승인합니다.`,buttons:['취소','저장된 참조 연결'],defaultId:0,cancelId:0,noLink:true});
  if(response.response!==1)deny();
  const host=await loadOneVaultApprovedHost(runtime.currentNativeOwner()!.hostId,runtime.trust,runtime.sources.vault);
  if(native!==BrowserWindow.fromId(window.id)||window.isDestroyed()||!window.isFocused()||!p.isNativeOwnerWindow(window)||live()!==epoch||oneVaultDigest(lookupStoredReference(commandId)?.reference)!==oneVaultDigest(reference))deny('revision_changed');
  const body={schema:'agentlas.one-personal-reference-consent.v1' as const,id,commandId,anchorDigest:oneVaultDigest(r.anchor),source:structuredClone(r.source),target:structuredClone(r.target),pageRevision:r.pageRevision,pageDigest:r.pageDigest,owner:runtime.currentNativeOwner()!,reference,hostKeyId:host.metadata.hostKeyId,trustGeneration:host.metadata.generation,expectedReceiptId:old?.id??null};
  const value={...body,signature:sign('sha256',Buffer.from(oneVaultCanonical(['personal-reference-consent',body])),{key:host.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
  runtime.sources.db.transaction(()=>{
   const prior=runtime.sources.db.prepare('SELECT id FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operation) as {id:string}|undefined;
   if((prior?.id??null)!==value.expectedReceiptId||live()!==epoch||!window.isFocused()||!p.isNativeOwnerWindow(window)||oneVaultDigest(lookupStoredReference(commandId)?.reference)!==oneVaultDigest(reference))deny('generation_conflict');
   runtime.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,operation,JSON.stringify(value.owner),oneVaultDigest(value),JSON.stringify(value),runtime.sources.now?.()??Date.now());
   referenceBinding(commandId);
  }).immediate();return immutable(reference);
 }
 function referenceBinding(commandId:string){
  const current=lookupStoredReference(commandId,'consumer');if(!current)deny('authority_unavailable');const {r,reference,op,metadata}=current,owner=runtime.currentNativeOwner()!,host=runtime.trust.currentHostMetadata()!;
  const row=runtime.sources.db.prepare('SELECT id,owner_json,metadata_digest,disclosure_json,revoked_at FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get('personal-vault-reference:'+commandId) as {id:string;owner_json:string;metadata_digest:string;disclosure_json:string;revoked_at:number|null}|undefined;
  if(!row||row.revoked_at!==null)deny('authority_unavailable');const value=JSON.parse(row.disclosure_json),{signature,...body}=value;
  if(value.schema!=='agentlas.one-personal-reference-consent.v1'||value.id!==row.id||value.commandId!==commandId||value.anchorDigest!==oneVaultDigest(r.anchor)||oneVaultDigest(value.source)!==oneVaultDigest(r.source)||personalDataHash(value.target)!==personalDataHash(r.target)||value.pageRevision!==r.pageRevision||value.pageDigest!==r.pageDigest||oneVaultDigest(value.owner)!==oneVaultDigest(owner)||oneVaultDigest(JSON.parse(row.owner_json))!==oneVaultDigest(owner)||oneVaultDigest(value.reference)!==oneVaultDigest(reference)||value.hostKeyId!==host.hostKeyId||value.trustGeneration!==host.generation||oneVaultDigest(value)!==row.metadata_digest
   ||!verify('sha256',Buffer.from(oneVaultCanonical(['personal-reference-consent',body])),{key:oneVaultPublicKey(host.signingPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64)))deny('revision_changed');
  return{r,m:metadata,op,binding:{commandId,toolId:'elevenlabs-audio',keyName:'ELEVENLABS_API_KEY',requestDigest:reference.requestDigest,slotId:reference.slotId,credentialRef:reference.credentialRef,generation:reference.generation,principalId:owner.principalId,sessionId:owner.sessionId,workspaceId:owner.workspaceId,hostId:owner.hostId} satisfies Omit<OneVaultScopedConsumerReceipt,'installationRevision'>};
 }
 async function installScopedConsumer(commandId:string){
  const consumer=p.consumer;if(!consumer)deny('authority_unavailable');const saved=savedBinding(commandId),epoch=live(),prior=installations.get(commandId);
  if(prior){if(!activePorts.consumer!.current(commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'))deny('revision_changed');return immutable(prior.binding);}
  if(installing.has(commandId))deny('generation_conflict');installing.add(commandId);
  const binding={...saved.binding,installationRevision:'native-scoped-consumer:'+randomUUID()};
  const current=()=>{try{const latest=savedBinding(commandId);return live()===epoch&&latest.r===saved.r&&oneVaultDigest([latest.m,latest.op])===oneVaultDigest([saved.m,saved.op])}catch{return false}};
  let installed:OnePersonalNativeConsumerInstallation|null=null;try{
  installed=await consumer.install(immutable(binding),async consume=>{
   if(!current())deny('revision_changed');
   const grant=await consumer.authorizeCredentialRead(immutable(binding));
   const allowed=()=>current()&&grant.decision==='allow'&&valid(grant.revision)&&grant.bindingDigest===oneVaultDigest(binding)&&grant.stillCurrent();
   if(!allowed())deny('authority_unavailable');let raw:string|null=null,secret='';
   try{raw=await runtime.sources.vault.readSecret(saved.op.credentialRef);if(!allowed()||!raw)deny('revision_changed');const value=JSON.parse(raw);raw=null;
    if(value.schema!=='agentlas.one-vault-record.v1'||value.operationId!==saved.op.operationId||value.requestDigest!==saved.op.requestDigest||value.generation!==saved.op.generation||typeof value.value!=='string'||!value.value)deny();
    secret=value.value;value.value='';if(!allowed())deny('revision_changed');await consume(secret);if(!allowed())deny('revision_changed');
   }finally{raw=null;secret='';}
  });
  if(!current()||!installed||typeof installed.current!=='function'||typeof installed.revoke!=='function'||oneVaultDigest(installed.current())!==oneVaultDigest(binding))deny('revision_changed');
  installations.set(commandId,{owner:installed,binding,registration:saved.r});return immutable(binding);
  }catch(error){try{if(installed)installed.revoke();else if(consumer.clearInstallation?.(immutable(binding))!==true)cleanupUnknown=true}catch{cleanupUnknown=true}throw error}
  finally{installing.delete(commandId)}
 }
 function revokeOriginal(window:OneVaultOwnerWindow,commandId:string){
  live();const owner=runtime.currentNativeOwner(),r=registrations.get(commandId),native=BrowserWindow.fromId(window.id);
  if(!owner||!r||owner.principalId!==r.source.principalId||owner.workspaceId!==r.source.workspaceId||native!==window||window.isDestroyed()||!window.isFocused()||!p.isNativeOwnerWindow(window))deny();
  confirmations.delete(commandId);r.closed=true;
  const n=runtime.sources.db.prepare('UPDATE one_vault_native_approvals SET revoked_at=? WHERE operation_id IN (?,?) AND revoked_at IS NULL').run(runtime.sources.now?.()??Date.now(),'personal-vault-consent:'+commandId,'personal-vault-reference:'+commandId),installed=installations.get(commandId);
  try{installed?.owner.revoke();installations.delete(commandId)}catch{cleanupUnknown=true;deny('authority_unavailable')}return{revoked:Number(n.changes)};
 }
 function close(){closed=true;confirmations.clear();for(const r of registrations.values())r.closed=true;for(const [id,value] of installations)try{value.owner.revoke();installations.delete(id)}catch{cleanupUnknown=true}if(cleanupUnknown)deny('authority_unavailable');}
 function consumerReady(commandId:string,toolId:string,keyName:string){return activePorts.consumer!.current(commandId,toolId,keyName)!==null;}
 function stillCurrent(){try{live();return [...registrations.keys()].some(commandId=>{try{return !!currentRegistration(commandId,'consumer')}catch{return false}})}catch{return false}}
 const mcpCapabilities=new WeakMap<Registration,Map<string,{capability:OneOriginalMcpTransportOwners;current():boolean}>>();
 const nativeReceiver=p.consumer&&inspectOnePersonalScopedConsumerOwner(p.consumer),storedBridge=p.consumer&&createOneVaultStoredReferenceBridge(runtime,activePorts.consumer!,p.consumer);
 /** Same real registration, account source, and SAME installed reader. Presence
  * never creates endpoint/audience permission: independent native mapping is required. */
 function currentMcpOwners(original:Readonly<{origin:object;request:Readonly<McpInvocationRequest>}>,server:Readonly<InstalledMcpServer>):OneOriginalMcpTransportOwners|null{try{
  authorizeSupervisorNativeOrigin(original.origin,original.request);const matches=[...registrations.values()].filter(r=>r.origin===original.origin&&r.request.runId===original.request.runId);if(matches.length!==1||!nativeReceiver)return null;
  const r=currentRegistration(matches[0].anchor.commandId,'consumer'),receipt=activePorts.consumer!.current(r.anchor.commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'),use=receipt&&nativeReceiver.currentUse(receipt,server);
  if(!use||!use.stillCurrent()||use.scope!=='personal'||use.organizationId!==null||use.audience!=='owner'||use.resourceId!==r.source.resourceId||use.providerWorkspace!==r.source.providerWorkspace||use.region!==r.source.region)return null;
  const existing=mcpCapabilities.get(r)?.get(server.id);if(existing)return existing.current()?existing.capability:null;
  const installation=installations.get(r.anchor.commandId);if(!installation||!receipt)return null;
  const consumer=activePorts.consumer!,consumerCurrent=consumer.current,installationCurrent=installation.owner.current;
  const useCurrent=nativeReceiver.currentUse,receiver=nativeReceiver.receiver,receiverCurrent=receiver.current;
  const receiptDigest=oneVaultDigest(receipt),useCheck=use.stillCurrent,selectedServer=immutable(server);
  const check=()=>{try{const current=currentRegistration(r.anchor.commandId,'consumer');
   if(current!==r||installations.get(r.anchor.commandId)!==installation||installation.owner.current!==installationCurrent||activePorts.consumer!==consumer||consumer.current!==consumerCurrent||nativeReceiver.currentUse!==useCurrent||nativeReceiver.receiver!==receiver||receiver.current!==receiverCurrent||use.stillCurrent!==useCheck)return false;
   const now=consumerCurrent.call(consumer,r.anchor.commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'),actualUse=now&&useCurrent.call(nativeReceiver,now,selectedServer);
   return !!now&&oneVaultDigest(now)===receiptDigest&&actualUse===use&&useCheck.call(use);
  }catch{return false}};
  const lease=Object.freeze({owners:Object.freeze({stillCurrent:check})});
  const source=Object.freeze({current:(candidate:Readonly<{origin:object;request:Readonly<McpInvocationRequest>}>,anchor:Readonly<OneVaultRuntimeAnchor>,actual:OneVaultRuntime)=>candidate.origin===r.origin&&candidate.request.runId===r.anchor.runId&&actual===runtime&&oneVaultDigest(anchor)===oneVaultDigest(r.anchor)&&check()?lease:null});
  const credentialOwner=Object.freeze({current:(candidate:Readonly<{origin:object;request:Readonly<McpInvocationRequest>}>,anchor:Readonly<OneVaultRuntimeAnchor>,actualServer:Readonly<InstalledMcpServer>,envKey:string)=>source.current(candidate,anchor,runtime)&&envKey==='ELEVENLABS_API_KEY'&&actualServer.id===selectedServer.id&&useCurrent.call(nativeReceiver,receipt,actualServer)===use?use:null,consumer,storedReference:storedBridge?Object.freeze({current:storedBridge.current,inspect:(actual:OneVaultRuntime,proof:object)=>inspectOneVaultStoredReference(actual,proof as OneVaultStoredReferenceProof)}):undefined});
  const capability=Object.freeze({serverId:selectedServer.id,runtime,source,credentialOwner,receiver});
  if(!check())return null;let cache=mcpCapabilities.get(r);if(!cache){cache=new Map();mcpCapabilities.set(r,cache)}cache.set(selectedServer.id,{capability,current:check});return capability;
 }catch{return null}}
 const bundle=Object.freeze({policy,personal,activePorts,stillCurrent,registerOriginal,currentMcpOwners,lookupStoredReference:(commandId:string)=>{const found=lookupStoredReference(commandId);return found?immutable(found.reference):null},admitStoredReference,approveOriginalPending:adapter.approveOriginalPending.bind(adapter),consumerReady,installScopedConsumer,revokeOriginal,close});
 nativeOwnerEvidence.set(bundle,{runtime,window:w=>BrowserWindow.fromId(w.id)===w&&!w.isDestroyed()&&w.isFocused()&&p.isNativeOwnerWindow(w),cleanupConfirmed:()=>closed&&!cleanupUnknown&&installations.size===0&&installing.size===0,
  current:()=>{live();const rows=[...registrations.keys()].flatMap(id=>{try{return[currentRegistration(id,'consumer')]}catch{return[]}});if(rows.length!==1)deny('authority_unavailable');const r=rows[0],host=runtime.trust.currentHostMetadata();if(!host)deny('authority_unavailable');return immutable({anchor:r.anchor,source:r.source,target:r.target,pageRevision:r.pageRevision,pageDigest:r.pageDigest,owner:runtime.currentNativeOwner(),host});}});
 return bundle;
}

export interface OnePersonalNativeReauthorizationScope {readonly installationEpoch:number;readonly sessionDigest:string;readonly nativeOwnerDigest:string}
type PersonalNativeBundle=ReturnType<typeof createOnePersonalNativeOwners>;
interface PersonalNativeCapability {readonly scope:'personal';readonly personal:{readonly policy:OneVaultRuntimePolicy;readonly pendingConsent:{approveOriginalPending:PersonalNativeBundle['approveOriginalPending']};readonly credentialConsumer:PersonalNativeBundle['consumerReady'];readonly provider:null};readonly mobile:null;readonly providerReader:null;stillCurrent():boolean}
/** Main-owned source registry; construction/registration grants nothing. Provider/Mobile absent.
 * Existing-host signer preparation is separate; review/consume never read OS credentials. */
export function createOnePersonalNativeOwnerFactory(runtime:OneVaultRuntime,initial:PersonalNativeBundle){
 const initialEvidence=nativeOwnerEvidence.get(initial);if(!initialEvidence||initialEvidence.runtime!==runtime)deny('authority_unavailable');
 let activeBundle=initial,active=capability(initial),candidate:PersonalNativeBundle|null=null,closed=false;
 let signer:Awaited<ReturnType<typeof loadOneVaultApprovedHost>>|null=null,signerEvidence='';
 const receipts=new WeakMap<object,{id:string;scope:string;candidate:PersonalNativeBundle;evidence:string;window:BrowserWindow;prior:PersonalNativeCapability}>();
 function evidence(bundle:PersonalNativeBundle){const value=nativeOwnerEvidence.get(bundle);if(!value||value.runtime!==runtime)deny('authority_unavailable');return value;}
 function snapshot(bundle:PersonalNativeBundle){if(closed)deny('authority_unavailable');return evidence(bundle).current();}
 function capability(bundle:PersonalNativeBundle):PersonalNativeCapability{return Object.freeze({scope:'personal',personal:Object.freeze({policy:bundle.policy,pendingConsent:Object.freeze({approveOriginalPending:bundle.approveOriginalPending}),credentialConsumer:bundle.consumerReady,provider:null}),mobile:null,providerReader:null,stillCurrent:()=>{try{snapshot(bundle);return true}catch{return false}}});}
 function currentScope(scope:Readonly<OnePersonalNativeReauthorizationScope>){
  const session=runtime.sources.nativeSession(),owner=runtime.currentNativeOwner();
  if(closed||!session||!owner||!Number.isSafeInteger(scope.installationEpoch)||scope.installationEpoch<0||scope.sessionDigest!==oneVaultDigest(session)||scope.nativeOwnerDigest!==oneVaultDigest(owner))deny('revision_changed');return oneVaultDigest(scope);
 }
 function focused(window:BrowserWindow,bundle:PersonalNativeBundle){if(!evidence(bundle).window(window))deny('authority_denied');}
 function ready(){if(!candidate||candidate===activeBundle||!evidence(activeBundle).cleanupConfirmed())deny('authority_unavailable');snapshot(candidate);return candidate;}
 /** Existing native original-entry caller supplies genuine WeakMap origin + selected Page/provider. */
 function registerFreshOriginal(ports:OnePersonalNativeOwnerPorts,origin:object,request:Readonly<McpInvocationRequest>,target:OnePersonalNativeResourceTarget,selection:object){
  if(closed||candidate)deny('generation_conflict');if(!evidence(activeBundle).cleanupConfirmed())deny('authority_unavailable');
  const fresh=createOnePersonalNativeOwners(runtime,ports);try{fresh.registerOriginal(origin,request,target,selection);snapshot(fresh)}catch(error){fresh.close();throw error}candidate=fresh;signer=null;signerEvidence='';return fresh;
 }
 /** Separate explicit native approved-host step, not initialize/rotate/enroll or policy install. */
 async function prepareExistingHostSigner(window:BrowserWindow){
  const fresh=ready();focused(window,fresh);const before=oneVaultDigest(snapshot(fresh)),owner=runtime.currentNativeOwner()!;
  const host=await loadOneVaultApprovedHost(owner.hostId,runtime.trust,runtime.sources.vault);
  focused(window,fresh);if(ready()!==fresh||oneVaultDigest(snapshot(fresh))!==before||oneVaultDigest(host.metadata)!==oneVaultDigest(runtime.trust.currentHostMetadata()))deny('revision_changed');
  signer=host;signerEvidence=before;
 }
 const operation=()=>{const owner=runtime.currentNativeOwner();if(!owner)deny('authority_unavailable');return 'personal-vault-reauthorization:'+runtime.sources.oneId()+':'+owner.principalId;};
 function latest(){return runtime.sources.db.prepare('SELECT id,metadata_digest,disclosure_json,owner_json,revoked_at FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operation()) as {id:string;metadata_digest:string;disclosure_json:string;owner_json:string;revoked_at:number|null}|undefined;}
 function verifyReceipt(row:NonNullable<ReturnType<typeof latest>>,bundle:PersonalNativeBundle,scope:string){
  const value=JSON.parse(row.disclosure_json),{signature,...body}=value,host=runtime.trust.currentHostMetadata();
  if(!host||value.schema!=='agentlas.one-personal-reauthorization.v1'||value.id!==row.id||value.operation!==operation()||value.scopeDigest!==scope||value.evidenceDigest!==oneVaultDigest(snapshot(bundle))||value.hostKeyId!==host.hostKeyId||value.trustGeneration!==host.generation||oneVaultDigest(value.owner)!==oneVaultDigest(runtime.currentNativeOwner())||oneVaultDigest(JSON.parse(row.owner_json))!==oneVaultDigest(value.owner)||row.metadata_digest!==oneVaultDigest(value)
   ||!verify('sha256',Buffer.from(oneVaultCanonical(['personal-native-reauthorization',body])),{key:oneVaultPublicKey(host.signingPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64)))deny('revision_changed');return value;
 }
 async function reviewReauthorization(window:BrowserWindow,r:OneVaultRuntime,scope:Readonly<OnePersonalNativeReauthorizationScope>):Promise<object|null>{
  if(r!==runtime)deny('authority_denied');const scopeDigest=currentScope(scope),fresh=ready();focused(window,fresh);
  const disclosure=snapshot(fresh),evidenceDigest=oneVaultDigest(disclosure),prior=active,expectedId=latest()?.id??null;
  const signing=signer;if(!signing||signerEvidence!==evidenceDigest||oneVaultDigest(signing.metadata)!==oneVaultDigest(runtime.trust.currentHostMetadata()))deny('authority_unavailable');
  const response=await dialog.showMessageBox(window,{type:'question',title:'One 개인 권한 다시 승인',message:'현재 개인 원래 요청의 보안 입력 권한을 다시 승인할까요?',detail:`계정: ${disclosure.source.accountLabel}\n범위: 개인 / 소유자\n호스트: ${disclosure.owner!.hostId}\n원래 리소스: ${'kind' in disclosure.target?disclosure.target.chatId:disclosure.target.pageId}\n원래 작업: ${disclosure.anchor.taskId} / ${disclosure.anchor.runId}\n제공자: elevenlabs-audio / ${disclosure.source.region} / ${disclosure.source.providerWorkspace}\n현재 세션과 페이지·제공자 선택을 다시 확인합니다.\n키 저장·제공자 사용·유료 실행·기기 등록은 이 승인에 포함되지 않습니다.`,buttons:['취소','현재 권한 다시 승인'],defaultId:0,cancelId:0,noLink:true});
  if(response.response!==1)return null;
  focused(window,fresh);if(currentScope(scope)!==scopeDigest||ready()!==fresh||active!==prior||oneVaultDigest(snapshot(fresh))!==evidenceDigest||signer!==signing||oneVaultDigest(signing.metadata)!==oneVaultDigest(runtime.trust.currentHostMetadata()))deny('revision_changed');
  const id=randomUUID(),body={schema:'agentlas.one-personal-reauthorization.v1',id,operation:operation(),scopeDigest,evidenceDigest,owner:runtime.currentNativeOwner(),hostKeyId:signing.metadata.hostKeyId,trustGeneration:signing.metadata.generation,expectedId};
  const value={...body,signature:sign('sha256',Buffer.from(oneVaultCanonical(['personal-native-reauthorization',body])),{key:signing.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
  runtime.sources.db.transaction(()=>{
   focused(window,fresh);if(currentScope(scope)!==scopeDigest||ready()!==fresh||active!==prior||(latest()?.id??null)!==expectedId||oneVaultDigest(snapshot(fresh))!==evidenceDigest)deny('generation_conflict');
   runtime.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,operation(),JSON.stringify(value.owner),oneVaultDigest(value),JSON.stringify(value),runtime.sources.now?.()??Date.now());
   const row=latest();if(!row||row.id!==id)deny('generation_conflict');verifyReceipt(row,fresh,scopeDigest);
  }).immediate();
  const ticket=Object.freeze({});receipts.set(ticket,{id,scope:scopeDigest,candidate:fresh,evidence:evidenceDigest,window,prior});return ticket;
 }
 function consumeReauthorization(receipt:object,scope:Readonly<OnePersonalNativeReauthorizationScope>):PersonalNativeCapability|null{
  const held=receipts.get(receipt);receipts.delete(receipt);if(!held)deny('authority_denied');
  const fresh=held.candidate,next=capability(fresh);
  runtime.sources.db.transaction(()=>{
   focused(held.window,fresh);if(currentScope(scope)!==held.scope||ready()!==fresh||active!==held.prior||oneVaultDigest(snapshot(fresh))!==held.evidence)deny('revision_changed');
   const row=latest();if(!row||row.id!==held.id||row.revoked_at!==null)deny('generation_conflict');verifyReceipt(row,fresh,held.scope);
   const changed=runtime.sources.db.prepare('UPDATE one_vault_native_approvals SET revoked_at=? WHERE id=? AND metadata_digest=? AND revoked_at IS NULL').run(runtime.sources.now?.()??Date.now(),row.id,row.metadata_digest);
   if(Number(changed.changes)!==1)deny('generation_conflict');
   focused(held.window,fresh);if(currentScope(scope)!==held.scope||ready()!==fresh||oneVaultDigest(snapshot(fresh))!==held.evidence||!next.stillCurrent())deny('revision_changed');
  }).immediate();
  activeBundle=fresh;active=next;candidate=null;signer=null;signerEvidence='';return next;
 }
 function current(r:OneVaultRuntime){return r===runtime&&active.stillCurrent()?active:null;}
 function close(){closed=true;signer=null;signerEvidence='';let failure:unknown;for(const bundle of [activeBundle,candidate])if(bundle)try{bundle.close()}catch(error){failure=error}candidate=null;if(failure)throw failure;}
 return Object.freeze({current,registerFreshOriginal,prepareExistingHostSigner,reviewReauthorization,consumeReauthorization,close});
}
