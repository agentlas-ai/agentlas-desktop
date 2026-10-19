import { createHash } from 'node:crypto';
import { getDb } from '../store/db';
import type { CompanyAgentAsset } from './employee-agent-transfer-custody';
/** Host run-journal foreign-key reference only. Definition/content never enters
 * this personal registry; original company custody owns the actual agent. */
export function ensureCompanyWorkReference(asset:CompanyAgentAsset):void{
 const db=getDb();db.exec('CREATE TABLE IF NOT EXISTS company_work_references(agent_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, source_digest TEXT NOT NULL, principal_id TEXT NOT NULL)');
 const sourceDigest=createHash('sha256').update(JSON.stringify([asset.sourceKind,asset.registrationId,asset.transferId,asset.packageDigest,asset.targetRevision])).digest('hex');
 const old=db.prepare('SELECT * FROM company_work_references WHERE agent_id=?').get(asset.agentId) as {organization_id:string;source_digest:string;principal_id:string}|undefined;
 if(old&&(old.organization_id!==asset.organizationSession.organizationId||old.source_digest!==sourceDigest||old.principal_id!==asset.employeePrincipalId))throw Error('company_work_reference_changed');
 const existing=db.prepare('SELECT id,slug,system_prompt FROM installed_agents WHERE id=?').get(asset.agentId) as {id:string;slug:string;system_prompt:string}|undefined;
 if(existing&&!old)throw Error('company_work_personal_identity_collision');
 if(!old)db.transaction(()=>{
  db.prepare('INSERT INTO company_work_references VALUES(?,?,?,?)').run(asset.agentId,asset.organizationSession.organizationId,sourceDigest,asset.employeePrincipalId);
  db.prepare("INSERT INTO installed_agents(id,slug,name,tagline,system_prompt,mcp_servers_json,trust_grade,installed_at,tone,entity_kind) VALUES(?,?,?,?,?,?,?,?,?,?)").run(asset.agentId,'company-reference-'+createHash('sha256').update(asset.agentId).digest('hex'),'', '', '', '[]','untrusted',new Date().toISOString(),'','company-reference');
 })();
}
export function isCompanyWorkReference(agentId:string|null|undefined):boolean{if(!agentId)return false;const db=getDb();if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_work_references'").get())return false;return !!db.prepare('SELECT 1 FROM company_work_references WHERE agent_id=?').get(agentId)}
export function assertOrdinaryAgentReference(agentId:string):void{if(isCompanyWorkReference(agentId))throw Error('company_work_original_owner_required')}
