import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import type {createNativeEmployeeConnection} from './native-employee-connection';
import type {createNativeEmployeeResultSource} from './native-employee-source';
import {sameNativeEmployeeAssociation,type NativeEmployeeDelivery} from './native-employee-producer';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import type {BusinessEmployeeAgentReceipt} from '../../shared/business/employee-agent-report';
import {isBusinessNativePublicationDeferral,isBusinessNativePublicationRecovery,type BusinessNativePublicationDeferral,type BusinessNativePublicationRecovery} from '../../shared/business/native-sharing-wire';
type PublicationState='published'|'awaiting-enrollment'|'unknown';
type PublicationRow={state:string;request_json:string;receipt_json:string|null};
/** Fixed local cause markers only: no request, identity, source text or secrets. */
function publicationCause(error:unknown):string{
 const value=error as {code?:unknown;message?:unknown;name?:unknown}|null;
 const code=typeof value?.code==='string'?value.code:typeof value?.message==='string'?value.message:'';
 if(['connection_unavailable','connection_references_changed','connection_owner_unavailable','connection_identity_changed',
  'connection_response_native_changed','connection_response_auth_changed','connection_response_session_changed','connection_request_owner_changed',
  'connection_refresh_owner_unavailable','connection_refresh_association_changed','connection_refresh_owner_changed',
  'original_result_unavailable','original_checkpoint_required','publication_unconfirmed','publication_conflict'].some(reason=>code===`business_native_${reason}`))return code;
 return value?.name==='AbortError'?'transport_aborted':value?.name==='TimeoutError'?'transport_timeout':'unclassified';
}
/** Source custody is not enrollment or publication permission. An uncertain
 * dispatch reads receipts only. Explicit continuation requires original durable
 * Root proof that the exact publication intent has never been dispatched. */
