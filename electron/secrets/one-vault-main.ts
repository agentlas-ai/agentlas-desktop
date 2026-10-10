import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
// Electron is loaded on use: the background service (ELECTRON_RUN_AS_NODE) reaches this module through
// invocation and MCP code and has no 'electron' module, so a top-level import crashed it on every start (1.2.84).
const electron=():typeof import('electron')=>require('electron') as typeof import('electron');
import type { OneVaultNativeAPI } from '../../shared/one-vault';
import { OneVaultError } from '../../shared/one-vault';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { pendingRunKeyElicitation, configureRunKeySavedReceiptGate, resolveRunKeysFromNativeReceipt } from '../mcp/run-key-elicitation';
import { getAuthenticatedSessionBinding } from '../auth';
import { getDb } from '../store/db';
import { getOneProfile } from '../store/one-profile';
import { getInvocationAdmission } from '../store/invocation-admissions';
import { invocationRunOwners } from '../store/invocation-run-owners';
import type { SupervisorRequestRow } from '../one/supervisor-store';
import { supervisorHash } from '../one/supervisor-store';
import { currentOneNativeWorkControl } from '../one/supervisor';
import { oneSupervisorNativeRuntime, supervisorRuntimeMode } from '../one/supervisor-native-runtime';
import { nativeGuiChannelIdentity } from '../daemon/native-auth-channel';
import { acquireOneSensitiveSurface } from './sensitive-surface';
import { OneVaultWindowManager } from './one-vault-window';
import { configureOneVaultRuntime, currentOneVaultRuntime, existingOneVaultRuntimeSources, type OneVaultRuntimePolicy } from './one-vault-runtime';
import { oneVaultDigest, verifyOneVault } from './one-vault-crypto';
import { oneVaultSlot } from './one-vault-journal';
import { registerOneProviderMainIpc, type OneProviderDomainPorts } from './one-provider-main';
import { OneProviderNativePlayer } from './one-provider-native-player';
import { OneProviderError } from '../../shared/one-provider';
import { getMediaOperation, patchMediaOperation } from '../store/media-operations';

