import {createHash,randomUUID,sign} from 'node:crypto';
import {getAuthenticatedSessionBinding,sessionForDaemonHandoff,webBaseUrl} from '../auth';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import {loadOneVaultApprovedHost} from '../secrets/one-vault-service';
import {businessNativeSigningText,isBusinessNativeChallenge,isBusinessNativeIdentity,BUSINESS_NATIVE_SHARING_PURPOSE,
 type BusinessNativeIdentity,type BusinessNativeChallenge,type BusinessNativeApproval,type BusinessNativeAssociation,type BusinessNativeRequestProof} from '../../shared/business/native-sharing-wire';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import {isBusinessSession,isBusinessRevision,businessOnlyKeys} from '../../shared/business/context';
import type {BusinessNativeOrganizationAssociationOwner,BusinessNativeInstallationIdentity} from '../../shared/business/native-association';
const base='/api/business/native/employee-agents/';
function deny(code='business_native_connection_unavailable'):never{throw Object.assign(Error('business_native_connection_unavailable'),{code})}
function association(value:unknown):value is BusinessNativeAssociation{
 if(!businessOnlyKeys(value,['associationId','associationRevision','orgSession','native','nativeAccountAuthEpoch','purpose','audiencePrincipalIds','sourceAuthorityId','commandAuthorityId','consentRevision','sourceRevision','state','expiresAt']))return false;
 const v=value as unknown as BusinessNativeAssociation;
 return typeof v.associationId==='string'&&v.associationId.length>0&&v.associationId.length<=256&&isBusinessSession(v.orgSession)&&isBusinessNativeIdentity(v.native)&&Array.isArray(v.audiencePrincipalIds)&&v.audiencePrincipalIds.includes(v.orgSession.principalId)&&[v.associationRevision,v.nativeAccountAuthEpoch,v.sourceRevision,v.consentRevision].every(isBusinessRevision)&&v.purpose===BUSINESS_NATIVE_SHARING_PURPOSE&&v.state==='active'&&Number.isFinite(Date.parse(v.expiresAt));
}
/** Existing first-party native credential + original host key. Construction is
 * inert; only explicit native actions invoke fetch/key reads. No new bearer. */
