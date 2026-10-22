import {personalEmployeeAgentInstallation} from './employee-agent-personal-installation';
import {sharingSheet} from './native-approval-sheets';
import {registerEmployeeAgentTransferMain,type EmployeeAgentTransferOriginal} from './employee-agent-transfer-main';
import type {BrowserWindow,IpcMain,IpcMainInvokeEvent} from 'electron';
import {isAppControlEvent} from '../app-control/ipc-registry';
import {createNativeEmployeeConnection} from './native-employee-connection';
import {createNativeEmployeeResultSource} from './native-employee-source';
import {createNativeEmployeeReportJournal,type NativeEmployeeRootExpectations} from './native-employee-journal';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import {businessEmployeeAgentOnly,businessEmployeeAgentText} from '../../shared/business/employee-agent-report';
import {isBusinessId,isBusinessRevision} from '../../shared/business/context';
import type {OneNativeStartupOwners} from '../one/native-startup-installer';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
const electron=():typeof import('electron')=>require('electron') as typeof import('electron');
export type NativeEmployeeReportStartup=Omit<OneNativeStartupOwners,'signal'|'assertMainOwner'|'currentNativeInstallation'>;
export interface NativeEmployeeMainInput {
 companyOriginal?():EmployeeAgentTransferOriginal|null;
 isCompanyWindow?(window:BrowserWindow):boolean;
 ipc:Pick<IpcMain,'handle'>;assertTrustedSender(event:IpcMainInvokeEvent):void;isOwnerWindow(window:BrowserWindow):boolean;
 sources:NonNullable<ReturnType<typeof import('../secrets/one-vault-main').oneVaultMainMobileSources>>|null|undefined;
 hostSignal?:AbortSignal;
 signal:AbortSignal;installationGeneration():number;locale?():'ko'|'en';
 /** Original Main lifecycle owner, not a renderer instruction or new grant. */
 prepareGeneration?(event:IpcMainInvokeEvent):Promise<void>;
 /** SAME original Main factory/composition accepts only this genuine owner's family. */
 installStartup(startup:NativeEmployeeReportStartup):void;
}
/** Register concrete trusted native actions, with no startup observation, DB, key
 * read, login, HTTP, timer or task. Every effect starts in a focused owner action. */
