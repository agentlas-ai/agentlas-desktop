import { businessOnlyKeys as only, isBusinessId as id, isBusinessRevision as revision, isBusinessSession, type BusinessSession } from './context';
import { isValidRuntimeSelectionInput as isRuntimeSelection } from '../runtime-selection';
import type { RuntimeBackend, RuntimeSelection } from '../types';
export const COMPANY_WORK_SCHEMA = 'agentlas.business.company-work.v1' as const;
export const COMPANY_WORK_PURPOSE = 'company.mail-work' as const;
export const COMPANY_WORK_TOOLS = ['agent_mail_thread','agent_mail_read','agent_mail_reply','agent_mail_draft','company_file_read','company_file_write'] as const;
/** One explicit provider capability for the company picker and focused Main. */
export const COMPANY_WORK_BYOK_BACKENDS = ['anthropic','openai','google','glm','kimi','deepseek','minimax','xai','openrouter','upstage','custom'] as const;
export function isCompanyWorkByokBackend(value: unknown): value is RuntimeBackend {
 return typeof value==='string' && (COMPANY_WORK_BYOK_BACKENDS as readonly string[]).includes(value);
}
/** Match the ordinary Custom BYOK model-discovery URL boundary. The endpoint
 * itself is shown during Native consent and only its digest enters Root policy. */
export function normalizeCompanyWorkCustomEndpoint(value: unknown): string|null {
 if(typeof value!=='string'||!value.trim()||value.length>2048)return null;
 try{
  const url=new URL(value.trim()),host=url.hostname.toLowerCase();
  const loopback=['localhost','127.0.0.1','[::1]'].includes(host);
  const privateLan=/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&(loopback||privateLan)))||url.username||url.password||url.search||url.hash)return null;
  return url.href.replace(/\/$/,'');
 }catch{return null}
}
export type CompanyWorkTool = typeof COMPANY_WORK_TOOLS[number];
export interface CompanyWorkHost {
 readonly sourceKind: 'company-owned'|'host-consented';
 readonly runtime: RuntimeSelection;
 readonly configurationDigest: string;
 readonly credential: { readonly backend: string; readonly version: string; readonly fingerprint: string } | null;
}
export interface CompanyWorkPolicy {
 readonly schema: typeof COMPANY_WORK_SCHEMA; readonly policyId: string; readonly organizationId: string;
 readonly employeePrincipalId: string; readonly agentResourceId: string; readonly agentId: string;
 readonly sourceKind: 'company-source'|'transfer'; readonly registrationId: string|null; readonly transferId: string|null; readonly packageDigest: string; readonly targetRevision: number;
 readonly nativeHostId: string; readonly associationId: string; readonly associationRevision: number;
 readonly host: CompanyWorkHost; readonly tools: readonly CompanyWorkTool[]; readonly maxRuns: number;
 readonly maxOutputTokens: number; readonly expiresAt: string; readonly state: 'active'|'revoked'; readonly revision: number;
}
export interface CompanyWorkJob {
 readonly schema: typeof COMPANY_WORK_SCHEMA; readonly jobId: string; readonly policy: CompanyWorkPolicy;
 readonly organizationSession: BusinessSession; readonly requestDigest: string; readonly threadId: string;
 readonly mode: 'draft'|'reply'|'delegate'; readonly state: 'admitted'|'claimed'|'settled'|'cancelled'|'unknown';
 readonly claimId: string|null; readonly runId: string; readonly chatId: string; readonly generation: number;
 readonly expiresAt: string; readonly receiptId: string; readonly resultDigest: string|null;
}
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const expiry = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function isCompanyWorkHost(v: unknown): v is CompanyWorkHost {
 return only(v,['sourceKind','runtime','configurationDigest','credential']) && ['company-owned','host-consented'].includes(String(v.sourceKind)) && isRuntimeSelection(v.runtime) && hex(v.configurationDigest)
  && (v.credential===null || only(v.credential,['backend','version','fingerprint']) && id(v.credential.backend) && id(v.credential.version) && hex(v.credential.fingerprint));
}
export function isCompanyWorkPolicy(v: unknown): v is CompanyWorkPolicy {
 if (!only(v,['schema','policyId','organizationId','employeePrincipalId','agentResourceId','agentId','sourceKind','registrationId','transferId','packageDigest','targetRevision','nativeHostId','associationId','associationRevision','host','tools','maxRuns','maxOutputTokens','expiresAt','state','revision'])) return false;
 return v.schema===COMPANY_WORK_SCHEMA && ['policyId','organizationId','employeePrincipalId','agentResourceId','agentId','nativeHostId','associationId'].every(k=>id(v[k]))
  && (v.sourceKind==='transfer' && id(v.transferId) && v.registrationId===null || v.sourceKind==='company-source' && id(v.registrationId) && v.transferId===null)
  && hex(v.packageDigest) && revision(v.targetRevision) && revision(v.associationRevision) && revision(v.revision) && isCompanyWorkHost(v.host)
  && Array.isArray(v.tools) && v.tools.length>0 && v.tools.length<=COMPANY_WORK_TOOLS.length && new Set(v.tools).size===v.tools.length
  && v.tools.every(t=>(COMPANY_WORK_TOOLS as readonly unknown[]).includes(t)) && Number.isSafeInteger(v.maxRuns) && Number(v.maxRuns)>0 && Number(v.maxRuns)<=10000
  && Number.isSafeInteger(v.maxOutputTokens) && Number(v.maxOutputTokens)>0 && Number(v.maxOutputTokens)<=32768 && expiry(v.expiresAt) && ['active','revoked'].includes(String(v.state));
}
export function isCompanyWorkJob(v: unknown): v is CompanyWorkJob {
 return only(v,['schema','jobId','policy','organizationSession','requestDigest','threadId','mode','state','claimId','runId','chatId','generation','expiresAt','receiptId','resultDigest'])
  && v.schema===COMPANY_WORK_SCHEMA && isCompanyWorkPolicy(v.policy) && isBusinessSession(v.organizationSession) && hex(v.requestDigest)
  && ['jobId','threadId','runId','chatId','receiptId'].every(k=>id(v[k])) && (v.claimId===null || id(v.claimId)) && revision(v.generation)
  && ['draft','reply','delegate'].includes(String(v.mode)) && ['admitted','claimed','settled','cancelled','unknown'].includes(String(v.state))
  && expiry(v.expiresAt) && (v.resultDigest===null||hex(v.resultDigest));
}

export interface CompanyWorkAssetSelector {readonly sourceKind:'company-source'|'transfer';readonly registrationId:string|null;readonly transferId:string|null;readonly agentId:string;readonly agentResourceId:string;readonly packageDigest:string;readonly targetRevision:number}
export interface CompanyWorkReview {readonly reviewId:string;readonly host:CompanyWorkHost;readonly asset:CompanyWorkAssetSelector;readonly associationId:string;readonly associationRevision:number;readonly organizationId:string}
export interface CompanyWorkAPI {
 review(input:{agentId:string;runtime:RuntimeSelection}):Promise<CompanyWorkReview>;
 choices(input:{reviewId:string}):Promise<{policies:readonly CompanyWorkPolicy[]}>;
 activate(input:{reviewId:string;policyId:string}):Promise<{state:'active';policyId:string}>;
 stop():Promise<{state:'stopped'}>;
 status():Promise<{state:'active'|'inactive';policyId:string|null;organizationId:string|null}>;
}
