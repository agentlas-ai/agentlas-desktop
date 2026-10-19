import fs from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import type { CompanyAgentAssetOwner } from './employee-agent-transfer-custody';
import type { OneVaultSqlite } from '../secrets/one-vault-journal';
import { ensureCompanyWorkReference } from './company-work-reference';
import { createChat,getChat } from '../store/chats';
import { invocationService } from '../invocation/service';
import { bindOrganizationMailWorkPort,unbindOrganizationMailWorkPort,buildAgentMailInboundRequest,buildAgentMailDelegateRequest,type OrganizationMailWorkPort } from '../agent-mail/sync';
import { captureAgentMailExecutionScope,currentOrganizationMailSelection,withAgentMailExecutionScope,agentMailThread } from '../agent-mail/client';
import { registerAgentMailAutoRun } from '../agent-mail/control-server';
import { issueCompanyWorkGrant,assertCompanyWorkGrant,closeCompanyWorkGrant,settleCompanyWorkGrant } from './company-work-grant';
import { companyProviderHost,revokeCompanyProvider } from './company-work-provider';
import type { DeclaredPromptPart } from '../runtime/prompt-order';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface CompanyWorkPortInput{owner:CompanyAgentAssetOwner;assetCapability:object;providerCapability:object;policyId:string;db:OneVaultSqlite;companyDataPath(...segments:string[]):string;signal:AbortSignal}
/** Installed only after focused Native asset/provider review. Merely opening or
 * reading a Mail panel never creates this port or starts a run. */
