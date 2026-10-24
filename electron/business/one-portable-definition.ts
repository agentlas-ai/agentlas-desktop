import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
import {businessEmployeeAgentHex,businessEmployeeAgentOnly,type BusinessEmployeeAgentReceipt} from '../../shared/business/employee-agent-report';
import {isBusinessId,isBusinessRevision} from '../../shared/business/context';
import {employeeAgentTransferSafeText} from '../../shared/business/employee-agent-transfer';
import {composeDeclaredPrompt} from '../runtime/prompt-order';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import type {createNativeEmployeeConnection} from './native-employee-connection';
import type {createNativeEmployeeResultSource} from './native-employee-source';
import type {createNativeEmployeeReportJournal} from './native-employee-journal';

function deny():never{throw Error('one_portable_definition_current_source_required')}
function reportReceipt(value:unknown):value is BusinessEmployeeAgentReceipt{
 return businessEmployeeAgentOnly(value,['schema','receiptId','agentResourceId','agentId','employeePrincipalId','kind','revision',
  'reportDigest','readBackDigest','state','nativeReceiptId','replayed'])
  &&value.schema==='agentlas.business.employee-agent-receipt.v1'&&value.kind==='report'&&value.state==='reported'
  &&[value.receiptId,value.agentResourceId,value.agentId,value.employeePrincipalId].every(isBusinessId)
  &&isBusinessRevision(value.revision)&&businessEmployeeAgentHex(value.reportDigest)
  &&businessEmployeeAgentHex(value.readBackDigest)&&value.nativeReceiptId===null&&typeof value.replayed==='boolean';
}

/** A portable company definition contains only data the owner already approved
 * for this exact current One work result. It carries no grant or private profile. */
export function renderOnePortableDefinition(profile:{displayName:string;role:string},summary:string):string{
 if(!employeeAgentTransferSafeText(profile.displayName)||!profile.displayName.trim()||!employeeAgentTransferSafeText(profile.role)||!profile.role.trim()
  ||!employeeAgentTransferSafeText(summary)||!summary.trim())deny();
 const content=composeDeclaredPrompt([
  {id:'one.portable-definition.heading',revision:1,stability:'fixed-policy',changeTriggers:['release'],order:0,text:'# Agentlas One company agent'},
  {id:'one.portable-definition.profile',revision:1,stability:'configuration',changeTriggers:['profile'],order:0,text:`Name: ${profile.displayName}\nRole: ${profile.role}`},
  {id:'one.portable-definition.accepted-work',revision:1,stability:'task-context',changeTriggers:['task','owner-input'],order:0,text:`Approved completed-work summary:\n${summary}`},
 ])+'\n';
 if(!employeeAgentTransferSafeText(content)||Buffer.byteLength(content,'utf8')>196608)deny();
 return content;
}

/** The original personal Main supplies these ports. A renderer resource ID only
 * selects; it cannot supply a persona, report, accepted text or approval. */
