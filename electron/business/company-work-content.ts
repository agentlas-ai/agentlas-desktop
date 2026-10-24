import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash,randomUUID } from 'node:crypto';
import type { OneVaultSqlite } from '../secrets/one-vault-journal';
import type * as Original from '../harness/effect-ledger';
interface Scope{capability?:object;db:OneVaultSqlite;jobId:string;runId:string}
const scopes=new AsyncLocalStorage<Scope>();
export function currentCompanyWorkContent():Scope|undefined{return scopes.getStore()}
export function withCompanyWorkContent<T>(scope:Scope,fn:()=>T):T{
 scope.db.exec('CREATE TABLE IF NOT EXISTS company_work_content(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,value_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS company_work_effects(effect_key TEXT PRIMARY KEY,ref TEXT NOT NULL,state TEXT NOT NULL,result TEXT,acked INTEGER NOT NULL DEFAULT 0)');return scopes.run(scope,fn);
}
export function recordCompanyWorkContent(kind:string,value:unknown):void{const s=scopes.getStore();if(!s)throw Error('company_work_content_owner_required');s.db.prepare('INSERT INTO company_work_content VALUES(?,?,?,?,?)').run(randomUUID(),s.jobId,s.runId,kind,JSON.stringify(value))}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Dedicated original effect checkpoint. Unknown is durable and cannot become
 * retryable merely because a second call or a different run asks again. */
export function companyWorkEffectLedger():Pick<typeof Original,'beginEffect'|'settleEffect'|'acknowledgeEffect'|'effectRunId'>|null{
 const s=scopes.getStore();if(!s)return null;
 return{effectRunId:()=>s.runId,
  beginEffect:async input=>{const key=hash({job:s.jobId,tool:input.tool,args:input.args}),old=s.db.prepare('SELECT * FROM company_work_effects WHERE effect_key=?').get(key) as {ref:string;state:string;result:string|null}|undefined;
   if(old){if(old.state==='settled'&&old.result!==null)return{status:'replayed',priorRef:old.ref,priorAt:'company-original',content:old.result,replayed:true};return{status:'uncertain_prior',priorRef:old.ref,priorAt:'company-original',content:'company_work_effect_unknown'}}
   const ref=randomUUID();s.db.prepare('INSERT INTO company_work_effects(effect_key,ref,state) VALUES(?,?,?)').run(key,ref,'begin');return{status:'begun',ref}},
  settleEffect:async(ref,state,options)=>{const result=s.db.prepare("UPDATE company_work_effects SET state=?,result=? WHERE ref=? AND state='begin'").run(state,options?.result??null,ref) as {changes?:number};return result.changes===1},
  acknowledgeEffect:async ref=>{const result=s.db.prepare("UPDATE company_work_effects SET acked=1 WHERE ref=? AND state='settled'").run(ref) as {changes?:number};return result.changes===1}};
}
export async function companyOrOriginalEffectLedger(){return companyWorkEffectLedger()??await import('../harness/effect-ledger')}

/** Company consent is the Main-minted exact run grant, never an ordinary
 * personal permission card or a model-authored tool name. */
export async function approveCompanyWorkTool(resolved:unknown):Promise<"allow_once">{
 const scope=scopes.getStore();if(!scope?.capability)throw Error('company_work_tool_grant_required');
 const {assertCompanyWorkGrant,refreshCompanyWorkGrant}=await import('./company-work-grant');await refreshCompanyWorkGrant(scope.capability);const g=assertCompanyWorkGrant(scope.capability);
 const r=resolved as {kind?:string;serverToolName?:string;server?:{catalogId:string|null;command:string|null;args:string[]}};
 if(r.kind!=='mcp'||!r.server||!r.serverToolName||!g.job.policy.tools.includes(r.serverToolName as 'agent_mail_thread'))throw Error('company_work_tool_denied');
 const names=g.job.policy.tools;
 if(r.server.catalogId==='agent-mail'){
  if(!(await import('../agent-mail/mcp-server')).isAuthenticCompanyAgentMailMcpLaunch(r.server.command,r.server.args,names.filter(n=>n.startsWith('agent_mail_')),g.job.policy.expiresAt))throw Error('company_work_tool_source_changed');
 }else if(r.server.catalogId==='company-files'){
  if(!(await import('./company-work-files')).isAuthenticCompanyFileMcpLaunch(r.server.command,r.server.args,names.filter(n=>n.startsWith('company_file_'))))throw Error('company_work_tool_source_changed');
 }else throw Error('company_work_tool_denied');
 return 'allow_once';
}
