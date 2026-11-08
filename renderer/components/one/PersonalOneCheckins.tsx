"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { createStoreChangeThrottle } from "@/lib/store-change-policy";
import { ONE_CHECKIN_LIMITS, type OneCheckin, type SupervisorCheckinInput } from "@shared/one-supervisor";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./PersonalOneCapabilities.module.css";
import { Select } from "@/components/Select";

/** Check-in is a wrapper API, deliberately separate from receipt-returning outbox writers. */
export function PersonalOneCheckins({open,embedded=false,active=true,ownerScope,isOwnerCurrent,oneId,locale,onClose,onRefresh}:{open:boolean;embedded?:boolean;active?:boolean;ownerScope?:string|null;isOwnerCurrent?:()=>boolean;oneId?:string;locale:"ko"|"en";onClose():void;onRefresh():void}) {
  const copy=(ko:string,en:string)=>locale==="ko"?ko:en;
  const [items,setItems]=useState<OneCheckin[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [instruction,setInstruction]=useState("");
  const [cadence,setCadence]=useState("interval");
  const [minutes,setMinutes]=useState("60");
  const [time,setTime]=useState("09:00");
  const [notify,setNotify]=useState<"important"|"always">("important");
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<string|null>(null);
  const [pending,setPending]=useState<SupervisorCheckinInput[]>([]);
  const pendingRef=useRef<SupervisorCheckinInput[]>([]);
  const [volatileIds,setVolatileIds]=useState<string[]>([]);
  const volatileRef=useRef<string[]>([]);volatileRef.current=volatileIds;
  const [legacyPending,setLegacyPending]=useState(false);
  const [storageChecked,setStorageChecked]=useState(false);
  const current=useRef(0);
  const ownerRef=useRef(isOwnerCurrent);ownerRef.current=isOwnerCurrent;
  const storageKey=oneId&&ownerScope?`agentlas.one.checkin.command.v2.${encodeURIComponent(ownerScope)}.${encodeURIComponent(oneId)}.`:null;
  const legacyKey=oneId?`agentlas.one.checkin.command.${oneId}.`:null;
  const ownerCurrent=()=>!ownerRef.current||ownerRef.current();
  const remember=(request:SupervisorCheckinInput)=>{pendingRef.current=[...pendingRef.current.filter(item=>item.commandId!==request.commandId),request];setPending(pendingRef.current);};
  const forget=(commandId:string)=>{pendingRef.current=pendingRef.current.filter(item=>item.commandId!==commandId);setPending(pendingRef.current);setVolatileIds(ids=>ids.filter(id=>id!==commandId));};
  const load=useCallback(async()=>{
    if(!oneId)return;
    const generation=++current.current;
    try {
      const api=ipc()?.oneSupervisor;if(!api)throw new Error("desktop_unavailable");
      const value=await api.snapshot();
      if(generation!==current.current||!ownerCurrent()||value.oneId!==oneId)return;
      setItems(value.checkins ?? []);
      setLoaded(true);
      if(storageKey){
        const savedRequests:SupervisorCheckinInput[]=[];
        let legacy=false;
        for(let index=0;index<window.localStorage.length;index++){
          const key=window.localStorage.key(index);if(key&&legacyKey&&key.startsWith(legacyKey))legacy=true;if(!key?.startsWith(storageKey))continue;
          const raw=window.localStorage.getItem(key);if(!raw)continue;
          const saved=JSON.parse(raw) as SupervisorCheckinInput;
          if(saved.oneId!==oneId||key!==storageKey+saved.commandId||!["create","cancel"].includes(saved.action))throw new Error("saved_checkin_invalid");
          const receipt=value.requests.find(item=>item.commandId===saved.commandId);
          if(receipt&&receipt.acknowledgement!=="unknown"){window.localStorage.removeItem(key);index--;}
          else savedRequests.push(saved);
        }
        setLegacyPending(legacy);
        const savedIds=new Set(savedRequests.map(item=>item.commandId));
        const merged=[...savedRequests,...pendingRef.current.filter(item=>!savedIds.has(item.commandId)&&volatileRef.current.includes(item.commandId))];
        pendingRef.current=merged;setPending(merged);setStorageChecked(true);
      }
    }catch{if(generation===current.current&&ownerCurrent()){setStorageChecked(false);setStatus(copy("현재 감시 상태 또는 저장된 요청을 확인하지 못했습니다. 마지막 관측을 표시합니다.","Current monitoring state or saved requests could not be confirmed. Showing the last observation."));}}
  },[oneId,storageKey,legacyKey,locale]);
  useEffect(()=>{
    if(!open||!active)return;
    const reads=createCoalescedRefresh<void>(load,()=>undefined);
    const refresh=()=>{if(document.visibilityState!=="hidden")void reads.request(undefined);};
    const changes=createStoreChangeThrottle({immediate:()=>false,throttleMs:1_000,run:refresh});
    refresh();const off=ipcEvents()?.onStoreChanged?.(change=>changes.notify(change));
    document.addEventListener("visibilitychange",refresh);
    return()=>{++current.current;changes.dispose();reads.dispose();off?.();document.removeEventListener("visibilitychange",refresh);};
  },[open,active,load]);
  const submit=async(input:Omit<SupervisorCheckinInput,"commandId">|SupervisorCheckinInput)=>{
    if((busy&&input.action!=="cancel")||!oneId||!ownerCurrent())return;
    if(input.action!=="cancel"&&(!storageKey||!storageChecked))return;
    const previous=input.action==="cancel"&&!("commandId" in input)?pendingRef.current.find(item=>item.action==="cancel"&&item.checkinId===input.checkinId):undefined;
    const request:SupervisorCheckinInput="commandId" in input?input:previous??{...input,oneId,commandId:crypto.randomUUID()};
    if(!request)return;
    setBusy(true);setStatus(null);
    try {
      // Create requires a durable retry identity; stop must still reach the host if storage fails.
      let durable=false;
      try{if(storageKey){window.localStorage.setItem(storageKey+request.commandId,JSON.stringify(request));durable=true;}}catch{/* Stop remains available without durable local storage. */}
      if(!durable&&request.action!=="cancel"){setStatus(copy("요청을 이 기기에 저장하지 못해 감시 등록을 보내지 않았습니다.","Monitoring creation was not sent because its request could not be saved on this device."));return;}
      remember(request);
      if(!durable){volatileRef.current=[...new Set([...volatileRef.current,request.commandId])];setVolatileIds(volatileRef.current);}
      const value=await ipc()!.oneSupervisor.checkin(request);
      if(!ownerCurrent())return;
      if(!value.receipt||value.receipt.commandId!==request.commandId)throw new Error("checkin_receipt_unconfirmed");
      if(value.receipt.acknowledgement!=="unknown"){
        if(durable&&storageKey){try{window.localStorage.removeItem(storageKey+request.commandId);}catch{/* The next scoped read can reconcile the saved receipt. */}}
        forget(request.commandId);
        if(value.receipt.state==="completed"){
          if(request.action==="create")setInstruction(text=>text===request.instruction?"":text);
          setStatus(copy("조건을 저장했습니다. 다음 실행 시각은 아래 관측에서 확인하세요.","The conditions were saved. Check the next run in the observation below."));
        }else setStatus(copy("요청은 접수됐지만 조건 변경을 확인하지 못했습니다.","The request was received, but its change was not confirmed."));
        await load();if(ownerCurrent())onRefresh();
      }else throw new Error("checkin_receipt_unknown");
    }catch{if(ownerCurrent())setStatus(copy("접수를 확인하지 못했습니다. 아래에서 같은 요청을 다시 확인하세요.","Reception was not confirmed. Check the same request below."));}
    finally{if(ownerCurrent())setBusy(false);}
  };
  const valid=instruction.trim()&& (cadence==="daily"?/^([01]\d|2[0-3]):[0-5]\d$/.test(time):Number.isInteger(Number(minutes))&&Number(minutes)>=ONE_CHECKIN_LIMITS.minMinutes&&Number(minutes)<=ONE_CHECKIN_LIMITS.maxMinutes);
  return <OneBottomSheet open={open} embedded={embedded} onClose={onClose} closeLabel={copy("감시 닫기","Close monitoring")} title={copy("One 감시 조건","One monitoring")} ariaLabel={copy("One 감시 조건","One monitoring")} size="compact">
    <div className={styles.root}>
      <p>{copy("이 컴퓨터에서 정한 주기로 확인합니다. 컴퓨터가 꺼지거나 앱이 완전히 종료되면 로컬 확인은 실행되지 않습니다.","Checks run on this computer at your chosen cadence. Local checks do not run when the computer is off or the app has fully quit.")}</p>
      {legacyPending&&<p role="status">{copy("이전 감시 요청의 계정과 결과를 확인할 수 없어 이 기기에 보존했습니다. 새 감시를 등록하기 전 중복 여부를 확인하세요.","An earlier monitoring request was preserved because its account and outcome are unknown. Check for duplicates before creating another.")}</p>}
      {volatileIds.length>0&&<p role="status">{copy("중지 요청을 이 기기에 저장하지 못했습니다. 이 화면에서 같은 요청을 다시 확인할 수 있습니다. 계정을 바꾸거나 앱을 닫은 뒤에는 현재 감시 상태를 확인하세요.","A stop request could not be saved on this device. You can check the same request here. After switching accounts or closing the app, review the current monitoring state.")}</p>}
      {!ownerScope&&<p role="status">{copy("계정 상태가 확인되기 전에는 새 감시를 등록할 수 없습니다. 기존 감시는 중지할 수 있습니다.","New monitoring waits for confirmed account state. Existing monitoring can still be stopped.")}</p>}
      <form className={styles.form} onSubmit={event=>{event.preventDefault();void submit({action:"create",instruction:instruction.trim(),notify,...(cadence==="daily"?{dailyAt:time}:{everyMinutes:Number(minutes)})});}}>
        <label>{copy("확인할 일과 중요한 변화","What to check and what matters")}<textarea value={instruction} onChange={event=>setInstruction(event.target.value)} maxLength={8000} rows={3} required/></label>
        <label>{copy("주기","Cadence")}<Select aria-label={copy("주기","Cadence")} value={cadence} onChange={event=>setCadence(event.target.value)}><option value="interval">{copy("시간 간격","Interval")}</option><option value="daily">{copy("매일 지정 시각","Daily at a time")}</option></Select></label>
        {cadence==="daily"?<label>{copy("이 컴퓨터의 현지 시각","Local time on this computer")}<input type="time" value={time} onChange={event=>setTime(event.target.value)} required/></label>:<label>{copy("몇 분마다","Every (minutes)")}<input type="number" value={minutes} onChange={event=>setMinutes(event.target.value)} min={ONE_CHECKIN_LIMITS.minMinutes} max={ONE_CHECKIN_LIMITS.maxMinutes} required/></label>}
        <label>{copy("알림","Notification")}<Select aria-label={copy("알림","Notification")} value={notify} onChange={event=>setNotify(event.target.value as "important"|"always")}><option value="important">{copy("중요한 변화만","Meaningful changes only")}</option><option value="always">{copy("확인할 때마다 보고","Report every check")}</option></Select></label>
        <button type="submit" disabled={busy||pending.some(item=>item.action==="create")||!oneId||!ownerScope||!storageChecked||!valid||items.length>=ONE_CHECKIN_LIMITS.active}>{copy("이 조건으로 감시 시작","Start monitoring with these conditions")}</button>
      </form>
      {pending.map(request=><div key={request.commandId} className={styles.notice}><p>{request.action==="cancel"?copy("감시 중지 접수 확인 필요","Monitoring cancellation needs confirmation"):copy("감시 등록 접수 확인 필요","Monitoring creation needs confirmation")}</p><button type="button" disabled={busy} onClick={()=>void submit(request)}>{copy("같은 요청 접수 확인","Check the same request")}</button></div>)}
      {status&&<p role="status" className={styles.notice}>{status}</p>}
      <button type="button" onClick={()=>void load()}>{copy("현재 상태 새로 확인","Refresh current state")}</button>
      {loaded&&!items.length&&<p>{copy("등록된 감시가 없습니다.","No monitoring is registered.")}</p>}
      {items.map(item=><article className={styles.card} key={item.id} data-one-checkin={item.id}><strong>{item.instruction}</strong><p>{item.cadence.kind==="daily"?copy(`매일 ${item.cadence.time}`,`Daily ${item.cadence.time}`):copy(`${item.cadence.minutes}분마다`,`Every ${item.cadence.minutes} minutes`)} · {item.notify==="important"?copy("중요한 변화만","Meaningful changes only"):copy("매번 보고","Every check")}</p><small>{copy("다음 확인","Next check")}: {new Date(item.nextAt).toLocaleString()}</small><button type="button" onClick={()=>void submit({action:"cancel",checkinId:item.id})}>{copy("이 감시 중지","Stop this monitoring")}</button></article>)}
    </div>
  </OneBottomSheet>;
}
