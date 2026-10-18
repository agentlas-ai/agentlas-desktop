/** Main-only native startup composition; never an IPC or renderer authority DTO. */
import {getAuthenticatedSessionBinding} from '../auth';
import {businessOnlyKeys,isBusinessId,isBusinessRevision,isBusinessSession,sameBusinessSession} from '../../shared/business/context';
import type {BusinessNativeInstallationIdentity,BusinessNativeOrganizationAssociation,BusinessNativeOrganizationAssociationOwner} from '../../shared/business/native-association';
import {createBusinessNativeStartupBindings,type BusinessNativeStartupInput} from '../business/native-startup';
import {composeOneVaultBusinessPolicy} from '../secrets/one-vault-business';
import {configureOneVaultMainPolicy,configureOneVaultMainPendingConsent,type OneVaultMainPendingConsent,configureOneProviderMainDomain,invalidateOneVaultMainAuthority} from '../secrets/one-vault-main';
import type {OneVaultRuntimePolicy} from '../secrets/one-vault-runtime';
import type {OneProviderDomainPorts} from '../secrets/one-provider-main';
import {configureOneToolchainNativeOwnerPorts,forgetAllOneToolchainNativeCapabilities,type OneToolchainNativeOwnerPorts} from './toolchain-native-runtime';
import {createNativeEmployeeCustodyProducer,type NativeEmployeeCustodyOwners} from '../business/native-employee-producer';
import {createBusinessEmployeeAgentReportProducer} from '../business/employee-agent-report-producer';

export type OneNativeEmployeeReportOwners=Pick<Parameters<typeof createBusinessEmployeeAgentReportProducer>[0],'projection'|'source'|'journal'|'publisher'>;

export interface OneNativeStartupOwners {
 /** Actual existing Main/Supervisor host ownership assertion, never a renderer flag. */
 readonly assertMainOwner:()=>void;
 /** Original Main shutdown lifetime; auth changes call invalidate('session') separately. */
 readonly signal:AbortSignal;
 /** Installed Main/runtime identity, independently supplied by the owning composition. */
 readonly currentNativeInstallation:()=>BusinessNativeInstallationIdentity|null;
 /** Original authenticated native/account/employee/One/host association. No default. */
 readonly association:BusinessNativeOrganizationAssociationOwner|null;
 /** Optional original accepted-event reporting family. Missing owners never create defaults. */
 readonly employeeReports?:Readonly<OneNativeEmployeeReportOwners>|null;
 readonly business?:BusinessNativeStartupInput|null;
 /** Native-custody v2 has no fabricated organization action epoch or registry. */
 readonly organizationIdentity?:{current():import('../../shared/business/context').BusinessSession|null};
 readonly nativeCustodyReports?:NativeEmployeeCustodyOwners|null;
 /** Genuine native personal intent/resource/permission/current-grant producers. */
 readonly personalVault?:OneVaultRuntimePolicy|null;
 readonly pendingConsent?:OneVaultMainPendingConsent|null;
 readonly credentialConsumer?:((commandId:string,toolId:string,keyName:string)=>boolean)|null;
 readonly provider?:OneProviderDomainPorts|null;
 readonly toolchains?:Omit<OneToolchainNativeOwnerPorts,'business'>|null;
}
let installed:{input:OneNativeStartupOwners;handle:ReturnType<typeof bind>;state:'installed'|'failed'}|null=null;
const retiredReportStartups=new WeakMap<object,()=>boolean>();
function deny(code:string):never{throw Error(code)}
function requireFunction(owner:unknown,name:string,code:string):void{if(!owner||typeof (owner as Record<string,unknown>)[name]!=='function')deny(code)}
function installation(value:unknown):value is BusinessNativeInstallationIdentity {
 if(!businessOnlyKeys(value,['nativeActor','custodyGeneration','installationGeneration'])||!businessOnlyKeys(value.nativeActor,['principalId','sessionId','workspaceId','oneId','hostId']))return false;
 const actor=value.nativeActor;
 return ['principalId','sessionId','workspaceId','oneId','hostId'].every(k=>isBusinessId(actor[k]))&&isBusinessId(value.custodyGeneration)&&isBusinessRevision(value.installationGeneration);
}
function installationKey(v:BusinessNativeInstallationIdentity):string {const a=v.nativeActor;return JSON.stringify([a.principalId,a.sessionId,a.workspaceId,a.oneId,a.hostId,v.custodyGeneration,v.installationGeneration]);}
function associationKey(v:BusinessNativeOrganizationAssociation):string {const s=v.organizationSession;return JSON.stringify([installationKey(v),v.origin.authorityId,v.origin.recordId,v.origin.revision,v.nativeSessionRevision,v.sourceRevision,s.principalId,s.sessionId,s.sessionRevision,s.authEpoch,s.deploymentId,s.organizationId,s.identityAuthorityId,s.hostId,s.expiresAt]);}
/** Capability issuance and inspection stay with the same original owner. A valid
 * metadata shape (even with equal session strings) never substitutes for it. */
