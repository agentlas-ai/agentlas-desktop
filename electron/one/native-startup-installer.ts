/** Main-only native startup composition; never an IPC or renderer authority DTO. */
import {getAuthenticatedSessionBinding} from '../auth';
import {isBusinessSession} from '../../shared/business/context';
import {createBusinessNativeStartupBindings,type BusinessNativeStartupInput} from '../business/native-startup';
import {composeOneVaultBusinessPolicy} from '../secrets/one-vault-business';
import {configureOneVaultMainPolicy,configureOneVaultMainPendingConsent,type OneVaultMainPendingConsent,configureOneProviderMainDomain,invalidateOneVaultMainAuthority} from '../secrets/one-vault-main';
import type {OneVaultRuntimePolicy} from '../secrets/one-vault-runtime';
import type {OneProviderDomainPorts} from '../secrets/one-provider-main';
import {configureOneToolchainNativeOwnerPorts,forgetAllOneToolchainNativeCapabilities,type OneToolchainNativeOwnerPorts} from './toolchain-native-runtime';

export interface OneNativeStartupOwners {
 /** Actual existing Main/Supervisor host ownership assertion, never a renderer flag. */
 readonly assertMainOwner:()=>void;
 /** Original Main shutdown lifetime; auth changes call invalidate('session') separately. */
 readonly signal:AbortSignal;
 readonly business:BusinessNativeStartupInput;
 /** Genuine native personal intent/resource/permission/current-grant producers. */
 readonly personalVault:OneVaultRuntimePolicy;
 readonly pendingConsent:OneVaultMainPendingConsent;
 readonly credentialConsumer:(commandId:string,toolId:string,keyName:string)=>boolean;
 readonly provider:OneProviderDomainPorts;
 readonly toolchains:Omit<OneToolchainNativeOwnerPorts,'business'>;
}
let installed:{input:OneNativeStartupOwners;handle:ReturnType<typeof bind>;state:'installed'|'failed'}|null=null;
function deny(code:string):never{throw Error(code)}
function requireFunction(owner:unknown,name:string,code:string):void{if(!owner||typeof (owner as Record<string,unknown>)[name]!=='function')deny(code)}
/** No activation work until genuine supplied owners pass structural preflight.
 * Presence of a callable port is installation availability, NEVER a grant/receipt. */