export async function installCompanyWorkPort(input:CompanyWorkPortInput):Promise<{port:OrganizationMailWorkPort;close():void}>{
 input.signal.throwIfAborted();
 const scope=captureAgentMailExecutionScope();if(scope.kind!=='organization'||scope.key==='unavailable')throw Error('company_work_mail_selection_required');
 const mailKey=scope.key;
 const selected=input.owner.read(input.assetCapability);if(!selected)throw Error('company_work_source_required');
 const selection=currentOrganizationMailSelection();if(!selection||selection.key!==mailKey||selection.organizationId!==selected.organizationSession.organizationId||selection.principalId!==selected.employeePrincipalId)throw Error('company_work_mail_selection_required');
 const approvedHost=await companyProviderHost(input.providerCapability);input.signal.throwIfAborted();await input.owner.refresh(input.assetCapability);input.signal.throwIfAborted();
 input.db.exec('CREATE TABLE IF NOT EXISTS company_work_jobs (job_key TEXT PRIMARY KEY, input_digest TEXT NOT NULL, run_id TEXT NOT NULL, chat_id TEXT NOT NULL, state TEXT NOT NULL, receipt_digest TEXT)');
 let closed=false;const running=new Map<string,{cap:object;release:()=>void}>();
 const currentKey=()=>{if(closed||input.signal.aborted)return null;const now=captureAgentMailExecutionScope();return now.kind==='organization'&&now.key===mailKey&&currentOrganizationMailSelection()?.organizationId===selected.organizationSession.organizationId&&currentOrganizationMailSelection()?.principalId===selected.employeePrincipalId&&input.owner.read(input.assetCapability)?now.key:null};
 async function start(details:{mode:'draft'|'reply'|'delegate';threadId:string;userPrompt:string;title:string;locale:'ko'|'en';surfaceParts:readonly DeclaredPromptPart[];messageId?:string;identity:unknown}){
  if(currentKey()!==mailKey)throw Error('company_work_selection_changed');
  const requestDigest=hash({policyId:input.policyId,agentResourceId:selected!.agentResourceId,mode:details.mode,threadId:details.threadId,userPrompt:details.userPrompt,identity:details.identity}),jobKey=hash({scope:mailKey,requestDigest});
  const old=input.db.prepare('SELECT input_digest,run_id,chat_id,state FROM company_work_jobs WHERE job_key=?').get(jobKey) as {input_digest:string;run_id:string;chat_id:string;state:string}|undefined;
  if(old){if(old.input_digest!==requestDigest)throw Error('company_work_job_conflict');if(old.state==='running'||old.state==='settled')return{chatId:old.chat_id,runId:old.run_id};throw Error('company_work_job_effect_unknown')}
  const runId=randomUUID(),chatId=randomUUID();
  input.db.prepare('INSERT INTO company_work_jobs(job_key,input_digest,run_id,chat_id,state) VALUES(?,?,?,?,?)').run(jobKey,requestDigest,runId,chatId,'reserved');
  const hostPrompt='Company work '+requestDigest;
  let cap:object|undefined,release=()=>{},externalAttempted=false;
  try{
   ensureCompanyWorkReference(selected!);
   const chat=createChat({internalId:chatId,agentId:selected!.agentId,title:'Company work',kind:'division',taskMode:'conversation',originSurface:'work'});
   if(chat.id!==chatId||chat.agentId!==selected!.agentId||getChat(chatId)?.agentId!==selected!.agentId)throw Error('company_work_chat_actor_mismatch');
   const outputRoot=input.companyDataPath('work-outputs',jobKey);fs.mkdirSync(outputRoot,{recursive:true,mode:0o700});
   cap=await issueCompanyWorkGrant({...input,beforeFirstRootEffect:()=>{externalAttempted=true},outputRoot,host:approvedHost,requestDigest,threadId:details.threadId,mode:details.mode,runId,chatId,mailKey:mailKey,currentMailKey:currentKey,currentHost:()=>companyProviderHost(input.providerCapability),cancel:()=>{invocationService.cancel(runId)},userPrompt:details.userPrompt,hostPrompt,companyDb:input.db,surfaceParts:details.surfaceParts});
   if(currentKey()!==mailKey)throw Error('company_work_selection_changed');
   if(details.mode!=='delegate'){if(!details.messageId)throw Error('company_work_message_required');release=registerAgentMailAutoRun(chatId,{mode:details.mode,threadId:details.threadId,messageId:details.messageId})}
   running.set(runId,{cap,release});
   const binding=assertCompanyWorkGrant(cap).workspace;
   input.db.prepare("UPDATE company_work_jobs SET state='running' WHERE job_key=? AND state='reserved'").run(jobKey);
   const result=invocationService.start({runId,chatId,userPrompt:hostPrompt,locale:details.locale,permissions:'read',oneMode:false,taskIntent:'conversation',runtimeSelection:approvedHost.runtime},binding,{source:'company-work',companyWork:cap});
   if(result.runId!==runId)throw Error('company_work_run_owner_mismatch');return{chatId,runId};
  }catch(error){release();running.delete(runId);if(cap){closeCompanyWorkGrant(cap);await settleCompanyWorkGrant(cap,'unknown',null)}if(externalAttempted)input.db.prepare("UPDATE company_work_jobs SET state='unknown' WHERE job_key=? AND run_id=? AND state IN ('reserved','running')").run(jobKey,runId);else input.db.prepare("DELETE FROM company_work_jobs WHERE job_key=? AND input_digest=? AND run_id=? AND chat_id=? AND state='reserved'").run(jobKey,requestDigest,runId,chatId);throw error}
 }
 const removeSettled=invocationService.onSettled(async envelope=>{const job=running.get(envelope.runId);if(!job)return;running.delete(envelope.runId);job.release();
  const result=input.db.prepare("SELECT value_json FROM company_work_content WHERE run_id=? AND kind='result' ORDER BY rowid DESC LIMIT 1").get(envelope.runId) as {value_json:string}|undefined;
  const state=envelope.receipt.status==='completed'&&result?'settled':envelope.receipt.status==='cancelled'?'cancelled':'unknown',resultDigest=result?hash(JSON.parse(result.value_json)):null;
  input.db.prepare('UPDATE company_work_jobs SET state=?,receipt_digest=? WHERE run_id=?').run(state,resultDigest,envelope.runId);
  await settleCompanyWorkGrant(job.cap,state,resultDigest);
 });
 const port:OrganizationMailWorkPort={currentKey,
  startInbound:value=>withAgentMailExecutionScope(scope,async()=>{const p=buildAgentMailInboundRequest(value.mode,value.threadId,value.message);return start({...p,...value,surfaceParts:p.surfaceParts,messageId:value.message.id,identity:{messageId:value.message.id}})}),
  delegate:value=>withAgentMailExecutionScope(scope,async()=>{try{if(currentKey()!==mailKey)throw Error('company_work_selection_changed');const detail=await agentMailThread(value.threadId);if(!detail.ok)return detail;const p=buildAgentMailDelegateRequest(value,detail);return{ok:true,...await start({...p,mode:'delegate',threadId:value.threadId,surfaceParts:[],identity:detail})}}catch(error){return{ok:false,code:error instanceof Error?error.message:'company_work_start_failed',message:'Company work could not start.',status:null}}})};
 function close(){if(closed)return;closed=true;input.signal.removeEventListener('abort',close);unbindOrganizationMailWorkPort(port);for(const [runId,job]of running){closeCompanyWorkGrant(job.cap);invocationService.cancel(runId);job.release();input.db.prepare("UPDATE company_work_jobs SET state='unknown' WHERE run_id=? AND state='running'").run(runId)}running.clear();revokeCompanyProvider(input.providerCapability);removeSettled()}
 input.signal.addEventListener('abort',close,{once:true});if(input.signal.aborted){close();throw Error('company_work_owner_closed')}
 bindOrganizationMailWorkPort(port);return{port,close};
}
