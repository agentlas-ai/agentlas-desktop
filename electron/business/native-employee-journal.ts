import {createNativeEmployeePublication} from './native-employee-publication';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import {businessEmployeeAgentNativeDigest as digest,businessEmployeeAgentSummaryDigest} from './employee-agent-report-adapter';
import {BUSINESS_NATIVE_CUSTODY_PACKET,sameNativeEmployeeAssociation,type NativeEmployeeCustodyPacket,type NativeEmployeeCustodyOwners,type NativeEmployeeDelivery} from './native-employee-producer';
import type {NativeEmployeeAcceptedResult,createNativeEmployeeResultSource} from './native-employee-source';
import type {createNativeEmployeeConnection} from './native-employee-connection';
import {isBusinessId,isBusinessResource,isBusinessSession,sameBusinessSession,type BusinessResourceRef,type BusinessSession} from '../../shared/business/context';
import {isBusinessEmployeeAgentReport,type BusinessEmployeeAgentReport,type BusinessEmployeeAgentReportRequest} from '../../shared/business/employee-agent-report';
import type {BusinessNativeCustodyReceipt} from '../../shared/business/native-sharing-wire';
export interface NativeEmployeeRootExpectations {
 readonly expectationId:string;readonly mode:'registered-resource-expectations'|'future-resource-expectations';readonly registrationRequired:boolean;
 readonly session:BusinessSession;readonly resources:readonly BusinessResourceRef[];
 readonly plannedResources:readonly {kind:'future-resource-expectation';resource:BusinessResourceRef}[];
 readonly sourceAuthorityId:string;readonly commandAuthorityId:string;
 readonly origin:{authorityId:string;recordId:string;revision:string};readonly sourceRevision:number;readonly consentRevision:number;
}
function deny():never{throw Error('business_native_original_checkpoint_required')}
/** Delivery journal lives in the ORIGINAL native DB. It is not a task queue and
 * cannot authorize an organization action. Attempt CAS precedes any dispatch. */