export function installOneNativeStartup(input:OneNativeStartupOwners){
 if(installed){if(installed.input!==input||installed.state!=='installed')deny('one_native_startup_original_installation_required');return installed.handle;}
 input.assertMainOwner();input.signal.throwIfAborted();const native=getAuthenticatedSessionBinding();if(!native)deny('one_native_startup_authenticated_session_required');const identity=input.business.shared.identity?.current();if(!isBusinessSession(identity)||identity.principalId!==native.userId||identity.sessionId!==native.sessionId||Date.parse(identity.expiresAt)<=Date.now())deny('one_native_startup_business_identity_current_required');
 requireFunction(input.personalVault,'currentIntent','one_native_vault_intent_owner_unbound');requireFunction(input.personalVault.personal,'current','one_native_personal_authority_unbound');
 requireFunction(input.personalVault,'currentGrant','one_native_vault_current_grant_unbound');requireFunction(input.personalVault,'invalidateProviderReadiness','one_native_provider_invalidation_owner_unbound');
 requireFunction(input.pendingConsent,'approveOriginalPending','one_native_pending_consent_owner_unbound');
 if(typeof input.credentialConsumer!=='function')deny('one_native_credential_consumer_unbound');
 for(const name of ['resolve','stillCurrent','readText','approvedArtifactRoot','currentGrant'])requireFunction(input.provider,name,'one_native_provider_source_owner_unbound');
 for(const name of ['registerProduced','resolveAsset','resolveAudience','registerCall','resolveCall','currentCall','resolveReportIntent','currentReportIntent','ownerConversation','currentAsset','currentAudience'])requireFunction(input.toolchains.owners,name,'toolchain_native_shipping_owner_ports_unbound');
 for(const name of ['signal','assertCurrent','assertCandidate','withLifetime','producedSources','withPreparedCommit'])requireFunction(input.toolchains.preparation,name,'toolchain_native_preparation_owner_unbound');
 for(const name of ['signal','assertCurrent','withLifetime'])requireFunction(input.toolchains.execution,name,'toolchain_native_execution_owner_unbound');
 const business=createBusinessNativeStartupBindings(input.business);
 for(const family of [business.vault,business.toolchains]){const missing=family.blocker();if(missing){business.invalidate();deny(missing);}}
 const handle=bind(input,business);installed={input,handle,state:'failed'};
 try{
  // Existing sole authority router is installed by the existing policy composer.
  const policy=composeOneVaultBusinessPolicy(handle.personalPolicy,business.vault,business.data);
  input.assertMainOwner();input.signal.throwIfAborted();
  configureOneVaultMainPolicy(policy,handle.consumer);
  configureOneVaultMainPendingConsent(handle.pendingConsent);
  input.assertMainOwner();input.signal.throwIfAborted();
  configureOneProviderMainDomain(handle.provider);
  input.assertMainOwner();input.signal.throwIfAborted();
  configureOneToolchainNativeOwnerPorts(handle.toolchains);
  input.assertMainOwner();input.signal.throwIfAborted();
  installed.state='installed';handle.activate();return handle;
 }catch(error){try{handle.invalidate('shutdown')}catch{}throw error;}
}
function bind(input:OneNativeStartupOwners,business:ReturnType<typeof createBusinessNativeStartupBindings>){
 let active=false,closed=false,generation=0,cleanupUnknown=false;
 const lifetimeObservers=new Set<(reason:'session'|'shutdown')=>void>();
 const references=()=>[input.assertMainOwner,input.signal,input.business,input.business.shared.sessions,input.business.shared.identity,input.business.shared.authority,input.business.shared.registry,input.business.vault?.intents,input.business.vault?.admission,input.business.data?.contexts,input.business.data?.admission,input.business.data?.documents,input.business.toolchains?.contexts,input.business.toolchains?.admission,input.business.toolchains?.effects,input.personalVault,input.pendingConsent,input.credentialConsumer,input.provider,input.toolchains.owners,input.toolchains.preparation,input.toolchains.execution];
 const originalReferences=references();
 const check=()=>{if(cleanupUnknown)deny('one_native_startup_cleanup_unconfirmed');if(references().some((value,index)=>value!==originalReferences[index])){closed=true;active=false;deny('one_native_startup_owner_ports_changed')}if(closed||!active)deny('one_native_startup_unavailable');input.signal.throwIfAborted();input.assertMainOwner();const s=getAuthenticatedSessionBinding();if(!s||s.expiresAt!==null&&s.expiresAt<=Date.now())deny('one_native_startup_authenticated_session_required');const identity=input.business.shared.identity?.current();if(!isBusinessSession(identity)||identity.principalId!==s.userId||identity.sessionId!==s.sessionId||Date.parse(identity.expiresAt)<=Date.now())deny('one_native_startup_business_identity_current_required');return s;};
 const witness=()=>{const g=generation,s=check();return()=>{try{const n=check();return generation===g&&n.userId===s.userId&&n.sessionId===s.sessionId&&n.workspaceId===s.workspaceId;}catch{return false}}};
 // Original values/leases remain owner-issued. This fence grants nothing.
 const guard=<T extends object>(port:T):T=>new Proxy(port,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{const current=witness();const result=Reflect.apply(value,target,args);if(result&&typeof result.then==='function')return result.then((v:unknown)=>{if(!current())deny('one_native_startup_current_changed');return v});if(!current())deny('one_native_startup_current_changed');return result;};}});
 // The existing composer enumerates its policy input. Project inherited methods too,
 // while every read/call remains delegated to its original native receiver.
 const originalPolicy=input.personalVault,personal=guard(originalPolicy.personal);
 const projection=Object.create(null) as OneVaultRuntimePolicy,keys=new Set<PropertyKey>();
 for(let owner:object|null=originalPolicy;owner&&owner!==Object.prototype;owner=Object.getPrototypeOf(owner))
  for(const key of Reflect.ownKeys(owner))if(key!=='constructor')keys.add(key);
 for(const key of keys)Object.defineProperty(projection,key,{enumerable:true,configurable:false,get(){
  if(key==='personal')return personal;
  const value=Reflect.get(originalPolicy,key,originalPolicy);
  return typeof value==='function'?value.bind(originalPolicy):value;
 }});
 const personalPolicy=guard(projection),pendingConsent=guard(input.pendingConsent),provider=guard(input.provider);
 const businessFacade:OneToolchainNativeOwnerPorts['business']={
  async prepareCurrentAction(request){const current=witness(),result=await business.toolchains.prepareCurrentAction(request);if(!current()){result.release();deny('one_native_startup_current_changed')}return Object.freeze({...result,stillCurrent:()=>current()&&result.stillCurrent()});},
  async withCurrentExclusion(requests,reducer){const current=witness();const result=await business.toolchains.withCurrentExclusion(requests,scope=>{if(!current())deny('one_native_startup_current_changed');const value=reducer(scope);if(!current())deny('one_native_startup_current_changed');return value;});if(!current())deny('one_native_startup_effect_result_unknown');return result;},
 };
 const toolchains:OneToolchainNativeOwnerPorts={owners:guard(input.toolchains.owners),business:businessFacade,preparation:guard(input.toolchains.preparation!),execution:guard(input.toolchains.execution!)};
 const consumer=(...args:Parameters<OneNativeStartupOwners['credentialConsumer']>)=>{try{check();return input.credentialConsumer(...args)===true;}catch{return false}};
 const invalidate=(reason:'session'|'shutdown')=>{generation++;if(reason==='shutdown'){closed=true;active=false;}for(const listener of lifetimeObservers)try{listener(reason)}catch{cleanupUnknown=true;}for(const cleanup of [()=>business.invalidate(),()=>forgetAllOneToolchainNativeCapabilities(),()=>invalidateOneVaultMainAuthority()])try{cleanup()}catch{cleanupUnknown=true;}if(cleanupUnknown)deny('one_native_startup_cleanup_unconfirmed');};
 const abort=()=>{try{invalidate('shutdown')}catch{/* sticky uncertainty remains observable through invalidate() */}};
 input.signal.addEventListener('abort',abort,{once:true});
 return Object.freeze({personalPolicy,pendingConsent,provider,toolchains,consumer,
  signal:input.signal,
  currentEpoch(){check();return generation;},
  onInvalidated(listener:(reason:'session'|'shutdown')=>void){check();lifetimeObservers.add(listener);return()=>{lifetimeObservers.delete(listener);};},
  activate(){if(closed||input.signal.aborted)deny('one_native_startup_unavailable');active=true;check();},
  invalidate,ready(){try{check();return true}catch{return false}},
  /** Never replaces owners or resumes an uncertain native effect. */
  originalBusiness:business,
 });
}
