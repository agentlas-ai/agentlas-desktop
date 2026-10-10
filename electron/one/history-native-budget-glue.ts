import type { OneBudgetStore, OneBudgetReservation } from './budget-store';
import type { SupervisorRequestRow } from './supervisor-store';
import type { OneBudgetSnapshot } from '../../shared/one-budget';
import { personalDataHash, personalDataError } from './personal-data-store';
export interface NativeHistoryBudgetProof {reservation:Readonly<OneBudgetReservation>;expectedBindingHash:string;policy:OneBudgetSnapshot;assertCurrent():void}
export interface NativeHistoryBudgetRequest {request:Readonly<SupervisorRequestRow>;budgetId:string;purpose:'execution'|'publication'}
function fail():never{throw personalDataError('history_native_budget_binding_required');}
/** Validation only. Expiry remains reconciliation urgency, never a refund or renewed grant. Admission/reservation remains the existing OneBudgetRuntime owner. */
export function assertNativeHistoryBudgetProof(input:NativeHistoryBudgetRequest,proof:NativeHistoryBudgetProof|null,now=Date.now()):void{
  if(!proof)fail();proof.assertCurrent();const r=proof.reservation,q=input.request,p=proof.policy;
  let chatId:unknown;try{chatId=JSON.parse(q.payload_json).workerChatId;}catch{fail();}
  if(!q.task_id||!q.run_id||q.kind!=='work'||typeof chatId!=='string'||r.one_id!==q.one_id||r.command_id!==q.command_id||r.task_id!==q.task_id||r.run_id!==q.run_id||r.chat_id!==chatId
    ||r.budget_id!==input.budgetId||p.oneId!==q.one_id||p.budgetId!==input.budgetId||r.policy_revision!==p.revision||r.reserve_micros!==Math.round(p.reserveUsd*1_000_000)
    ||p.limitUsd!==null&&p.knownSubtotalUsd>p.limitUsd
    ||!proof.expectedBindingHash||r.binding_hash!==proof.expectedBindingHash||!Number.isFinite(r.expires_at)
    ||(input.purpose==='execution'?!['attempted','reconciling'].includes(r.state)||!['dispatching','accepted'].includes(q.state)||r.terminal_hash!==null:!['attempted','reconciling'].includes(r.state)||q.state!=='completed'))fail();
  proof.assertCurrent();
}
/** Parent supplies the SAME existing budget instance plus original native admission hash/custody.
 * No new store, queue or reservation is constructed here. No JSON caller can issue a proof. */
export function createHistoryNativeBudgetAuthority(input:{budget:Pick<OneBudgetStore,'forRun'|'snapshot'|'taskBudget'>;
  currentRequest(commandId:string):SupervisorRequestRow|null;
  nativeAdmissionBindingHash(request:Readonly<SupervisorRequestRow>):string|null;
  assertNativeCustody(request:Readonly<SupervisorRequestRow>,purpose:'execution'|'publication'):void;
  now?():number;
}):(request:NativeHistoryBudgetRequest)=>NativeHistoryBudgetProof|null{return request=>{
  const q=request.request,current=input.currentRequest(q.command_id);if(!current||personalDataHash(current)!==personalDataHash(q)||!q.run_id||!q.task_id)fail();
  const reservation=input.budget.forRun(q.run_id),policy=input.budget.snapshot({oneId:q.one_id,budgetId:request.budgetId})[0],expectedBindingHash=input.nativeAdmissionBindingHash(q);
  if(!reservation||!policy||!expectedBindingHash||input.budget.taskBudget(q.one_id,q.task_id)!==request.budgetId)fail();
  const digest=personalDataHash([current,reservation,policy.revision]),proof:NativeHistoryBudgetProof={reservation,policy,expectedBindingHash,assertCurrent(){
    input.assertNativeCustody(q,request.purpose);const now=input.currentRequest(q.command_id),r=input.budget.forRun(q.run_id!),p=input.budget.snapshot({oneId:q.one_id,budgetId:request.budgetId})[0];
    if(!now||!r||!p||personalDataHash([now,r,p.revision])!==digest||input.nativeAdmissionBindingHash(q)!==expectedBindingHash||input.budget.taskBudget(q.one_id,q.task_id!)!==request.budgetId)fail();}};
  assertNativeHistoryBudgetProof(request,proof,input.now?.()??Date.now());return proof;};}
