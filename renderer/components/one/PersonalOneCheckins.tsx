"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ONE_CHECKIN_LIMITS, type OneCheckin, type SupervisorCheckinInput } from "@shared/one-supervisor";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./PersonalOneCapabilities.module.css";

/** Check-in is a wrapper API, deliberately separate from receipt-returning outbox writers. */
export function PersonalOneCheckins({open,oneId,locale,onClose,onRefresh}:{open:boolean;oneId?:string;locale:"ko"|"en";onClose():void;onRefresh():void}) {
  const copy=(ko:string,en:string)=>locale==="ko"?ko:en;
  const [items,setItems]=useState<OneCheckin[]>([]);
  const [instruction,setInstruction]=useState("");
  const [cadence,setCadence]=useState("interval");
  const [minutes,setMinutes]=useState("60");
  const [time,setTime]=useState("09:00");
  const [notify,setNotify]=useState<"important"|"always">("important");
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<string|null>(null);
  const [pending,setPending]=useState<SupervisorCheckinInput[]>([]);
  const current=useRef(0);
  const storageKey=oneId?`agentlas.one.checkin.command.${oneId}.`:null;
  const load=useCallback(async()=>{
    if(!oneId)return;
    const generation=++current.current;
    try {
      const api=ipc()?.oneSupervisor;if(!api)throw new Error("desktop_unavailable");
      const value=await api.snapshot();
      if(generation!==current.current||value.oneId!==oneId)return;
      setItems(value.checkins ?? []);
      if(storageKey){
        const savedRequests:SupervisorCheckinInput[]=[];
        for(let index=0;index<window.localStorage.length;index++){
          const key=window.localStorage.key(index);if(!key?.startsWith(storageKey))continue;
          const raw=window.localStorage.getItem(key);if(!raw)continue;
          const saved=JSON.parse(raw) as SupervisorCheckinInput;
          if(saved.oneId!==oneId||key!==storageKey+saved.commandId||!["create","cancel"].includes(saved.action))throw new Error("saved_checkin_invalid");
          const receipt=value.requests.find(item=>item.commandId===saved.commandId);
          if(receipt&&receipt.acknowledgement!=="unknown"){window.localStorage.removeItem(key);index--;}
          else savedRequests.push(saved);
        }
        setPending(savedRequests);
      }
    }catch{if(generation===current.current)setStatus(copy("현재 감시 상태를 확인하지 못했습니다. 마지막 관측을 표시합니다.","Current monitoring state could not be confirmed. Showing the last observation."));}
  },[oneId,storageKey,locale]);
  useEffect(()=>{if(!open)return;void load();const off=ipcEvents()?.onStoreChanged?.(()=>void load());return()=>{++current.current;off?.();};},[open,load]);
  const submit=async(input:Omit<SupervisorCheckinInput,"commandId">|SupervisorCheckinInput)=>{
    if((busy&&input.action!=="cancel")||!oneId||!storageKey)return;
    const request:SupervisorCheckinInput="commandId" in input?input:{...input,oneId,commandId:crypto.randomUUID()};
    if(!request)return;
    setBusy(true);setStatus(null);
    try {
      // Save before invoking. Closing the sheet or a response loss keeps this exact command.
      window.localStorage.setItem(storageKey+request.commandId,JSON.stringify(request));setPending(prior=>[...prior.filter(item=>item.commandId!==request.commandId),request]);
      const value=await ipc()!.oneSupervisor.checkin(request);
      if(!value.receipt||value.receipt.commandId!==request.commandId)throw new Error("checkin_receipt_unconfirmed");
      if(value.receipt.acknowledgement!=="unknown"){
        window.localStorage.removeItem(storageKey+request.commandId);setPending(prior=>prior.filter(item=>item.commandId!==request.commandId));
        if(value.receipt.state==="completed"){
          if(request.action==="create")setInstruction(text=>text===request.instruction?"":text);
          setStatus(copy("조건을 저장했습니다. 다음 실행 시각은 아래 관측에서 확인하세요.","The conditions were saved. Check the next run in the observation below."));
        }else setStatus(copy("요청은 접수됐지만 조건 변경을 확인하지 못했습니다.","The request was received, but its change was not confirmed."));
        await load();onRefresh();
      }else throw new Error("checkin_receipt_unknown");
    }catch{setStatus(copy("접수를 확인하지 못했습니다. 아래에서 같은 요청을 다시 확인하세요.","Reception was not confirmed. Check the same request below."));}
    finally{setBusy(false);}
  };
  const valid=instruction.trim()&& (cadence==="daily"?/^([01]\d|2[0-3]):[0-5]\d$/.test(time):Number.isInteger(Number(minutes))&&Number(minutes)>=ONE_CHECKIN_LIMITS.minMinutes&&Number(minutes)<=ONE_CHECKIN_LIMITS.maxMinutes);
  return <OneBottomSheet open={open} onClose={onClose} closeLabel={copy("감시 닫기","Close monitoring")} title={copy("One 감시 조건","One monitoring")} ariaLabel={copy("One 감시 조건","One monitoring")} size="compact">
    <div className={styles.root}>
      <p>{copy("이 컴퓨터에서 정한 주기로 확인합니다. 컴퓨터가 꺼지거나 앱이 완전히 종료되면 로컬 확인은 실행되지 않습니다.","Checks run on this computer at your chosen cadence. Local checks do not run when the computer is off or the app has fully quit.")}</p>
      <form className={styles.form} onSubmit={event=>{event.preventDefault();void submit({action:"create",instruction:instruction.trim(),notify,...(cadence==="daily"?{dailyAt:time}:{everyMinutes:Number(minutes)})});}}>
        <label>{copy("확인할 일과 중요한 변화","What to check and what matters")}<textarea value={instruction} onChange={event=>setInstruction(event.target.value)} maxLength={8000} rows={3} required/></label>
        <label>{copy("주기","Cadence")}<select aria-label={copy("주기","Cadence")} value={cadence} onChange={event=>setCadence(event.target.value)}><option value="interval">{copy("시간 간격","Interval")}</option><option value="daily">{copy("매일 지정 시각","Daily at a time")}</option></select></label>
        {cadence==="daily"?<label>{copy("이 컴퓨터의 현지 시각","Local time on this computer")}<input type="time" value={time} onChange={event=>setTime(event.target.value)} required/></label>:<label>{copy("몇 분마다","Every (minutes)")}<input type="number" value={minutes} onChange={event=>setMinutes(event.target.value)} min={ONE_CHECKIN_LIMITS.minMinutes} max={ONE_CHECKIN_LIMITS.maxMinutes} required/></label>}
        <label>{copy("알림","Notification")}<select aria-label={copy("알림","Notification")} value={notify} onChange={event=>setNotify(event.target.value as "important"|"always")}><option value="important">{copy("중요한 변화만","Meaningful changes only")}</option><option value="always">{copy("확인할 때마다 보고","Report every check")}</option></select></label>
        <button type="submit" disabled={busy||pending.some(item=>item.action==="create")||!oneId||!valid||items.length>=ONE_CHECKIN_LIMITS.active}>{copy("이 조건으로 감시 시작","Start monitoring with these conditions")}</button>
      </form>
      {pending.map(request=><div key={request.commandId} className={styles.notice}><p>{request.action==="cancel"?copy("감시 중지 접수 확인 필요","Monitoring cancellation needs confirmation"):copy("감시 등록 접수 확인 필요","Monitoring creation needs confirmation")}</p><button type="button" disabled={busy} onClick={()=>void submit(request)}>{copy("같은 요청 접수 확인","Check the same request")}</button></div>)}
      {status&&<p role="status" className={styles.notice}>{status}</p>}
      <button type="button" onClick={()=>void load()}>{copy("현재 상태 새로 확인","Refresh current state")}</button>
      {!items.length&&<p>{copy("등록된 감시가 없습니다.","No monitoring is registered.")}</p>}
      {items.map(item=><article className={styles.card} key={item.id} data-one-checkin={item.id}><strong>{item.instruction}</strong><p>{item.cadence.kind==="daily"?copy(`매일 ${item.cadence.time}`,`Daily ${item.cadence.time}`):copy(`${item.cadence.minutes}분마다`,`Every ${item.cadence.minutes} minutes`)} · {item.notify==="important"?copy("중요한 변화만","Meaningful changes only"):copy("매번 보고","Every check")}</p><small>{copy("다음 확인","Next check")}: {new Date(item.nextAt).toLocaleString()}</small><button type="button" disabled={pending.some(request=>request.action==="cancel"&&request.checkinId===item.id)} onClick={()=>void submit({action:"cancel",checkinId:item.id})}>{copy("이 감시 중지","Stop this monitoring")}</button></article>)}
    </div>
  </OneBottomSheet>;
}
