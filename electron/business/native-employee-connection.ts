import {createHash,randomUUID,sign} from 'node:crypto';
import {getAuthenticatedSessionBinding,sessionForDaemonHandoff,webBaseUrl} from '../auth';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import {loadOneVaultApprovedHost} from '../secrets/one-vault-service';
import {businessNativeSigningText,isBusinessNativeChallenge,isBusinessNativeIdentity,BUSINESS_NATIVE_SHARING_PURPOSE,
 type BusinessNativeIdentity,type BusinessNativeChallenge,type BusinessNativeApproval,type BusinessNativeAssociation,type BusinessNativeRequestProof} from '../../shared/business/native-sharing-wire';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import {isBusinessId,isBusinessSession,isBusinessRevision,businessOnlyKeys} from '../../shared/business/context';
import type {BusinessNativeOrganizationAssociationOwner,BusinessNativeInstallationIdentity} from '../../shared/business/native-association';
const base='/api/business/native/employee-agents/';
function deny(code='business_native_connection_unavailable'):never{throw Object.assign(Error('business_native_connection_unavailable'),{code})}
/** The identity of the same personal account on the same device: session ID/revision, installation generation AND custody generation are the
 * moving parts (custody generation embeds this process's owner epoch, so it changes on every app start). The device key anchors custody. */