export function createNativeEmployeeReportJournal(runtime:OneVaultRuntime,source:ReturnType<typeof createNativeEmployeeResultSource>,connection:ReturnType<typeof createNativeEmployeeConnection>){
 const db=runtime.sources.db,results=new WeakMap<object,{acceptanceId:string;association:string;receipt:string}>(),sending=new Set<string>();
 function initialize(){db.exec(`CREATE TABLE IF NOT EXISTS one_business_native_report_delivery(
 acceptance_id TEXT PRIMARY KEY,packet_json TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT);`)}
 function currentRecord(record:Readonly<NativeEmployeeAcceptedResult>){const a=connection.current();if(!a||a.associationId!==record.associationId||a.associationRevision!==record.associationRevision||record.sourceRevision!==`source:${a.sourceRevision}`||record.consentRevision!==`consent:${a.consentRevision}`)deny();return a;}
 function row(record:Readonly<NativeEmployeeAcceptedResult>):NativeEmployeeDelivery|null{currentRecord(record);const value=db.prepare('SELECT * FROM one_business_native_report_delivery WHERE acceptance_id=?').get(record.acceptanceId) as {packet_json:string;request_json:string;state:NativeEmployeeDelivery['state'];receipt_json:string|null}|undefined;
  if(!value)return null;const packet=JSON.parse(value.packet_json) as NativeEmployeeCustodyPacket;if(packet.schema!==BUSINESS_NATIVE_CUSTODY_PACKET||!sameNativeEmployeeAssociation(currentRecord(record),packet)||packet.approved.original.acceptedReceiptId!==record.acceptanceId||packet.approved.original.acceptedDigest!==digest(record))deny();return {packet,reportRequest:JSON.parse(value.request_json),state:value.state,receipt:value.receipt_json?JSON.parse(value.receipt_json):null};}
 function checkpoint(record:Readonly<NativeEmployeeAcceptedResult>,expectations:Readonly<NativeEmployeeRootExpectations>,selectors:{agentResourceId:string;sourceResourceId:string;expectedRevision:number|null}){
  if((db as unknown as {inTransaction?:boolean}).inTransaction!==true)deny();const a=currentRecord(record),e=expectations;
  if(!isBusinessId(e.expectationId)||!isBusinessSession(e.session)||!sameBusinessSession(e.session,a.orgSession)||e.sourceAuthorityId!==a.sourceAuthorityId||e.commandAuthorityId!==a.commandAuthorityId||e.sourceRevision!==a.sourceRevision||e.consentRevision!==a.consentRevision||digest(e.origin)!==digest({authorityId:a.sourceAuthorityId,recordId:a.associationId,revision:`association:${a.associationRevision}`}))deny();
  if(!Array.isArray(e.resources)||!Array.isArray(e.plannedResources))deny();
  if(e.mode==='registered-resource-expectations'){if(e.registrationRequired!==false||e.plannedResources.length)deny()}
  else if(e.mode==='future-resource-expectations'){if(e.registrationRequired!==true||!e.plannedResources.length||e.plannedResources.some(p=>p?.kind!=='future-resource-expectation'||!isBusinessResource(p.resource)||p.resource.revision!==0||p.resource.aclRevision!==0))deny()}else deny();
  // Future refs describe the exact registration requested from Root. They are
  // report expectations only: no current resource, mapping, epoch or grant.
  const refs=[...e.resources,...e.plannedResources.map(p=>p.resource)];
  if(refs.length!==2||new Set(refs.map(r=>r.resourceId)).size!==2)deny();
  const agent=refs.find(r=>r.resourceId===selectors.agentResourceId),resource=refs.find(r=>r.resourceId===selectors.sourceResourceId);
  if(!agent||!resource||agent.resourceId===resource.resourceId||![agent,resource].every(r=>isBusinessResource(r)&&r.scope.kind==='organization'&&r.scope.organizationId===a.orgSession.organizationId))deny();
  const original=record.original,personaSource={authorityId:a.sourceAuthorityId,recordId:record.acceptanceId,revision:`source:${a.sourceRevision}`,resource,versionId:String(original.profile.version),digest:digest(original.profile),audiencePrincipalIds:a.audiencePrincipalIds,
   approval:{receiptId:record.acceptanceId,revision:a.consentRevision,contentDigest:'',approvedByPrincipalId:a.orgSession.principalId,audiencePrincipalIds:a.audiencePrincipalIds,expiresAt:a.expiresAt}};
  const persona={displayName:original.profile.displayName,role:original.profile.role,summary:record.summary,source:personaSource};personaSource.approval.contentDigest=businessEmployeeAgentSummaryDigest(persona);
  const report:BusinessEmployeeAgentReport={schema:'agentlas.business.employee-agent-report.v1',deploymentId:a.orgSession.deploymentId,identityAuthorityId:a.orgSession.identityAuthorityId,organizationId:a.orgSession.organizationId,agentResource:agent,agentId:original.nativeActor.oneId,employeePrincipalId:a.orgSession.principalId,employeeAuthEpoch:a.orgSession.authEpoch,
   profileRevision:String(original.profile.version),reportId:record.acceptanceId,reportRevision:'acceptance:0',origin:e.origin,producedAt:record.acceptedAt,expiresAt:a.expiresAt,audiencePrincipalIds:a.audiencePrincipalIds,persona,skills:[],memory:[],artifacts:[]};
  if(!isBusinessEmployeeAgentReport(report,a.orgSession))deny();
  const packet:NativeEmployeeCustodyPacket={schema:BUSINESS_NATIVE_CUSTODY_PACKET,acceptanceKind:'explicit-sharing-acceptance',expectationId:e.expectationId,associationId:a.associationId,associationRevision:a.associationRevision,sourceRevision:a.sourceRevision,consentRevision:a.consentRevision,idempotencyKey:record.acceptanceId,
   approved:{schema:'agentlas.business.employee-agent-approved-packet.v1',selector:{packetId:record.acceptanceId,packetRevision:'acceptance:0'},report,
    original:{authorityId:a.commandAuthorityId,recordId:record.acceptanceId,revision:'acceptance:0',nativeAccountId:a.native.nativeAccountId,nativeSessionId:a.native.nativeSessionId,nativeSessionRevision:a.native.nativeSessionRevision,nativeHostId:a.native.nativeHostId,oneId:a.native.oneId,profileRevision:String(original.profile.version),enrollment:e.origin,
     work:{taskId:original.taskId,runId:original.runId,commandId:original.commandId,occurrenceId:record.acceptanceId,controlVersion:original.controlVersion,invocationLeaseId:original.leaseId,inputRef:original.runId,inputRevision:original.inputRevision,inputDigest:original.nativeInputDigest},acceptedReceiptId:record.acceptanceId,acceptedDigest:digest(record)}}};
  const request:BusinessEmployeeAgentReportRequest={kind:'report',agentResourceId:agent.resourceId,ownerReportId:record.acceptanceId,expectedRevision:selectors.expectedRevision,idempotencyKey:record.acceptanceId};
  db.prepare("INSERT INTO one_business_native_report_delivery VALUES(?,?,?,'ready',NULL)").run(record.acceptanceId,JSON.stringify(packet),JSON.stringify(request));currentRecord(record);
 }
 /** The same packet, under the same idempotency key, for a delivery whose first submission is unknown or never reached Root. */
 async function resend(cap:object,packet:NativeEmployeeCustodyPacket):Promise<BusinessNativeCustodyReceipt>{
  const moved=await source.withCurrent(cap,r=>Number(db.prepare("UPDATE one_business_native_report_delivery SET state='attempted' WHERE acceptance_id=? AND state IN ('unknown','attempted')").run(r.acceptanceId).changes)===1);
  if(!moved)deny();sending.add(packet.idempotencyKey);
  try{return await owners.submit(cap,packet)}catch(error){await owners.holdUnknown(cap);throw error}
 }
 const publication=createNativeEmployeePublication(runtime,source,connection,cap=>source.withCurrent(cap,row));
 const owners:NativeEmployeeCustodyOwners={protocol:'agentlas.business.native-custody-producer.v2',publish:publication.publish,subscribeAccepted:source.subscribeAccepted,pending,
  async current(cap){try{return await source.withCurrent(cap,r=>{currentRecord(r);return true})}catch{return false}},
  inspect:cap=>source.withCurrent(cap,row),
  // The association check is the last work before the packet leaves, so it runs before the attempt is recorded: a failure there sent nothing and leaves the row 'ready'.
  beginAttempt:async(cap,packetDigest)=>{await connection.refresh();return source.withCurrent(cap,r=>{const prior=row(r);if(!prior||prior.state!=='ready'||digest(prior.packet)!==packetDigest)return false;const moved=Number(db.prepare("UPDATE one_business_native_report_delivery SET state='attempted' WHERE acceptance_id=? AND state='ready' AND packet_json=?").run(r.acceptanceId,JSON.stringify(prior.packet)).changes)===1;if(moved)sending.add(r.acceptanceId);return moved})},
  async holdUnknown(cap){const record=source.read(cap);if(record){sending.delete(record.acceptanceId);db.prepare("UPDATE one_business_native_report_delivery SET state='unknown' WHERE acceptance_id=? AND state='attempted'").run(record.acceptanceId)}},
  async submit(cap,packet){const delivery=await source.withCurrent(cap,r=>row(r));if(!delivery||delivery.state!=='attempted'||digest(delivery.packet)!==digest(packet))deny();sending.add(packet.idempotencyKey);let result:BusinessNativeCustodyReceipt;try{result=await connection.request('packet',packet) as BusinessNativeCustodyReceipt}finally{sending.delete(packet.idempotencyKey)}
   await source.withCurrent(cap,r=>{const a=currentRecord(r);results.set(result,{acceptanceId:r.acceptanceId,association:JSON.stringify(a),receipt:JSON.stringify(result)})});return result;},
  async lookup(cap,packet){const delivery=await source.withCurrent(cap,r=>row(r));if(!delivery||delivery.state==='ready'||digest(delivery.packet)!==digest(packet))deny();await connection.refresh();let result:BusinessNativeCustodyReceipt;
   try{result=await connection.request('receipt',null,{idempotencyKey:packet.idempotencyKey}) as BusinessNativeCustodyReceipt}
   catch(error){
    // No receipt could be read under this key. The key is fixed and Root deduplicates by it, so sending the same packet again is how an unsent or lost submission ends;
    // a settled row or a send still under way in this process is left alone.
    if(delivery.state==='settled'||sending.has(packet.idempotencyKey))throw error;
    result=await resend(cap,packet);
   }
   await source.withCurrent(cap,r=>{const a=currentRecord(r);results.set(result,{acceptanceId:r.acceptanceId,association:JSON.stringify(a),receipt:JSON.stringify(result)})});return result;},
  async currentResult(cap,result){try{await connection.refresh();const latest=await connection.request('receipt',null,{idempotencyKey:result.idempotencyKey}) as BusinessNativeCustodyReceipt;if(digest({...latest,replayed:false})!==digest({...result,replayed:false}))return false;return await source.withCurrent(cap,r=>{const proof=results.get(result);return !!proof&&proof.acceptanceId===r.acceptanceId&&proof.association===JSON.stringify(currentRecord(r))&&proof.receipt===JSON.stringify(result)})}catch{return false}},
  async settle(cap,result){if(!await owners.currentResult(cap,result))return false;return source.withCurrent(cap,r=>{const prior=row(r);if(!prior||result.idempotencyKey!==prior.packet.idempotencyKey||result.nativePacketDigest!==digest(prior.packet.approved))return false;if(prior.receipt&&digest({...prior.receipt,replayed:false})!==digest({...result,replayed:false}))return false;return Number(db.prepare("UPDATE one_business_native_report_delivery SET state='settled',receipt_json=? WHERE acceptance_id=? AND state IN ('attempted','unknown','settled')").run(JSON.stringify(result),r.acceptanceId).changes)===1})},
 };
 /** Focused owner action only: sends an accepted share whose first attempt stopped before the packet left (the row is still 'ready'). Null when it is not. */
 async function dispatch(cap:object):Promise<BusinessNativeCustodyReceipt|null>{
  const delivery=await source.withCurrent(cap,row);if(!delivery||delivery.state!=='ready')return null;
  if(!await owners.beginAttempt(cap,digest(delivery.packet)))return null;
  try{return await owners.submit(cap,delivery.packet)}catch(error){await owners.holdUnknown(cap);throw error}
 }
 /** Accepted shares whose delivery has not settled, as fresh capabilities, so an attach after a restart can finish what the owner already approved. */
 async function pending():Promise<object[]>{
  const caps:object[]=[];
  try{
   const ids=db.prepare("SELECT acceptance_id FROM one_business_native_report_delivery WHERE state IN ('ready','attempted','unknown') ORDER BY rowid LIMIT 16").all() as Array<{acceptance_id:string}>;
   for(const {acceptance_id} of ids)try{caps.push(await source.restore(acceptance_id))}catch{/* revoked or changed original: nothing left to deliver */}
  }catch{/* the journal table does not exist yet: nothing was ever accepted */}
  return caps;
 }
 return Object.freeze({initialize,checkpoint,dispatch,reconcilePublication:publication.reconcile,recoverPublication:publication.recover,
  continuePublication:publication.continue,owners:Object.freeze(owners)});
}
