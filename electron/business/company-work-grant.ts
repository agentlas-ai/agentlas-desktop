import { createHash } from 'node:crypto';
import { sameBusinessSession } from '../../shared/business/context';
import { isCompanyWorkJob, isCompanyWorkPolicy, type CompanyWorkHost, type CompanyWorkJob } from '../../shared/business/company-work';
import type { McpInvocationRequest } from '../../shared/types';
import type { CompanyAgentAsset, CompanyAgentAssetOwner } from './employee-agent-transfer-custody';
import { captureCompanyInvocationBinding, revalidateInvocationWorkspaceBinding, type InvocationWorkspaceBinding } from '../invocation/workspace-binding';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export interface CompanyWorkGrantInput {
 readonly owner: CompanyAgentAssetOwner; readonly assetCapability: object; readonly policyId: string;
 readonly host: CompanyWorkHost; readonly requestDigest: string; readonly threadId: string;
 readonly mode: 'draft'|'reply'|'delegate'; readonly runId: string; readonly chatId: string;
 readonly currentHost: () => Promise<CompanyWorkHost>; readonly currentMailKey: () => string|null; readonly mailKey: string;
 readonly cancel: () => void; readonly providerCapability: object; readonly userPrompt: string; readonly hostPrompt: string; readonly outputRoot:string; readonly companyDb: import('../secrets/one-vault-journal').OneVaultSqlite;
 readonly surfaceParts: readonly import('../runtime/prompt-order').DeclaredPromptPart[];
 /** Called immediately before submitting the Root job admission request. */
 readonly beforeFirstRootEffect?: () => void;
}
type Held = { input: CompanyWorkGrantInput; asset: CompanyAgentAsset; job: CompanyWorkJob;
 workspace: InvocationWorkspaceBinding; closed: boolean; timer: ReturnType<typeof setInterval>; refreshing: Promise<void>|null };
const grants = new WeakMap<object,Held>();
/** The Root answer is fetched here through the original signed Native receiver.
 * No DTO-returning caller can mint an admitted company run. */