export interface OneVaultMainHost {
  preloadPath:string;rendererBaseUrl():string;prepareSession(session:Session):void|Promise<void>;
  reauthorizeNativeOwner?(event:IpcMainInvokeEvent):Promise<void>;
  /** Actual native original controller; construction never grants storage/read. */
  preparePersonalPending?(window:BrowserWindow,runId:string):Promise<{commandId:string;reference:boolean}>;
  installPersonalSavedConsumer?(window:BrowserWindow,runId:string):Promise<void>;
  isOwnerWindow(window:BrowserWindow):boolean;assertTrustedSender(event:IpcMainInvokeEvent):BrowserWindow;
}
let host:OneVaultMainHost|null=null,manager:OneVaultWindowManager|null=null;
let policy:OneVaultRuntimePolicy|null=null;
let consumerReady:((commandId:string,toolId:string,keyName:string)=>boolean)|null=null;
/** Existing native personal consent owner, installed by Main only; never a renderer approval flag. */
export interface OneVaultMainPendingConsent {
  approveOriginalPending(window:BrowserWindow,runId:string):Promise<{state:'approved';commandId:string}>;
}
let pendingConsent:OneVaultMainPendingConsent|null=null;
export function configureOneVaultMainPendingConsent(value:OneVaultMainPendingConsent):void {
  if(typeof value?.approveOriginalPending!=='function'||pendingConsent&&pendingConsent!==value)throw new OneVaultError('authority_unavailable');
  pendingConsent=value;
}
let providerDomain:OneProviderDomainPorts|null=null,providerPlayer:OneProviderNativePlayer|null=null;
/** The real source/quote owner binds once. This does not create credentials, trust, grants or provider calls. */
export function configureOneProviderMainDomain(value:OneProviderDomainPorts):void {
  if(providerDomain&&providerDomain!==value)throw new OneProviderError('authority_unavailable');providerDomain=value;
}
/** Installed native policy/credential consumers bind once. A catalog/key-presence flag cannot bind them. */
export function configureOneVaultMainPolicy(value:OneVaultRuntimePolicy,consumer:(commandId:string,toolId:string,keyName:string)=>boolean):void {
  if(policy&&policy!==value)throw new OneVaultError('authority_unavailable');policy=value;consumerReady=consumer;
  currentOneVaultRuntime()?.configurePolicy(value);
}
function replyAuthority(row:Readonly<SupervisorRequestRow>) {
  if(row.kind!=='reply'||row.task_id!==null||!row.run_id)return null;
  const admission=getInvocationAdmission(row.run_id),custody=invocationRunOwners.getRunOwner(row.origin_chat_id,row.run_id);
  if(!admission||admission.status!=='admitted'||admission.chatId!==row.origin_chat_id||!custody||custody.state!=='active'||custody.ownerId!==admission.ownerProcessEpoch)return null;
  // This is an explicit native reply registry revision, never a synthetic task controlVersion.
  const revision=supervisorHash(['native-reply-authority.v1',row.command_id,row.run_id,row.payload_hash,row.payload_json,admission.inputDigest,custody.leaseId,custody.ownerId]);
  const stillCurrent=()=>{
    const current=getDb().prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(row.command_id) as SupervisorRequestRow|undefined;
    const currentAdmission=getInvocationAdmission(row.run_id!),currentOwner=invocationRunOwners.getRunOwner(row.origin_chat_id,row.run_id!);
    return !!current&&current.kind==='reply'&&current.task_id===null&&current.run_id===row.run_id&&current.payload_hash===row.payload_hash&&current.payload_json===row.payload_json
      &&['dispatching','accepted'].includes(current.state)&&currentAdmission?.status==='admitted'&&currentAdmission.inputDigest===admission.inputDigest
      &&currentOwner?.state==='active'&&currentOwner.leaseId===custody.leaseId&&currentOwner.ownerId===custody.ownerId
      &&!getDb().prepare("SELECT 1 FROM one_supervisor_requests WHERE run_id=? AND kind IN ('cancel','stop-reply') AND state<>'failed'").get(row.run_id);
  };
  return stillCurrent()?{revision,admissionDigest:admission.inputDigest,stillCurrent}:null;
}
function runtime() {
  if(!host)throw new OneVaultError('secure_route_unavailable');
  let value=currentOneVaultRuntime();
  if(!value){
    const sources=existingOneVaultRuntimeSources({currentControl:currentOneNativeWorkControl,currentNativeReplyAuthority:replyAuthority,
      isNativeOwnerWindow:window=>!!host&&!window.isDestroyed()&&host.isOwnerWindow(window as BrowserWindow),
      approvedDaemonCustody:(domain,run)=>{
        const channel=oneSupervisorNativeRuntime()?.getChannel(),identity=channel&&nativeGuiChannelIdentity(channel);
        if(!channel||!identity||supervisorRuntimeMode()!=='daemon'||identity.bootId!==domain.owner_epoch||run&&run.ownerId!==identity.bootId)return null;
        return {identity:oneVaultDigest(identity),stillCurrent:()=>oneSupervisorNativeRuntime()?.getChannel()===channel&&nativeGuiChannelIdentity(channel)===identity&&supervisorRuntimeMode()==='daemon'};
      }});
    value=configureOneVaultRuntime(sources);if(policy)value.configurePolicy(policy);
  }
  return value;
}
/** Main-native source access only. No runtime/trust initialization and no IPC selector. */
export function oneVaultMainMobileSources(){
 const original=host;if(!original)return null;
 return Object.freeze({runtime:()=>host===original?currentOneVaultRuntime():null,
  /** Explicit Main startup only: reuses existing runtime constructor; creates no host keys/approval. */
  prepareRuntime:()=>host===original?runtime():null,
  isNativeOwnerWindow(window:{id:number;isDestroyed():boolean;isFocused():boolean}){
   return host===original&&!window.isDestroyed()&&electron().BrowserWindow.fromId(window.id)===window&&original.isOwnerWindow(window as BrowserWindow);
  }});
}
function owned(event:IpcMainInvokeEvent):BrowserWindow {
  if(!host||isAppControlEvent(event))throw new OneVaultError('secure_route_unavailable');
  const window=host.assertTrustedSender(event);
  if(window.isDestroyed()||!window.isFocused()||!host.isOwnerWindow(window))throw new OneVaultError('authority_denied');
  return window;
}
const authorityRebinds=new WeakMap<object,{window:BrowserWindow;runtime:ReturnType<typeof runtime>;ticket:object;policy:OneVaultRuntimePolicy;consumer:((commandId:string,toolId:string,keyName:string)=>boolean)|null;consent:OneVaultMainPendingConsent|null;cleared:boolean}>();
 /** Main top-frame/native owner action only. Existing provider domains require their own drain owner. */
 export async function prepareOneVaultMainReauthorization(event:IpcMainInvokeEvent):Promise<{ticket:object;window:BrowserWindow}>{
  const window=owned(event),r=runtime(),original=policy;
  if(!original||providerDomain)throw new OneVaultError('authority_unavailable');
  const consumer=consumerReady,consent=pendingConsent,ticket=await r.preparePolicyRebind(original);
  if(owned(event)!==window||policy!==original||consumerReady!==consumer||pendingConsent!==consent||currentOneVaultRuntime()!==r)throw new OneVaultError('authority_unavailable');
  const token=Object.freeze({});authorityRebinds.set(token,{window,runtime:r,ticket,policy:original,consumer,consent,cleared:false});return{ticket:token,window};
 }
 export function clearOneVaultMainForReauthorization(event:IpcMainInvokeEvent,token:object):void{
  const held=authorityRebinds.get(token);if(!held||held.cleared||owned(event)!==held.window||currentOneVaultRuntime()!==held.runtime||policy!==held.policy||consumerReady!==held.consumer||pendingConsent!==held.consent||providerDomain)throw new OneVaultError('authority_unavailable');
  held.runtime.clearPolicyForRebind(held.ticket,held.policy);held.cleared=true;policy=null;consumerReady=null;pendingConsent=null;
 }
 export function finishOneVaultMainReauthorization(event:IpcMainInvokeEvent,token:object):void{
  const held=authorityRebinds.get(token);if(!held||!held.cleared||owned(event)!==held.window||!policy||!consumerReady||!pendingConsent||currentOneVaultRuntime()!==held.runtime)throw new OneVaultError('authority_unavailable');
  authorityRebinds.delete(token);held.runtime.finishPolicyRebind(held.ticket,policy);
 }
 function windows(value:ReturnType<typeof runtime>):OneVaultWindowManager {
  if(!manager){manager=new OneVaultWindowManager({service:value.service,preloadPath:host!.preloadPath,rendererBaseUrl:host!.rendererBaseUrl(),prepareSession:host!.prepareSession,acquireSensitiveSurface:acquireOneSensitiveSurface});manager.registerIpc();}
  return manager;
}
async function saved(runId:string):Promise<boolean> {
  const request=pendingRunKeyElicitation(runId),value=currentOneVaultRuntime();if(!request||!value||!consumerReady)return false;
  try{
    const commandId=value.commandForPendingRun(runId,'consumer'),context=value.resolveCommand(commandId),metadata=value.metadata.read(commandId);
    if(!metadata?.operationId){
      const anchor=value.anchor(commandId),owner=value.currentNativeOwner();if(!anchor||!owner||anchor.runId!==runId||owner.principalId!==getAuthenticatedSessionBinding()?.userId)return false;
      const leases=request.tools.flatMap(tool=>tool.envKeys.map(key=>value.currentStoredReference(commandId,tool.id,key.key)));
      if(!leases.length||leases.some(lease=>!lease))return false;
      await Promise.resolve();
      return oneVaultDigest(pendingRunKeyElicitation(runId))===oneVaultDigest(request)&&oneVaultDigest(value.anchor(commandId))===oneVaultDigest(anchor)
        &&oneVaultDigest(value.currentNativeOwner())===oneVaultDigest(owner)&&leases.every(lease=>lease!.stillCurrent());
    }
    if(!context||metadata.request.binding.principalId!==getAuthenticatedSessionBinding()?.userId)return false;
    const operation=value.journal.get(metadata.operationId);
    if(!operation||operation.state!=='saved'||operation.requestDigest!==oneVaultDigest(metadata.request)||operation.generation!==context.binding.expectedGeneration)return false;
    const approvedHost=value.trust.currentHostMetadata();
    if(!approvedHost||approvedHost.hostId!==metadata.request.binding.hostId||approvedHost.hostKeyId!==metadata.request.hostKeyId
      ||approvedHost.generation!==metadata.request.binding.trustGeneration||!verifyOneVault('request',metadata.request,approvedHost.signingPublicKey))return false;
    const slot=value.journal.current(oneVaultSlot(metadata.request));
    if(slot.pendingOperation!==null||slot.generation!==operation.generation||slot.credentialRef!==operation.credentialRef)return false;
    const lease=await value.authority(metadata.request.binding,'reconcile');
    return lease.stillCurrent()&&oneVaultDigest(pendingRunKeyElicitation(runId))===oneVaultDigest(request)
      &&oneVaultDigest(value.trust.currentHostMetadata())===oneVaultDigest(approvedHost)
      &&oneVaultDigest(value.resolveCommand(commandId)?.binding??null)===oneVaultDigest(context.binding)
      &&oneVaultDigest(value.metadata.read(commandId))===oneVaultDigest(metadata)
      &&oneVaultDigest(value.journal.current(oneVaultSlot(metadata.request)))===oneVaultDigest(slot)
      &&request.tools.every(tool=>tool.envKeys.every(key=>consumerReady!(commandId,tool.id,key.key)));
  }catch{return false;}
}
export function registerOneVaultMainIpc(input:{ipc:Pick<IpcMain,'handle'>;host:OneVaultMainHost}):void {
  if(host)throw new OneVaultError('secure_route_unavailable');host=input.host;
  configureRunKeySavedReceiptGate(request=>saved(request.runId));
  const domain:OneProviderDomainPorts={resolve:id=>providerDomain?.resolve(id)??Promise.resolve(null),
    stillCurrent:plan=>providerDomain?.stillCurrent(plan)??false,
    readText:(ref,anchor)=>{if(!providerDomain)throw new OneProviderError('authority_unavailable');return providerDomain.readText(ref,anchor);},
    approvedArtifactRoot:(ref,anchor)=>providerDomain?.approvedArtifactRoot(ref,anchor)??null,
    currentGrant:(action,phase)=>providerDomain?.currentGrant(action,phase)??Promise.resolve({decision:'unknown',lease:null})};
  registerOneProviderMainIpc({ipc:input.ipc,ports:{runtime:()=>runtime(),domain,assertOwner:owned,media:{getMediaOperation,patchMediaOperation},
    approve:async(window,prepared,retention)=>{
      const native=electron().BrowserWindow.fromId(window.id);if(native!==window||!host?.isOwnerWindow(native)||!native.isFocused())return false;
      const binding=prepared.action.binding;
      const money=new Intl.NumberFormat('ko-KR',{style:'currency',currency:prepared.quote.currency});
      const maximumCost=money.format(prepared.quote.upperBoundMinor/10**(money.resolvedOptions().maximumFractionDigits??0));
      const result=await (await import('electron')).dialog.showMessageBox(native,{type:'question',title:'One 제공자 실행 확인',
        message:prepared.action.kind==='tts'?'선택한 텍스트로 음성을 생성할까요?':'선택한 제공자의 연결과 사용 권한을 확인할까요?',
        detail:`계정: ${binding.principalId}\n범위: ${binding.scope}${binding.organizationId?` / ${binding.organizationId}`:''}\n호스트: ${binding.hostId}\n제공자: ${binding.provider} / ${binding.region}\n작업: ${binding.taskId} / ${binding.runId}\n목적: ${binding.purpose}\n권한: ${binding.operations.join(', ')}\n결제 주체: ${prepared.quote.payerId}\n최대 비용: ${maximumCost}\n보관: ${retention.disclosure}`,
        buttons:['취소','확인 후 실행'],defaultId:0,cancelId:0,noLink:true});return result.response===1;
    },
    playAudio:async(bytes,receipt,current)=>{providerPlayer??=new OneProviderNativePlayer(window=>!!host?.isOwnerWindow(window));await providerPlayer.play(bytes,receipt,current);},
  }});
  input.ipc.handle('oneVault:openRunKeyRequest',async(event,raw,...extra):Promise<Awaited<ReturnType<OneVaultNativeAPI['openRunKeyRequest']>>>=>{
    try{
      const window=owned(event);
      if(extra.length||!raw||Object.keys(raw).sort().join('|')!=='keyName|runId|toolId'||![raw.runId,raw.toolId,raw.keyName].every(x=>typeof x==='string'&&x.length>0&&x.length<201))throw new OneVaultError('invalid_request');
      const original=pendingRunKeyElicitation(raw.runId);
      if(!original?.tools.some(tool=>tool.id===raw.toolId&&tool.envKeys.some(key=>key.key===raw.keyName)))throw new OneVaultError('request_expired');
      const value=runtime();
      // Consent is not yet an entry intent. Resolve only the sole original native run anchor here.
      const rows=value.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(value.sources.oneId(),raw.runId) as Array<{command_id:string}>;
      const commandId=rows.length===1?rows[0].command_id:null,anchor=commandId?value.anchor(commandId):null;
      if(!commandId||!anchor||anchor.runId!==raw.runId)throw new OneVaultError('authority_denied');
      const owner=value.currentNativeOwner(),session=getAuthenticatedSessionBinding();
      if(!owner||!session)throw new OneVaultError('authority_unavailable');
      // Resolve actual original/current source before invoking the focused native caller.
      // Unknown/reserved effects never request new consent or submit another write.
      const beforeMetadata=value.metadata.read(commandId),beforeOperation=beforeMetadata?.operationId?value.journal.get(beforeMetadata.operationId):null;
      const statusOnly=beforeOperation?.state==='store_unknown'||beforeOperation?.state==='reserved';
      const initial=oneVaultDigest([anchor,original,owner,session,beforeMetadata,beforeOperation]);
      let prepared:{commandId:string;reference:boolean}|null=null;
      if(!statusOnly&&!beforeMetadata?.operationId&&!policy?.currentIntent(Object.freeze(anchor),original)){
        const prepare=host?.preparePersonalPending;
        if(!prepare||raw.toolId!=='elevenlabs-audio'||raw.keyName!=='ELEVENLABS_API_KEY')throw new OneVaultError('authority_unavailable');
        prepared=await prepare.call(host,window,raw.runId);
        if(owned(event)!==window||runtime()!==value||host?.preparePersonalPending!==prepare||prepared.commandId!==commandId
          ||oneVaultDigest([value.anchor(commandId),pendingRunKeyElicitation(raw.runId),value.currentNativeOwner(),getAuthenticatedSessionBinding(),value.metadata.read(commandId),beforeMetadata?.operationId?value.journal.get(beforeMetadata.operationId):null])!==initial)throw new OneVaultError('revision_changed');
      }
      const originalPolicy=policy,originalConsumer=consumerReady;
      if(!originalPolicy||!originalConsumer)throw new OneVaultError('authority_unavailable');
      if(prepared?.reference){if(!await saved(raw.runId)||owned(event)!==window)throw new OneVaultError('revision_changed');return{state:'opened',errorCode:null};}
      const pinned=oneVaultDigest([anchor,original,owner,session]);
      const current=()=>owned(event)===window&&runtime()===value&&policy===originalPolicy&&consumerReady===originalConsumer
        &&oneVaultDigest([value.anchor(commandId),pendingRunKeyElicitation(raw.runId),value.currentNativeOwner(),getAuthenticatedSessionBinding()])===pinned;
      const metadata=value.metadata.read(commandId),operation=metadata?.operationId?value.journal.get(metadata.operationId):null;
      const reconcileOnly=operation?.state==='store_unknown'||operation?.state==='reserved';
      if(!reconcileOnly){
        let currentIntent=originalPolicy.currentIntent(Object.freeze(anchor),original);
        if(!currentIntent){
          const consent=pendingConsent;
          if(!consent||raw.toolId!=='elevenlabs-audio'||raw.keyName!=='ELEVENLABS_API_KEY')throw new OneVaultError('authority_unavailable');
          const effect=oneVaultDigest([metadata,operation]);
          if(!current())throw new OneVaultError('revision_changed');
          const approved=await consent.approveOriginalPending(window,raw.runId);
          if(!current()||pendingConsent!==consent||approved.state!=='approved'||approved.commandId!==commandId
            ||oneVaultDigest([value.metadata.read(commandId),metadata?.operationId?value.journal.get(metadata.operationId):null])!==effect)throw new OneVaultError('revision_changed');
          currentIntent=originalPolicy.currentIntent(Object.freeze(anchor),original);
        }
        if(!currentIntent||currentIntent.toolId!==raw.toolId||currentIntent.envKey!==raw.keyName
          ||value.commandForPendingRun(raw.runId)!==commandId||!value.resolveCommand(commandId))throw new OneVaultError('revision_changed');
      }else {
        const retainedIntent=originalPolicy.currentIntent(Object.freeze(anchor),original);
        if(retainedIntent?retainedIntent.toolId!==raw.toolId||retainedIntent.envKey!==raw.keyName:raw.toolId!=='elevenlabs-audio'||raw.keyName!=='ELEVENLABS_API_KEY')throw new OneVaultError('revision_changed');
        if(!value.resolveCommand(commandId,'reconcile'))throw new OneVaultError('authority_unavailable');
      }
      if(!current())throw new OneVaultError('revision_changed');
      await windows(value).open(commandId,{reconcileOnly});
      return{state:'opened',errorCode:null};
    }catch(error){return{state:'blocked',errorCode:error instanceof OneVaultError?error.code:'secure_route_unavailable'};}
  });
  input.ipc.handle('oneVault:runKeyStatus',async(event,raw,...extra):Promise<Awaited<ReturnType<OneVaultNativeAPI['runKeyStatus']>>>=>{
    const window=owned(event);
    if(extra.length||!raw||Object.keys(raw).join('|')!=='runId'||typeof raw.runId!=='string')throw new OneVaultError('invalid_request');
    // Reader installation is an explicit owner action after an actual signed save.
    const finish=host?.installPersonalSavedConsumer;
    if(finish&&pendingRunKeyElicitation(raw.runId)){
      const value=currentOneVaultRuntime(),original=pendingRunKeyElicitation(raw.runId),owner=value?.currentNativeOwner();
      if(!value||!owner)throw new OneVaultError('authority_unavailable');
      const pinned=oneVaultDigest([owner,original,getAuthenticatedSessionBinding()]);
      await finish.call(host,window,raw.runId);
      if(owned(event)!==window||currentOneVaultRuntime()!==value||host?.installPersonalSavedConsumer!==finish||oneVaultDigest([value.currentNativeOwner(),pendingRunKeyElicitation(raw.runId),getAuthenticatedSessionBinding()])!==pinned)throw new OneVaultError('revision_changed');
    }
    if(await saved(raw.runId)){owned(event);if((await resolveRunKeysFromNativeReceipt(raw.runId)).ok)return{state:'saved',errorCode:null};}
    const value=currentOneVaultRuntime();
    try{const command=value?.commandForPendingRun(raw.runId),metadata=command&&value?.metadata.read(command),operation=metadata&&metadata.operationId?value?.journal.get(metadata.operationId):null;
      if(operation?.state==='store_unknown'||operation?.state==='reserved')return{state:'store_unknown',errorCode:'store_unknown'};
    }catch{/* Unavailable remains unavailable; no implicit recovery or new save. */}
    return{state:pendingRunKeyElicitation(raw.runId)&&value?'pending':'unavailable',errorCode:value?null:'secure_route_unavailable'};
  });
  input.ipc.handle('oneVault:recoverableOperations',async(event,...extra)=>{
    owned(event);if(extra.length)throw new OneVaultError('invalid_request');
    const value=currentOneVaultRuntime(),session=getAuthenticatedSessionBinding();if(!value||!session)return[];
    const owner=value.currentNativeOwner(),approvedHost=value.trust.currentHostMetadata(),oneId=getOneProfile().oneId;
    if(!owner||!approvedHost)return[];
    const sameOwner=()=>oneVaultDigest(getAuthenticatedSessionBinding())===oneVaultDigest(session)
      &&getOneProfile().oneId===oneId&&oneVaultDigest(value.currentNativeOwner())===oneVaultDigest(owner)
      &&oneVaultDigest(value.trust.currentHostMetadata())===oneVaultDigest(approvedHost);
    const rows=getDb().prepare('SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND one_vault_metadata_json IS NOT NULL ORDER BY rowid DESC LIMIT 100').all(oneId) as Array<{command_id:string}>;
    const allowed:Array<{operationId:string;commandId:string;state:'reserved'|'store_unknown';provider:string;scope:'personal'|'organization'}>=[];
    const retained:Array<()=>boolean>=[];
    for(const row of rows){
      if(!sameOwner())return[];
      const metadata=value.metadata.read(row.command_id),operation=metadata?.operationId?value.journal.get(metadata.operationId):null;
      if(!metadata||metadata.request.binding.principalId!==session.userId||metadata.request.binding.workspaceId!==session.workspaceId
        ||metadata.request.binding.hostId!==approvedHost.hostId||metadata.request.hostKeyId!==approvedHost.hostKeyId
        ||metadata.request.recipientKeyId!==approvedHost.recipientKeyId||metadata.request.binding.trustGeneration!==approvedHost.generation
        ||!verifyOneVault('request',metadata.request,approvedHost.signingPublicKey)
        ||!operation||!['reserved','store_unknown'].includes(operation.state)||operation.requestDigest!==oneVaultDigest(metadata.request))continue;
      try{
        const context=value.resolveCommand(row.command_id,'reconcile');if(!context)continue;
        // Authorize the current status scope; preserve the historical signed request unchanged.
        const binding={...metadata.request.binding,...context.binding};
        const lease=await value.authority(binding,'reconcile','reconcile');owned(event);
        if(!sameOwner())return[];
        const stillCurrent=()=>lease.stillCurrent()
          &&oneVaultDigest(value.resolveCommand(row.command_id,'reconcile'))===oneVaultDigest(context)
          &&oneVaultDigest(value.metadata.read(row.command_id))===oneVaultDigest(metadata)
          &&oneVaultDigest(value.journal.get(operation.operationId))===oneVaultDigest(operation);
        if(stillCurrent()){
          retained.push(stillCurrent);
          allowed.push({operationId:operation.operationId,commandId:row.command_id,state:operation.state as 'reserved'|'store_unknown',provider:metadata.request.binding.provider,scope:metadata.request.binding.scope});
        }
      }catch{/* No current status grant means no disclosure. */}
    }
    owned(event);
    try{return sameOwner()&&retained.every(check=>check())?allowed:[];}catch{return[];}
  });
  input.ipc.handle('oneVault:openStoredOperation',async(event,raw,...extra)=>{
    try{
      owned(event);if(extra.length||!raw||Object.keys(raw).join('|')!=='operationId'||typeof raw.operationId!=='string'||raw.operationId.length>200)throw new OneVaultError('invalid_request');
      const value=runtime(),session=getAuthenticatedSessionBinding(),operation=value.journal.get(raw.operationId);
      if(!session||!operation)throw new OneVaultError('not_found');
      const row=getDb().prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND json_extract(one_vault_metadata_json,'$.operationId')=?").get(getOneProfile().oneId,raw.operationId) as {command_id:string}|undefined;
      const metadata=row&&value.metadata.read(row.command_id);
      if(!metadata||metadata.request.binding.principalId!==session.userId||metadata.request.binding.workspaceId!==session.workspaceId||operation.requestDigest!==oneVaultDigest(metadata.request))throw new OneVaultError('authority_denied');
      // Reconcile-only resolves fresh retained-effect authority; it grants no submit/provider permission.
      if(!value.resolveCommand(row!.command_id,'reconcile'))throw new OneVaultError('authority_unavailable');
      await windows(value).open(row!.command_id,{reconcileOnly:true});return{state:'opened',errorCode:null};
    }catch(error){return{state:'blocked',errorCode:error instanceof OneVaultError?error.code:'secure_route_unavailable'};}
  });
  input.ipc.handle('oneVault:reviewHostTrust',async(event,raw,...extra)=>{
    const window=owned(event);
    if(extra.length||!raw||Object.keys(raw).join('|')!=='mode'||!['initialize-or-rotate','reconcile','reauthorize'].includes(raw.mode))throw new OneVaultError('invalid_request');
    const result=await runtime().approveHostFromWindow(window,raw.mode);owned(event);
    if(raw.mode==='reauthorize'&&result.state==='active')await host?.reauthorizeNativeOwner?.(event);
    owned(event);
    return{state:result.state}; // Public keys and native receipt stay in the native ledger.
  });
}
export function closeOneVaultMain():void {manager?.shutdown();providerPlayer?.close();}
export function invalidateOneVaultMainAuthority():void {const r=currentOneVaultRuntime();void r?.service.beginAuthorityDrain().catch(()=>{/* Sticky drain failure remains in the service. */});manager?.shutdown();providerPlayer?.close();r?.invalidateApprovals();}