export function createNativeEmployeePublication(runtime:OneVaultRuntime,source:ReturnType<typeof createNativeEmployeeResultSource>,connection:ReturnType<typeof createNativeEmployeeConnection>,inspect:(cap:object)=>Promise<NativeEmployeeDelivery|null>){
 const db=runtime.sources.db;
 function initialize(){db.exec(`CREATE TABLE IF NOT EXISTS one_business_native_report_publication(
 acceptance_id TEXT PRIMARY KEY,state TEXT NOT NULL,request_json TEXT NOT NULL,receipt_json TEXT);`)}
 function deferral(value:unknown,delivery:NativeEmployeeDelivery):value is BusinessNativePublicationDeferral {
  const p=delivery.packet;
  return isBusinessNativePublicationDeferral(value)&&value.associationId===p.associationId&&value.associationRevision===p.associationRevision
   &&value.sourceRevision===p.sourceRevision&&value.consentRevision===p.consentRevision&&value.nativePacketDigest===digest(p.approved)
   &&digest(value.request)===digest(delivery.reportRequest);
 }
 function recovery(value:unknown,delivery:NativeEmployeeDelivery):value is BusinessNativePublicationRecovery {
  const p=delivery.packet;
  return isBusinessNativePublicationRecovery(value)&&value.associationId===p.associationId&&value.associationRevision===p.associationRevision
   &&value.sourceRevision===p.sourceRevision&&value.consentRevision===p.consentRevision&&value.nativePacketDigest===digest(p.approved)
   &&digest(value.request)===digest(delivery.reportRequest);
 }
 async function publication(cap:object,mode:'initial'|'lookup'|'recover'|'continue',assertExplicitOwner?:()=>void):Promise<PublicationState>{
  const delivery=await inspect(cap);if(!delivery||delivery.state!=='settled')return 'unknown';initialize();
  const request=delivery.reportRequest,{kind:_kind,...body}=request,packet=delivery.packet;
  const localCheck=()=>{const a=connection.current();if(!a||!sameNativeEmployeeAssociation(a,packet))throw Error('business_native_publication_unconfirmed');assertExplicitOwner?.()};
  const current=async()=>{localCheck();const latest=await inspect(cap);localCheck();if(!latest||latest.state!=='settled'||digest(latest.packet)!==digest(packet)||digest(latest.reportRequest)!==digest(request))throw Error('business_native_publication_unconfirmed')};
  const attempt=await source.withCurrent(cap,record=>{
   localCheck();const original=db.prepare('SELECT state,request_json,receipt_json FROM one_business_native_report_publication WHERE acceptance_id=?').get(record.acceptanceId) as PublicationRow|undefined;
   if(original&&original.request_json!==JSON.stringify(request))throw Error('business_native_publication_conflict');
   if(mode==='recover'){
    if(!assertExplicitOwner||!original?.receipt_json||!['unknown','rearmed'].includes(original.state))return null;
    const proof:unknown=JSON.parse(original.receipt_json);
    if(original.state==='unknown'&&!deferral(proof,delivery)&&!recovery(proof,delivery)
      ||original.state==='rearmed'&&!recovery(proof,delivery))return null;
    return{first:true,state:original.state,prior:original.receipt_json,proof};
   }
   if(mode==='continue'){
    // A new focused employee gesture cannot reset unknown/attempted/published.
    if(!assertExplicitOwner||!original||!['awaiting-enrollment','rearmed'].includes(original.state)||!original.receipt_json)return null;
    const proof:unknown=JSON.parse(original.receipt_json);
    if(original.state==='awaiting-enrollment'&&!deferral(proof,delivery)||original.state==='rearmed'&&!recovery(proof,delivery))return null;
    const changed=db.prepare("UPDATE one_business_native_report_publication SET state='attempted' WHERE acceptance_id=? AND state=? AND request_json=? AND receipt_json=?").run(record.acceptanceId,original.state,original.request_json,original.receipt_json);
    if(Number(changed.changes)!==1)return null;return{first:true,state:'attempted',prior:null,proof};
   }
   if(original)return{first:false,state:original.state,prior:original.receipt_json,proof:null};
   if(mode==='lookup')return null;
   db.prepare("INSERT INTO one_business_native_report_publication VALUES(?,'attempted',?,NULL)").run(record.acceptanceId,JSON.stringify(request));return{first:true,state:'attempted',prior:null,proof:null};
  });
  if(!attempt)return 'unknown';
  let phase='association-refresh';
  try{
   await connection.refresh();phase='current-after-refresh';await current();
   const operation=mode==='recover'?'publication-recover':attempt.first?(mode==='continue'?'publish-continue':'publish'):'publication-receipt';
   const recoverProof=attempt.proof as BusinessNativePublicationRecovery|BusinessNativePublicationDeferral|null;
   phase='publication-request';const result=await connection.request(operation,mode==='recover'
    ?{request,deferralReceiptId:isBusinessNativePublicationRecovery(recoverProof)
      ?recoverProof.deferralReceiptId:(recoverProof as BusinessNativePublicationDeferral).receiptId}
    :attempt.first&&mode==='continue'
      ?{request,deferralReceiptId:isBusinessNativePublicationRecovery(recoverProof)
        ?recoverProof.deferralReceiptId:(recoverProof as BusinessNativePublicationDeferral).receiptId,
        ...(isBusinessNativePublicationRecovery(recoverProof)?{recoveryReceiptId:recoverProof.recoveryReceiptId}:{})}
      :attempt.first?body:request);
   phase='current-after-response';await current();
   phase='publication-validation';
   if(mode==='recover'){
    if(!recovery(result,delivery)||!recoverProof
      ||(attempt.state==='rearmed'&&digest(result)!==digest(recoverProof))
      ||(attempt.state==='unknown'&&isBusinessNativePublicationRecovery(recoverProof)&&digest(result)!==digest(recoverProof))
      ||(attempt.state==='unknown'&&isBusinessNativePublicationDeferral(recoverProof)&&result.deferralReceiptId!==recoverProof.receiptId))throw Error('business_native_publication_unconfirmed');
    const changed=await source.withCurrent(cap,record=>{localCheck();return db.prepare("UPDATE one_business_native_report_publication SET state='rearmed',receipt_json=? WHERE acceptance_id=? AND state=? AND request_json=? AND receipt_json=?")
     .run(JSON.stringify(result),record.acceptanceId,attempt.state,JSON.stringify(request),attempt.prior).changes});
    return Number(changed)===1?'awaiting-enrollment':'unknown';
   }
   if(isBusinessNativePublicationDeferral(result)){
    if(!deferral(result,delivery))throw Error('business_native_publication_unconfirmed');
    // A lost reply remains unknown. Retain only its exact canonical deferral
    // proof so a later focused action can obtain a new Root recovery receipt;
    // this passive read cannot rearm, enroll, or dispatch the publication.
    if(!attempt.first&&!['awaiting-enrollment','rearmed'].includes(attempt.state)){
     if(attempt.state==='unknown'&&attempt.prior===null)await source.withCurrent(cap,record=>{
      localCheck();return db.prepare("UPDATE one_business_native_report_publication SET receipt_json=? WHERE acceptance_id=? AND state='unknown' AND request_json=? AND receipt_json IS NULL")
       .run(JSON.stringify(result),record.acceptanceId,JSON.stringify(request)).changes;
     });
     return 'unknown';
    }
    if(attempt.state==='awaiting-enrollment'&&(!attempt.prior||digest(JSON.parse(attempt.prior))!==digest(result)))throw Error('business_native_publication_conflict');
    if(attempt.state==='rearmed'&&(!attempt.prior||!recovery(JSON.parse(attempt.prior),delivery)
      ||(JSON.parse(attempt.prior) as BusinessNativePublicationRecovery).deferralReceiptId!==result.receiptId))throw Error('business_native_publication_conflict');
    if(!attempt.first&&attempt.state==='rearmed')return 'awaiting-enrollment';
    const changed=await source.withCurrent(cap,record=>{localCheck();return db.prepare("UPDATE one_business_native_report_publication SET state='awaiting-enrollment',receipt_json=? WHERE acceptance_id=? AND state IN ('attempted','awaiting-enrollment') AND request_json=?").run(JSON.stringify(result),record.acceptanceId,JSON.stringify(request)).changes});
    return Number(changed)===1?'awaiting-enrollment':'unknown';
   }
   const receipt=result as BusinessEmployeeAgentReceipt;
   phase='report-read';const read=await connection.request('report',null,{agentResourceId:request.agentResourceId});phase='current-after-report';await current();
   const p=packet.approved.report,expectedRevision=request.expectedRevision===null?0:request.expectedRevision+1;
   const expected={schema:p.schema,agentResourceId:p.agentResource.resourceId,agentId:p.agentId,employeePrincipalId:p.employeePrincipalId,revision:expectedRevision,state:'reported',profileRevision:p.profileRevision,reportId:p.reportId,reportRevision:p.reportRevision,reportDigest:digest(p),producedAt:p.producedAt,expiresAt:p.expiresAt,audiencePrincipalIds:p.audiencePrincipalIds,persona:p.persona,skills:p.skills,memory:p.memory,artifacts:p.artifacts};
   const priorReceipt=attempt.prior?JSON.parse(attempt.prior):null;
   phase='report-validation';if(!receipt||receipt.schema!=='agentlas.business.employee-agent-receipt.v1'||receipt.kind!=='report'||receipt.state!=='reported'||receipt.nativeReceiptId!==null||receipt.agentResourceId!==p.agentResource.resourceId||receipt.agentId!==p.agentId||receipt.employeePrincipalId!==p.employeePrincipalId||receipt.revision!==expectedRevision||receipt.reportDigest!==digest(p)||digest(read)!==digest(expected)||receipt.readBackDigest!==digest({report:p,reportDigest:digest(p),revision:expectedRevision,state:'reported',audiencePrincipalIds:p.audiencePrincipalIds,nativeControl:null})||priorReceipt&&!isBusinessNativePublicationDeferral(priorReceipt)&&!isBusinessNativePublicationRecovery(priorReceipt)&&digest({...priorReceipt,replayed:false})!==digest({...receipt,replayed:false}))throw Error('business_native_publication_unconfirmed');
   phase='receipt-read';const fresh=await connection.request('publication-receipt',request);phase='current-after-receipt';await current();
   phase='receipt-validation';
   if(digest({...fresh as BusinessEmployeeAgentReceipt,replayed:false})!==digest({...receipt,replayed:false}))throw Error('business_native_publication_unconfirmed');
   const changed=await source.withCurrent(cap,record=>{localCheck();return db.prepare("UPDATE one_business_native_report_publication SET state='published',receipt_json=? WHERE acceptance_id=? AND state IN ('attempted','unknown','published') AND request_json=?").run(JSON.stringify(receipt),record.acceptanceId,JSON.stringify(request)).changes});
   return Number(changed)===1?'published':'unknown';
  }catch(error){
   try{console.warn(JSON.stringify({schema:'agentlas.business.native-publication-diagnostic.v1',mode,phase,cause:publicationCause(error)}));}catch{/* Diagnostics cannot block the original settlement. */}
   const record=source.read(cap);if(record)db.prepare("UPDATE one_business_native_report_publication SET state='unknown' WHERE acceptance_id=? AND state='attempted'").run(record.acceptanceId);
   return 'unknown';
  }
 }
 return Object.freeze({publish:(cap:object)=>publication(cap,'initial'),reconcile:(cap:object)=>publication(cap,'lookup'),
  recover:(cap:object,assertExplicitOwner:()=>void)=>publication(cap,'recover',assertExplicitOwner),
  continue:(cap:object,assertExplicitOwner:()=>void)=>publication(cap,'continue',assertExplicitOwner)});
}
