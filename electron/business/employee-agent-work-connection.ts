import {createHash,randomUUID,sign} from 'node:crypto';
import {getAuthenticatedSessionBinding,sessionForDaemonHandoff,webBaseUrl} from '../auth';
import {loadOneVaultApprovedHost} from '../secrets/one-vault-service';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import {EMPLOYEE_AGENT_WORK_PURPOSE,workSnapshot,workFail,type WorkAssociationPins} from '../../shared/business/employee-agent-work';
import {WORK_NATIVE_BASE,isWorkAssociation,isWorkChallenge,workSigningText,type WorkNativeApproval,type WorkNativeAssociation,type WorkNativeProof} from '../../shared/business/employee-agent-work-api';
import type {BusinessNativeIdentity} from '../../shared/business/native-sharing-wire';
import type {EmployeeAgentWorkAdmission} from './employee-agent-work-owner';
import {workDigest} from './employee-agent-work-semantics';
type Operation='association'|'register'|'intent'|'result'|'receipt'|'revoke';
/** WORK local consent and remote observations are separate. Construction reads no
 * credentials, storage or network. No report association is consulted. */
export function createEmployeeAgentWorkConnection(runtime:OneVaultRuntime,generation:()=>number){
 const db=runtime.sources.db,refs=[runtime.sources,runtime.trust,runtime.currentNativeOwner,runtime.trust.currentHostMetadata,runtime.sources.oneId];
 let closed=false,initialized=false,active:WorkNativeAssociation|null=null,lastState:'disconnected'|'expired'|'revoked'='disconnected',associationUpdatePending=false;const caps=new WeakMap<object,string>();
 function schema(){if(initialized)return;db.exec(`CREATE TABLE IF NOT EXISTS one_business_work_connections(association_id TEXT PRIMARY KEY,state TEXT NOT NULL,record_json TEXT NOT NULL,approval_json TEXT NOT NULL,sequence INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS one_business_work_connection_attempts(id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL,approval_json TEXT NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS one_business_work_requests(request_id TEXT PRIMARY KEY,association_id TEXT NOT NULL,operation TEXT NOT NULL,body_json TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT);`);initialized=true}
 function native():BusinessNativeIdentity{
  if(closed||runtime.sources.db!==db||[runtime.sources,runtime.trust,runtime.currentNativeOwner,runtime.trust.currentHostMetadata,runtime.sources.oneId].some((v,i)=>v!==refs[i]))workFail('native_owner_changed');
  const owner=runtime.currentNativeOwner(),auth=getAuthenticatedSessionBinding(),host=runtime.trust.currentHostMetadata();
  if(!owner||!auth||!host||owner.principalId!==auth.userId||owner.sessionId!==auth.sessionId||owner.workspaceId!==auth.workspaceId||owner.hostId!==host.hostId)workFail('native_owner_required');
  return{nativeAccountId:owner.principalId,nativeWorkspaceId:owner.workspaceId,nativeSessionId:owner.sessionId,nativeSessionRevision:auth.sessionId,nativeHostId:owner.hostId,oneId:runtime.sources.oneId(),hostKeyId:host.hostKeyId,hostPublicKey:host.signingPublicKey,custodyGeneration:owner.custodyGeneration,installationGeneration:generation(),trustGeneration:host.generation};
 }
 function current():WorkNativeAssociation|null{try{
  if(!active||active.state!=='active'||active.expiresAt<=Date.now()||workDigest(active.native)!==workDigest(native()))return null;
  const row=db.prepare("SELECT record_json FROM one_business_work_connections WHERE association_id=? AND state='active'").get(active.associationId) as {record_json:string}|undefined;
  return row?.record_json===JSON.stringify(active)?workSnapshot(active):null;
 }catch{return null}}
 function requireCurrent(){const value=current();if(!value)workFail('work_consent_unavailable');return value}
 function beginAssociationUpdate(){if(associationUpdatePending)workFail('connection_approval_in_progress');associationUpdatePending=true;return()=>{associationUpdatePending=false;};}
 function url(op:string,query?:Record<string,string>){const root=new URL(webBaseUrl());if(root.protocol!=='https:'||root.username||root.password||root.search||root.hash)workFail('root_endpoint_invalid');const target=new URL(WORK_NATIVE_BASE+op,root);for(const[k,v]of Object.entries(query??{}))target.searchParams.set(k,v);return target.toString()}
 async function fetchOriginal(target:string,method:string,body:string,proof?:WorkNativeProof,approval?:WorkNativeApproval){
  const n=native(),actor=getAuthenticatedSessionBinding(),session=sessionForDaemonHandoff();if(!actor||!session?.cookieValue)workFail('native_session_required');
  const check=()=>{if(workDigest(native())!==workDigest(n)||workDigest(getAuthenticatedSessionBinding())!==workDigest(actor)||sessionForDaemonHandoff()?.cookieValue!==session.cookieValue)workFail('native_session_changed')};
  const headers:Record<string,string>={Authorization:`Bearer ${session.cookieValue}`,'Content-Type':'application/json'};
  if(proof)headers['x-agentlas-business-work-proof']=Buffer.from(JSON.stringify(proof)).toString('base64url');if(approval)headers['x-agentlas-business-work-approval']=Buffer.from(JSON.stringify(approval)).toString('base64url');
  const response=await fetch(target,{method,headers,...(method==='GET'?{}:{body}),redirect:'error',signal:AbortSignal.timeout(20000)});check();const text=await response.text();check();if(Buffer.byteLength(text)>512000)workFail('root_response_limit');const value=workSnapshot(JSON.parse(text));
  if(!response.ok){const raw=value?.error,code=typeof raw==='string'?raw:raw?.code;throw Object.assign(new Error('employee_agent_work_root_denied'),{code:typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:'employee_agent_work_root_denied',status:response.status})}return value;
 }
 async function signPayload(domain:'association-approve'|'request',payload:unknown,check:()=>void){check();const before=native(),host=await loadOneVaultApprovedHost(before.nativeHostId,runtime.trust,runtime.sources.vault);check();if(workDigest(native())!==workDigest(before)||host.metadata.hostKeyId!==before.hostKeyId||host.metadata.signingPublicKey!==before.hostPublicKey)workFail('host_custody_changed');return sign('sha256',Buffer.from(workSigningText(domain,payload)),{key:host.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}
 async function challenge(id:string){const value=await fetchOriginal(url('challenge',{challengeId:id}),'GET','');if(!isWorkChallenge(value)||value.challengeId!==id||value.expiresAt<=Date.now()||workDigest(value.native)!==workDigest(native()))workFail('challenge_changed');return value}
 function install(value:unknown,approval:WorkNativeApproval){
  if(!isWorkAssociation(value)||value.state!=='active'||value.expiresAt<=Date.now()||workDigest(value.native)!==workDigest(native())||workDigest(value.orgSession)!==workDigest(approval.challenge.orgSession))workFail('association_changed');
  db.transaction(()=>{const prior=db.prepare('SELECT record_json FROM one_business_work_connections WHERE association_id=?').get(value.associationId) as {record_json:string}|undefined;if(prior&&prior.record_json!==JSON.stringify(value))workFail('association_changed');if(!prior)db.prepare("INSERT INTO one_business_work_connections VALUES(?,'active',?,?,0)").run(value.associationId,JSON.stringify(value),JSON.stringify(approval));db.prepare("UPDATE one_business_work_connection_attempts SET state='confirmed' WHERE id=?").run(approval.approvalReceiptId)}).immediate();active=workSnapshot(value);return requireCurrent();
 }
 async function complete(value:unknown,focused:()=>void){if(current())workFail('connection_already_active');const release=beginAssociationUpdate();try{
  if(!isWorkChallenge(value))workFail('challenge_required');const c=workSnapshot(value),check=()=>{focused();if(current())workFail('connection_already_active');if(c.expiresAt<=Date.now()||workDigest(c.native)!==workDigest(native()))workFail('challenge_changed')};check();schema();
  if(db.prepare('SELECT id FROM one_business_work_connection_attempts WHERE challenge_id=?').get(c.challengeId))workFail('receipt_lookup_required');
  const payload={challenge:c,approvedAt:Date.now(),approvalReceiptId:randomUUID()},signature=await signPayload('association-approve',payload,check);check();const approval={...payload,signature};db.prepare("INSERT INTO one_business_work_connection_attempts VALUES(?,?,?,'attempted')").run(payload.approvalReceiptId,c.challengeId,JSON.stringify(approval));
  const result=await fetchOriginal(url('complete'),'POST',JSON.stringify(approval));check();return install(result,approval);
  }finally{release();}
 }
 async function reconcileApproval(id:string){const release=beginAssociationUpdate();try{
  schema();const row=db.prepare('SELECT approval_json FROM one_business_work_connection_attempts WHERE id=?').get(id) as {approval_json:string}|undefined;if(!row)workFail('receipt_unknown');const approval=JSON.parse(row.approval_json) as WorkNativeApproval;if(workDigest(approval.challenge.native)!==workDigest(native()))workFail('native_owner_changed');
  const before=current();if(before){const original=db.prepare('SELECT approval_json FROM one_business_work_connections WHERE association_id=?').get(before.associationId) as {approval_json:string}|undefined;if(original?.approval_json!==row.approval_json)workFail('connection_already_active');}
  const value=await fetchOriginal(url('complete',{challengeId:approval.challenge.challengeId,approvalReceiptId:id}),'GET','',undefined,approval);
  if(before&&workDigest(value)!==workDigest(before))workFail('connection_already_active');return install(value,approval);
  }finally{release();}}
 function pendingApproval(id:string){if(!initialized)return null;const row=db.prepare("SELECT id FROM one_business_work_connection_attempts WHERE challenge_id=? AND state='attempted'").get(id) as {id:string}|undefined;return row?.id??null}
 async function request(op:Operation,body:unknown=null,query?:Record<string,string>,method:'GET'|'POST'=op==='association'||op==='receipt'?'GET':'POST',terminal?:WorkNativeAssociation){
  if(terminal&&op!=='revoke')workFail('terminal_operation_invalid');
  const before=terminal??requireCurrent(),checkLocal=()=>{if(terminal){if(workDigest(native())!==workDigest(before.native))workFail('native_owner_changed')}else if(workDigest(requireCurrent())!==workDigest(before))workFail('work_consent_changed')},target=url(op,query),bytes=method==='GET'?'':JSON.stringify(workSnapshot(body));
  const sequence=db.transaction(()=>{checkLocal();const row=db.prepare('SELECT sequence FROM one_business_work_connections WHERE association_id=?').get(before.associationId) as {sequence:number};if(!Number.isSafeInteger(row.sequence)||row.sequence>=Number.MAX_SAFE_INTEGER)workFail('sequence_exhausted');const next=row.sequence+1;if(db.prepare("UPDATE one_business_work_connections SET sequence=? WHERE association_id=? AND sequence=?").run(next,before.associationId,row.sequence).changes!==1)workFail('work_consent_changed');return next}).immediate();
  const issuedAt=Date.now(),payload={associationId:before.associationId,associationRevision:before.associationRevision,native:before.native,nativeAccountAuthEpoch:before.nativeAccountAuthEpoch,method,url:target,bodyDigest:createHash('sha256').update(bytes).digest('hex'),nonce:randomUUID(),sequence,issuedAt,expiresAt:issuedAt+30000};const check=checkLocal,signature=await signPayload('request',payload,check);check();const result=await fetchOriginal(target,method,bytes,{payload,signature});check();return result;
 }
 async function refresh(){const before=requireCurrent(),value=await request('association');if(!isWorkAssociation(value))workFail('association_invalid');if(value.state!=='active'||value.expiresAt<=Date.now()){localRevoke();workFail(value.state==='revoked'?'association_revoked':'association_expired')}if(workDigest(value)!==workDigest(before)){localRevoke();workFail('association_changed')}return value}
 async function submit(op:'register'|'intent'|'result',key:string,body:unknown){schema();const a=requireCurrent(),id=op+':'+key,bytes=JSON.stringify(workSnapshot(body));if(db.prepare('SELECT request_id FROM one_business_work_requests WHERE request_id=?').get(id))workFail('receipt_lookup_required');db.prepare("INSERT INTO one_business_work_requests VALUES(?,?,?,?,'attempted',NULL)").run(id,a.associationId,op,bytes);const result=await request(op,body);db.prepare("UPDATE one_business_work_requests SET state='observed',result_json=? WHERE request_id=? AND state='attempted'").run(JSON.stringify(result),id);return result}
 async function lookup(op:'register'|'intent'|'result',key:string){schema();const a=requireCurrent(),row=db.prepare('SELECT association_id FROM one_business_work_requests WHERE request_id=?').get(op+':'+key) as {association_id:string}|undefined;if(!row||row.association_id!==a.associationId)workFail('receipt_unknown');return request('receipt',null,{kind:op,key})}
 function localRevoke(){const prior=active;active=null;lastState='revoked';if(initialized&&prior)db.prepare("UPDATE one_business_work_connections SET state='revoked' WHERE association_id=?").run(prior.associationId)}
 const admission:EmployeeAgentWorkAdmission=Object.freeze({protocol:'agentlas.business.original-work-local-admission.v1',capture(){const a=requireCurrent(),cap=Object.freeze({});caps.set(cap,workDigest(a));return cap},read(cap:object){const a=requireCurrent();if(caps.get(cap)!==workDigest(a))return null;const pins:WorkAssociationPins={purpose:EMPLOYEE_AGENT_WORK_PURPOSE,associationId:a.associationId,revision:String(a.associationRevision),organizationId:a.orgSession.organizationId,principalId:a.orgSession.principalId,nativeSessionId:a.native.nativeSessionId,nativeWorkspaceId:a.native.nativeWorkspaceId,hostId:a.native.nativeHostId,custodyGeneration:a.native.custodyGeneration,installationGeneration:a.native.installationGeneration,consentRevision:String(a.consentRevision),sourceRevision:String(a.sourceRevision)};return pins},assertCurrent(cap:object){const a=requireCurrent();if(caps.get(cap)!==workDigest(a))workFail('work_consent_changed')},refreshCurrent:async()=>{await refresh()}});
 return Object.freeze({native,current,status(){if(active?.expiresAt&&active.expiresAt<=Date.now())return{state:'expired' as const};return{state:current()?'associated' as const:active?'revoked' as const:lastState}},admission,challenge,complete,reconcileApproval,pendingApproval,refresh,submit,lookup,readIntent:(id:string)=>request('intent',null,{intentId:id},'GET'),
  async revoke(){const before=active;localRevoke();if(!before)return{state:'revoked'};try{return await request('revoke',{associationId:before.associationId,associationRevision:before.associationRevision,idempotencyKey:'revoke:'+before.associationId},undefined,'POST',before)}catch{return{state:'unknown'}}},localRevoke,close(){try{localRevoke()}finally{closed=true}}});
}