export async function issueCompanyWorkGrant(input: CompanyWorkGrantInput): Promise<object> {
 await input.owner.refresh(input.assetCapability);
 const asset = input.owner.read(input.assetCapability); if (!asset || input.currentMailKey()!==input.mailKey) fail('company_work_source_unavailable');
 const workspace = captureCompanyInvocationBinding(input.outputRoot);
 input.beforeFirstRootEffect?.();
 const raw = await input.owner.request(input.assetCapability,{operation:'admit',payload:{policyId:input.policyId,host:input.host,
  requestDigest:input.requestDigest,threadId:input.threadId,mode:input.mode,runId:input.runId,chatId:input.chatId}});
 if (!isCompanyWorkJob(raw) || raw.state!=='admitted' || raw.policy.policyId!==input.policyId || raw.requestDigest!==input.requestDigest
  || raw.runId!==input.runId || raw.chatId!==input.chatId || raw.threadId!==input.threadId || raw.mode!==input.mode
  || !sameBusinessSession(raw.organizationSession,asset.organizationSession) || raw.policy.agentId!==asset.agentId
  || raw.policy.sourceKind!==asset.sourceKind || raw.policy.registrationId!==asset.registrationId
  || raw.policy.agentResourceId!==asset.agentResourceId || raw.policy.transferId!==asset.transferId || raw.policy.packageDigest!==asset.packageDigest
  || raw.policy.targetRevision!==asset.targetRevision || raw.policy.associationId!==asset.associationId
  || raw.policy.associationRevision!==asset.associationRevision || digest(raw.policy.host)!==digest(input.host)) fail('company_work_admission_invalid');
 const claimed = await input.owner.request(input.assetCapability,{operation:'claim',payload:{jobId:raw.jobId,requestDigest:input.requestDigest,runId:input.runId,chatId:input.chatId}});
 if (!isCompanyWorkJob(claimed) || claimed.jobId!==raw.jobId || claimed.state!=='claimed' || !claimed.claimId
  || claimed.generation!==raw.generation+1 || digest(claimed.policy)!==digest(raw.policy)) fail('company_work_claim_unknown');
 const cap=Object.freeze({});
 const held: Held={input:Object.freeze({...input}),asset,job:claimed,workspace,closed:false,timer:null as unknown as ReturnType<typeof setInterval>,refreshing:null};
 grants.set(cap,held);
 held.timer=setInterval(()=>{ void refreshCompanyWorkGrant(cap).catch(()=>closeCompanyWorkGrant(cap)); },5000);
 held.timer.unref?.();
 try { await refreshCompanyWorkGrant(cap); return cap; } catch(error) { closeCompanyWorkGrant(cap); throw error; }
}
function held(cap: object): Held { const value=grants.get(cap); if(!value||value.closed)fail('company_work_grant_unavailable');return value; }
export function assertCompanyWorkGrant(cap: object, request?: Pick<McpInvocationRequest,'runId'|'chatId'|'userPrompt'>): Readonly<{asset:CompanyAgentAsset;job:CompanyWorkJob;workspace:InvocationWorkspaceBinding;providerCapability:object;surfaceParts:CompanyWorkGrantInput['surfaceParts'];userPrompt:string;companyDb:CompanyWorkGrantInput['companyDb']}> {
 const h=held(cap),a=h.input.owner.read(h.input.assetCapability);
 if (!a || digest(a)!==digest(h.asset) || h.input.currentMailKey()!==h.input.mailKey || !isCompanyWorkPolicy(h.job.policy)
  || h.job.policy.state!=='active' || Date.parse(h.job.expiresAt)<=Date.now() || Date.parse(h.job.policy.expiresAt)<=Date.now()
  || request && (request.runId!==h.job.runId||request.chatId!==h.job.chatId||request.userPrompt!==h.input.hostPrompt)
  || revalidateInvocationWorkspaceBinding(h.workspace)!==h.input.outputRoot) fail('company_work_grant_changed');
 h.input.owner.assertCurrent(h.input.assetCapability);
 return {asset:h.asset,job:h.job,workspace:h.workspace,providerCapability:h.input.providerCapability,surfaceParts:h.input.surfaceParts,userPrompt:h.input.userPrompt,companyDb:h.input.companyDb};
}
export async function refreshCompanyWorkGrant(cap: object): Promise<void> {
 const h=held(cap); if(h.refreshing)return h.refreshing;
 h.refreshing=(async()=>{
  // The signed Root refresh below revalidates the current Native association
  // and locks the original company source/installed transfer in its admission
  // transaction. A second local association+source-receipt round trip here can
  // consume the entire claimed lease before that authoritative check runs.
  assertCompanyWorkGrant(cap);
  if(digest(await h.input.currentHost())!==digest(h.input.host))fail('company_work_host_configuration_changed');
  const current=await h.input.owner.request(h.input.assetCapability,{operation:'refresh',payload:{jobId:h.job.jobId,claimId:h.job.claimId,generation:h.job.generation}});
  if(!isCompanyWorkJob(current)||current.state!=='claimed'||current.jobId!==h.job.jobId||current.claimId!==h.job.claimId
   ||current.generation!==h.job.generation||digest(current.policy)!==digest(h.job.policy))fail('company_work_revoked');
  h.job=current;assertCompanyWorkGrant(cap);
 })().catch(error=>{closeCompanyWorkGrant(cap);throw error}).finally(()=>{h.refreshing=null});return h.refreshing;
}
/** Local stop is unconditional, even when revoked SSO prevents remote receipt. */
export function closeCompanyWorkGrant(cap: object): void {
 const h=grants.get(cap);if(!h||h.closed)return;h.closed=true;clearInterval(h.timer);try{h.input.cancel()}catch{}
}
export async function settleCompanyWorkGrant(cap: object,state:'settled'|'unknown'|'cancelled',resultDigest:string|null): Promise<CompanyWorkJob|null> {
 const h=grants.get(cap);if(!h)return null;
 // Withhold new effects first. A lost settlement response never reclaims the job.
 h.closed=true;clearInterval(h.timer);
 try {const value=await h.input.owner.request(h.input.assetCapability,{operation:'settle',payload:{jobId:h.job.jobId,claimId:h.job.claimId,generation:h.job.generation,state,resultDigest}});
  return isCompanyWorkJob(value)&&value.jobId===h.job.jobId?value:null;}catch{return null}
}
