import { randomUUID } from 'node:crypto';
import type { BrowserWindow,IpcMain,IpcMainInvokeEvent } from 'electron';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { businessOnlyKeys,isBusinessId } from '../../shared/business/context';
import { isValidRuntimeSelectionInput } from '../../shared/runtime-selection';
import type { RuntimeSelection } from '../../shared/types';
import type { OneVaultSqlite } from '../secrets/one-vault-journal';
import type { CompanyAgentAssetOwner } from './employee-agent-transfer-custody';
import { reviewHostCompanyProvider,companyProviderHost,revokeCompanyProvider } from './company-work-provider';
import { installCompanyWorkPort } from './company-work-port';
interface Input{ipc:Pick<IpcMain,'handle'>;assertTrustedSender(event:IpcMainInvokeEvent):void;isOwnerWindow(window:BrowserWindow):boolean;companyAgents():CompanyAgentAssetOwner;companyDb():OneVaultSqlite;companyDataPath(...segments:string[]):string;signal:AbortSignal}
/** Explicit Native dual-consent review. Renderer chooses a selector but cannot
 * mint an asset, provider permit, work policy, or run capability. */
export function registerCompanyWorkMain(input:Input){
 const electron=()=>require('electron') as typeof import('electron');
 let activePolicyId:string|null=null,activeOrganizationId:string|null=null,activeReview: {owner:CompanyAgentAssetOwner;asset:object;provider:object;reviewId:string}|null=null;
 let closed=false,stopEpoch=0,active:Awaited<ReturnType<typeof installCompanyWorkPort>>|null=null;
 const pendingActivations=new Set<AbortController>();
 const abortPending=()=>{for(const controller of pendingActivations)controller.abort('company_work_stopped');pendingActivations.clear()};
 const reviews=new Map<string,{window:BrowserWindow;owner:CompanyAgentAssetOwner;asset:object;provider:object;expiresAt:number}>();
 const current=(epoch:number,check:()=>void)=>{check();if(epoch!==stopEpoch)throw Error('company_work_stopped')};
 const clearReviews=()=>{for(const review of reviews.values())revokeCompanyProvider(review.provider);reviews.clear()};
 function owned(event:IpcMainInvokeEvent){input.assertTrustedSender(event);const window=electron().BrowserWindow.fromWebContents(event.sender);
  const check=()=>{input.assertTrustedSender(event);if(closed||input.signal.aborted||isAppControlEvent(event)||!window||window.isDestroyed()||!window.isFocused()||!input.isOwnerWindow(window)||event.senderFrame!==event.sender.mainFrame||electron().BrowserWindow.fromWebContents(event.sender)!==window)throw Error('company_work_focused_owner_required')};check();return{window:window!,check};}
 input.ipc.handle('businessCompanyWork:review',async(event,value:unknown)=>{const action=owned(event),epoch=stopEpoch;
  if(!businessOnlyKeys(value,['agentId','runtime'])||!isBusinessId(value.agentId)||!isValidRuntimeSelectionInput(value.runtime))throw Error('company_work_request_invalid');
  const owner=input.companyAgents(),asset=await owner.capture(value.agentId);current(epoch,action.check);if(!asset)throw Error('company_work_source_required');const selected=owner.read(asset);if(!selected)throw Error('company_work_source_required');
  clearReviews();let provider:object|null=null,reviewId:string|null=null;
  try{
   provider=await reviewHostCompanyProvider(value.runtime as RuntimeSelection,()=>current(epoch,action.check),async host=>{
    const result=await electron().dialog.showMessageBox(action.window,{type:'question',buttons:['Cancel','Allow this company provider'],defaultId:0,cancelId:0,noLink:true,title:'Company work provider',message:'Review company work on this host',detail:`Organization: ${selected.organizationSession.organizationId}\nEmployee: ${selected.employeePrincipalId}\nAgent: ${selected.agentId}\nProvider: ${host.runtime.kind==='claude-code'?'Claude Code subscription':host.runtime.backend}\nModel: ${host.runtime.model}\n${host.runtime.kind==='claude-code'?`Original CLI: ${host.runtime.source}\nSubscription and binary fingerprint: ${host.configurationDigest}`:`Credential source: ${host.sourceKind}\nFingerprint: ${host.credential?.fingerprint??"Original provider metadata will be created after this approval."}`}\nMaximum 20 runs, 2048 output tokens per run, 30 minutes.\nCompany Mail and approved input files; bounded per-job company output files only. Company operator must separately approve this exact configuration. This does not share the key or personal context.`});current(epoch,action.check);return result.response===1;
   });current(epoch,action.check);owner.assertCurrent(asset);const host=await companyProviderHost(provider);current(epoch,action.check);
   const rootReview=await owner.request(asset,{operation:'review',payload:{host,maxRuns:20,maxOutputTokens:2048,expiresAt:new Date(Math.min(Date.now()+1800000,Date.parse(selected.organizationSession.expiresAt))).toISOString()}}) as {reviewId?:unknown};current(epoch,action.check);if(!rootReview||typeof rootReview.reviewId!=='string'||!isBusinessId(rootReview.reviewId))throw Error('company_work_review_receipt_invalid');reviewId=rootReview.reviewId;
   reviews.set(reviewId,{window:action.window,owner,asset,provider,expiresAt:Date.now()+600000});
   return{reviewId,host,asset:{sourceKind:selected.sourceKind,registrationId:selected.registrationId,transferId:selected.transferId,agentId:selected.agentId,agentResourceId:selected.agentResourceId,packageDigest:selected.packageDigest,targetRevision:selected.targetRevision},associationId:selected.associationId,associationRevision:selected.associationRevision,organizationId:selected.organizationSession.organizationId};
  }catch(error){if(reviewId&&reviews.get(reviewId)?.provider===provider)reviews.delete(reviewId);if(provider)revokeCompanyProvider(provider);throw error}
 });
 input.ipc.handle('businessCompanyWork:choices',async(event,value:unknown)=>{const action=owned(event),epoch=stopEpoch;if(!businessOnlyKeys(value,['reviewId'])||!isBusinessId(value.reviewId))throw Error('company_work_request_invalid');const review=reviews.get(value.reviewId);if(!review||review.window!==action.window||review.owner!==input.companyAgents()||review.expiresAt<=Date.now())throw Error('company_work_review_required');await companyProviderHost(review.provider);current(epoch,action.check);const result=await review.owner.request(review.asset,{operation:'policies',payload:{reviewId:value.reviewId}});current(epoch,action.check);if(reviews.get(value.reviewId)!==review)throw Error('company_work_review_required');return result});
 input.ipc.handle('businessCompanyWork:activate',async(event,value:unknown)=>{const action=owned(event),epoch=stopEpoch;
  if(!businessOnlyKeys(value,['reviewId','policyId'])||!isBusinessId(value.reviewId)||!isBusinessId(value.policyId))throw Error('company_work_request_invalid');
  const review=reviews.get(value.reviewId);if(!review||review.window!==action.window||review.owner!==input.companyAgents()||review.expiresAt<=Date.now())throw Error('company_work_review_required');
  const available=await review.owner.request(review.asset,{operation:'policies',payload:{reviewId:value.reviewId}}) as {policies?:unknown};current(epoch,action.check);if(reviews.get(value.reviewId)!==review||!available||!Array.isArray(available.policies)||!available.policies.some(p=>p&&p.policyId===value.policyId))throw Error('company_work_policy_selection_required');
  reviews.delete(value.reviewId);review.owner.assertCurrent(review.asset);active?.close();active=null;activePolicyId=null;activeReview=null;activeOrganizationId=null;
  const activation=new AbortController(),activationSignal=AbortSignal.any([input.signal,activation.signal]);pendingActivations.add(activation);
  let installed:Awaited<ReturnType<typeof installCompanyWorkPort>>|null=null;
  try{installed=await installCompanyWorkPort({owner:review.owner,assetCapability:review.asset,providerCapability:review.provider,policyId:value.policyId,db:input.companyDb(),companyDataPath:input.companyDataPath,signal:activationSignal});current(epoch,action.check);const asset=review.owner.read(review.asset);if(!asset)throw Error('company_work_source_required');active=installed;activePolicyId=value.policyId;activeReview={...review,reviewId:value.reviewId};activeOrganizationId=asset.organizationSession.organizationId;return{state:'active',policyId:value.policyId}}catch(error){installed?.close();if(active===installed){active=null;activePolicyId=null;activeReview=null;activeOrganizationId=null}revokeCompanyProvider(review.provider);throw error}finally{pendingActivations.delete(activation)}
 });
 input.ipc.handle('businessCompanyWork:status',async(event)=>{const action=owned(event),epoch=stopEpoch,installed=active,review=activeReview;let available=false;try{if(installed?.port.currentKey()&&review&&review.owner===input.companyAgents()){review.owner.assertCurrent(review.asset);await companyProviderHost(review.provider);current(epoch,action.check);const result=await review.owner.request(review.asset,{operation:'policies',payload:{reviewId:review.reviewId}}) as {policies?:unknown};current(epoch,action.check);available=active===installed&&activeReview===review&&!!result&&Array.isArray(result.policies)&&result.policies.some(p=>p&&p.policyId===activePolicyId)}}catch{}return{state:available?'active':'inactive',policyId:available?activePolicyId:null,organizationId:available?activeOrganizationId:null}});
 input.ipc.handle('businessCompanyWork:stop',async(event)=>{owned(event);stopEpoch++;abortPending();active?.close();active=null;activeReview=null;activePolicyId=null;activeOrganizationId=null;clearReviews();return{state:'stopped'}});
 function close(){if(closed)return;closed=true;stopEpoch++;abortPending();active?.close();active=null;activeReview=null;activePolicyId=null;activeOrganizationId=null;clearReviews()}
 input.signal.addEventListener('abort',close,{once:true});return Object.freeze({close});
}
