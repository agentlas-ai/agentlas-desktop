import type Database from "better-sqlite3";
import { getAuthenticatedSessionBinding } from "../auth";
import { invocationProvenNotStarted } from "../store/invocation-admissions";
import { getInvocationRunReceipt } from "../store/run-events";
import { latestInvocationBrowserLoginWait } from "../invocation/browser-login-wait";
import { signInCarrier } from "./supervisor-work-executor";
import { createCompanionWorkDeliveryRuntime } from "./companion-work-delivery-runtime";

/** GUI-bound signer. The paired daemon still owns and executes the work; this
 * worker may only sign terminal results whose original owner is still held. */
export function createCompanionGuiDeliveryRuntime(options:{db:Database.Database;oneId():string;
  channel():{bootId:string;connection:string;generation:string}|null;retireUnstarted(input:{userId:string;workspaceId:string;oneId:string;commandId:string;runId:string}):Promise<unknown>;executionEvidence?:boolean}) {
  const actor=getAuthenticatedSessionBinding(),original=options.channel(),one=options.oneId();
  if(!actor || !original || !one)throw new Error("companion_gui_delivery_scope_unavailable");
  const owner=options.db.prepare("SELECT one_id,owner_epoch,owner_kind,generation FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as
    {one_id:string;owner_epoch:string;owner_kind:string;generation:number}|undefined;
  if(!owner || owner.one_id!==one || owner.owner_epoch!==original.bootId || owner.owner_kind!=="work-daemon")throw new Error("companion_gui_delivery_owner_unavailable");
  const originalScope={userId:actor.userId,workspaceId:actor.workspaceId,oneId:one};
  const assertRetirementOwner=()=>{
    const channel=options.channel(),current=options.db.prepare("SELECT one_id,owner_epoch,owner_kind,generation,phase,lease_until FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as
      {one_id:string;owner_epoch:string;owner_kind:string;generation:number;phase:string;lease_until:number}|undefined;
    if(!channel || channel.bootId!==original.bootId || channel.connection!==original.connection || channel.generation!==original.generation ||
      !current || current.one_id!==owner.one_id || current.owner_epoch!==owner.owner_epoch || current.owner_kind!==owner.owner_kind || current.generation!==owner.generation ||
      current.phase==="released" || current.lease_until<=Date.now())throw new Error("companion_gui_delivery_owner_changed");
  };
  const assertOwner=()=>{assertRetirementOwner();const current=getAuthenticatedSessionBinding();
    if(!current || current.userId!==actor.userId || current.workspaceId!==actor.workspaceId || current.sessionId!==actor.sessionId || options.oneId()!==one)
      throw new Error("companion_gui_delivery_account_changed");};
  const receipt=(runId:string)=>getInvocationRunReceipt(runId);
  const worker=createCompanionWorkDeliveryRuntime({db:options.db,tasks:()=>[],oneId:options.oneId,assertOwner,assertRetirementOwner,
    retirementScope:()=>originalScope,noStartProof:runId=>invocationProvenNotStarted(runId),nativeReceipt:receipt,
    // The GUI can only request the exact original run; the daemon independently
    // rechecks its original owner and proves the start boundary was not crossed.
    retireUnstarted:async commandId=>{assertRetirementOwner();const row=options.db.prepare("SELECT run_id FROM one_supervisor_requests WHERE command_id=? AND one_id=?").get(commandId,one) as {run_id:string}|undefined;
      if(row?.run_id)await options.retireUnstarted({...originalScope,commandId,runId:row.run_id});assertRetirementOwner();},executionEvidence:options.executionEvidence,
    carrierRunId:(runId,chatId)=>{const carrier=signInCarrier({receipt,successorRun:id=>{const wait=latestInvocationBrowserLoginWait(id);
      return wait?.state==="dispatched" && wait.successorInvocationId ? wait.successorInvocationId:null;}},runId);
      return carrier.receipt?.runId===carrier.runId && carrier.receipt.chatId===chatId ? carrier.runId:null;}});
  return worker;
}
