import {getDb} from "../store/db";
import {getOneProfile} from "../store/one-profile";
import {getAuthenticatedActorIds} from "../auth";
import {getInvocationAdmission} from "../store/invocation-admissions";
import {invocationProcessOwner,invocationRunOwners} from "../store/invocation-run-owners";
import {oneOsLeaseBroker,isOneOsHostAvailable,configuredOneOsLeaseBroker} from "./context-lease";
import {oneContextService,OneContextError,type OneContextService} from "./context-service";
import {supervisorError} from "../../shared/one-supervisor";
import type {SupervisorRequestRow} from "./supervisor-store";
import {daemonDeviceBridge,DeviceBridgeError,type DaemonDeviceBridge,type DeviceBridgeErrorCode} from "../daemon/device-bridge";

/** Host-only monotonic screen restriction; model requests cannot enable it again. */
let screenExecutionDenied: string | undefined;
export function configureSupervisorScreenPolicy(policy: Readonly<{ computerUse: false; reason: "managed_one_computer_use_unavailable" }>): void {
  if (policy.computerUse !== false || policy.reason !== "managed_one_computer_use_unavailable") throw new Error("supervisor_screen_policy_invalid");
  if (screenExecutionDenied && screenExecutionDenied !== policy.reason) throw new Error("supervisor_screen_policy_immutable");
  screenExecutionDenied = policy.reason;
}

/** A run that executes in the background service while the window process holds the screen. Main validates the daemon's
 * request against the durable rows (owner row ownerKind "daemon" for the attached boot, admission digest, supervisor
 * domain generation); nothing in this record is trusted on its own. */
export interface RemoteDaemonSource {daemonBootId:string;inputDigest:string}

/** Called only while materializing the actual native run's physical MCP
 * transport. Native browser guests keep their separate virtual-only scope. */
function supervisorRequestRows(runId:string):SupervisorRequestRow[] {
  const db=getDb();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get())return [];
  return db.prepare("SELECT * FROM one_supervisor_requests WHERE run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runId) as SupervisorRequestRow[];
}
export function prepareSupervisorOsExecution(input:{runId?:string;chatId?:string;permission?:"read"|"write"|"full";admissionCurrent?:()=>boolean;remoteDaemon?:RemoteDaemonSource}) {
  if (screenExecutionDenied) throw new Error(screenExecutionDenied);
  if(!input.runId || !input.chatId)return null;
  const db=getDb();
  const rows=supervisorRequestRows(input.runId);
  if(!rows.length)return null;
  if(rows.length!==1)throw supervisorError("supervisor_os_original_command_required");
  // The background service never hosts the screen: the window process owns the input driver, the OS lease broker and
  // the computer-use control server. Hope's personal turns run in the service since the One domain moved there, and
  // this refusal failed every one of them that picked computer use, and every later turn of that chat, which asked
  // for it again (production 1.2.95, 2026-10-11: supervisor_os_host_unavailable). Such a run uses the window's control
  // server through the shared control file, like any other run with computer use. A process that has a broker but
  // whose host is down (locked screen, server stopped) still refuses.
  // 1.3.0 device bridge: the service now asks the window process to prepare the scoped execution (remoteDaemon), see
  // prepareSupervisorOsExecutionAsync. Without a broker and without a remote source nothing is prepared here.
  if(!configuredOneOsLeaseBroker()){
    if(input.remoteDaemon)throw supervisorError("supervisor_os_host_unavailable");
    return null;
  }
  if(!isOneOsHostAvailable())throw supervisorError("supervisor_os_host_unavailable");
  const row=rows[0],oneId=getOneProfile().oneId,actor=JSON.stringify(getAuthenticatedActorIds());
  const remote=input.remoteDaemon;
  // The expected run owner: this process for a window-hosted run; for a daemon-hosted run exactly the attached daemon
  // boot with ownerKind "daemon". Nothing else widens: a window process never accepts a run owned by another desktop.
  const processOwner:{ownerId:string;ownerKind:string}=remote?{ownerId:remote.daemonBootId,ownerKind:"daemon"}:invocationProcessOwner();
  const custody=invocationRunOwners.getOwnerByRunId(input.runId),admission=getInvocationAdmission(input.runId);
  if(remote && (!admission || admission.inputDigest!==remote.inputDigest))throw supervisorError("supervisor_os_source_fenced");
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

export type SupervisorOsExecutionOutcome =
  | {kind:"scoped";capability:{version:"agentlas.one-os-execution.v1";executionId:string;token:string};dispose():void}
  /** The run keeps going; only its computer-use tool calls fail, with this machine-readable reason. */
  | {kind:"unavailable";reason:DeviceBridgeErrorCode|string};

/** Called while materializing a run's physical MCP transport, in either process.
 *  - Window process (has a broker): the scoped execution is prepared here, as before.
 *  - Background service (no broker) running a daemon-owned supervisor run: the window process prepares it over the
 *    device bridge. Never the owner token: if the window is not attached, or the request fails, the result is
 *    "unavailable" and the computer-use child fails each tool call with that reason. The whole run does not fail.
 *  - Anything else (no supervisor request for this run, or a process that is neither): null, as before. */
export async function prepareSupervisorOsExecutionAsync(input:{runId?:string;chatId?:string;permission?:"read"|"write"|"full";admissionCurrent?:()=>boolean;deviceBridge?:DaemonDeviceBridge}):Promise<SupervisorOsExecutionOutcome|null> {
  if (screenExecutionDenied) return { kind:"unavailable", reason:screenExecutionDenied };
  if(!input.runId || !input.chatId)return null;
  if(configuredOneOsLeaseBroker()){
    const local=prepareSupervisorOsExecution(input);
    return local?{kind:"scoped",capability:local.capability,dispose:local.dispose}:null;
  }
  const rows=supervisorRequestRows(input.runId);
  if(!rows.length)return null;
  if(rows.length!==1)throw supervisorError("supervisor_os_original_command_required");
  const processOwner=invocationProcessOwner();
  if(processOwner.ownerKind!=="daemon")return null;
  const custody=invocationRunOwners.getOwnerByRunId(input.runId),admission=getInvocationAdmission(input.runId);
  if(!custody || custody.state!=="active" || custody.ownerKind!=="daemon" || custody.ownerId!==processOwner.ownerId || custody.chatId!==input.chatId || !admission || admission.chatId!==input.chatId)
    return {kind:"unavailable",reason:"device_bridge_refused"};
  const bridge=input.deviceBridge??daemonDeviceBridge();
  try {
    if(input.admissionCurrent && !input.admissionCurrent())return {kind:"unavailable",reason:"device_bridge_refused"};
    const prepared=await bridge.prepareOsExecution({runId:input.runId,chatId:input.chatId,permission:input.permission??"read",inputDigest:admission.inputDigest});
    return {kind:"scoped",capability:prepared.capability,dispose:prepared.dispose};
  } catch(error) {
    return {kind:"unavailable",reason:error instanceof DeviceBridgeError?error.code:"device_bridge_unavailable"};
  }
}