export function registerNativeEmployeeMain(input:NativeEmployeeMainInput){
 let closed=false,personalClosed=false,retiredGeneration:number|null=null,cleanupUnknown=false,associationApprovalPending=false,runtime:OneVaultRuntime|null=null,connection:ReturnType<typeof createNativeEmployeeConnection>|null=null,
 source:ReturnType<typeof createNativeEmployeeResultSource>|null=null,journal:ReturnType<typeof createNativeEmployeeReportJournal>|null=null,startup:NativeEmployeeReportStartup|null=null;
 function deny():never{throw Error('business_native_focused_owner_required')}
 function owned(event:IpcMainInvokeEvent,retiredIdentity=false){input.assertTrustedSender(event);const window=electron().BrowserWindow.fromWebContents(event.sender);
  if(closed||personalClosed||cleanupUnknown||retiredGeneration!==null&&!retiredIdentity||input.signal.aborted||isAppControlEvent(event)||!window||window.isDestroyed()||!window.isFocused()||!input.isOwnerWindow(window)||event.senderFrame!==event.sender.mainFrame)deny();
  const frame=event.senderFrame,url=frame?.url,epoch=input.installationGeneration();return{window,check(){input.assertTrustedSender(event);if(closed||personalClosed||cleanupUnknown||retiredGeneration!==null&&!retiredIdentity||input.signal.aborted||window.isDestroyed()||!window.isFocused()||!input.isOwnerWindow(window)||electron().BrowserWindow.fromWebContents(event.sender)!==window||event.senderFrame!==frame||frame?.url!==url||input.installationGeneration()!==epoch||isAppControlEvent(event))deny()}};
 }
 function original(){if(closed||personalClosed||input.signal.aborted)deny();const current=input.sources?.runtime()??input.sources?.prepareRuntime();if(!current||runtime&&current!==runtime||!current.currentNativeOwner())deny();
  if(!runtime){runtime=current;connection=createNativeEmployeeConnection(current,input.installationGeneration);source=createNativeEmployeeResultSource(current);journal=createNativeEmployeeReportJournal(current,source,connection);}
  return{runtime:runtime!,connection:connection!,source:source!,journal:journal!};
 }
 function currentStartup(){return startup&&connection?.current()?startup:null}
 let personalTransferOriginal:EmployeeAgentTransferOriginal|null=null;
 const employeeTransfers=registerEmployeeAgentTransferMain({ipc:input.ipc,locale:()=>input.locale?.()??'en',original:event=>{const company=input.companyOriginal?.(),companyWindow=event&&electron().BrowserWindow.fromWebContents(event.sender);if(event&&companyWindow&&input.isCompanyWindow?.(companyWindow)){if(!company)deny();company.assertCurrent();return company;}if(!event&&company){company.assertCurrent();return company;}const o=original();if(personalTransferOriginal)return personalTransferOriginal;return personalTransferOriginal={identityOwner:o.runtime,db:o.runtime.sources.db,userDataPath:require('../runtime-paths').userDataPath,assertCurrent:()=>{if(original().runtime!==o.runtime)deny();},installation:personalEmployeeAgentInstallation(o.runtime,()=>{if(original().runtime!==o.runtime)deny();}),connection:{current:o.connection.current,refresh:o.connection.refresh,request:(operation:string,value:unknown)=>o.connection.request(operation as Parameters<typeof o.connection.request>[0],value)}};},focused:event=>{
  const target=electron().BrowserWindow.fromWebContents(event.sender);if(!target||!input.isCompanyWindow?.(target))return owned(event);
  if(!input.companyOriginal?.())deny();
  input.assertTrustedSender(event);const window=electron().BrowserWindow.fromWebContents(event.sender),frame=event.senderFrame,url=frame?.url,identity=input.companyOriginal()!;
  const check=()=>{input.assertTrustedSender(event);identity.assertCurrent();if(closed||(input.hostSignal??input.signal).aborted||isAppControlEvent(event)||!window||window.isDestroyed()||!window.isFocused()||!input.isOwnerWindow(window)||electron().BrowserWindow.fromWebContents(event.sender)!==window||frame!==event.sender.mainFrame||event.senderFrame!==frame||frame?.url!==url||input.companyOriginal?.()?.identityOwner!==identity.identityOwner)deny();};check();return{window:window!,check};
 }});
 function attach(){const o=original();if(!startup)startup=Object.freeze({association:o.connection.association,organizationIdentity:Object.freeze({current:()=>o.connection.current()?.orgSession??null}),nativeCustodyReports:o.journal.owners});input.installStartup(startup);}
 // A cached startup pins its original association capability. Expiry/revocation
 // cannot authorize replacing that capability inside the same generation.
 function requireAssociationGeneration(){if(startup&&!connection?.current())throw Object.assign(Error('business_native_report_generation_retirement_required'),{code:'business_native_report_generation_retirement_required'});}
 async function review(window:BrowserWindow,check:()=>void,title:string,detail:string){check();const result=await electron().dialog.showMessageBox(window,sharingSheet(input.locale?.()==='ko',title,detail));check();if(result.response!==1)throw Error('business_native_sharing_declined')}
 input.ipc.handle('businessNative:identity',(event:IpcMainInvokeEvent)=>{
  owned(event,true);return (async()=>{await input.prepareGeneration?.(event);owned(event,true);
  if(retiredGeneration!==null){if(!input.prepareGeneration||input.installationGeneration()<=retiredGeneration)deny();retiredGeneration=null;}
  const action=owned(event),o=original();action.check();return o.connection.native();})();
 });
 input.ipc.handle('businessNative:completedWork',async(event:IpcMainInvokeEvent)=>{const action=owned(event),o=original();action.check();const items=await o.source.completedWork();action.check();return items});
 input.ipc.handle('businessNative:approveAssociation',async(event:IpcMainInvokeEvent,value:unknown)=>{
  const action=owned(event);if(!businessEmployeeAgentOnly(value,['challengeId'])||!isBusinessId(value.challengeId))deny();const o=original();
  const check=()=>{action.check();if(o.connection.current())throw Object.assign(Error('business_native_connection_already_active'),{code:'business_native_connection_already_active'});requireAssociationGeneration();};check();
  if(associationApprovalPending)throw Object.assign(Error('business_native_connection_approval_in_progress'),{code:'business_native_connection_approval_in_progress'});associationApprovalPending=true;
  try{const challenge=await o.connection.challenge(value.challengeId);check();
  await review(action.window,check,input.locale?.()==='ko'?'직원 에이전트 보고 공유 승인':'Approve employee agent report sharing',input.locale?.()==='ko'?`조직: ${challenge.orgSession.organizationId}\n직원: ${challenge.orgSession.principalId}\n호스트: ${challenge.native.nativeHostId}\nOne: ${challenge.native.oneId}\n받는 사람: ${challenge.audiencePrincipalIds.join(', ')}\n목적: ${challenge.purpose}\n\n• 완료된 원래 작업의 별도 검토한 요약만 공유합니다.\n• 키 저장 승인은 공유 권한을 주지 않습니다.\n• 개인 이력의 자동 수집은 시작하지 않습니다.`:`Organization: ${challenge.orgSession.organizationId}\nEmployee: ${challenge.orgSession.principalId}\nHost: ${challenge.native.nativeHostId}\nOne: ${challenge.native.oneId}\nAudience: ${challenge.audiencePrincipalIds.join(', ')}\nPurpose: ${challenge.purpose}\n\n• Only individually reviewed summaries of completed original work will be shared.\n• Credential storage approval grants no sharing permission.\n• Automatic personal history collection remains off.`);
  try{const association=await o.connection.complete(challenge,check);action.check();attach();return{state:'associated' as const,associationId:association.associationId,associationRevision:association.associationRevision}}catch(error){const approvalReceiptId=o.connection.pendingApproval(challenge.challengeId);if(approvalReceiptId)return{state:'unknown' as const,approvalReceiptId};throw error}
  }finally{associationApprovalPending=false;}
 });
 input.ipc.handle('businessNative:shareCompletedResult',async(event:IpcMainInvokeEvent,value:unknown)=>{
  const action=owned(event);if(!businessEmployeeAgentOnly(value,['commandId','agentResourceId','sourceResourceId','summary','expectedRevision'])||![value.commandId,value.agentResourceId,value.sourceResourceId].every(isBusinessId)||!businessEmployeeAgentText(value.summary)||value.expectedRevision!==null&&!isBusinessRevision(value.expectedRevision))deny();
  const v=value as unknown as {commandId:string;agentResourceId:string;sourceResourceId:string;summary:string;expectedRevision:number|null},o=original(),association=await o.connection.refresh(),resultOriginal=await o.source.inspect(v.commandId);action.check();
  const preparation={agentResourceId:v.agentResourceId,sourceResourceIds:[v.sourceResourceId]},expectations=await o.connection.request('prepare',preparation) as NativeEmployeeRootExpectations;action.check();
  await review(action.window,action.check,input.locale?.()==='ko'?'완료된 One 작업 요약 공유':'Share completed One work summary',input.locale?.()==='ko'?`조직: ${association.orgSession.organizationId}\n받는 사람: ${association.audiencePrincipalIds.join(', ')}\n원래 작업: ${resultOriginal.taskId}\n실행: ${resultOriginal.runId}\n결과 영수증: ${resultOriginal.resultReceiptId}\n이름: ${resultOriginal.profile.displayName}\n역할: ${resultOriginal.profile.role}\n\n공유할 요약:\n${v.summary}`:`Organization: ${association.orgSession.organizationId}\nAudience: ${association.audiencePrincipalIds.join(', ')}\nOriginal task: ${resultOriginal.taskId}\nRun: ${resultOriginal.runId}\nResult receipt: ${resultOriginal.resultReceiptId}\nName: ${resultOriginal.profile.displayName}\nRole: ${resultOriginal.profile.role}\n\nSummary to share:\n${v.summary}`);
  const current=await o.connection.refresh(),currentExpectations=await o.connection.request('prepare',preparation);action.check();
  if(digest(current)!==digest(association)||digest(currentExpectations)!==digest(expectations))throw Error('business_native_review_changed');
  const approved=()=>{action.check();if(digest(o.connection.current())!==digest(association))throw Error('business_native_review_changed')};approved();o.journal.initialize();attach();
  const cap=await o.source.accept({original:resultOriginal,summary:v.summary,associationId:association.associationId,associationRevision:association.associationRevision,sourceRevision:`source:${association.sourceRevision}`,consentRevision:`consent:${association.consentRevision}`},approved,record=>o.journal.checkpoint(record,expectations,v));
  const accepted=o.source.read(cap);return{state:'accepted' as const,acceptanceId:accepted!.acceptanceId,delivery:'pending' as const};
 });
 input.ipc.handle('businessNative:receipt',async(event:IpcMainInvokeEvent,value:unknown)=>{
  const action=owned(event);if(!businessEmployeeAgentOnly(value,['acceptanceId'])||!isBusinessId(value.acceptanceId))deny();const o=original(),cap=await o.source.restore(value.acceptanceId),delivery=await o.journal.owners.inspect(cap);action.check();
  if(!delivery)return{state:'unknown' as const};if(delivery.state==='ready')return{state:'accepted' as const,delivery:'not-dispatched' as const};
  const result=await o.journal.owners.lookup(cap,delivery.packet);action.check();if(!await o.journal.owners.currentResult(cap,result)||!await o.journal.owners.settle(cap,result))return{state:'unknown' as const};
  const publication=await o.journal.reconcilePublication(cap);action.check();
  // Copy only the original durable packet selection after a fresh current read.
  // This metadata is not registration, approval, or a publication grant.
  if(!await o.journal.owners.currentResult(cap,result))return{state:'unknown' as const};action.check();
  const selector=delivery.packet.approved.selector;
  const registrationSelector=publication!=='unknown'&&businessEmployeeAgentOnly(selector,['packetId','packetRevision'])&&isBusinessId(selector.packetId)&&isBusinessId(selector.packetRevision)
   ?{packetId:selector.packetId,packetRevision:selector.packetRevision}:undefined;
  return{state:'custody-confirmed' as const,receipt:result,publication,...(registrationSelector?{registrationSelector}:{})};
 });
 input.ipc.handle('businessNative:continuePublication',async(event:IpcMainInvokeEvent,value:unknown)=>{
  const action=owned(event);if(!businessEmployeeAgentOnly(value,['acceptanceId'])||!isBusinessId(value.acceptanceId))deny();
  const o=original(),cap=await o.source.restore(value.acceptanceId);action.check();
  // A read cannot initiate publication or promote an unknown attempt into a
  // retryable state. Only the stored original no-effect receipt enables review.
  if(await o.journal.reconcilePublication(cap)!=='awaiting-enrollment')return{publication:'unknown' as const};
  const record=await o.source.withCurrent(cap,r=>structuredClone(r)),association=await o.connection.refresh();action.check();
  await review(action.window,action.check,input.locale?.()==='ko'?'원래 요약의 조직 보고 발행 계속':'Continue publication of the original summary',input.locale?.()==='ko'?`조직: ${association.orgSession.organizationId}\n받는 사람: ${association.audiencePrincipalIds.join(', ')}\n원래 작업: ${record.original.taskId}\n원래 공유 승인: ${record.acceptanceId}\n\n원래 승인한 요약:\n${record.summary}\n\n직원 등록과 현재 권한을 다시 확인한 뒤 이 원래 요청의 발행만 계속합니다.`:`Organization: ${association.orgSession.organizationId}\nAudience: ${association.audiencePrincipalIds.join(', ')}\nOriginal task: ${record.original.taskId}\nOriginal sharing approval: ${record.acceptanceId}\n\nOriginally approved summary:\n${record.summary}\n\nContinue only this original publication after checking employee enrollment and current permission again.`);
  const check=()=>{action.check();if(digest(o.connection.current())!==digest(association))throw Error('business_native_review_changed')};
  check();const publication=await o.journal.continuePublication(cap,check);check();return{publication};
 });
 input.ipc.handle('businessNative:reconcileAssociation',async(event:IpcMainInvokeEvent,value:unknown)=>{const action=owned(event);if(!businessEmployeeAgentOnly(value,['approvalReceiptId'])||!isBusinessId(value.approvalReceiptId))deny();const o=original();requireAssociationGeneration();const association=await o.connection.reconcile(value.approvalReceiptId);action.check();requireAssociationGeneration();attach();return{state:'associated' as const,associationId:association.associationId}});
 input.ipc.handle('businessNative:revoke',async(event:IpcMainInvokeEvent)=>{
  owned(event);const o=original(),association=o.connection.current();if(!association)return{state:'unknown' as const};
  // Local source terminal fence precedes remote work and requires no current source
  // grant. Final cleanup runs even if Root or native key custody is unavailable.
  o.source.revokeAssociation(association.associationId);try{const receipt=await o.connection.request('revoke',{associationId:association.associationId,associationRevision:association.associationRevision,idempotencyKey:`revoke:${association.associationId}:${association.associationRevision}`});return{state:'revoked' as const,receipt}}
  finally{o.connection.invalidate();}
 });
 function retire(){retiredGeneration=input.installationGeneration();for(const cleanup of [()=>source?.close(),()=>connection?.close()])try{cleanup()}catch{cleanupUnknown=true}
  if(cleanupUnknown){personalClosed=true;throw Error('business_native_cleanup_unknown')}runtime=null;connection=null;source=null;journal=null;startup=null;
 }
 function closePersonal(){personalClosed=true;retire()}
 function close(){closed=true;closePersonal()}
 input.signal.addEventListener('abort',closePersonal,{once:true});input.hostSignal?.addEventListener('abort',close,{once:true});return Object.freeze({currentStartup,companyAgents:employeeTransfers.companyAgents,closePersonal,close,invalidate:retire});
}
export type NativeEmployeeMainEntry=ReturnType<typeof registerNativeEmployeeMain>;
