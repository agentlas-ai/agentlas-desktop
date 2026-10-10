import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { PersonalDataTarget } from '../../shared/one-personal-data';
import type { GmailPersonalRegistrationService, GmailRegistrationActor, GmailRegistrationSelection, GmailRegistrationCustody, GmailNativeApprovalRequest, GmailNativeApprovalReceipt } from '../plugins/gmail-personal-registration';
import type { NativeHistoryEvolutionService } from './history-evolution-native';
import type { PreparedMcpBinding } from '../mcp-tools/prepared-transport';
import { personalDataHash, personalDataTarget, personalDataId, personalDataError } from './personal-data-store';

export const PERSONAL_INTEGRATION_METHODS=['gmailCatalog','gmailPropose','gmailApprove','gmailRegister','gmailPause','gmailRevoke','gmailResume','gmailIntake','historySnapshot','historyObserve','historyDraft','historyCollectDraft','historyEvaluate','historyAccept','historyRun','historyProposeFeedback','historyAcceptFeedback','historyReconcileFeedback','historyControl','historyRestore'] as const;
export type PersonalIntegrationMethod=typeof PERSONAL_INTEGRATION_METHODS[number];
export interface NativePersonalReviewContext {window:BrowserWindow;actor:GmailRegistrationActor;assertCurrent():void}
const nativeReviews=new AsyncLocalStorage<NativePersonalReviewContext>();
function fail(code:string):never{throw personalDataError(code);}
const approvalMethods=new Set<PersonalIntegrationMethod>(['gmailApprove','historyAccept','historyAcceptFeedback']);
/** Main-owned explicit native approver; never accepts an approval object from the renderer. */
export function createGmailNativeDialogReview(input:{actor():GmailRegistrationActor;showMessageBox(window:BrowserWindow,options:MessageBoxOptions):Promise<MessageBoxReturnValue>}):(request:Readonly<GmailNativeApprovalRequest>)=>Promise<GmailNativeApprovalReceipt|null>{return async request=>{
  const context=nativeReviews.getStore();if(!context)fail('personal_integration_native_review_required');context.assertCurrent();
  if(personalDataHash(context.actor)!==personalDataHash(input.actor())||personalDataHash(request.actor)!==personalDataHash(context.actor)||context.window.isDestroyed()||!context.window.isFocused())fail('personal_integration_native_review_changed');
  const requestDigest=personalDataHash(request),selection=request.selection;
  const response=await input.showMessageBox(context.window,{type:'question',title:'Approve Gmail read scope',message:'Approve this exact installed mailbox read scope?',buttons:['Cancel','Approve read scope'],defaultId:0,cancelId:0,noLink:true,
    detail:[`Installed connector: ${selection.serverId}`,`Mailbox reference: ${selection.expectedAccountRef}`,`Native account: ${request.actor.principalId}`,`Workspace: ${request.actor.workspaceId}`,`Host: ${request.actor.hostId}`,`Page: ${selection.target.spaceId}/${selection.target.pageId}`,`Scope: ${selection.target.scope}; audience: ${selection.target.audience}`,`Organization: ${selection.target.organizationId??'none'}; project: ${selection.target.projectId??'none'}`,`Purpose: ${selection.purpose}`,`Bounded query: ${selection.query}`,`Labels: ${selection.labelIds.join(', ')||'none'}`,`Message body: ${selection.allowMessageBody?'permitted':'metadata only'}`,`Incremental history: ${selection.allowHistory?'explicit discovered contract required':'bounded search; incomplete history'}`,`Existing budget: ${selection.budgetId}`,`Permission revision: ${request.permissionRevision}`,`Audience grant: ${request.audienceGrantRevision}`,`Credential generation: ${request.credentialGeneration}`,`Proposal digest: ${request.proposalDigest}`,`Tool schema digests: ${Object.entries(request.toolDigests).map(([name,digest])=>`${name}:${digest}`).join(', ')}`].join('\n')});
  context.assertCurrent();if(context.window.isDestroyed()||personalDataHash(input.actor())!==personalDataHash(context.actor)||personalDataHash(request)!==requestDigest)fail('personal_integration_native_review_changed');
  if(response.response!==1)return null;return {consentId:request.consentId,proposalDigest:request.proposalDigest,actorDigest:personalDataHash(context.actor),authorityRevision:request.authorityRevision,proofRef:`native-gmail-review:${randomUUID()}`};};}
/** Reuse actual Electron dialog without invoking it at construction/development. */
export function createDefaultGmailNativeDialogReview(actor:()=>GmailRegistrationActor){return createGmailNativeDialogReview({actor,showMessageBox:async(window,options)=>(await import('electron')).dialog.showMessageBox(window,options)});}

