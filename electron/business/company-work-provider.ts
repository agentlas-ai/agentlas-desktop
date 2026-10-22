import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { RuntimeBackend, RuntimeSelection } from '../../shared/types';
import type { CompanyWorkHost } from '../../shared/business/company-work';
import { isCompanyWorkByokBackend,normalizeCompanyWorkCustomEndpoint } from '../../shared/business/company-work';
import { readByokWire } from '../runtime/byok-wire';
import { readGeminiCacheSetting } from '../runtime/gemini-explicit-cache';
import { describeApiKey,ensureExistingApiKeyDescriptor,retryCredentialReadFromUser } from '../secrets/vault';
import { getDb } from '../store/db';
import {reviewCompanyClaudePin,assertCompanyClaudePin,type CompanyClaudePin} from './company-work-claude';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Permit={host:CompanyWorkHost;assertFocusedOwner:()=>void;current:()=>Promise<void>;closed:boolean;claude?:CompanyClaudePin;customEndpoint?:string};
const permits=new WeakMap<object,Permit>();
const scope=new AsyncLocalStorage<Permit>();
function fail():never{throw Error('company_work_provider_consent_required')}
function currentCustomEndpoint():string|null{
 try{const row=getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as {value?:unknown}|undefined;
  return normalizeCompanyWorkCustomEndpoint(row?.value);
 }catch{return null}
}
/** Called only by the focused Native owner after displaying this exact value-free
 * descriptor. The original credential owner keeps the secret in its own vault. */
export async function reviewHostCompanyProvider(runtime:RuntimeSelection,assertFocusedOwner:()=>void,review:(host:CompanyWorkHost,customEndpoint:string|null)=>Promise<boolean>):Promise<object>{
 assertFocusedOwner();
 if(runtime.kind==='claude-code'){
  const pin=await reviewCompanyClaudePin(runtime,assertFocusedOwner);
  const host:CompanyWorkHost={sourceKind:'host-consented',runtime:Object.freeze({...runtime}),credential:null,configurationDigest:pin.configurationDigest};
  if(!await review(host,null))fail();assertFocusedOwner();await assertCompanyClaudePin(pin);assertFocusedOwner();
  const cap=Object.freeze({});permits.set(cap,{host,assertFocusedOwner,closed:false,claude:pin,current:()=>assertCompanyClaudePin(pin)});return cap;
 }
 if(runtime.kind!=='byok'||!runtime.backend||!runtime.model||!isCompanyWorkByokBackend(runtime.backend))throw Error('company_work_runtime_tools_unverified');
 const configuration=async()=>({wire:await readByokWire(runtime.backend!),...(runtime.backend==='google'?{explicitCache:await readGeminiCacheSetting()}: {}),
  ...(runtime.backend==='custom'?{endpoint:currentCustomEndpoint()}: {})});
 const configurationPin=await configuration();
 if(runtime.backend==='custom'&&!configurationPin.endpoint)throw Error('company_work_provider_endpoint_invalid');
 let descriptor=await describeApiKey(runtime.backend as RuntimeBackend);assertFocusedOwner();
 // Custom endpoints are reviewed together with their exact existing key
 // descriptor. A key first stored after the dialog needs a fresh review.
 if(runtime.backend==='custom'&&!descriptor){descriptor=await ensureExistingApiKeyDescriptor(runtime.backend);assertFocusedOwner();if(!descriptor)fail()}
 const reviewedDescriptorDigest=hash(descriptor);
 const buildHost=():CompanyWorkHost=>({sourceKind:'host-consented',runtime:Object.freeze({...runtime}),credential:descriptor?{backend:descriptor.backend,version:descriptor.version,fingerprint:descriptor.fingerprint}:null,configurationDigest:hash({runtime,credential:descriptor,configuration:configurationPin,sourceKind:'host-consented'})});
 if(!await review(buildHost(),configurationPin.endpoint??null))fail();assertFocusedOwner();
 await retryCredentialReadFromUser('api',runtime.backend);assertFocusedOwner();
 if(!descriptor){descriptor=await ensureExistingApiKeyDescriptor(runtime.backend as RuntimeBackend);assertFocusedOwner();if(!descriptor)fail()}
 if(runtime.backend==='custom'&&hash(await describeApiKey(runtime.backend))!==reviewedDescriptorDigest)fail();
 const pinnedDescriptor=descriptor,host=buildHost();
 const cap=Object.freeze({}),permit:Permit={host,assertFocusedOwner,closed:false,
  ...(runtime.backend==='custom'?{customEndpoint:configurationPin.endpoint!}:{}),
  current:async()=>{const now=await describeApiKey(runtime.backend as RuntimeBackend);if(!now||hash(now)!==hash(pinnedDescriptor)||hash(await configuration())!==hash(configurationPin))throw Error('company_work_provider_changed')}};
 await permit.current();assertFocusedOwner();permits.set(cap,permit);return cap;
}
export async function companyProviderHost(cap:object):Promise<CompanyWorkHost>{const p=permits.get(cap);if(!p||p.closed)fail();await p.current();if(p.closed)fail();return p.host}
export async function companyClaudePin(cap:object):Promise<CompanyClaudePin>{const p=permits.get(cap);if(!p||p.closed||!p.claude)fail();await p.current();if(p.closed)fail();return p.claude}
export function revokeCompanyProvider(cap:object):void{const p=permits.get(cap);if(p)p.closed=true}
export async function withCompanyProvider<T>(cap:object,run:()=>Promise<T>):Promise<T>{const p=permits.get(cap);if(!p||p.closed)fail();await p.current();if(p.closed)fail();return scope.run(p,run)}
/** Central vault fence applies to every concrete adapter and nested provider call.
 * Only the descriptor consented above may use the original secret in-process. */
export async function assertCompanyProviderCredential(backend:RuntimeBackend):Promise<void>{const p=scope.getStore();if(!p)return;if(p.closed||p.host.sourceKind!=='host-consented'||p.host.credential?.backend!==backend)fail();await p.current();if(p.closed)fail()}
/** Bind the model call to the URL reviewed with the exact company credential.
 * Ordinary personal Custom BYOK calls keep their existing endpoint behavior. */
export async function companyCustomByokEndpoint(selected:string):Promise<string>{
 const p=scope.getStore();if(!p)return selected;
 if(p.closed||p.host.runtime.kind!=='byok'||p.host.runtime.backend!=='custom'||!p.customEndpoint
  ||normalizeCompanyWorkCustomEndpoint(selected)!==p.customEndpoint)fail();
 await p.current();if(p.closed)fail();return p.customEndpoint;
}
