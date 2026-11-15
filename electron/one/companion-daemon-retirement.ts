import type { OneSupervisorStore } from "./supervisor-store";
import type { OneSupervisorWorkQueue } from "./supervisor-work-queue";
import { companionHandoffProofBytes } from "../../shared/companion-handoff-proof";
import { retireCompanionUnstarted } from "./companion-work-receipt";

type Scope={userId:string;workspaceId:string;oneId:string;commandId:string;runId:string};
/** Only the enrolled GUI can ask the daemon to retire its original account's
 * exact run after the GUI has observed server cancellation. A cancelled row is
 * never evidence that a started invocation has stopped. */
export function retireDaemonCompanionUnstarted(options:{store:OneSupervisorStore;queue:OneSupervisorWorkQueue;input:unknown;
  owner:{userId:string;workspaceId:string;oneId:string};assertOwner():void;noStartProof(runId:string):boolean;nativeReceipt(runId:string):unknown}):boolean {
  try {
    const input=options.input;if(!input || typeof input!=="object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",")!=="commandId,oneId,runId,userId,workspaceId")return false;
    const value=input as Scope;if(!Object.values(value).every(x=>typeof x==="string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(x)) ||
      value.userId!==options.owner.userId || value.workspaceId!==options.owner.workspaceId || value.oneId!==options.owner.oneId)return false;
    return options.store.db.transaction(()=>{
      options.assertOwner();const handoff=options.store.db.prepare("SELECT binding_json FROM one_companion_handoffs WHERE command_id=?").get(value.commandId) as {binding_json:string}|undefined;
      if(!handoff)return false;const binding=JSON.parse(handoff.binding_json) as Record<string,unknown>;companionHandoffProofBytes(binding);
      if(binding.method!=="one.work-handoff.send.v1" || binding.commandId!==value.commandId || binding.userId!==value.userId ||
        binding.workspaceId!==value.workspaceId || binding.oneId!==value.oneId)return false;
      const job=options.queue.get(value.commandId),row=options.store.get(value.commandId);
      if(!job || !row || job.run_id!==value.runId || row.run_id!==value.runId || job.one_id!==value.oneId || row.one_id!==value.oneId ||
        row.task_id!==job.task_id || row.kind!=="work" || options.nativeReceipt(value.runId) || !options.noStartProof(value.runId))return false;
      if(job.phase==="cancelled" && row.state==="cancelled") {
        const receipt=JSON.parse(row.receipt_json) as {acknowledgement?:unknown;reason?:unknown};
        return receipt.acknowledgement==="settled" && receipt.reason==="cancelled_before_dispatch";
      }
      if(!["queued","claimed"].includes(job.phase) || row.state!=="stored")return false;
      retireCompanionUnstarted({store:options.store,queue:options.queue,commandId:value.commandId,noStartProof:options.noStartProof,nativeReceipt:options.nativeReceipt});
      options.assertOwner();const after=options.queue.get(value.commandId),saved=options.store.get(value.commandId);
      return after?.phase==="cancelled" && saved?.state==="cancelled" && saved.run_id===value.runId;
    }).immediate();
  }catch{return false;}
}