function captureAssociation(input:OneNativeStartupOwners){
 const owner=input.association,identity=input.business?.shared.identity??input.organizationIdentity,currentNative=input.currentNativeInstallation;
 if(!owner||typeof owner.captureCurrent!=='function'||typeof owner.readCurrent!=='function'||typeof currentNative!=='function'||!identity||typeof identity.current!=='function')deny('one_native_startup_original_association_required');
 const capture=owner.captureCurrent,read=owner.readCurrent,currentIdentity=identity.current;
 const references=()=>input.association===owner&&owner.captureCurrent===capture&&owner.readCurrent===read&&input.currentNativeInstallation===currentNative&&(input.business?.shared.identity??input.organizationIdentity)===identity&&identity.current===currentIdentity;
 const current=()=>{
  if(!references())deny('one_native_startup_association_owner_changed');
  input.assertMainOwner();input.signal.throwIfAborted();
  const auth=getAuthenticatedSessionBinding(),native=currentNative.call(input),organization=currentIdentity.call(identity);
  if(!auth||auth.expiresAt!==null&&auth.expiresAt<=Date.now())deny('one_native_startup_authenticated_session_required');
  if(!installation(native)||native.nativeActor.principalId!==auth.userId||native.nativeActor.sessionId!==auth.sessionId||native.nativeActor.workspaceId!==auth.workspaceId)deny('one_native_startup_native_installation_changed');
  if(!isBusinessSession(organization)||Date.parse(organization.expiresAt)<=Date.now())deny('one_native_startup_business_identity_current_required');
  if(!references())deny('one_native_startup_association_owner_changed');
  return {native:structuredClone(native),organization:structuredClone(organization)};
 };
 const initial=current(),request=Object.freeze({...initial.native,nativeActor:Object.freeze(initial.native.nativeActor),organizationSession:Object.freeze(initial.organization)});
 const capability=capture.call(owner,request);
 if(!capability||typeof capability!=='object')deny('one_native_startup_original_association_required');
 let pinned:string|null=null;
 const assertCurrent=()=>{
  const before=current(),value=read.call(owner,capability),after=current();
  if(installationKey(before.native)!==installationKey(initial.native)||installationKey(after.native)!==installationKey(initial.native)||!sameBusinessSession(before.organization,initial.organization)||!sameBusinessSession(after.organization,initial.organization))deny('one_native_startup_association_changed');
  if(!businessOnlyKeys(value,['origin','nativeActor','custodyGeneration','installationGeneration','organizationSession','nativeSessionRevision','sourceRevision'])||!businessOnlyKeys(value.origin,['authorityId','recordId','revision'])||!(['authorityId','recordId','revision'] as const).every(k=>isBusinessId(value.origin[k]))||!isBusinessId(value.nativeSessionRevision)||!isBusinessId(value.sourceRevision)||!installation({nativeActor:value.nativeActor,custodyGeneration:value.custodyGeneration,installationGeneration:value.installationGeneration})||!isBusinessSession(value.organizationSession))deny('one_native_startup_original_association_required');
  const association=value as unknown as BusinessNativeOrganizationAssociation;
  if(installationKey(association)!==installationKey(initial.native)||!sameBusinessSession(association.organizationSession,initial.organization))deny('one_native_startup_association_changed');
  const key=associationKey(association);if(pinned!==null&&pinned!==key)deny('one_native_startup_association_changed');pinned=key;
  return before.native;
 };
 assertCurrent();return {assertCurrent};
}
/** No activation work until genuine supplied owners pass structural preflight.
 * Presence of a callable port is installation availability, NEVER a grant/receipt. */