export function createNativeEmployeeConnection(runtime:OneVaultRuntime,installationGeneration:()=>number){
 let closed=false,active:BusinessNativeAssociation|null=null,associationUpdatePending=false;
 const capabilities=new WeakMap<object,string>();
 const db=runtime.sources.db,originalReferences=[runtime.currentNativeOwner,runtime.sources,runtime.trust,runtime.trust.currentHostMetadata,runtime.sources.oneId];
 function schema(){db.exec(`CREATE TABLE IF NOT EXISTS one_business_native_associations(
 association_id TEXT PRIMARY KEY,state TEXT NOT NULL,record_json TEXT NOT NULL,approval_json TEXT NOT NULL,sequence INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS one_business_native_association_attempts(approval_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL,state TEXT NOT NULL,approval_json TEXT NOT NULL);`)}
 function native():BusinessNativeIdentity{
  if([runtime.currentNativeOwner,runtime.sources,runtime.trust,runtime.trust.currentHostMetadata,runtime.sources.oneId].some((v,i)=>v!==originalReferences[i])||runtime.sources.db!==db)deny();
  const owner=runtime.currentNativeOwner(),auth=getAuthenticatedSessionBinding(),host=runtime.trust.currentHostMetadata();
  if(closed||!owner||!auth||!host||owner.principalId!==auth.userId||owner.sessionId!==auth.sessionId||owner.workspaceId!==auth.workspaceId||host.hostId!==owner.hostId)deny();
  return {nativeAccountId:owner.principalId,nativeWorkspaceId:owner.workspaceId,nativeSessionId:owner.sessionId,nativeSessionRevision:auth.sessionId,
   nativeHostId:owner.hostId,oneId:runtime.sources.oneId(),hostKeyId:host.hostKeyId,hostPublicKey:host.signingPublicKey,custodyGeneration:owner.custodyGeneration,installationGeneration:installationGeneration(),trustGeneration:host.generation};
 }
 function current():BusinessNativeAssociation|null{
  try{if(!active||active.state!=='active'||Date.parse(active.expiresAt)<=Date.now()||digest(active.native)!==digest(native()))return null;
   const row=db.prepare("SELECT record_json FROM one_business_native_associations WHERE association_id=? AND state='active'").get(active.associationId) as {record_json:string}|undefined;
   return row?.record_json===JSON.stringify(active)?structuredClone(active):null;
  }catch{return null;}
 }
 function beginAssociationUpdate(){if(associationUpdatePending)deny('business_native_connection_approval_in_progress');associationUpdatePending=true;return()=>{associationUpdatePending=false;};}
 function url(operation:string,query?:Record<string,string>){const root=new URL(webBaseUrl());if(root.protocol!=='https:'||root.username||root.password||root.search||root.hash)deny();const target=new URL(base+operation,root);for(const [k,v]of Object.entries(query??{}))target.searchParams.set(k,v);return target.toString();}
 async function fetchOriginal(target:string,method:string,body:string,proof?:BusinessNativeRequestProof,approval?:BusinessNativeApproval){
  const before=native(),auth=getAuthenticatedSessionBinding(),session=sessionForDaemonHandoff();if(!auth||!session?.cookieValue)deny();
  const headers:Record<string,string>={Authorization:`Bearer ${session.cookieValue}`,'Content-Type':'application/json'};
  if(approval)headers['x-agentlas-business-native-approval']=Buffer.from(JSON.stringify(approval),'utf8').toString('base64url');
  if(proof)headers['x-agentlas-business-native-proof']=Buffer.from(JSON.stringify(proof),'utf8').toString('base64url');
  const response=await fetch(target,{method,headers,...(method==='GET'?{}:{body}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(digest(native())!==digest(before)||digest(getAuthenticatedSessionBinding())!==digest(auth)||sessionForDaemonHandoff()?.cookieValue!==session.cookieValue)deny();
  const text=await response.text();if(Buffer.byteLength(text)>512000)deny();const value:unknown=JSON.parse(text);
  if(!response.ok){const candidate=value&&typeof value==='object'?(value as {error?:unknown}).error:null;const code=typeof candidate==='string'?candidate:candidate&&typeof candidate==='object'?(candidate as {code?:unknown}).code:null;throw Object.assign(Error('business_native_root_denied'),{code:typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:'business_native_root_denied',status:response.status})}
  if(digest(native())!==digest(before)||digest(getAuthenticatedSessionBinding())!==digest(auth)||sessionForDaemonHandoff()?.cookieValue!==session.cookieValue)deny();return value;
 }
 async function signPayload(domain:'association-approve'|'request',payload:unknown,assertCurrent:()=>void){
  assertCurrent();const before=native(),host=await loadOneVaultApprovedHost(before.nativeHostId,runtime.trust,runtime.sources.vault);assertCurrent();
  if(digest(native())!==digest(before)||host.metadata.hostKeyId!==before.hostKeyId||host.metadata.signingPublicKey!==before.hostPublicKey)deny();
  return sign('sha256',Buffer.from(businessNativeSigningText(domain,payload),'utf8'),{key:host.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 }
 async function challenge(challengeId:string){if(typeof challengeId!=='string'||!challengeId||challengeId.length>256)deny();const value=await fetchOriginal(url('challenge',{challengeId}),'GET','');
  if(!isBusinessNativeChallenge(value)||value.challengeId!==challengeId||value.expiresAt<=Date.now()||digest(value.native)!==digest(native()))deny();return structuredClone(value);
 }
 async function complete(challenge:BusinessNativeChallenge,assertFocusedApproval:()=>void){
  if(current())deny('business_native_connection_already_active');const release=beginAssociationUpdate();try{
  const exact=structuredClone(challenge);const check=()=>{assertFocusedApproval();if(current())deny('business_native_connection_already_active');if(!isBusinessNativeChallenge(exact)||exact.expiresAt<=Date.now()||digest(exact.native)!==digest(native()))deny()};check();schema();
  if(db.prepare('SELECT 1 FROM one_business_native_association_attempts WHERE challenge_id=?').get(exact.challengeId))throw Error('business_native_completion_use_receipt_lookup');
  const payload={challenge:exact,approvedAt:Date.now(),approvalReceiptId:randomUUID()},signature=await signPayload('association-approve',payload,check);check();
  const approval:BusinessNativeApproval={...payload,signature};db.transaction(()=>{check();db.prepare("INSERT INTO one_business_native_association_attempts VALUES(?,?,'attempted',?)").run(payload.approvalReceiptId,exact.challengeId,JSON.stringify(approval))}).immediate();
  const value=await fetchOriginal(url('complete'),'POST',JSON.stringify(approval));check();
  if(!association(value)||digest(value.native)!==digest(exact.native)||digest(value.orgSession)!==digest(exact.orgSession)||digest(value.audiencePrincipalIds)!==digest(exact.audiencePrincipalIds)||value.sourceAuthorityId!==exact.sourceAuthorityId||value.commandAuthorityId!==exact.commandAuthorityId)deny();
  db.transaction(()=>{check();db.prepare("INSERT INTO one_business_native_associations VALUES(?,'active',?,?,0)").run(value.associationId,JSON.stringify(value),JSON.stringify(approval));db.prepare("UPDATE one_business_native_association_attempts SET state='confirmed' WHERE approval_id=? AND state='attempted'").run(payload.approvalReceiptId)}).immediate();active=structuredClone(value);return current()??deny();
  }finally{release();}
 }
 function pendingApproval(challengeId:string):string|null{try{const rows=db.prepare("SELECT approval_id,approval_json FROM one_business_native_association_attempts WHERE challenge_id=? AND state='attempted'").all(challengeId) as Array<{approval_id:string;approval_json:string}>;if(rows.length!==1)return null;const approval=JSON.parse(rows[0].approval_json) as BusinessNativeApproval;return digest(approval.challenge.native)===digest(native())?rows[0].approval_id:null}catch{return null}}
 async function reconcile(approvalReceiptId:string){
  const release=beginAssociationUpdate();try{
  schema();const row=db.prepare('SELECT approval_json FROM one_business_native_association_attempts WHERE approval_id=?').get(approvalReceiptId) as {approval_json:string}|undefined;if(!row)deny();
  const approval=JSON.parse(row.approval_json) as BusinessNativeApproval;if(digest(approval.challenge.native)!==digest(native()))deny();
  const before=current();if(before){const original=db.prepare('SELECT approval_json FROM one_business_native_associations WHERE association_id=?').get(before.associationId) as {approval_json:string}|undefined;
   if(original?.approval_json!==row.approval_json)deny('business_native_connection_already_active');}
  const value=await fetchOriginal(url('complete',{challengeId:approval.challenge.challengeId,approvalReceiptId}),'GET','',undefined,approval);
  if(!association(value)||digest(value.native)!==digest(native())||digest(value.orgSession)!==digest(approval.challenge.orgSession)||digest(value.audiencePrincipalIds)!==digest(approval.challenge.audiencePrincipalIds)||value.sourceAuthorityId!==approval.challenge.sourceAuthorityId||value.commandAuthorityId!==approval.challenge.commandAuthorityId)deny();
  if(before&&digest(value)!==digest(before))deny('business_native_connection_already_active');
  db.transaction(()=>{if(digest(value.native)!==digest(native()))deny();const existing=db.prepare('SELECT record_json FROM one_business_native_associations WHERE association_id=?').get(value.associationId) as {record_json:string}|undefined;
   if(existing&&existing.record_json!==JSON.stringify(value))deny();if(!existing)db.prepare("INSERT INTO one_business_native_associations VALUES(?,'active',?,?,0)").run(value.associationId,JSON.stringify(value),row.approval_json);
   db.prepare("UPDATE one_business_native_association_attempts SET state='confirmed' WHERE approval_id=?").run(approvalReceiptId);
  }).immediate();active=structuredClone(value);return current()??deny();
  }finally{release();}
 }
 async function request(operation:'association'|'prepare'|'packet'|'receipt'|'revoke'|'publish'|'report'|'publication-receipt'|'publish-continue'|'transfers/prepare'|'transfers/commit'|'transfers/receipt'|'transfers/package'|'transfers/inbox'|'transfers/snapshot'|'transfers/install-ack'|'transfers/installation-receipt'|`company-work/${'admit'|'claim'|'refresh'|'settle'|'receipt'|'cancel'|'review'|'policies'}`,body:unknown=null,query?:Record<string,string>){
  const before=current();if(!before)deny();const method=operation==='association'||operation==='receipt'||operation==='report'?'GET':'POST',target=url(operation,query),bytes=method==='GET'?'':JSON.stringify(body);
  const sequence=db.transaction(()=>{if(digest(current())!==digest(before))deny();const row=db.prepare('SELECT sequence FROM one_business_native_associations WHERE association_id=?').get(before.associationId) as {sequence:number};
   if(!Number.isSafeInteger(row.sequence)||row.sequence>=Number.MAX_SAFE_INTEGER)deny();const next=row.sequence+1;const changed=db.prepare('UPDATE one_business_native_associations SET sequence=? WHERE association_id=? AND sequence=? AND state=\'active\'').run(next,before.associationId,row.sequence);if(Number(changed.changes)!==1)deny();return next;}).immediate();
  const issuedAt=Date.now(),payload={associationId:before.associationId,associationRevision:before.associationRevision,native:before.native,nativeAccountAuthEpoch:before.nativeAccountAuthEpoch,method,url:target,bodyDigest:createHash('sha256').update(bytes).digest('hex'),nonce:randomUUID(),sequence,issuedAt,expiresAt:issuedAt+30000};
  const check=()=>{if(digest(current())!==digest(before))deny()},signature=await signPayload('request',payload,check);check();const result=await fetchOriginal(target,method,bytes,{payload,signature});check();return result;
 }
 async function refresh(){const before=current();if(!before)deny();try{const value=await request('association');if(!association(value)||digest(value)!==digest(before)){invalidate();deny()}return current()??deny();}catch(error){throw error}}
 function invalidate(){if(active){try{db.prepare("UPDATE one_business_native_associations SET state='revoked' WHERE association_id=?").run(active.associationId)}finally{active=null;}}}
 const owner:BusinessNativeOrganizationAssociationOwner=Object.freeze({captureCurrent(input:Readonly<BusinessNativeInstallationIdentity&{organizationSession:import('../../shared/business/context').BusinessSession}>){const value=current();if(!value)return null;const n=value.native;
  if(digest(input)!==digest({nativeActor:{principalId:n.nativeAccountId,sessionId:n.nativeSessionId,workspaceId:n.nativeWorkspaceId,oneId:n.oneId,hostId:n.nativeHostId},custodyGeneration:n.custodyGeneration,installationGeneration:n.installationGeneration,organizationSession:value.orgSession}))return null;
  const cap=Object.freeze({});capabilities.set(cap,JSON.stringify(value));return cap;},readCurrent(cap:object){const value=current();if(!value||capabilities.get(cap)!==JSON.stringify(value))return null;const n=value.native;return {nativeActor:{principalId:n.nativeAccountId,sessionId:n.nativeSessionId,workspaceId:n.nativeWorkspaceId,oneId:n.oneId,hostId:n.nativeHostId},custodyGeneration:n.custodyGeneration,installationGeneration:n.installationGeneration,organizationSession:value.orgSession,
   origin:{authorityId:value.sourceAuthorityId,recordId:value.associationId,revision:`association:${value.associationRevision}`},nativeSessionRevision:n.nativeSessionRevision,sourceRevision:`source:${value.sourceRevision}`};}});
 return Object.freeze({native,challenge,complete,pendingApproval,reconcile,request,refresh,current,association:owner,invalidate,close(){closed=true;invalidate()}});
}
