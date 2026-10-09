import type {InvocationRunReceipt,McpInvocationRequest} from "../../shared/types";
import type {OneBudgetUsage} from "../../shared/one-budget";
import {supervisorError} from "../../shared/one-supervisor";
import {canonicalInvocationRequestJson} from "../store/invocation-admissions";
import {OneBudgetStore,OneBudgetAdmissionDenied,type OneBudgetReservation} from "./budget-store";
import type {OneSupervisorStore,SupervisorRequestRow} from "./supervisor-store";

function object(value:unknown):Record<string,unknown>|null {
  if(typeof value==="string"){try{return object(JSON.parse(value));}catch{return null;}}
  return value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:null;
}
function tokens(value:Record<string,unknown>|null):OneBudgetUsage["tokens"] {
  if(!value || !Number.isSafeInteger(value.inputTokens) || (value.inputTokens as number)<0
    || !Number.isSafeInteger(value.outputTokens) || (value.outputTokens as number)<0)return null;
  const cached=value.cachedInputTokens;
  return {inputTokens:value.inputTokens as number,outputTokens:value.outputTokens as number,
    ...(Number.isSafeInteger(cached) && (cached as number)>=0 && (cached as number)<=(value.inputTokens as number)?{cachedInputTokens:cached as number}:{})};
}
/** Existing native receipts and host accounting events supply observations.
 * There is no renderer/model settlement endpoint or price lookup. */
export class OneBudgetRuntime {
  constructor(private readonly deps:{budget:OneBudgetStore;store:OneSupervisorStore;oneId():string;assertOwner():void;receipt(runId:string):InvocationRunReceipt|null}){}
  dispatch<T>(request:McpInvocationRequest,start:()=>T):T {
    try {
      this.deps.assertOwner();
      const rows=this.deps.store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'")
        .all(this.deps.oneId(),request.runId) as SupervisorRequestRow[];
      if(rows.length!==1 || !request.runId)throw supervisorError("supervisor_budget_original_command_required");
      const row=rows[0];
      this.deps.budget.admit({commandId:row.command_id,oneId:row.one_id,taskId:row.task_id,runId:request.runId,chatId:request.chatId,
        bindingHash:canonicalInvocationRequestJson(request)});
    }catch(error){throw new OneBudgetAdmissionDenied(error && typeof error==="object" && "code" in error && typeof error.code==="string"?error.code:"supervisor_budget_admission_unavailable");}
    // The reservation stays unresolved if this call throws, loses its reply,
    // or is cancelled: preparation itself can already have incurred usage.
    return start();
  }
  reconcileRun(runId:string,receipt?:InvocationRunReceipt|null):void {
    const reservation=this.deps.budget.forRun(runId);
    if(!reservation || reservation.one_id!==this.deps.oneId())return;
    this.deps.assertOwner();this.readUsage(reservation);
    const observed=receipt??this.deps.receipt(runId);
    if(observed?.runId===runId && observed.chatId===reservation.chat_id && ["completed","failed","cancelled","interrupted"].includes(observed.status)) {
      this.deps.budget.terminal({oneId:reservation.one_id,runId,chatId:reservation.chat_id,status:observed.status});
    }
  }
  reconcile():void {
    this.deps.assertOwner();const oneId=this.deps.oneId();this.deps.budget.expire(oneId);
    for(const row of this.deps.budget.pending(oneId))this.reconcileRun(row.run_id);
  }
  private readUsage(reservation:OneBudgetReservation):void {
    const db=this.deps.store.db;
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_events'").get())return;
    const rows=db.prepare(`SELECT id,kind,payload_json FROM run_events WHERE run_id=? AND chat_id=?
      AND kind IN ('runtime_usage_recorded','mcp_final') ORDER BY rowid`).all(reservation.run_id,reservation.chat_id) as Array<{id:string;kind:string;payload_json:string}>;
    for(const row of rows){
      const payload=object(row.payload_json);if(!payload)continue;
      if(row.kind==="runtime_usage_recorded" && payload.schemaVersion!=="agentlas.inference-accounting.v1")continue;
      const observed=row.kind==="mcp_final"?tokens({inputTokens:payload.observedInputTokens,outputTokens:payload.observedOutputTokens,cachedInputTokens:payload.observedCachedInputTokens}):tokens(object(payload.tokens));
      const cost=row.kind==="runtime_usage_recorded"?object(payload.cost):null;
      const measured=cost?.status==="measured" && typeof cost.usd==="number" && Number.isFinite(cost.usd) && cost.usd>=0
        && typeof cost.sourceRef==="string" && cost.sourceRef.length>0 && cost.sourceRef.length<=500;
      this.deps.budget.usage(reservation.one_id,{sourceId:`event:${row.id}`,runId:reservation.run_id,kind:row.kind==="mcp_final"?"provider":"inference",tokens:observed,
        cost:measured?{status:"measured",usd:cost!.usd as number,sourceRef:cost!.sourceRef as string}:{status:"unknown",usd:null,sourceRef:null}});
    }
  }
}