export function installOneNativeStartup(input:OneNativeStartupOwners){
 if(installed){if(installed.input!==input||installed.state!=='installed')deny('one_native_startup_original_installation_required');installed.handle.currentEpoch();return installed.handle;}
 const association=captureAssociation(input);
 if(input.employeeReports!==undefined&&input.employeeReports!==null&&!businessOnlyKeys(input.employeeReports,['projection','source','journal','publisher']))deny('employee_agent_original_family_required');
 const hasVault=input.personalVault!=null||input.pendingConsent!=null||input.credentialConsumer!=null;
 if(hasVault){
  requireFunction(input.personalVault,'currentIntent','one_native_vault_intent_owner_unbound');requireFunction(input.personalVault?.personal,'current','one_native_personal_authority_unbound');
  requireFunction(input.personalVault,'currentGrant','one_native_vault_current_grant_unbound');requireFunction(input.personalVault,'invalidateProviderReadiness','one_native_provider_invalidation_owner_unbound');
  requireFunction(input.pendingConsent,'approveOriginalPending','one_native_pending_consent_owner_unbound');
  if(typeof input.credentialConsumer!=='function')deny('one_native_credential_consumer_unbound');
 }
 if(input.provider!=null){if(!hasVault)deny('one_native_provider_vault_owner_unbound');for(const name of ['resolve','stillCurrent','readText','approvedArtifactRoot','currentGrant'])requireFunction(input.provider,name,'one_native_provider_source_owner_unbound');}
 if(input.toolchains!=null){
  for(const name of ['registerProduced','resolveAsset','resolveAudience','registerCall','resolveCall','currentCall','resolveReportIntent','currentReportIntent','ownerConversation','currentAsset','currentAudience'])requireFunction(input.toolchains.owners,name,'toolchain_native_shipping_owner_ports_unbound');
  for(const name of ['signal','assertCurrent','assertCandidate','withLifetime','producedSources','withPreparedCommit'])requireFunction(input.toolchains.preparation,name,'toolchain_native_preparation_owner_unbound');
  for(const name of ['signal','assertCurrent','withLifetime'])requireFunction(input.toolchains.execution,name,'toolchain_native_execution_owner_unbound');
 }
 if(input.employeeReports&&input.nativeCustodyReports)deny('one_native_report_family_conflict');
 if(!input.business&&(hasVault||input.toolchains||input.employeeReports))deny('one_native_business_original_startup_required');
 if(!hasVault&&!input.toolchains&&!input.employeeReports&&!input.nativeCustodyReports)deny('one_native_startup_family_unbound');
 const business=input.business?createBusinessNativeStartupBindings(input.business):null;
 for(const family of [...(hasVault?[business!.vault]:[]),...(input.toolchains?[business!.toolchains]:[])]){const missing=family.blocker();if(missing){business!.invalidate();deny(missing);}}
 association.assertCurrent();const handle=bind(input,business,association);installed={input,handle,state:'failed'};
 try{
  // Existing sole authority router is installed by the existing policy composer.
  input.assertMainOwner();input.signal.throwIfAborted();
  if(handle.personalPolicy&&handle.pendingConsent&&handle.consumer){
   const policy=composeOneVaultBusinessPolicy(handle.personalPolicy,business!.vault,business!.data);
   configureOneVaultMainPolicy(policy,handle.consumer);
   configureOneVaultMainPendingConsent(handle.pendingConsent);
  }
  input.assertMainOwner();input.signal.throwIfAborted();
  if(handle.provider)configureOneProviderMainDomain(handle.provider);
  input.assertMainOwner();input.signal.throwIfAborted();
  if(handle.toolchains)configureOneToolchainNativeOwnerPorts(handle.toolchains);
  input.assertMainOwner();input.signal.throwIfAborted();
  handle.activate();installed.state='installed';return handle;
 }catch(error){try{handle.invalidate('shutdown')}catch{}throw error;}
}
/** Main calls this only after its original drain and generation ticket complete.
 * Releasing a clean report-only installation grants nothing and never resumes
 * old approvals, pending deliveries, Vault policy, providers or toolchains. */
