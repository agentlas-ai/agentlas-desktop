"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {ipc,ipcEvents} from "@/lib/ipc";
import {createCoalescedRefresh} from "@/lib/one-refresh-coordinator";
import {ONE_BUDGET_REJECTION_CODES,type OneBudgetConfigureInput,type OneBudgetSnapshot} from "@shared/one-budget";
import {OneBottomSheet} from "./OneBottomSheet";
import styles from "./PersonalOneBudget.module.css";

export function usePersonalOneBudgets(oneId?:string) {
  const [items,setItems]=useState<OneBudgetSnapshot[]>([]);const [unconfirmed,setUnconfirmed]=useState(false);
  const current=useRef(0);const reader=useRef<ReturnType<typeof createCoalescedRefresh<void>>|null>(null);
  const read=useCallback(async()=>{if(!oneId)return;const ticket=++current.current;try{const api=ipc()?.oneSupervisor;if(!api?.budgets)throw Error("budget_bridge_unavailable");const value=await api.budgets({oneId});if(!Array.isArray(value)||value.some(item=>item.oneId!==oneId))throw Error("budget_scope_unconfirmed");if(ticket===current.current){setItems(value);setUnconfirmed(false);}}catch{if(ticket===current.current)setUnconfirmed(true);}},[oneId]);
  const refresh=useCallback(()=>reader.current?.request(undefined) ?? Promise.resolve(),[]);
  useEffect(()=>{setItems([]);setUnconfirmed(false);if(!oneId)return;const owner=createCoalescedRefresh<void>(read,()=>undefined);reader.current=owner;void refresh();const off=ipcEvents()?.onStoreChanged?.(()=>void refresh());const focus=()=>void refresh();window.addEventListener("focus",focus);const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void refresh();},15_000);return()=>{++current.current;owner.dispose();if(reader.current===owner)reader.current=null;off?.();window.removeEventListener("focus",focus);window.clearInterval(timer);};},[oneId,read,refresh]);
  return {items,unconfirmed,refresh};
}
const dollars=(amount:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:6}).format(amount);
export function personalOneBudgetName(value:Pick<OneBudgetSnapshot,"budgetId"|"limitUsd">,locale:"ko"|"en") {return `${locale==="ko"?"예산":"Budget"} ${value.budgetId.slice(0,8)} · ${value.limitUsd===null?(locale==="ko"?"관측만":"Observe only"):dollars(value.limitUsd)}`;}
const amount=(text:string)=>/^\d+(?:\.\d{1,6})?$/.test(text)&&Number(text)<=1_000_000_000;
function savedBudget(raw:string,key:string,prefix:string,oneId:string):OneBudgetConfigureInput {
  const value=JSON.parse(raw) as OneBudgetConfigureInput;
  if(!value||value.oneId!==oneId||typeof value.commandId!=="string"||key!==prefix+value.commandId||typeof value.budgetId!=="string"||!value.budgetId||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||value.limitUsd!==null&&(typeof value.limitUsd!=="number"||!Number.isFinite(value.limitUsd)||value.limitUsd<0)||typeof value.reserveUsd!=="number"||!Number.isFinite(value.reserveUsd)||value.reserveUsd<=0)throw Error("saved_budget_invalid");
  return value;
}
/** Owner configuration has its own receipt shape and never enters the generic execution outbox. */
export function PersonalOneBudget({open,oneId,locale,items,unconfirmed,onRefresh,onClose}:{open:boolean;oneId?:string;locale:"ko"|"en";items:OneBudgetSnapshot[];unconfirmed:boolean;onRefresh():Promise<void>;onClose():void}) {
  const copy=(ko:string,en:string)=>locale==="ko"?ko:en;
  const [selected,setSelected]=useState("");const [editingRevision,setEditingRevision]=useState(0);const [mode,setMode]=useState<"observe"|"reservation">("observe");const [limit,setLimit]=useState("");const [reserve,setReserve]=useState("1");
  const [pending,setPending]=useState<OneBudgetConfigureInput[]>([]);const [busy,setBusy]=useState(false);const [storageError,setStorageError]=useState(false);const [status,setStatus]=useState<string|null>(null);
  const prefix=oneId?`agentlas.one.budget.command.${oneId}.`:null;const policy=items.find(item=>item.budgetId===selected);const selection=useRef("");
  useEffect(()=>{selection.current=selected;},[selected]);
  const loadSaved=useCallback(()=>{if(!oneId||!prefix)return;try{const values:OneBudgetConfigureInput[]=[];for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(!key?.startsWith(prefix))continue;const raw=localStorage.getItem(key);if(raw)values.push(savedBudget(raw,key,prefix,oneId));}setPending(values);setStorageError(false);}catch{setStorageError(true);}},[prefix,oneId]);
  useEffect(()=>{if(!open)return;loadSaved();void onRefresh();const storage=()=>loadSaved();window.addEventListener("storage",storage);return()=>window.removeEventListener("storage",storage);},[open,loadSaved,onRefresh]);
  const choose=(id:string)=>{setSelected(id);setStatus(null);const item=items.find(value=>value.budgetId===id);setMode(item?.limitUsd!=null?"reservation":"observe");setLimit(item?.limitUsd!=null?String(item.limitUsd):"");setReserve(String(item?.reserveUsd ?? 1));setEditingRevision(item?.revision ?? 0);};
  const configure=async(request?:OneBudgetConfigureInput)=>{
    if(busy||!oneId||!prefix||storageError)return;
    const exact=request ?? {commandId:crypto.randomUUID(),oneId,budgetId:selected||crypto.randomUUID(),expectedRevision:editingRevision,limitUsd:mode==="observe"?null:Number(limit),reserveUsd:Number(reserve)};
    if(!request&&(unconfirmed||selected&&(!policy||policy.revision!==editingRevision)||!amount(reserve)||Number(reserve)<=0||mode==="reservation"&&!amount(limit)||pending.some(item=>item.budgetId===exact.budgetId)))return;
    setBusy(true);setStatus(null);
    try{localStorage.setItem(prefix+exact.commandId,JSON.stringify(exact));setPending(prior=>[...prior.filter(item=>item.commandId!==exact.commandId),exact]);const api=ipc()?.oneSupervisor;if(!api?.budgetConfigure)throw Error("budget_bridge_unavailable");const receipt=await api.budgetConfigure(exact);
      if(receipt.commandId!==exact.commandId)throw Error("budget_receipt_unconfirmed");
      if("state" in receipt){
        if(receipt.state!=="rejected"||!ONE_BUDGET_REJECTION_CODES.includes(receipt.reasonCode))throw Error("budget_rejection_unconfirmed");
        localStorage.removeItem(prefix+exact.commandId);setPending(prior=>prior.filter(item=>item.commandId!==exact.commandId));await onRefresh();
        setStatus(receipt.reasonCode==="supervisor_budget_revision_conflict"?copy("설정은 이전 정책 버전으로 거절됐습니다. 현재 관측을 편집 양식에 불러온 뒤 새 요청을 저장하세요.","Configuration was rejected because its policy revision changed. Load the observed policy into the form, then save a new request."):copy("호스트가 이 설정 요청을 거절했습니다. 현재 정책과 입력값을 확인한 뒤 새 요청을 저장하세요.","The host rejected this configuration request. Review the current policy and inputs before saving a new request."));return;
      }
      const result=receipt.policy;
      if(receipt.commandId!==exact.commandId||result.oneId!==oneId||result.budgetId!==exact.budgetId||result.revision!==exact.expectedRevision+1||result.limitUsd!==exact.limitUsd||result.reserveUsd!==exact.reserveUsd||exact.reservationTtlMs!==undefined&&result.reservationTtlMs!==exact.reservationTtlMs)throw Error("budget_receipt_unconfirmed");
      localStorage.removeItem(prefix+exact.commandId);setPending(prior=>prior.filter(item=>item.commandId!==exact.commandId));await onRefresh();
      if(!selection.current||selection.current===exact.budgetId){setSelected(exact.budgetId);setEditingRevision(result.revision);setMode(exact.limitUsd===null?"observe":"reservation");setLimit(exact.limitUsd===null?"":String(exact.limitUsd));setReserve(String(exact.reserveUsd));}
      setStatus(copy("설정 요청의 접수를 확인했습니다. 아래 최신 관측을 확인하세요. 실행에는 작업 화면에서 예산을 직접 선택해야 합니다.","The policy request was confirmed. Review the latest observation below. Select a budget explicitly in the task screen to use it for execution."));
    }catch{setStatus(copy("설정 결과를 확인하지 못했습니다. 저장된 동일 요청을 다시 확인하세요. 현재 관측만으로 이 요청의 접수를 추정하지 않습니다.","The policy outcome is unconfirmed. Check the same saved request. Current observations alone do not prove that request was received."));}
    finally{setBusy(false);}
  };
  const revisionChanged=!!selected&&!!policy&&editingRevision!==policy.revision;
  const valid=amount(reserve)&&Number(reserve)>0&&(mode==="observe"||amount(limit))&&(!selected||!!policy)&&!revisionChanged;
  return <OneBottomSheet open={open} onClose={onClose} closeLabel={copy("실행 예산 닫기","Close execution budgets")} title={copy("실행 예산과 비용 관측","Execution budgets and billing observations")} ariaLabel={copy("실행 예산과 비용 관측","Execution budgets and billing observations")} size="compact">
    <div className={styles.root}>
      <p>{copy("기본은 제한 없이 관측만 합니다. 선택한 예산은 이 컴퓨터의 실행 접수를 제한합니다. 공급자의 실제 청구 비용 상한을 보장하지 않습니다.","The default is unrestricted observation. A selected budget limits local execution admission. It does not guarantee a cap on actual provider charges.")}</p>
      <p>{copy("각 새 실행은 지정액을 예약합니다. 같은 업무의 후속 실행도 같은 예산을 사용합니다. 청구가 미확정이면 예약은 유지되며 만료가 자동 환급을 뜻하지 않습니다.","Each new native run reserves the configured amount. Follow-up runs use the same task budget. Reservations remain while billing is unconfirmed; expiry does not mean an automatic refund.")}</p>
      {unconfirmed&&<p role="status">{copy("최신 비용·예산 관측을 확인하지 못했습니다. 마지막 관측을 표시하며 새 설정은 보류합니다.","Current budget and billing observations are unconfirmed. The last observation is shown; new configuration is held.")}</p>}
      {storageError&&<p role="status">{copy("저장된 예산 요청을 읽지 못했습니다. 새 설정을 보류합니다.","Saved budget requests could not be read. New configuration is held.")}</p>}
      <form className={styles.form} onSubmit={event=>{event.preventDefault();void configure();}}>
        <label>{copy("설정할 예산","Budget to configure")}<select aria-label={copy("설정할 예산","Budget to configure")} value={selected} onChange={event=>choose(event.target.value)}><option value="">{copy("새 예산","New budget")}</option>{items.map(item=><option key={item.budgetId} value={item.budgetId}>{personalOneBudgetName(item,locale)}</option>)}</select></label>
        {revisionChanged&&<p role="status">{copy("편집 중인 설정보다 새 정책 버전을 관측했습니다. 저장 전에 최신 설정을 확인하세요.","A newer policy revision was observed while editing. Review it before saving.")}</p>}
        {selected&&<button type="button" disabled={!policy} onClick={()=>choose(selected)}>{copy("현재 관측 정책을 편집 양식에 불러오기","Load observed policy for editing")}</button>}
        <label>{copy("실행 접수 방식","Execution admission mode")}<select aria-label={copy("실행 접수 방식","Execution admission mode")} value={mode} onChange={event=>setMode(event.target.value as "observe"|"reservation")}><option value="observe">{copy("제한 없이 관측만","Unrestricted observation only")}</option><option value="reservation">{copy("예약액 기준으로 접수 제한","Limit admission by reserved amounts")}</option></select></label>
        {mode==="reservation"&&<label>{copy("로컬 실행 접수 한도 (USD)","Local admission limit (USD)")}<input aria-label={copy("로컬 실행 접수 한도 (USD)","Local admission limit (USD)")} inputMode="decimal" value={limit} onChange={event=>setLimit(event.target.value)} required/></label>}
        <label>{copy("새 실행 1회 예약액 (USD)","Reservation per native run (USD)")}<input aria-label={copy("새 실행 1회 예약액 (USD)","Reservation per native run (USD)")} inputMode="decimal" value={reserve} onChange={event=>setReserve(event.target.value)} required/></label>
        <button type="submit" disabled={busy||!oneId||unconfirmed||storageError||!valid||pending.some(item=>item.budgetId===selected||!selected&&item.expectedRevision===0)}>{copy("이 예산 정책 저장","Save this budget policy")}</button>
      </form>
      {pending.map(item=><article className={styles.card} key={item.commandId}><strong>{copy("예산 설정 접수 확인 필요","Budget policy reception needs confirmation")}</strong><span>{item.limitUsd===null?copy("제한 없이 관측만","Unrestricted observation only"):copy(`한도 ${dollars(item.limitUsd)}`,`Limit ${dollars(item.limitUsd)}`)} · {copy("예약액","Reservation")} {dollars(item.reserveUsd)}</span><button type="button" disabled={busy||storageError} onClick={()=>void configure(item)}>{copy("같은 예산 요청 확인","Check the same budget request")}</button></article>)}
      {status&&<p role="status">{status}</p>}
      <button type="button" onClick={()=>void onRefresh()}>{copy("현재 예산 관측 새로 확인","Refresh budget observations")}</button>
      {!items.length&&<p>{copy("저장된 예산 정책이 없습니다. 새 Work 실행은 기본적으로 제한 없이 관측합니다.","No budget policy is saved. New Work tasks use unrestricted observation by default.")}</p>}
      {items.map(item=><article className={styles.card} key={item.budgetId} data-one-budget={item.budgetId}><strong>{personalOneBudgetName(item,locale)}</strong><small>{copy("정책 버전","Policy revision")} {item.revision}</small><dl><dt>{copy("확정된 부분합","Confirmed subtotal")}</dt><dd>{dollars(item.knownSubtotalUsd)}</dd><dt>{copy("유지 중인 예약액","Held reservations")}</dt><dd>{dollars(item.reservedUsd)}</dd><dt>{copy("미확정 청구 건수","Unconfirmed billing events")}</dt><dd>{item.unknownCount}</dd><dt>{copy("정산 대기 실행","Runs awaiting reconciliation")}</dt><dd>{item.unresolvedRuns}</dd><dt>{copy("로컬 추가 접수 가능액","Available for local admission")}</dt><dd>{item.availableUsd===null?copy("제한 없음","Unrestricted"):dollars(item.availableUsd)}</dd></dl>{(item.unknownCount>0||item.unresolvedRuns>0)&&<p>{copy("실제 총비용은 미확정입니다. 확정된 부분합만으로 총비용을 계산하지 않습니다.","Actual total charges remain unconfirmed. The confirmed subtotal is not the total cost.")}</p>}</article>)}
    </div>
  </OneBottomSheet>;
}
