import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { RuntimeBackend, RuntimeSelection } from '../../shared/types';
import type { CompanyWorkHost } from '../../shared/business/company-work';
import { readByokWire } from '../runtime/byok-wire';
import { readGeminiCacheSetting } from '../runtime/gemini-explicit-cache';
import { describeApiKey,ensureExistingApiKeyDescriptor,retryCredentialReadFromUser } from '../secrets/vault';
import {reviewCompanyClaudePin,assertCompanyClaudePin,type CompanyClaudePin} from './company-work-claude';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const supported=new Set(['anthropic','openai','google','glm','kimi','deepseek','minimax','xai','openrouter','upstage']);
type Permit={host:CompanyWorkHost;assertFocusedOwner:()=>void;current:()=>Promise<void>;closed:boolean;claude?:CompanyClaudePin};
const permits=new WeakMap<object,Permit>();
const scope=new AsyncLocalStorage<Permit>();
function fail():never{throw Error('company_work_provider_consent_required')}
/** Called only by the focused Native owner after displaying this exact value-free
 * descriptor. The original credential owner keeps the secret in its own vault. */
export async function reviewHostCompanyProvider(runtime:RuntimeSelection,assertFocusedOwner:()=>void,review:(host:CompanyWorkHost)=>Promise<boolean>):Promise<object>{
 assertFocusedOwner();
 if(runtime.kind==='claude-code'){
  const pin=await reviewCompanyClaudePin(runtime,assertFocusedOwner);
  const host:CompanyWorkHost={sourceKind:'host-consented',runtime:Object.freeze({...runtime}),credential:null,configurationDigest:pin.configurationDigest};
  if(!await review(host))fail();assertFocusedOwner();await assertCompanyClaudePin(pin);assertFocusedOwner();
  const cap=Object.freeze({});permits.set(cap,{host,assertFocusedOwner,closed:false,claude:pin,current:()=>assertCompanyClaudePin(pin)});return cap;
 }
 if(runtime.kind!=='byok'||!runtime.backend||!runtime.model||!supported.has(runtime.backend))throw Error('company_work_runtime_tools_unverified');
 const configuration=async()=>({wire:await readByokWire(runtime.backend!),...(runtime.backend==='google'?{explicitCache:await readGeminiCacheSetting()}: {})});
 const configurationPin=await configuration();
 let descriptor=await describeApiKey(runtime.backend as RuntimeBackend);assertFocusedOwner();
 const buildHost=():CompanyWorkHost=>({sourceKind:'host-consented',runtime:Object.freeze({...runtime}),credential:descriptor?{backend:descriptor.backend,version:descriptor.version,fingerprint:descriptor.fingerprint}:null,configurationDigest:hash({runtime,credential:descriptor,configuration:configurationPin,sourceKind:'host-consented'})});
 if(!await review(buildHost()))fail();assertFocusedOwner();
 await retryCredentialReadFromUser('api',runtime.backend);assertFocusedOwner();
 if(!descriptor){descriptor=await ensureExistingApiKeyDescriptor(runtime.backend as RuntimeBackend);assertFocusedOwner();if(!descriptor)fail()}
 const pinnedDescriptor=descriptor,host=buildHost();
 const cap=Object.freeze({}),permit:Permit={host,assertFocusedOwner,closed:false,current:async()=>{const now=await describeApiKey(runtime.backend as RuntimeBackend);if(!now||hash(now)!==hash(pinnedDescriptor)||hash(await configuration())!==hash(configurationPin))throw Error('company_work_provider_changed')}};
 await permit.current();assertFocusedOwner();permits.set(cap,permit);return cap;
}
export async function companyProviderHost(cap:object):Promise<CompanyWorkHost>{const p=permits.get(cap);if(!p||p.closed)fail();await p.current();if(p.closed)fail();return p.host}
export async function companyClaudePin(cap:object):Promise<CompanyClaudePin>{const p=permits.get(cap);if(!p||p.closed||!p.claude)fail();await p.current();if(p.closed)fail();return p.claude}
export function revokeCompanyProvider(cap:object):void{const p=permits.get(cap);if(p)p.closed=true}
export async function withCompanyProvider<T>(cap:object,run:()=>Promise<T>):Promise<T>{const p=permits.get(cap);if(!p||p.closed)fail();await p.current();if(p.closed)fail();return scope.run(p,run)}
/** Central vault fence applies to every concrete adapter and nested provider call.
 * Only the descriptor consented above may use the original secret in-process. */
export async function assertCompanyProviderCredential(backend:RuntimeBackend):Promise<void>{const p=scope.getStore();if(!p)return;if(p.closed||p.host.sourceKind!=='host-consented'||p.host.credential?.backend!==backend)fail();await p.current();if(p.closed)fail()}