export function retireOneNativeReportStartup(previous:object):void {
 if(!installed||installed.handle!==previous||installed.state!=='installed'||retiredReportStartups.get(previous)?.()!==true)
  deny('one_native_startup_retirement_unconfirmed');
 retiredReportStartups.delete(previous);installed=null;
}
function bind(input:OneNativeStartupOwners,business:ReturnType<typeof createBusinessNativeStartupBindings>|null,association:ReturnType<typeof captureAssociation>){
 let active=false,closed=false,generation=0,cleanupUnknown=false;
 const originalSignal=input.signal;
 const reportOnly=input.nativeCustodyReports!=null&&[input.business,input.employeeReports,input.personalVault,input.pendingConsent,input.credentialConsumer,input.provider,input.toolchains].every(value=>value==null);
 let employeeReports:ReturnType<typeof createBusinessEmployeeAgentReportProducer>|ReturnType<typeof createNativeEmployeeCustodyProducer>|null=null;
 let reportCleanup:(()=>boolean)|null=null;
 const lifetimeObservers=new Set<(reason:'session'|'shutdown')=>void>();
 const references=()=>[input.assertMainOwner,input.signal,input.business,input.business?.shared.sessions,input.business?.shared.identity,input.business?.shared.authority,input.business?.shared.registry,input.business?.vault?.intents,input.business?.vault?.admission,input.business?.data?.contexts,input.business?.data?.admission,input.business?.data?.documents,input.business?.toolchains?.contexts,input.business?.toolchains?.admission,input.business?.toolchains?.effects,input.personalVault,input.personalVault?.personal,input.pendingConsent,input.credentialConsumer,input.provider,input.toolchains?.owners,input.toolchains?.preparation,input.toolchains?.execution,input.employeeReports,input.employeeReports?.projection,input.employeeReports?.source,input.employeeReports?.journal,input.employeeReports?.publisher,input.organizationIdentity,input.organizationIdentity?.current,input.nativeCustodyReports];
 const originalReferences=references();
 const check=()=>{if(cleanupUnknown)deny('one_native_startup_cleanup_unconfirmed');if(closed||!active)deny('one_native_startup_unavailable');try{if(references().some((value,index)=>value!==originalReferences[index]))deny('one_native_startup_owner_ports_changed');const reportBlocker=employeeReports?.blocker();if(reportBlocker)deny(reportBlocker);return association.assertCurrent();}catch(error){invalidate('session');throw error}};
 const witness=()=>{const g=generation,s=check();return()=>{try{const n=check();return generation===g&&installationKey(n)===installationKey(s);}catch{return false}}};
 // Original values/leases remain owner-issued. This fence grants nothing.
 const guard=<T extends object>(port:T):T=>{
  const methods=new Map<PropertyKey,unknown>();
  for(let at:object|null=port;at&&at!==Object.prototype;at=Object.getPrototypeOf(at))for(const key of Reflect.ownKeys(at))if(key!=='constructor'&&!methods.has(key)){const value=Reflect.get(port,key,port);if(typeof value==='function')methods.set(key,value);}
  return new Proxy(port,{get(target,key){const value=Reflect.get(target,key,target);if(methods.has(key)&&methods.get(key)!==value){invalidate('session');deny('one_native_startup_owner_ports_changed')}if(typeof value!=='function')return value;return (...args:unknown[])=>{const current=witness(),finish=()=>{if(!current()||Reflect.get(target,key,target)!==value){invalidate('session');deny('one_native_startup_current_changed')}};finish();let result;try{result=Reflect.apply(value,target,args)}catch(error){finish();throw error}if(result&&typeof result.then==='function')return result.then((v:unknown)=>{finish();return v},(error:unknown)=>{finish();throw error});finish();return result;};}});
 };
 // The existing composer enumerates its policy input. Project inherited methods too,
 // while every read/call remains delegated to its original native receiver.
 const originalPolicy=input.personalVault,personal=originalPolicy?guard(originalPolicy.personal):null;
 const projection=Object.create(null) as OneVaultRuntimePolicy,keys=new Set<PropertyKey>();
 for(let owner:object|null=originalPolicy??null;owner&&owner!==Object.prototype;owner=Object.getPrototypeOf(owner))
  for(const key of Reflect.ownKeys(owner))if(key!=='constructor')keys.add(key);
 for(const key of keys){const original=Reflect.get(originalPolicy!,key,originalPolicy!),bound=typeof original==='function'?original.bind(originalPolicy):original;Object.defineProperty(projection,key,{enumerable:true,configurable:false,get(){
  if(key==='personal')return personal;
  if(Reflect.get(originalPolicy!,key,originalPolicy!)!==original){invalidate('session');deny('one_native_startup_owner_ports_changed')}return bound;
 }});}
 const personalPolicy=originalPolicy?guard(projection):null,pendingConsent=input.pendingConsent?guard(input.pendingConsent):null,provider=input.provider?guard(input.provider):null;
 const businessFacade:OneToolchainNativeOwnerPorts['business']={
  async prepareCurrentAction(request){const current=witness(),result=await business!.toolchains.prepareCurrentAction(request);if(!current()){result.release();deny('one_native_startup_current_changed')}return Object.freeze({...result,stillCurrent:()=>current()&&result.stillCurrent()});},
  async withCurrentExclusion(requests,reducer){const current=witness();const result=await business!.toolchains.withCurrentExclusion(requests,scope=>{if(!current())deny('one_native_startup_current_changed');const value=reducer(scope);if(!current())deny('one_native_startup_current_changed');return value;});if(!current())deny('one_native_startup_effect_result_unknown');return result;},
 };
 const toolchains:OneToolchainNativeOwnerPorts|null=input.toolchains?{owners:guard(input.toolchains.owners),business:businessFacade,preparation:guard(input.toolchains.preparation!),execution:guard(input.toolchains.execution!)}:null;
 const consumer=input.credentialConsumer? (...args:Parameters<NonNullable<OneNativeStartupOwners['credentialConsumer']>>)=>{try{const current=witness(),result=input.credentialConsumer!(...args);return current()&&result===true;}catch{return false}}:null;
 const invalidate=(reason:'session'|'shutdown')=>{generation++;closed=true;active=false;for(const listener of lifetimeObservers)try{listener(reason)}catch{cleanupUnknown=true;}for(const cleanup of [()=>employeeReports?.close(),()=>business?.invalidate(),()=>{if(toolchains)forgetAllOneToolchainNativeCapabilities()},()=>{if(personalPolicy)invalidateOneVaultMainAuthority()}])try{cleanup()}catch{cleanupUnknown=true;}if(cleanupUnknown)deny('one_native_startup_cleanup_unconfirmed');};
 if(input.employeeReports){
  if(!input.business||!business)deny('one_native_business_original_startup_required');
  employeeReports=createBusinessEmployeeAgentReportProducer({...input.employeeReports,shared:input.business.shared,originalBusiness:business,lifetime:{signal:input.signal,current:()=>{try{check();return true}catch{return false}}}});
  const blocker=employeeReports.blocker();if(blocker){employeeReports.close();business?.invalidate();deny(blocker);}
 }
 if(input.nativeCustodyReports){
  const producer=createNativeEmployeeCustodyProducer(input.nativeCustodyReports,{signal:input.signal,current:()=>{try{check();return true}catch{return false}}});
  employeeReports=producer;reportCleanup=()=>producer.cleanlyClosed();
  const blocker=employeeReports.blocker();if(blocker){employeeReports.close();business?.invalidate();deny(blocker);}
 }
 const abort=()=>{try{invalidate('shutdown')}catch{/* sticky uncertainty remains observable through invalidate() */}};
 input.signal.addEventListener('abort',abort,{once:true});
 const handle=Object.freeze({personalPolicy,pendingConsent,provider,toolchains,consumer,
  signal:input.signal,
  currentEpoch(){check();return generation;},
  onInvalidated(listener:(reason:'session'|'shutdown')=>void){check();lifetimeObservers.add(listener);return()=>{lifetimeObservers.delete(listener);};},
  activate(){if(closed||input.signal.aborted)deny('one_native_startup_unavailable');if(active){check();return;}active=true;check();if(employeeReports&&!employeeReports.attach())deny('employee_agent_original_attachment_unconfirmed');check();},
  employeeReportStatus(){let current=false;try{check();current=true}catch{}const blocker=employeeReports?.blocker()??(employeeReports?null:'employee_agent_original_family_unbound');return {available:current&&blocker===null,blocker:blocker??(current?null:'one_native_startup_unavailable')};},
  invalidate,ready(){try{check();return true}catch{return false}},
  /** Never replaces owners or resumes an uncertain native effect. */
  originalBusiness:business,
 });
 retiredReportStartups.set(handle,()=>reportOnly&&closed&&!active&&!cleanupUnknown&&originalSignal.aborted&&reportCleanup?.()===true);
 return handle;
}