const STABLE_NATIVE=['nativeAccountId','nativeWorkspaceId','nativeHostId','oneId','hostKeyId','hostPublicKey','trustGeneration'] as const;
const sameStable=(a:BusinessNativeIdentity,b:BusinessNativeIdentity)=>STABLE_NATIVE.every(k=>a[k]===b[k]);
/** A server-confirmed re-binding of the SAME approved pair: nothing but the live session context may differ from what is stored. */
function compatible(before:BusinessNativeAssociation,value:BusinessNativeAssociation):boolean{
 const a=before.orgSession,b=value.orgSession;
 return value.associationId===before.associationId&&value.associationRevision===before.associationRevision&&value.state==='active'
  &&sameStable(before.native,value.native)&&value.nativeAccountAuthEpoch===before.nativeAccountAuthEpoch&&value.purpose===before.purpose
  &&a.principalId===b.principalId&&a.deploymentId===b.deploymentId&&a.identityAuthorityId===b.identityAuthorityId&&a.organizationId===b.organizationId
  &&digest(value.audiencePrincipalIds)===digest(before.audiencePrincipalIds)&&value.sourceAuthorityId===before.sourceAuthorityId&&value.commandAuthorityId===before.commandAuthorityId
  &&value.consentRevision===before.consentRevision&&value.sourceRevision===before.sourceRevision&&Date.parse(value.expiresAt)>Date.now();
}
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
 function prepareSchema(){db.exec(`CREATE TABLE IF NOT EXISTS one_business_native_prepare_attempts(
 association_id TEXT NOT NULL,selection_digest TEXT NOT NULL,state TEXT NOT NULL,selection_json TEXT NOT NULL,expectation_json TEXT,
 PRIMARY KEY(association_id,selection_digest));`)}
 function native():BusinessNativeIdentity{
  if([runtime.currentNativeOwner,runtime.sources,runtime.trust,runtime.trust.currentHostMetadata,runtime.sources.oneId].some((v,i)=>v!==originalReferences[i])||runtime.sources.db!==db)deny('business_native_connection_references_changed');
  const owner=runtime.currentNativeOwner(),auth=getAuthenticatedSessionBinding(),host=runtime.trust.currentHostMetadata();
  if(closed||!owner||!auth||!host)deny('business_native_connection_owner_unavailable');
  if(owner.principalId!==auth.userId||owner.sessionId!==auth.sessionId||owner.workspaceId!==auth.workspaceId||host.hostId!==owner.hostId)deny('business_native_connection_identity_changed');
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
 async function fetchOriginal(target:string,method:string,body:string,proof?:BusinessNativeRequestProof,approval?:BusinessNativeApproval,challengeExpiresAt?:number,deviceProof?:{payload:{expiresAt:number};signature:string}){
  const before=native(),auth=getAuthenticatedSessionBinding(),session=sessionForDaemonHandoff();if(!auth||!session?.cookieValue)deny();
  // This personal Native route may wait for the original Root admission, but
  // never outlive the signed proof, focused challenge, or current identity.
  // Receipt reconciliation deliberately has no challenge deadline: its original
  // GET reads the exact already attempted effect after a challenge expires.
  const now=Date.now(),deadlines=[now+45000];
  if(auth.expiresAt!==null)deadlines.push(auth.expiresAt);
  if(challengeExpiresAt!==undefined)deadlines.push(challengeExpiresAt);
  if(proof)deadlines.push(proof.payload.expiresAt);
  if(deviceProof)deadlines.push(deviceProof.payload.expiresAt);
  if(active){deadlines.push(Date.parse(active.expiresAt),Date.parse(active.orgSession.expiresAt));}
  if(deadlines.some(v=>!Number.isFinite(v))||Math.min(...deadlines)<=now)deny();
  const budget=Math.floor(Math.min(...deadlines)-now);if(budget<1)deny();
  const headers:Record<string,string>={Authorization:`Bearer ${session.cookieValue}`,'Content-Type':'application/json'};
  if(approval)headers['x-agentlas-business-native-approval']=Buffer.from(JSON.stringify(approval),'utf8').toString('base64url');
  if(proof)headers['x-agentlas-business-native-proof']=Buffer.from(JSON.stringify(proof),'utf8').toString('base64url');
  if(deviceProof)headers['x-agentlas-business-native-device']=Buffer.from(JSON.stringify(deviceProof),'utf8').toString('base64url');
  const response=await fetch(target,{method,headers,...(method==='GET'?{}:{body}),redirect:'error',signal:AbortSignal.timeout(budget)});
  const responseOwner=()=>{
   if(digest(native())!==digest(before))deny('business_native_connection_response_native_changed');
   if(digest(getAuthenticatedSessionBinding())!==digest(auth))deny('business_native_connection_response_auth_changed');
   if(sessionForDaemonHandoff()?.cookieValue!==session.cookieValue)deny('business_native_connection_response_session_changed');
  };responseOwner();
  const text=await response.text();if(Buffer.byteLength(text)>512000)deny();const value:unknown=JSON.parse(text);
  if(!response.ok){const candidate=value&&typeof value==='object'?(value as {error?:unknown}).error:null;const code=typeof candidate==='string'?candidate:candidate&&typeof candidate==='object'?(candidate as {code?:unknown}).code:null;throw Object.assign(Error('business_native_root_denied'),{code:typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:'business_native_root_denied',status:response.status})}
  responseOwner();return value;
 }
 async function signPayload(domain:'association-approve'|'request'|'device-register',payload:unknown,assertCurrent:()=>void){
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
  const value=await fetchOriginal(url('complete'),'POST',JSON.stringify(approval),undefined,undefined,exact.expiresAt);check();
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
 async function signedRequest(operation:string,method:'GET'|'POST',body:unknown,query?:Record<string,string>,candidate?:BusinessNativeAssociation){
  // A candidate is a persisted approved association being resumed with the CURRENT native identity; it is held, not current, until the server confirms it.
  const before=candidate??current();if(!before)deny();const target=url(operation,query),bytes=method==='GET'?'':JSON.stringify(body);
  const holds=()=>candidate?digest(candidate.native)===digest(native())&&!!db.prepare("SELECT 1 FROM one_business_native_associations WHERE association_id=? AND state='active'").get(candidate.associationId):digest(current())===digest(before);
  const sequence=db.transaction(()=>{if(!holds())deny();const row=db.prepare('SELECT sequence FROM one_business_native_associations WHERE association_id=?').get(before.associationId) as {sequence:number};
   if(!Number.isSafeInteger(row.sequence)||row.sequence>=Number.MAX_SAFE_INTEGER)deny();const next=row.sequence+1;const changed=db.prepare('UPDATE one_business_native_associations SET sequence=? WHERE association_id=? AND sequence=? AND state=\'active\'').run(next,before.associationId,row.sequence);if(Number(changed.changes)!==1)deny();return next;}).immediate();
  const issuedAt=Date.now(),payload={associationId:before.associationId,associationRevision:before.associationRevision,native:before.native,nativeAccountAuthEpoch:before.nativeAccountAuthEpoch,method,url:target,bodyDigest:createHash('sha256').update(bytes).digest('hex'),nonce:randomUUID(),sequence,issuedAt,expiresAt:issuedAt+30000};
  const check=()=>{if(!holds())deny('business_native_connection_request_owner_changed')},signature=await signPayload('request',payload,check);check();const result=await fetchOriginal(target,method,bytes,{payload,signature});check();return result;
 }
 let lastResume:'none'|'resumed'|'company-login-required'|'revoked'|'unavailable'='none',lastRegistration:{at:number;registered:number}|null=null;
 /** A device that holds no approved pair of its own asks the server to let it join the pairs THIS personal account already has approved. No approval
  * step exists: the server re-checks the personal login, the live company login, membership and licence, and this device key signs a proof of possession.
  * Only a server-confirmed association for THIS device (current identity) is adopted. An ended device key is refused by the server and stays ended. */
 async function registerDevice():Promise<BusinessNativeAssociation|null>{
  const existing=current();if(existing)return existing;
  // Asked a moment ago and the account has no approved pair at all: do not ask again on every action. A refusal with a reason is asked again at once.
  if(lastRegistration&&Date.now()-lastRegistration.at<60000)return null;
  const release=beginAssociationUpdate();try{
   schema();const now=native(),target=url('device-register'),bytes=JSON.stringify({});
   const issuedAt=Date.now(),payload={native:now,organizationId:null,method:'POST' as const,url:target,bodyDigest:createHash('sha256').update(bytes).digest('hex'),nonce:randomUUID(),issuedAt,expiresAt:issuedAt+30000};
   const check=()=>{if(digest(native())!==digest(now))deny('business_native_connection_request_owner_changed')};
   const signature=await signPayload('device-register',payload,check);check();
   const value=await fetchOriginal(target,'POST',bytes,undefined,undefined,undefined,{payload,signature});check();
   const v=value as {schema?:unknown;registered?:unknown;skipped?:unknown};
   if(!businessOnlyKeys(value,['schema','registered','skipped'])||v.schema!=='agentlas.business.native-device-registration.v1'||!Array.isArray(v.registered)||v.registered.length>8||!Array.isArray(v.skipped)||v.skipped.length>8)return null;
   const adopted=(v.registered as unknown[]).filter((x):x is BusinessNativeAssociation=>association(x)&&sameStable(x.native,now)&&digest(x.native)===digest(now)&&Date.parse(x.expiresAt)>Date.now());
   if(!adopted.length){if(!(v.registered as unknown[]).length&&!(v.skipped as unknown[]).length)lastRegistration={at:Date.now(),registered:0};return null}
   db.transaction(()=>{if(digest(native())!==digest(now))deny();
    for(const x of adopted)db.prepare("INSERT INTO one_business_native_associations VALUES(?,'active',?,?,0) ON CONFLICT(association_id) DO UPDATE SET record_json=excluded.record_json WHERE one_business_native_associations.state='active'").run(x.associationId,JSON.stringify(x),JSON.stringify({kind:'automatic-device-registration',registeredAt:Date.now()}));
   }).immediate();
   active=structuredClone(adopted[0]);lastRegistration=null;lastResume='resumed';return current();
  }finally{release()}
 }
 /** After a restart/re-login/org switch: the persisted approved pair is offered to the server with the CURRENT identity. Nothing is trusted from
  * disk: only a server-confirmed, compatible association becomes current, and the capability that follows is minted afresh from it. */
 async function resume():Promise<BusinessNativeAssociation|null>{
  const existing=current();if(existing)return existing;
  const release=beginAssociationUpdate();try{
   schema();const now=native();let outcome:typeof lastResume='none';
   const rows=db.prepare("SELECT association_id,record_json FROM one_business_native_associations WHERE state='active' ORDER BY rowid DESC LIMIT 16").all() as Array<{association_id:string;record_json:string}>;
   for(const row of rows){
    let stored:unknown;try{stored=JSON.parse(row.record_json)}catch{continue}
    if(!association(stored)||stored.associationId!==row.association_id||stored.state!=='active'||!sameStable(stored.native,now))continue;
    const candidate:BusinessNativeAssociation={...stored,native:now};let value:unknown;
    try{value=await signedRequest('association','GET',null,undefined,candidate)}
    catch(error){const code=error&&typeof error==='object'?(error as {code?:unknown}).code:null;
     if(code==='business_native_association_revoked'||code==='business_native_association_invalid'){db.prepare("UPDATE one_business_native_associations SET state='revoked' WHERE association_id=?").run(row.association_id);outcome='revoked'}
     else if(code==='business_native_company_login_required')outcome='company-login-required';else if(outcome==='none')outcome='unavailable';continue}
    if(!association(value)||!compatible(candidate,value)||digest(value.native)!==digest(now)){outcome='unavailable';continue}
    db.transaction(()=>{if(digest(native())!==digest(now))deny();const changed=db.prepare("UPDATE one_business_native_associations SET record_json=? WHERE association_id=? AND state='active'").run(JSON.stringify(value),row.association_id);if(Number(changed.changes)!==1)deny()}).immediate();
    active=structuredClone(value);lastResume='resumed';return current();
   }
   lastResume=outcome;return null;
  }finally{release()}
 }
 async function request(operation:'association'|'prepare'|'packet'|'receipt'|'revoke'|'publish'|'report'|'publication-receipt'|'publication-recover'|'publish-continue'|'transfers/prepare'|'transfers/commit'|'transfers/receipt'|'transfers/package'|'transfers/inbox'|'transfers/snapshot'|'transfers/snapshot-receipt'|'transfers/install-ack'|'transfers/installation-receipt'|`company-work/${'admit'|'claim'|'refresh'|'settle'|'receipt'|'cancel'|'review'|'policies'}`,body:unknown=null,query?:Record<string,string>){
  if(operation==='prepare'){
   if(!body||typeof body!=='object'||!businessOnlyKeys(body,['agentResourceId','sourceResourceIds']))deny();
   const selection=body as {agentResourceId:string;sourceResourceIds:string[]};
   if(!isBusinessId(selection.agentResourceId)||!Array.isArray(selection.sourceResourceIds)||selection.sourceResourceIds.length<1
     ||selection.sourceResourceIds.length>49||selection.sourceResourceIds.some(id=>!isBusinessId(id))
     ||new Set([selection.agentResourceId,...selection.sourceResourceIds]).size!==selection.sourceResourceIds.length+1)deny();
   const a=current();if(!a)deny();prepareSchema();const exact=JSON.stringify(selection),selectionDigest=digest(selection);
   const prior=db.prepare('SELECT state,selection_json FROM one_business_native_prepare_attempts WHERE association_id=? AND selection_digest=?')
    .get(a.associationId,selectionDigest) as {state:string;selection_json:string}|undefined;
   if(prior){if(prior.selection_json!==exact||!['attempted','confirmed'].includes(prior.state))deny();return lookupPrepare(selection)}
   db.prepare("INSERT INTO one_business_native_prepare_attempts VALUES(?,?,'attempted',?,NULL)").run(a.associationId,selectionDigest,exact);
   const value=await signedRequest(operation,'POST',body,query);
   db.prepare("UPDATE one_business_native_prepare_attempts SET state='confirmed',expectation_json=? WHERE association_id=? AND selection_digest=? AND state='attempted'")
    .run(JSON.stringify(value),a.associationId,selectionDigest);
   return value;
  }
  return signedRequest(operation,operation==='association'||operation==='receipt'||operation==='report'?'GET':'POST',body,query);
 }
 async function lookupPrepare(selection:{readonly requestId?:string;readonly agentResourceId:string;readonly sourceResourceIds:readonly string[]}){
  if(!businessOnlyKeys(selection,selection.requestId===undefined?['agentResourceId','sourceResourceIds']:['requestId','agentResourceId','sourceResourceIds'])
    ||!isBusinessId(selection.agentResourceId)||selection.requestId!==undefined&&!isBusinessId(selection.requestId)
    ||!Array.isArray(selection.sourceResourceIds)||selection.sourceResourceIds.length<1||selection.sourceResourceIds.length>49
    ||selection.sourceResourceIds.some(id=>!isBusinessId(id))||new Set([selection.agentResourceId,...selection.sourceResourceIds]).size!==selection.sourceResourceIds.length+1)deny();
  const encoded=Buffer.from(JSON.stringify(selection),'utf8').toString('base64url');if(encoded.length>8192)deny();
  const a=current();if(!a)deny();const value=await signedRequest('prepare','GET',null,{selection:encoded});
  if(!value||typeof value!=='object'||!isBusinessId((value as {expectationId?:unknown}).expectationId)
    ||digest((value as {session?:unknown}).session)!==digest(a.orgSession)
    ||digest((value as {origin?:unknown}).origin)!==digest({authorityId:a.sourceAuthorityId,recordId:a.associationId,revision:`association:${a.associationRevision}`})
    ||(value as {sourceRevision?:unknown}).sourceRevision!==a.sourceRevision
    ||(value as {consentRevision?:unknown}).consentRevision!==a.consentRevision)deny();
  prepareSchema();const exact=JSON.stringify({agentResourceId:selection.agentResourceId,sourceResourceIds:selection.sourceResourceIds}),selectionDigest=digest(JSON.parse(exact));
  db.prepare("UPDATE one_business_native_prepare_attempts SET state='confirmed',expectation_json=? WHERE association_id=? AND selection_digest=? AND selection_json=? AND state IN ('attempted','confirmed')")
   .run(JSON.stringify(value),a.associationId,selectionDigest,exact);
  return value;
 }
 async function refresh(){const before=current();if(!before)deny('business_native_connection_refresh_owner_unavailable');try{const value=await request('association');
  if(association(value)&&digest(value)!==digest(before)&&compatible(before,value)){
   // The same approved pair, re-bound by the server to a different live company session. It is adopted, but anything pinned to the earlier
   // association (capabilities, an attached startup) no longer matches and fails closed until a new generation.
   db.transaction(()=>{const changed=db.prepare("UPDATE one_business_native_associations SET record_json=? WHERE association_id=? AND state='active'").run(JSON.stringify(value),before.associationId);if(Number(changed.changes)!==1)deny('business_native_connection_refresh_owner_changed')}).immediate();
   active=structuredClone(value);return current()??deny('business_native_connection_refresh_owner_changed');
  }
  if(!association(value)||digest(value)!==digest(before)){invalidate();deny('business_native_connection_refresh_association_changed')}return current()??deny('business_native_connection_refresh_owner_changed');}catch(error){throw error}}
 function invalidate(){if(active){try{db.prepare("UPDATE one_business_native_associations SET state='revoked' WHERE association_id=?").run(active.associationId)}finally{active=null;}}}
 const owner:BusinessNativeOrganizationAssociationOwner=Object.freeze({captureCurrent(input:Readonly<BusinessNativeInstallationIdentity&{organizationSession:import('../../shared/business/context').BusinessSession}>){const value=current();if(!value)return null;const n=value.native;
  if(digest(input)!==digest({nativeActor:{principalId:n.nativeAccountId,sessionId:n.nativeSessionId,workspaceId:n.nativeWorkspaceId,oneId:n.oneId,hostId:n.nativeHostId},custodyGeneration:n.custodyGeneration,installationGeneration:n.installationGeneration,organizationSession:value.orgSession}))return null;
  const cap=Object.freeze({});capabilities.set(cap,JSON.stringify(value));return cap;},readCurrent(cap:object){const value=current();if(!value||capabilities.get(cap)!==JSON.stringify(value))return null;const n=value.native;return {nativeActor:{principalId:n.nativeAccountId,sessionId:n.nativeSessionId,workspaceId:n.nativeWorkspaceId,oneId:n.oneId,hostId:n.nativeHostId},custodyGeneration:n.custodyGeneration,installationGeneration:n.installationGeneration,organizationSession:value.orgSession,
   origin:{authorityId:value.sourceAuthorityId,recordId:value.associationId,revision:`association:${value.associationRevision}`},nativeSessionRevision:n.nativeSessionRevision,sourceRevision:`source:${value.sourceRevision}`};}});
 return Object.freeze({native,challenge,complete,pendingApproval,reconcile,request,lookupPrepare,refresh,resume,registerDevice,resumeState:()=>lastResume,current,association:owner,invalidate,close(){closed=true;invalidate()}});
}
