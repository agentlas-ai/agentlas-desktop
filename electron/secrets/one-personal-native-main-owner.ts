import {BrowserWindow,dialog} from 'electron';
import {currentOnePersonalNativeOriginal,type OnePersonalNativeOriginal} from './one-personal-native-entry';
import {authorizeSupervisorNativeOrigin} from '../one/supervisor-native-runtime';
import {pendingRunKeyElicitation} from '../mcp/run-key-elicitation';
import {configureOneNativeMainOwnerFactory,type OneNativeMainOwnerFactory,currentOneNativeMainComposition} from '../one/native-main-composition';
import {oneVaultDigest} from './one-vault-crypto';
import {createOnePersonalNativeOwners,createOnePersonalNativeOwnerFactory,type OnePersonalNativeOwnerPorts,type OnePersonalNativeResourceTarget} from './one-personal-native-owners';
import {composeOneVaultStoredReferenceOwner} from './one-vault-stored-reference';
import {createOnePersonalNativeSavedAccountCatalog} from './one-personal-native-account-catalog';
import {createOnePersonalScopedConsumerOwner} from './one-personal-native-scoped-consumer';
import type {OneOriginalMcpSelection} from '../one/one-original-mcp-credential';
import type {InstalledMcpServer} from '../../shared/types';
import type {OneVaultRuntime} from './one-vault-runtime';
export interface OnePersonalNativeAccountChoice {readonly handle:object;readonly label:string;stillCurrent():boolean}
export interface OnePersonalNativeMainOwnerPorts {
 /** Existing actual Main/runtime/native owner getters. No runtime/trust is created here. */
 runtime():OneVaultRuntime|null;
 isNativeOwnerWindow(window:BrowserWindow):boolean;
 ownerPorts:OnePersonalNativeOwnerPorts;
 /** Independently current native installed provider/account catalog. No caller strings/global env. */
 accounts: {current(original:Readonly<OnePersonalNativeOriginal>):readonly OnePersonalNativeAccountChoice[]}|null;
}
/** One local native caller/controller, using the existing ALS and the ONE factory registry.
 * Capture holds the actual origin reference only; it neither mints an origin nor grants permission. */
