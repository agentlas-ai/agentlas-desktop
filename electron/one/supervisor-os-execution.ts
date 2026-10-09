import {getDb} from "../store/db";
import {getOneProfile} from "../store/one-profile";
import {getAuthenticatedActorIds} from "../auth";
import {getInvocationAdmission} from "../store/invocation-admissions";
import {invocationProcessOwner,invocationRunOwners} from "../store/invocation-run-owners";
import {oneOsLeaseBroker,isOneOsHostAvailable} from "./context-lease";
import {oneContextService,OneContextError,type OneContextService} from "./context-service";
import {supervisorError} from "../../shared/one-supervisor";
import type {SupervisorRequestRow} from "./supervisor-store";

/** Called only while materializing the actual native run's physical MCP
 * transport. Native browser guests keep their separate virtual-only scope. */
export function prepareSupervisorOsExecution(input:{runId?:string;chatId?:string;permission?:"read"|"write"|"full";admissionCurrent?:()=>boolean}) {
  if(!input.runId || !input.chatId)return null;
  const db=getDb();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get())return null;
  const rows=db.prepare("SELECT * FROM one_supervisor_requests WHERE run_id=? AND kind IN ('reply','work','follow-up','chat-send')")
    .all(input.runId) as SupervisorRequestRow[];
  if(!rows.length)return null;
  if(rows.length!==1)throw supervisorError("supervisor_os_original_command_required");
  if(!isOneOsHostAvailable())throw supervisorError("supervisor_os_host_unavailable");
  const row=rows[0],oneId=getOneProfile().oneId,actor=JSON.stringify(getAuthenticatedActorIds());
  const custody=invocationRunOwners.getOwnerByRunId(input.runId),processOwner=invocationProcessOwner(),admission=getInvocationAdmission(input.runId);
  const started=db.prepare("SELECT id,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' ORDER BY rowid LIMIT 1")
    .get(input.runId,input.chatId) as {id:string;payload_json:string}|undefined;
  const original=started?JSON.parse(started.payload_json) as {onePermissionMode?:string;permissions?:string}:null;
  const permissions=input.permission??"read",sourcePermission=original?.onePermissionMode??original?.permissions??"read";
  const ranks:Record<string,number>={read:0,write:1,full:2};
  if(!started || !(sourcePermission in ranks) || ranks[permissions]>ranks[sourcePermission])throw supervisorError("supervisor_os_permission_binding_invalid");
  const domain=db.prepare("SELECT * FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as {one_id:string;owner_epoch:string;generation:number;phase:string;lease_until:number}|undefined;
  const assertCurrent=()=>{
    if(!input.admissionCurrent?.() || row.one_id!==oneId || getOneProfile().oneId!==oneId || JSON.stringify(getAuthenticatedActorIds())!==actor)throw supervisorError("supervisor_os_source_fenced");
    const current=db.prepare("SELECT * FROM one_supervisor_requests WHERE command_id=?").get(row.command_id) as SupervisorRequestRow|undefined;
    const owner=invocationRunOwners.getOwnerByRunId(input.runId!),currentAdmission=getInvocationAdmission(input.runId!);
    const currentDomain=db.prepare("SELECT * FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as typeof domain;
    if(!isOneOsHostAvailable() || !custody || !owner || owner.leaseId!==custody.leaseId || owner.state!=="active"
      || owner.chatId!==input.chatId || owner.ownerId!==processOwner.ownerId || owner.ownerKind!==processOwner.ownerKind
      || !admission || !currentAdmission || currentAdmission.inputDigest!==admission.inputDigest || currentAdmission.status!=="admitted"
      || currentAdmission.chatId!==input.chatId || currentAdmission.ownerProcessEpoch!==owner.ownerId
      || !domain || !currentDomain || currentDomain.owner_epoch!==domain.owner_epoch || currentDomain.generation!==domain.generation
      || currentDomain.one_id!==oneId || currentDomain.phase!=="active" || currentDomain.lease_until<=Date.now()
      || !current || current.payload_hash!==row.payload_hash || current.run_id!==input.runId || !["dispatching","accepted"].includes(current.state))throw supervisorError("supervisor_os_source_fenced");
  };
  assertCurrent();
  const taskId=row.task_id??`one:${row.origin_chat_id}`;
  let context:OneContextService|undefined;
  try { context=oneContextService(); }
  catch(error) { if(!(error instanceof OneContextError) || error.code!=="one-context-host-unavailable")throw error; }
  // The owner's optional task grant narrows the existing native permission.
  // Observation grants never authorize input or block unrelated valid input.
  // Only an unconfigured context host is optional; source/identity errors fail.
  const contextGrantId=context?.snapshot({oneId,...(row.task_id?{taskId}:{})}).grants
    .find(grant=>grant.oneId===oneId && grant.taskId===taskId && grant.state==="active" && grant.mode==="interact")?.grantId;
  return oneOsLeaseBroker().registerExecution({oneId,taskId,runId:input.runId,
    ownerEpoch:custody!.ownerId,permissions,...(contextGrantId?{contextGrantId}:{})},assertCurrent);
}