export function createOnePortableDefinitionSource(input:{runtime:OneVaultRuntime;
 connection:ReturnType<typeof createNativeEmployeeConnection>;
 source:ReturnType<typeof createNativeEmployeeResultSource>;
 journal:ReturnType<typeof createNativeEmployeeReportJournal>}){
 const {runtime,connection,source,journal}=input,db=runtime.sources.db;
 async function read(resourceId:string){
  if(!isBusinessId(resourceId))deny();
  const association=connection.current();if(!association||association.state!=='active'||Date.parse(association.expiresAt)<=Date.now())deny();
  // The signed original report read resolves the current organization head under
  // its own organization.read and agent.read admissions. Historical local
  // publications cannot choose which accepted result is current.
  const head:unknown=await connection.request('report',null,{agentResourceId:resourceId});
  if(!businessEmployeeAgentOnly(head,['schema','agentResourceId','agentId','employeePrincipalId','revision','state','profileRevision',
   'reportId','reportRevision','reportDigest','producedAt','expiresAt','audiencePrincipalIds','persona','skills','memory','artifacts'])
   ||head.schema!=='agentlas.business.employee-agent-report.v1'||head.agentResourceId!==resourceId
   ||!isBusinessId(head.reportId)||!isBusinessRevision(head.revision)||!businessEmployeeAgentHex(head.reportDigest))deny();
  const rows=db.prepare(`SELECT d.acceptance_id AS acceptanceId,p.receipt_json AS publicationReceipt FROM one_business_native_report_delivery d
   JOIN one_business_native_report_publication p ON p.acceptance_id=d.acceptance_id
   WHERE d.state='settled' AND p.state='published'
   AND json_extract(d.packet_json,'$.approved.report.agentResource.resourceId')=?
   AND d.acceptance_id=?`).all(resourceId,head.reportId) as Array<{acceptanceId:string;publicationReceipt:string|null}>;
  if(rows.length!==1)deny();
  let publicationReceipt:unknown;try{publicationReceipt=JSON.parse(rows[0].publicationReceipt??'null')}catch{deny()}
  if(!reportReceipt(publicationReceipt)
   ||publicationReceipt.agentResourceId!==resourceId||publicationReceipt.nativeReceiptId!==null)deny();
  const cap=await source.restore(rows[0].acceptanceId);
  if(await journal.reconcilePublication(cap)!=='published')deny();
  const delivery=await journal.owners.inspect(cap);if(!delivery||delivery.state!=='settled'||!delivery.receipt)deny();
  const accepted=await source.withCurrent(cap,record=>structuredClone(record));
  const current=connection.current(),report=delivery.packet.approved.report;
  if(!current||current.associationId!==accepted.associationId||current.associationRevision!==accepted.associationRevision
   ||accepted.sourceRevision!==`source:${current.sourceRevision}`||accepted.consentRevision!==`consent:${current.consentRevision}`
   ||report.agentResource.resourceId!==resourceId||report.agentId!==accepted.original.profile.oneId
   ||report.reportId!==accepted.acceptanceId||report.persona.summary!==accepted.summary
   ||report.persona.displayName!==accepted.original.profile.displayName||report.persona.role!==accepted.original.profile.role
   ||report.profileRevision!==String(accepted.original.profile.version)
   ||head.agentId!==report.agentId||head.employeePrincipalId!==report.employeePrincipalId
   ||head.profileRevision!==report.profileRevision||head.reportRevision!==report.reportRevision
   ||head.reportDigest!==digest(report)||head.producedAt!==report.producedAt||head.expiresAt!==report.expiresAt
   ||digest(head.persona)!==digest(report.persona)||digest(head.skills)!==digest(report.skills)
   ||digest(head.memory)!==digest(report.memory)||digest(head.artifacts)!==digest(report.artifacts)
   ||!delivery.receipt||publicationReceipt.reportDigest!==digest(report)
   ||publicationReceipt.agentId!==report.agentId||publicationReceipt.employeePrincipalId!==report.employeePrincipalId
   ||head.revision<publicationReceipt.revision)deny();
  const confirmed:unknown=await connection.request('report',null,{agentResourceId:resourceId});
  if(digest(confirmed)!==digest(head)||digest(connection.current())!==digest(current))deny();
  const content=renderOnePortableDefinition(accepted.original.profile,accepted.summary);
  return{content,oneId:accepted.original.profile.oneId,displayName:accepted.original.profile.displayName,role:accepted.original.profile.role,
   proof:digest({association:current,head,accepted,delivery,content})};
 }
 return Object.freeze({ownsAgent(agentId:string){return runtime.sources.oneId()===agentId},
  async select(resourceId:string){const initial=await read(resourceId);return Object.freeze({content:initial.content,oneId:initial.oneId,displayName:initial.displayName,role:initial.role,
  async assertCurrent(){const latest=await read(resourceId);if(latest.proof!==initial.proof)deny();}})}});
}