export interface NativeGmailGrantDescriptor {
  decision:'allow'|'deny'|'unknown';actorDigest:string;selectionDigest:string;expectedAccountRef:string;
  permissionRevision:string;audienceGrantRevision:string;credentialGeneration:string;
  /** Exact already admitted Main config; not a renderer path and not an instruction to prepare/login. */
  preparedConfigPath:string|null;preparedConsentResource:string|null;
}
export interface NativeGmailPreparedSealPorts {bindings(configPath:string):PreparedMcpBinding[];consentResource(binding:PreparedMcpBinding):string}
/** A prepared transport is custody evidence, not mailbox/source/audience consent. Both must be current. */
export function createGmailPreparedCustody(input:{currentGrant(selection:Readonly<GmailRegistrationSelection>,actor:Readonly<GmailRegistrationActor>):NativeGmailGrantDescriptor;seals:NativeGmailPreparedSealPorts}):(selection:Readonly<GmailRegistrationSelection>,actor:Readonly<GmailRegistrationActor>)=>GmailRegistrationCustody{return (selection,actor)=>{
  const grant=input.currentGrant(selection,actor);const unknown=():GmailRegistrationCustody=>({decision:'unknown',permissionRevision:'',audienceGrantRevision:'',credentialGeneration:'',expectedAccountRef:'',prepared:null});
  if(grant.decision!=='allow'||grant.actorDigest!==personalDataHash(actor)||grant.selectionDigest!==personalDataHash(selection)||grant.expectedAccountRef!==selection.expectedAccountRef||!grant.permissionRevision||!grant.audienceGrantRevision||!grant.credentialGeneration||!grant.preparedConfigPath||!grant.preparedConsentResource)return unknown();
  try{const matches=input.seals.bindings(grant.preparedConfigPath).filter(b=>b.server.id===selection.serverId);if(matches.length!==1||input.seals.consentResource(matches[0])!==grant.preparedConsentResource)return unknown();
    return {decision:'allow',permissionRevision:grant.permissionRevision,audienceGrantRevision:grant.audienceGrantRevision,credentialGeneration:grant.credentialGeneration,expectedAccountRef:grant.expectedAccountRef,prepared:matches[0]};}catch{return unknown();}};}
export async function createDefaultGmailPreparedCustody(currentGrant:Parameters<typeof createGmailPreparedCustody>[0]['currentGrant']){const native=await import('../mcp-tools/prepared-transport');return createGmailPreparedCustody({currentGrant,seals:{bindings:native.preparedMcpBindings,consentResource:b=>native.preparedMcpConsentResource(b,b.server)}});}

const keys:Record<PersonalIntegrationMethod,string[]>={gmailCatalog:[],gmailPropose:['commandId','serverId','expectedAccountRef','target','budgetId','query','labelIds','allowMessageBody','allowHistory','purpose'],gmailApprove:['consentId','expectedRevision'],gmailRegister:['consentId','expectedRevision'],gmailPause:['consentId','expectedRevision'],gmailRevoke:['consentId','expectedRevision'],gmailResume:['consentId','expectedRevision'],gmailIntake:['consentId','expectedRevision','subscriptionRevision','enabled'],historySnapshot:['target'],historyObserve:['target','predecessorId'],historyDraft:['target','candidateId','expectedRevision','commandId'],historyCollectDraft:['target','candidateId','expectedRevision'],historyEvaluate:['target','candidateId','expectedRevision'],historyAccept:['target','candidateId','expectedRevision'],historyRun:['target','candidateId','expectedRevision','commandId'],historyProposeFeedback:['target','candidateId','expectedRevision'],historyAcceptFeedback:['target','candidateId','expectedRevision','proposalId','expectedPageRevision','commandId'],historyReconcileFeedback:['target','candidateId','expectedRevision'],historyControl:['target','candidateId','expectedRevision','action','commandId','expectedControlVersion'],historyRestore:['target','candidateId','expectedRevision','versionId']};
function validate(method:PersonalIntegrationMethod,value:unknown):Record<string,unknown>{if(method==='gmailCatalog'){if(value!==undefined)fail('personal_integration_input_invalid');return {};}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys[method].includes(k)))fail('personal_integration_input_invalid');
  const v=value as Record<string,unknown>;for(const key of ['expectedRevision','subscriptionRevision','expectedPageRevision'])if(key in v&&(!Number.isSafeInteger(v[key])||(v[key] as number)<0))fail('personal_integration_input_invalid');
  if('target' in v)personalDataTarget(v.target as PersonalDataTarget);for(const key of ['consentId','candidateId','proposalId','commandId','versionId'])if(key in v)personalDataId(v[key]);return v;}