export function createOnePersonalNativeMainOwner(p:OnePersonalNativeMainOwnerPorts){
 const originals=new Map<string,{original:Readonly<OnePersonalNativeOriginal>;selectedAccount:object|null}>();let closed=false,bundleOwnerDigest:string|null=null;
 let bundle:ReturnType<typeof createOnePersonalNativeOwners>|null=null,factory:ReturnType<typeof createOnePersonalNativeOwnerFactory>|null=null;
 let reference:ReturnType<typeof composeOneVaultStoredReferenceOwner>|null=null;
 const refs=[p.runtime,p.isNativeOwnerWindow,p.ownerPorts,p.accounts];
 const current=()=>{if(closed||[p.runtime,p.isNativeOwnerWindow,p.ownerPorts,p.accounts].some((v,i)=>v!==refs[i]))throw Error('one_personal_native_main_owner_changed');const r=p.runtime();if(!r?.currentNativeOwner())throw Error('one_personal_native_runtime_unavailable');return r;};
 function captureOriginal(){if(closed)throw Error('one_personal_native_main_owner_changed');const original=currentOnePersonalNativeOriginal();if(!original?.request.runId)return;
  // Opaque origin validates the existing sole Supervisor/canonical invocation.
  // Value-free retention grants nothing; legacy use needs no Vault owner.
  authorizeSupervisorNativeOrigin(original.origin,original.request);const prior=originals.get(original.request.runId);if(prior&&prior.original.origin!==original.origin)throw Error('one_personal_native_original_changed');if(!prior)originals.set(original.request.runId,{original,selectedAccount:null});
 }
 function capturePending(){const original=currentOnePersonalNativeOriginal();if(original?.request.runId&&pendingRunKeyElicitation(original.request.runId))captureOriginal();}
 function focused(w:BrowserWindow){if(BrowserWindow.fromId(w.id)!==w||w.isDestroyed()||!w.isFocused()||!p.isNativeOwnerWindow(w))throw Error('one_personal_native_focused_owner_required');}
 async function preparePending(window:BrowserWindow,runId:string){
  focused(window);const original=originals.get(runId)?.original,pending=pendingRunKeyElicitation(runId);
  if(!original||!pending)throw Error('one_personal_native_account_or_consumer_unbound');authorizeSupervisorNativeOrigin(original.origin,original.request);
  const r=current();if(!p.accounts||!p.ownerPorts.consumer||!p.ownerPorts.providerSelections)throw Error('one_personal_native_account_or_consumer_unbound');
  const rows=r.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind='reply'").all(r.sources.oneId(),runId) as Array<{command_id:string}>;
  const command=rows.length===1?rows[0].command_id:null,anchor=command&&r.anchor(command);if(!command||!anchor||anchor.chatId!==original.request.chatId)throw Error('one_personal_native_original_unavailable');
  // Reserved/unknown effects must use existing retained recovery, never new consent or nonce.
  const metadata=r.metadata.read(command);if(metadata?.operationId)throw Error('one_personal_native_existing_effect_use_recovery');
  const choices=p.accounts.current(original);if(!choices.length||choices.length>16||choices.some(c=>!c.handle||!c.label||c.label.length>512||!c.stillCurrent()))throw Error('one_personal_native_account_selection_unavailable');
  const identity=oneVaultDigest([anchor,pending,r.currentNativeOwner()]);
  const check=()=>{focused(window);if(current()!==r||oneVaultDigest([r.anchor(command),pendingRunKeyElicitation(runId),r.currentNativeOwner()])!==identity)throw Error('one_personal_native_current_source_changed');authorizeSupervisorNativeOrigin(original.origin,original.request);};
  const picked=await dialog.showMessageBox(window,{type:'question',title:'One 원래 요청의 개인 연결 선택',message:'이 원래 대화 요청에 사용할 현재 계정을 선택하세요.',detail:`호스트: ${r.currentNativeOwner()!.hostId}\n원래 대화: ${anchor.chatId}\n원래 실행: ${anchor.runId}\n범위: 개인 / 소유자\n키 저장·기존 키 읽기·제공자 유료 사용은 각각 별도 승인합니다.`,buttons:['취소',...choices.map(c=>c.label)],defaultId:0,cancelId:0,noLink:true});
  if(picked.response<1||picked.response>choices.length)throw Error('one_personal_native_declined');const choice=choices[picked.response-1];originals.get(runId)!.selectedAccount=choice.handle;check();if(!choice.stillCurrent()||!p.accounts.current(original).some(c=>c.handle===choice.handle&&c.label===choice.label&&c.stillCurrent()))throw Error('one_personal_native_account_changed');
  if(bundle&&bundleOwnerDigest!==oneVaultDigest(r.currentNativeOwner()))throw Error('one_personal_native_existing_owner_use_reauthorization');
  const target:OnePersonalNativeResourceTarget={kind:'ordinary-one-room',deploymentId:r.currentNativeOwner()!.hostId,oneId:r.sources.oneId(),scope:'personal',organizationId:null,projectId:null,audience:'owner',chatId:anchor.chatId};
  const created=bundle??createOnePersonalNativeOwners(r,p.ownerPorts);created.registerOriginal(original.origin,original.request,target,choice.handle);
  const found=created.lookupStoredReference(command);
  if(found){reference=composeOneVaultStoredReferenceOwner(r,{...created,readAuthority:p.ownerPorts.consumer!});if(!reference)throw Error('one_personal_native_scoped_consumer_unbound');await reference.approveOriginalReference(window,runId);check();created.policy.currentStoredReference=reference.policy.currentStoredReference;}
  else{await created.approveOriginalPending(window,runId);check();}
  bundle=created;bundleOwnerDigest=oneVaultDigest(r.currentNativeOwner());if(!factory){factory=createOnePersonalNativeOwnerFactory(r,created);configureOneNativeMainOwnerFactory(factory as OneNativeMainOwnerFactory);}
  const installed=currentOneNativeMainComposition()?.start();check();if(installed?.state!=='ready')throw Error('one_personal_native_main_install_unavailable');return{commandId:command,reference:!!found};
 }
 async function finishSaved(runId:string){const original=originals.get(runId)?.original;if(!bundle||!original)return;const r=current();authorizeSupervisorNativeOrigin(original.origin,original.request);const rows=r.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=?").all(r.sources.oneId(),runId) as Array<{command_id:string}>;if(rows.length!==1)return;const metadata=r.metadata.read(rows[0].command_id),op=metadata?.operationId&&r.journal.get(metadata.operationId);if(op&&op.state==='saved')await bundle.installScopedConsumer(rows[0].command_id);}
 function close(){closed=true;for(const [runId,value]of originals)if(!value.selectedAccount)originals.delete(runId);let unknown=false;try{bundle?.close()}catch{unknown=true}try{factory?.close()}catch{unknown=true}if(unknown)throw Error('one_personal_native_main_cleanup_unknown');}
 function currentMcpSelection(original:Readonly<OnePersonalNativeOriginal>,server:Readonly<InstalledMcpServer>){
  // An explicitly captured scoped route never becomes legacy when its owner is unavailable.
  const retained=originals.get(original.request.runId??'');if(!retained||retained.original.origin!==original.origin||!retained.selectedAccount||!server.envKeys.includes('ELEVENLABS_API_KEY'))return null;if(closed)return Object.freeze({route:'scoped' as const,serverId:server.id,owners:null});try{authorizeSupervisorNativeOrigin(original.origin,original.request)}catch{return Object.freeze({route:'scoped' as const,serverId:server.id,owners:null})}
  return Object.freeze({route:'scoped' as const,serverId:server.id,owners:bundle?.currentMcpOwners(original,server)??null});
 }
 return Object.freeze({captureOriginal,capturePending,preparePending,finishSaved,currentMcpSelection,close});
}

let nativePendingEntry:ReturnType<typeof createOnePersonalNativeMainOwner>|null=null;
export function configureOnePersonalNativePendingEntry(value:ReturnType<typeof createOnePersonalNativeMainOwner>){if(nativePendingEntry&&nativePendingEntry!==value)throw Error('one_personal_native_pending_entry_changed');nativePendingEntry=value}
/** Existing MCP gate sink, inside the genuine original ALS; capture precedes renderer delivery. */
export function captureOnePersonalNativePending(){nativePendingEntry?.capturePending()}

export function resolveOnePersonalNativeMcpSelection(server:Readonly<InstalledMcpServer>):OneOriginalMcpSelection{const original=currentOnePersonalNativeOriginal();if(!original)return Object.freeze({route:'legacy' as const});return nativePendingEntry?.currentMcpSelection(original,server)??Object.freeze({route:'legacy' as const})}

export function captureOnePersonalNativeOriginal(){nativePendingEntry?.captureOriginal()}

/** Once-only actual Main caller recipe: existing runtime/host/session lifecycle,
 * signed saved-account catalog, SAME native scoped reader receiver. The missing
 * installed endpoint/account mapping owner is explicit null, never a default grant. */
export function createOnePersonalNativeMainEntry(input:{
 sources:NonNullable<ReturnType<typeof import('./one-vault-main').oneVaultMainMobileSources>>;
 lifetime:OnePersonalNativeOwnerPorts['lifetime'];focusedWindow():BrowserWindow|null;
 currentServer(serverId:string):Readonly<InstalledMcpServer>|null;configurationDigest(server:Readonly<InstalledMcpServer>):string;
 mappingOwner:{current(binding:Readonly<import('./one-vault-personal-adapter').OneVaultScopedConsumerReceipt>):import('./one-personal-native-scoped-consumer').OnePersonalNativeMcpMapping|null}|null;
 /** Required only when an actual separate provider domain is composed by its owner. */
 invalidateProviderReadiness?:OnePersonalNativeOwnerPorts['invalidateProviderReadiness'];
}){
 let runtime:OneVaultRuntime|null=null,catalog:ReturnType<typeof createOnePersonalNativeSavedAccountCatalog>|null=null,scoped:ReturnType<typeof createOnePersonalScopedConsumerOwner>|null=null,closed=false;
 function currentRuntime(){if(closed)throw Error('one_personal_native_entry_closed');const current=input.sources.runtime()??input.sources.prepareRuntime();if(!current||runtime&&runtime!==current)throw Error('one_personal_native_existing_runtime_unavailable');runtime=current;return current;}
 function nativeOwners(){const current=currentRuntime();if(!catalog||!scoped){catalog=createOnePersonalNativeSavedAccountCatalog(current);scoped=createOnePersonalScopedConsumerOwner({runtime:current,focusedWindow:input.focusedWindow,isNativeOwnerWindow:input.sources.isNativeOwnerWindow,currentMapping:binding=>closed?null:input.mappingOwner?.current(binding)??null,currentServer:input.currentServer,configurationDigest:input.configurationDigest});}return{catalog,scoped};}
 // Stable lazy receivers; construction reads no runtime/schema/native owner.
 const ports:OnePersonalNativeOwnerPorts={lifetime:input.lifetime,isNativeOwnerWindow:input.sources.isNativeOwnerWindow,
  get providerSelections(){return nativeOwners().catalog.providerSelections},get consumer(){return nativeOwners().scoped.consumer},
  invalidateProviderReadiness:(slot,generation)=>{scoped?.invalidateSlot(slot,generation);input.invalidateProviderReadiness?.(slot,generation)}};
 const controller=createOnePersonalNativeMainOwner({runtime:currentRuntime,isNativeOwnerWindow:input.sources.isNativeOwnerWindow,accounts:{current:original=>nativeOwners().catalog.accounts.current(original)},ownerPorts:ports});
 configureOnePersonalNativePendingEntry(controller);
 return Object.freeze({...controller,close(){closed=true;let unknown=false;try{controller.close()}catch{unknown=true}try{scoped?.close()}catch{unknown=true}if(unknown)throw Error('one_personal_native_main_cleanup_unknown')}});
}
