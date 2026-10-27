import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {EmployeeAgentTransferOriginal} from './employee-agent-transfer-main';
import {employeeAgentTransferDigest as digest,readEmployeeAgentTransferFile,type CompanyAgentAsset} from './employee-agent-transfer-custody';
import {employeeAgentTransferCanonical as canonical,employeeAgentTransferPath,employeeAgentTransferSafeText,type EmployeeAgentTransferKind} from '../../shared/business/employee-agent-transfer';
import {employeeAgentChangeObject as object} from '../../shared/business/employee-agent-change';
import {isBusinessId} from '../../shared/business/context';
export interface CompanySourceFile{path:string;kind:EmployeeAgentTransferKind;digest:string;bytes:number;content:string}
function fail():never{throw Error('company_agent_source_original_required')}
/** Independent company source ownership: no personal One work/result is used.
 * Native focused review and exact licensed Root approval remain separate. */
export function createCompanyAgentSourceCustody(o:EmployeeAgentTransferOriginal,registration:{install(v:{agentId:string;displayName:string;definition:string},root:string):Promise<void>;installed(v:{agentId:string;displayName:string;definition:string},root:string):boolean}){
 const held=new WeakMap<object,{registrationId:string;value:any;association:string}>(),refs=[o.identityOwner,o.db,o.connection,o.assertCurrent,o.userDataPath,registration.install,registration.installed];
 function current(){o.assertCurrent();if([o.identityOwner,o.db,o.connection,o.assertCurrent,o.userDataPath,registration.install,registration.installed].some((v,i)=>v!==refs[i]))fail();const a=o.connection.current();if(!a||a.state!=='active'||Date.parse(a.expiresAt)<=Date.now())fail();return a;}
 o.db.exec("CREATE TABLE IF NOT EXISTS company_agent_source_custody(registration_id TEXT PRIMARY KEY,agent_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,record_digest TEXT NOT NULL,root_path TEXT,receipt_json TEXT);");
 function row(id:string){current();const r=o.db.prepare('SELECT * FROM company_agent_source_custody WHERE registration_id=?').get(id) as {registration_id:string;agent_id:string;state:string;record_json:string;record_digest:string;root_path:string|null;receipt_json:string|null}|undefined;if(r&&digest(JSON.parse(r.record_json))!==r.record_digest)fail();return r;}
 function validate(files:readonly CompanySourceFile[]){if(!files.length||files.length>64||files.filter(f=>f.kind==='definition').length!==1||new Set(files.map(f=>f.path.toLowerCase())).size!==files.length||files.reduce((n,f)=>n+f.bytes,0)>196608)fail();for(const f of files)if(!object(f,['path','kind','digest','bytes','content'])||!employeeAgentTransferPath(f.path,f.kind)||!employeeAgentTransferSafeText(f.content)||Buffer.byteLength(f.content)!==f.bytes||createHash('sha256').update(f.content).digest('hex')!==f.digest)fail();}
 async function propose(displayName:string,role:string,files:readonly CompanySourceFile[]){
  const a=current();validate(files);if(!employeeAgentTransferSafeText(displayName)||!displayName.trim()||displayName.length>100||!employeeAgentTransferSafeText(role)||role.length>100)fail();
  const registrationId=randomUUID(),agentId=`agt_${randomUUID().replaceAll('-','')}`,manifest=files.map(({content:_content,...file})=>file),packageDigest=digest({schema:'agentlas.business.company-agent-source.v1',registrationId,agentId,files:files.map(({path,content})=>({path,content}))});
  const proposal={registrationId,agentId,displayName,role,files:manifest,packageDigest,nativeReviewReceiptId:randomUUID()},record={proposal,files,association:canonical(a)};
  o.db.prepare("INSERT INTO company_agent_source_custody VALUES(?,?,'attempted',?,?,NULL,NULL)").run(registrationId,agentId,canonical(record),digest(record));
  try{const result=await o.connection.request('transfers/source-register',proposal);current();if(!object(result)||result.registrationId!==registrationId||result.agentId!==agentId||result.state!=='pending')fail();o.db.prepare("UPDATE company_agent_source_custody SET state='pending' WHERE registration_id=? AND state='attempted'").run(registrationId);return{registrationId,agentId,state:'pending' as const};}catch{return{registrationId,agentId,state:'unknown' as const};}
 }
 function sourceReceipt(v:unknown,record:any){
  const a=current(),p=record.proposal;
  if(!object(v,['schema','registrationId','agentId','agentResourceId','employeePrincipalId','associationId','associationRevision','sourceRevision','consentRevision','displayName','role','revision','state','manifestDigest','packageDigest','files','nativeReviewReceiptId','approvalReceiptId','registeredAt','expiresAt','managerPrincipalId','organizationId','deploymentId','identityAuthorityId'])
   ||v.schema!=='agentlas.business.company-agent-source.v1'||v.registrationId!==p.registrationId||v.agentId!==p.agentId||!isBusinessId(v.agentResourceId)||v.employeePrincipalId!==a.orgSession.principalId
   ||v.organizationId!==a.orgSession.organizationId||v.deploymentId!==a.orgSession.deploymentId||v.identityAuthorityId!==a.orgSession.identityAuthorityId||v.associationId!==a.associationId||v.associationRevision!==a.associationRevision
   ||v.sourceRevision!==a.sourceRevision||v.consentRevision!==a.consentRevision||v.displayName!==p.displayName||v.role!==p.role||v.nativeReviewReceiptId!==p.nativeReviewReceiptId||v.packageDigest!==p.packageDigest||v.manifestDigest!==digest(p.files)||digest(v.files)!==digest(p.files)
   ||typeof v.revision!=='number'||!Number.isSafeInteger(v.revision)||v.revision<1||!['pending','active','paused','revoked'].includes(v.state as string)||typeof v.registeredAt!=='number'||!Number.isSafeInteger(v.registeredAt)||v.registeredAt<0
   ||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)>Date.parse(a.expiresAt)||Date.parse(v.expiresAt)<=Date.now()
   ||(v.state==='pending'?(v.approvalReceiptId!==null||v.managerPrincipalId!==null):(!isBusinessId(v.approvalReceiptId)||!isBusinessId(v.managerPrincipalId))))fail();
  return v;
 }
 function readback(r:NonNullable<ReturnType<typeof row>>,v:any,needInstalled=true){
  if(!r.root_path)fail();const record=JSON.parse(r.record_json);validate(record.files);const p=record.proposal;
  if(v.registrationId!==r.registration_id||v.agentId!==r.agent_id||v.packageDigest!==p.packageDigest||v.manifestDigest!==digest(p.files)||digest(v.files)!==digest(p.files)||!v.approvalReceiptId||v.state!=='active'||Date.parse(v.expiresAt)<=Date.now()||record.association!==canonical(current()))fail();
  const stat=fs.lstatSync(r.root_path);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(r.root_path)!==r.root_path)fail();
  for(const f of record.files){const b=readEmployeeAgentTransferFile(r.root_path,f.path);if(b.length!==f.bytes||createHash('sha256').update(b).digest('hex')!==f.digest)fail();}
  const manifest=JSON.stringify({agentId:p.agentId,entry:p.files.find((f:any)=>f.kind==='definition').path});if(readEmployeeAgentTransferFile(r.root_path,'manifest.json').toString()!==manifest)fail();
  const expected=new Set(['manifest.json',...p.files.map((f:any)=>f.path)]);function walk(dir:string,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())walk(path.join(dir,entry.name),name+'/');else if(!entry.isFile()||!expected.delete(name))fail();}}walk(r.root_path);if(expected.size)fail();
  if(needInstalled&&!registration.installed({agentId:p.agentId,displayName:p.displayName,definition:record.files.find((f:any)=>f.kind==='definition').content},r.root_path))fail();
 }
 // A second ask for the same registration waits for the first: an unfinished materialization is rebuilt, which must never run twice at once.
 const inflight=new Map<string,ReturnType<typeof reconcileOnce>>();
 function reconcile(id:string){const running=inflight.get(id);if(running)return running;const p=reconcileOnce(id).finally(()=>{if(inflight.get(id)===p)inflight.delete(id)});inflight.set(id,p);return p;}
 async function reconcileOnce(id:string){
  const r=row(id);if(!r)fail();const record=JSON.parse(r.record_json),a=current();if(record.association!==canonical(a))fail();
  if(r.state==='attempted')await o.connection.request('transfers/source-register',record.proposal);
  const v=sourceReceipt(await o.connection.request('transfers/source-receipt',{registrationId:id}),record);current();if(!object(v)||v.registrationId!==id||v.agentId!==r.agent_id||v.packageDigest!==record.proposal.packageDigest||v.associationId!==a.associationId||v.associationRevision!==a.associationRevision||v.employeePrincipalId!==a.orgSession.principalId)fail();
  if(v.state!=='active'){
   // A succession pause or revocation is authoritative even when this host
   // previously materialized the source. Keep its files for audit, but remove
   // the local active selector before a held capability can be read again.
   if(v.state==='paused'||v.state==='revoked')o.db.prepare("UPDATE company_agent_source_custody SET state=? WHERE registration_id=? AND state IN ('attempted','pending','active')").run(v.state,id);
   return {registrationId:id,agentId:r.agent_id,state:v.state as 'pending'|'paused'|'revoked'};
  }
  if(r.state==='active'){if(!r.receipt_json||digest(JSON.parse(r.receipt_json))!==digest(v))fail();readback(r,v);return{registrationId:id,agentId:r.agent_id,state:'active' as const};}
  validate(record.files);
  const base=o.userDataPath('company-agent-sources');fs.mkdirSync(base,{recursive:true,mode:0o700});const baseStat=fs.lstatSync(base);if(!baseStat.isDirectory()||baseStat.isSymbolicLink()||fs.realpathSync.native(base)!==base)fail();
  // The server already holds this source as active, and the effect here is local (files plus this device's registration): an attempt that stopped
  // (state 'materializing' after a kill, 'unknown' after a failed write or install) is read back and finished, never refused. The folder is the
  // source agent's own, named by its id, so whatever an interrupted attempt left in it is replaced rather than mixed with the approved set.
  const root=path.join(base,r.agent_id);if(o.db.prepare("UPDATE company_agent_source_custody SET state='materializing',root_path=? WHERE registration_id=? AND state IN ('attempted','pending','materializing','unknown')").run(root,id).changes!==1)fail();
  const updated={...r,root_path:root};let intact=false;if(fs.existsSync(root)){try{readback(updated,v,false);intact=true}catch{/* rebuilt below */}}
  try{if(!intact){fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});fs.mkdirSync(root,{mode:0o700});const rootPin=fs.lstatSync(root);const directory=(folder:string)=>{const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(folder)!==folder)fail();return stat;};const pin=()=>{current();const stat=directory(root);if(stat.dev!==rootPin.dev||stat.ino!==rootPin.ino)fail();};const files=[{path:'manifest.json',content:JSON.stringify({agentId:r.agent_id,entry:record.proposal.files.find((f:any)=>f.kind==='definition').path})},...record.files];for(const f of files){pin();let folder=root;for(const component of f.path.split('/').slice(0,-1)){folder=path.join(folder,component);if(!fs.existsSync(folder))fs.mkdirSync(folder,{mode:0o700});directory(folder);}const absolute=path.join(root,f.path);pin();directory(folder);const fd=fs.openSync(absolute,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0),0o600);try{pin();directory(folder);fs.writeFileSync(fd,f.content,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd)}}}
   const registered={agentId:r.agent_id,displayName:record.proposal.displayName,definition:record.files.find((f:any)=>f.kind==='definition').content};
   if(!registration.installed(registered,root))await registration.install(registered,root);readback(updated,v);o.db.prepare("UPDATE company_agent_source_custody SET state='active',receipt_json=? WHERE registration_id=? AND state='materializing'").run(canonical(v),id);return{registrationId:id,agentId:r.agent_id,state:'active' as const};
  }catch(e){o.db.prepare("UPDATE company_agent_source_custody SET state='unknown' WHERE registration_id=? AND state='materializing'").run(id);throw e;}
 }
 async function capture(agentId:string){const rows=o.db.prepare("SELECT registration_id FROM company_agent_source_custody WHERE agent_id=? AND state IN ('pending','attempted','materializing','unknown','active')").all(agentId) as {registration_id:string}[];if(!rows.length)return null;if(rows.length!==1)fail();const result=await reconcile(rows[0].registration_id);if(result.state!=='active')return null;const r=row(result.registrationId)!;const value=JSON.parse(r.receipt_json!);readback(r,value);const cap=Object.freeze({});held.set(cap,{registrationId:r.registration_id,value,association:canonical(current())});return cap;}
 function read(cap:object):CompanyAgentAsset|null{try{const h=held.get(cap);if(!h||h.association!==canonical(current()))return null;const r=row(h.registrationId);if(!r||r.state!=='active'||!r.receipt_json||digest(JSON.parse(r.receipt_json))!==digest(h.value))return null;readback(r,h.value);const a=current(),v=h.value;return {protocol:'agentlas.business.original-company-agent.v1',sourceKind:'company-source',registrationId:v.registrationId,transferId:null,organizationSession:a.orgSession,associationId:a.associationId,associationRevision:a.associationRevision,agentId:v.agentId,agentResourceId:v.agentResourceId,employeePrincipalId:v.employeePrincipalId,packageDigest:v.packageDigest,sourceAgentId:v.agentId,sourceRevision:v.revision,targetRevision:v.revision,rootPath:r.root_path!,entryPath:v.files.find((f:any)=>f.kind==='definition').path,approvedPaths:v.files.map((f:any)=>f.path),files:v.files.map((f:any)=>({...f,source:{authorityId:a.sourceAuthorityId,recordId:v.registrationId,revision:`source:${v.revision}`,approvalReceiptId:v.approvalReceiptId}})),native:a.native};}catch{return null;}}
 async function refresh(cap:object){const h=held.get(cap);if(!h||!read(cap))fail();await o.connection.refresh();await reconcile(h.registrationId);if(!read(cap))fail();}
 async function reconcilePending(){const rows=o.db.prepare("SELECT registration_id FROM company_agent_source_custody WHERE state IN ('attempted','pending','materializing','unknown')").all() as {registration_id:string}[];
  // One source that cannot be finished now (its server answer, a locked file) must not keep the others, or the inbox that called this, from working; it is asked again next time.
  for(const r of rows.slice(0,64))try{await reconcile(r.registration_id)}catch(error){console.warn('[company-agent-source] reconcile deferred: company_agent_source_reconcile_deferred',r.registration_id,error instanceof Error?error.message:'unknown')}}
 return Object.freeze({propose,reconcile,reconcilePending,capture,read,refresh});
}