export interface OnePersonalIntegrationOwnerPorts {
  assertOwner():void;hasHistoryProvenance(target:PersonalDataTarget):boolean;
}
/** Same owner's service instances; no constructor creates a timer, provider call or queue. */
export function createOnePersonalIntegrationOwner(ports:OnePersonalIntegrationOwnerPorts){let gmail:GmailPersonalRegistrationService|null=null,history:NativeHistoryEvolutionService|null=null;
  const configureGmail=(service:GmailPersonalRegistrationService)=>{ports.assertOwner();if(gmail&&gmail!==service)fail('personal_integration_already_configured');gmail=service;};
  const configureNativeHistory=(service:NativeHistoryEvolutionService)=>{ports.assertOwner();if(history&&history!==service)fail('personal_integration_already_configured');history=service;};
  const beforePageRead=(target:PersonalDataTarget)=>{ports.assertOwner();personalDataTarget(target);if(!ports.hasHistoryProvenance(target))return;if(!history)fail('personal_integration_history_required');history.restorePageProvenance(target);};
  const dispatch=async(method:string,value?:unknown):Promise<unknown>=>{ports.assertOwner();if(!(PERSONAL_INTEGRATION_METHODS as readonly string[]).includes(method))fail('personal_integration_method_invalid');const name=method as PersonalIntegrationMethod,v=validate(name,value);
    if(name.startsWith('gmail')){if(!gmail)fail('gmail_personal_permission_required');const map={gmailCatalog:'catalog',gmailPropose:'propose',gmailApprove:'approve',gmailRegister:'register',gmailPause:'pause',gmailRevoke:'revoke',gmailResume:'resume',gmailIntake:'configureIntake'} as const;
      const action=map[name as keyof typeof map];return (gmail[action] as (...args:any[])=>unknown).call(gmail,...(name==='gmailCatalog'?[]:[v]));}
    if(!history)fail('personal_integration_history_required');const map={historySnapshot:'snapshot',historyObserve:'observe',historyDraft:'draft',historyCollectDraft:'collectDraft',historyEvaluate:'evaluate',historyAccept:'acceptNative',historyRun:'run',historyProposeFeedback:'proposeFeedback',historyAcceptFeedback:'acceptFeedbackNative',historyReconcileFeedback:'reconcileFeedback',historyControl:'control',historyRestore:'restore'} as const;
    return (history[map[name as keyof typeof map]] as (...args:any[])=>unknown).call(history,v);};
  return {configureGmail,configureNativeHistory,beforePageRead,dispatch,invalidateCurrent:()=>{gmail?.invalidateCurrent();},close:()=>{gmail?.close();history?.close();gmail=null;history=null;}};
}
export function registerOnePersonalIntegrationIpc(input:{ipc:Pick<IpcMain,'handle'>;assertTrustedSender(event:IpcMainInvokeEvent):void;
  /** Parent reuses its existing app-control provenance marker, native owner-window and sender/frame check. */
  isAppControlEvent(event:IpcMainInvokeEvent):boolean;reviewContext(event:IpcMainInvokeEvent):NativePersonalReviewContext;
  mode():'local'|'handoff'|'daemon';local:Pick<ReturnType<typeof createOnePersonalIntegrationOwner>,'dispatch'>;
  invokeOwner(method:PersonalIntegrationMethod,value:unknown):Promise<unknown>;
  /** Required ONLY for daemon approval: current native GUI channel proof, never a serialized approval boolean. */
  invokeOwnerReview?:(method:PersonalIntegrationMethod,value:unknown,context:NativePersonalReviewContext)=>Promise<unknown>;
}):void{for(const method of PERSONAL_INTEGRATION_METHODS)input.ipc.handle(`onePersonalData:${method}`,async(event,value,...extras)=>{
  input.assertTrustedSender(event);if(input.isAppControlEvent(event)||extras.length)fail('personal_integration_dedicated_port_required');validate(method,value);
  const mode=input.mode();if(mode==='handoff')fail('personal_integration_owner_handoff_pending');
  try {if(mode==='daemon'){if(approvalMethods.has(method)){if(!input.invokeOwnerReview)fail('personal_integration_native_review_bridge_required');const context=input.reviewContext(event);context.assertCurrent();const result=await input.invokeOwnerReview(method,value,context);context.assertCurrent();return result;}return await input.invokeOwner(method,value);}
    if(approvalMethods.has(method)){const context=input.reviewContext(event);context.assertCurrent();return await nativeReviews.run(context,()=>input.local.dispatch(method,value));}return await input.local.dispatch(method,value);
  }catch(error){const code=(error as {code?:unknown})?.code;throw personalDataError(typeof code==='string'&&/^(?:personal_integration|gmail_personal|history_native|history_evolution)_[a-z_]{1,80}$/.test(code)?code:'personal_integration_unavailable');}});}

/** Intake wake fanout only. Parent calls wakeFromExistingCheckin inside its ALREADY existing owner timer. */
export function createExistingPersonalOwnerWake(assertOwner:()=>void){const listeners=new Set<()=>void>();return {
  subscribeOwnerWake(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  wakeFromExistingCheckin(){assertOwner();for(const listener of [...listeners]){try{assertOwner();listener();}catch{/* A listener's hold must not stop other current-owner observers. */}}},
  close(){listeners.clear();},
};}
