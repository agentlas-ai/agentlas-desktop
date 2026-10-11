"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { SupervisorTask } from "@shared/one-supervisor";
import type { OneContextGrant, OneContextSnapshot, OneContextTargetSelection } from "@shared/one-context";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./PersonalOneContext.module.css";
import { Select } from "@/components/Select";

export function activeOneContextGrants(value:OneContextSnapshot|null,now=Date.now()):OneContextGrant[] {
  return value?.grants.filter(grant=>grant.state==="active"&&Date.parse(grant.expiresAt)>now) ?? [];
}
/** Snapshot polling never requests a capture. Grant and capture are direct owner actions below. */
export function usePersonalOneContext(oneId?:string) {
  const [snapshot,setSnapshot]=useState<OneContextSnapshot|null>(null);
  const [unconfirmed,setUnconfirmed]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  const stopEpoch=useRef(0);const current=useRef(0);
  const coordinator=useRef<ReturnType<typeof createCoalescedRefresh<void>>|null>(null);
  const read=useCallback(async()=>{
    if(!oneId)return;
    const generation=++current.current;
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");
      const value=await api.snapshot({oneId});
      if(value.oneId!==oneId||!Array.isArray(value.grants)||!value.readiness)throw new Error("one_context_binding_unconfirmed");
      if(generation!==current.current)return;setSnapshot(value);setUnconfirmed(false);setNow(Date.now());
    }catch{if(generation===current.current)setUnconfirmed(true);}
  },[oneId]);
  const refresh=useCallback(()=>coordinator.current?.request(undefined) ?? Promise.resolve(),[]);
  useEffect(()=>{
    setSnapshot(null);setUnconfirmed(false);if(!oneId)return;
    const refreshOwner=createCoalescedRefresh<void>(read,()=>undefined);coordinator.current=refreshOwner;
    void refresh();const off=ipcEvents()?.onStoreChanged?.(()=>void refresh());
    const focus=()=>void refresh();window.addEventListener("focus",focus);
    const timer=window.setInterval(()=>{setNow(Date.now());if(document.visibilityState!=="hidden")void refresh();},5000);
    return()=>{++current.current;refreshOwner.dispose();if(coordinator.current===refreshOwner)coordinator.current=null;off?.();window.removeEventListener("focus",focus);window.clearInterval(timer);};
  },[oneId,read,refresh]);
  const stop=useCallback(async(grantId?:string)=>{if(!oneId)return;++stopEpoch.current;try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await api.revoke({oneId,...(grantId?{grantId}:{})});await refresh();}catch(error){setUnconfirmed(true);throw error;}},[oneId,refresh]);
  return {snapshot,unconfirmed,now,refresh,stop,stopEpoch};
}

export function personalOneContextLabel(value:OneContextSnapshot|null,unconfirmed:boolean,now:number,locale:"ko"|"en") {
  const copy=(ko:string,en:string)=>locale==="ko"?ko:en;
  if(unconfirmed)return copy("화면 상태 확인 필요","Screen status unconfirmed");
  if(!value)return copy("화면 상태 확인 중","Checking screen status");
  const active=activeOneContextGrants(value,now);
  if(!active.length)return value.grants.some(grant=>grant.state==="expired"||grant.state==="active"&&Date.parse(grant.expiresAt)<=now)?copy("보여주기 시간 끝남","Showing time ended"):copy("화면 보기 꺼짐","Screen viewing off");
  if(value.readiness.session!=="awake")return copy("화면 보기 잠시 멈춤","Screen viewing paused");
  const latest=value.latest;
  const fresh=latest&&active.some(grant=>grant.grantId===latest.grantId)&&latest.state==="fresh"&&Date.parse(latest.staleAt)>now;
  return fresh?copy(`보는 중 · ${active[0].target.label}`,`Viewing · ${active[0].target.label}`):copy(`보여주는 중 · ${active[0].target.label}`,`Showing · ${active[0].target.label}`);
}

export function PersonalOneContext({open,oneId,tasks,preferredTaskId,locale,value,unconfirmed,now,stopEpoch,onStop,onClose,onRefresh}:{
  open:boolean;oneId?:string;tasks:SupervisorTask[];preferredTaskId:string|null;locale:"ko"|"en";
  value:OneContextSnapshot|null;unconfirmed:boolean;now:number;stopEpoch:{current:number};onStop(grantId?:string):Promise<void>;onClose():void;onRefresh():Promise<void>;
}) {
  const ko=locale==="ko";const copy=(a:string,b:string)=>ko?a:b;
  const [taskId,setTaskId]=useState("");
  const [kind,setKind]=useState<"window"|"display">("window");
  const [selection,setSelection]=useState<OneContextTargetSelection|null>(null);
  const [sourceId,setSourceId]=useState("");
  const [mode,setMode]=useState<"observe"|"interact">("observe");
  const [duration,setDuration]=useState(5*60_000);
  const [consent,setConsent]=useState(false);
  const [listing,setListing]=useState(false);const [granting,setGranting]=useState(false);
  const [feedback,setFeedback]=useState<string|null>(null);const [uncertainGrant,setUncertainGrant]=useState(false);
  const [stopping,setStopping]=useState(false);const [capturing,setCapturing]=useState<string|null>(null);
  const generation=useRef(0);
  const active=activeOneContextGrants(value,now);
  const knownTask=tasks.some(item=>item.taskId===taskId);
  const readiness=value?.readiness;
  const metadataReady=!unconfirmed&&readiness?.session==="awake";
  const readReady=metadataReady&&readiness?.available;
  const target=selection?.targets.find(item=>item.sourceId===sourceId&&item.kind===kind);
  const targetFresh=selection&&Date.parse(selection.expiresAt)>now;
  const targetReadReady=metadataReady&&target?.captureAvailable;
  const interactionReady=metadataReady&&target?.interactionAvailable&&readiness?.driverAvailable&&readiness.accessibility==="granted";
  useEffect(()=>{if(!open){++generation.current;setConsent(false);setListing(false);return;}setFeedback(null);setMode("observe");setSelection(null);setSourceId("");setTaskId(preferredTaskId&&tasks.some(task=>task.taskId===preferredTaskId)?preferredTaskId:tasks.length===1?tasks[0].taskId:"");void onRefresh();},[open,oneId]);
  // Preselect the only task when it appears after the sheet opened; never overrides an owner choice.
  useEffect(()=>{if(open&&!taskId&&tasks.length===1)setTaskId(tasks[0].taskId);},[open,taskId,tasks.length,tasks[0]?.taskId]);
  useEffect(()=>{setConsent(false);},[taskId,kind,sourceId,mode,duration]);
  useEffect(()=>{++generation.current;setSelection(null);setSourceId("");setListing(false);},[taskId,kind]);
  const list=async()=>{
    if(!oneId||!taskId||!knownTask||listing||!metadataReady)return;const ticket=++generation.current;setListing(true);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");const result=await api.targets({oneId,taskId,kind});if(ticket!==generation.current)return;setSelection(result);setSourceId("");setConsent(false);}
    catch{if(ticket===generation.current)setFeedback(copy("창 목록을 불러오지 못했습니다. 화면 기록 권한과 작업을 확인하고 다시 불러와 주세요.","Could not load the list. Check screen recording permission and the task, then try again."));}
    finally{if(ticket===generation.current)setListing(false);}
  };
  const grant=async()=>{
    if(granting||!oneId||!taskId||!knownTask||!target||!selection||!targetFresh||Date.parse(selection.expiresAt)<=Date.now()||!consent||!targetReadReady||mode==="interact"&&!interactionReady||uncertainGrant)return;
    const epoch=stopEpoch.current;setGranting(true);setFeedback(null);setConsent(false);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await api.grant({oneId,taskId,selectionId:selection.selectionId,sourceId:target.sourceId,durationMs:duration,mode});
      // Stop also wins when a grant request was already in flight.
      if(epoch!==stopEpoch.current)await onStop();
      await onRefresh();setUncertainGrant(false);setFeedback(copy("보여주기를 시작했습니다. 아래에서 상태를 확인하세요.","Showing has started. Check the status below."));
    }catch{setUncertainGrant(true);setFeedback(copy("보여주기가 시작됐는지 확인하지 못했습니다. 다시 시작하기 전에 상태를 확인하거나 모두 그만 보여주기를 누르세요.","Could not confirm that showing started. Check the status, or stop everything, before trying again."));}
    finally{setGranting(false);}
  };
  const stop=async(grantId?:string)=>{
    if(!oneId)return;setConsent(false);setStopping(true);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await onStop(grantId);await onRefresh();setUncertainGrant(false);setFeedback(copy("그만 보여주기를 요청했습니다. 아래에서 상태를 확인하세요.","Stop was requested. Check the status below."));}
    catch{setFeedback(copy("그만 보여주기를 확인하지 못했습니다. 다시 눌러 보거나 상태를 확인하세요.","Could not confirm the stop. Try again or check the status."));}
    finally{setStopping(false);}
  };
  const capture=async(grant:OneContextGrant)=>{
    if(!oneId||capturing||!metadataReady||grant.state!=="active"||Date.parse(grant.expiresAt)<=Date.now()||!grant.target.captureAvailable)return;setCapturing(grant.grantId);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await api.capture({oneId,taskId:grant.taskId,grantId:grant.grantId});await onRefresh();}
    catch{setFeedback(copy("지금 화면을 보지 못했습니다. 이전에 본 화면은 현재 화면으로 쓰지 않습니다.","Could not view the screen now. An earlier view is not used as the current screen."));}
    finally{setCapturing(null);}
  };
  const latest=value?.latest;
  const preview=latest&&!unconfirmed&&readiness?.session==="awake"&&latest.state==="fresh"&&Date.parse(latest.staleAt)>now&&active.some(grant=>grant.grantId===latest.grantId)&&/^data:image\/(png|jpeg|webp);base64,/i.test(latest.dataUrl)?latest:null;
  const openPermission=(kind:"screen"|"accessibility")=>void ipc()?.oneContext?.openPermissions({kind}).then(()=>setFeedback(copy("설정 창을 열었습니다. 바꾼 뒤 '다시 확인'을 누르세요.","Settings opened. After changing them, press Refresh."))).catch(()=>setFeedback(copy("설정 창을 열지 못했습니다.","Could not open settings.")));
  const targetNoun=kind==="display"?copy("화면","screen"):copy("창","window");
  return <OneBottomSheet open={open} onClose={onClose} closeLabel={copy("화면 보여주기 닫기","Close showing your screen")} ariaLabel={copy("화면 보여주기","Show your screen")} title={copy("화면 보여주기","Show your screen")} size="compact" footer={<div className={styles.root}><button type="button" className={styles.stop} aria-busy={stopping} disabled={!oneId} onClick={()=>void stop()}>{copy("모두 그만 보여주기","Stop showing everything")}</button></div>}>
    <div className={styles.root}>
      <p>{copy("Hope에게 보여줄 창을 고르세요. 고른 창만, 정한 시간 동안 봅니다.","Choose a window to show Hope. Only that window is visible, only for the time you set.")}</p>
      {unconfirmed&&<p role="status" className={styles.notice}>{copy("지금 상태를 확인하지 못했습니다. 아래 '모두 그만 보여주기'는 계속 쓸 수 있습니다.","Could not check the current status. Stop showing everything below still works.")}</p>}
      <div className={styles.readiness} aria-label={copy("화면 보기 상태","Screen viewing status")}>
        <span>{readReady?copy("화면 보기 준비됨","Ready to view your screen"):readiness?.session==="locked"?copy("컴퓨터가 잠겨 있습니다","The computer is locked"):readiness?.session==="sleeping"?copy("컴퓨터가 잠자기 상태입니다","The computer is asleep"):readiness&&readiness.screenPermission!=="granted"?copy("화면 기록 권한이 필요합니다","Screen recording permission is needed"):copy("화면 보기를 준비하지 못했습니다","Screen viewing is not ready")}</span>
        {readiness?.screenPermission!=="granted"&&<button type="button" className={styles.link} onClick={()=>openPermission("screen")}>{copy("설정 열기","Open settings")}</button>}
        {readiness?.accessibility!=="granted"&&<button type="button" className={styles.link} onClick={()=>openPermission("accessibility")}>{copy("조작 권한 설정 열기","Open control settings")}</button>}
        <button type="button" className={styles.link} onClick={()=>void onRefresh()}>{copy("다시 확인","Refresh")}</button>
        {value?.lease.state!=="idle"&&value?.lease&&<small>{value.lease.state==="waiting"?copy("다른 작업이 화면 조작을 끝내기를 기다리는 중입니다.","Waiting for another task to finish using the screen."):copy("다른 작업이 화면을 조작하는 중입니다. 보기만 허용해도 조작 권한은 생기지 않습니다.","Another task is operating the screen. Allowing viewing does not give control.")}</small>}
        {readiness?.humanBusy&&<small>{copy("직접 쓰는 중이라 Hope의 조작은 잠시 기다립니다.","You are using the computer, so Hope waits before operating it.")}</small>}
      </div>
      <form className={styles.form} onSubmit={event=>{event.preventDefault();void grant();}}>
        <label>{copy("어떤 작업에 쓸지","Which task")}<Select aria-label={copy("어떤 작업에 쓸지","Which task")} value={taskId} onChange={event=>setTaskId(event.target.value)}><option value="">{copy("작업 선택","Choose a task")}</option>{tasks.map(task=><option key={task.taskId} value={task.taskId}>{task.title}</option>)}</Select></label>
        {!tasks.length&&<p>{copy("먼저 One에서 작업을 시작하면 그 작업에 화면을 연결할 수 있습니다.","Start a task in One first, then you can connect a screen to it.")}</p>}
        <label>{copy("보여줄 것","What to show")}<Select aria-label={copy("보여줄 것","What to show")} value={kind} onChange={event=>setKind(event.target.value as "window"|"display")}><option value="window">{copy("창 하나","One window")}</option><option value="display">{copy("화면 전체","Whole screen")}</option></Select></label>
        <button type="button" disabled={!oneId||!taskId||!knownTask||listing||!metadataReady} onClick={()=>void list()}>{listing?copy("불러오는 중","Loading"):kind==="display"?copy("화면 목록 불러오기","Load screen list"):copy("창 목록 불러오기","Load window list")}</button>
        {selection&&selection.targets.length===0&&<p>{copy("보여줄 수 있는 것이 없습니다. 화면 기록 권한과 열려 있는 창을 확인해 주세요.","Nothing is available to show. Check screen recording permission and open windows.")}</p>}
        {selection&&<label>{kind==="display"?copy("보여줄 화면","Screen to show"):copy("보여줄 창","Window to show")}<Select aria-label={kind==="display"?copy("보여줄 화면","Screen to show"):copy("보여줄 창","Window to show")} value={sourceId} onChange={event=>setSourceId(event.target.value)}><option value="">{copy(`${targetNoun} 선택`,`Choose a ${targetNoun}`)}</option>{selection.targets.map(item=><option key={item.sourceId} value={item.sourceId}>{item.label}</option>)}</Select></label>}
        {selection&&!targetFresh&&<p role="status">{copy("목록이 오래됐습니다. 다시 불러와 주세요.","The list is out of date. Load it again.")}</p>}
        <label>{copy("Hope가 할 수 있는 것","What Hope can do")}<Select aria-label={copy("Hope가 할 수 있는 것","What Hope can do")} value={mode} onChange={event=>setMode(event.target.value as "observe"|"interact")}><option value="observe">{copy("보기만","View only")}</option><option value="interact" disabled={!interactionReady}>{copy("보고 조작하기","View and control")}</option></Select></label>
        {target&&!target.captureAvailable&&<p role="status">{copy("화면 기록 권한이 없어 이 창을 볼 수 없습니다. 권한을 확인한 뒤 목록을 다시 불러와 주세요.","Without screen recording permission this cannot be viewed. Check permissions, then reload the list.")}</p>}
        {target&&!interactionReady&&<p>{copy("지금은 이 창을 조작할 수 없습니다. 보기만 선택할 수 있습니다.","This cannot be controlled right now. You can choose view only.")}</p>}
        {mode==="interact"&&<p>{copy("조작하기 전에 권한을 다시 확인하고, 직접 쓰는 중이면 Hope가 잠시 멈춥니다.","Hope rechecks permission before controlling, and pauses when you are using the computer.")}</p>}
        <label>{copy("시간","For how long")}<Select aria-label={copy("시간","For how long")} value={duration} onChange={event=>setDuration(Number(event.target.value))}><option value={30_000}>{copy("30초","30 seconds")}</option><option value={5*60_000}>{copy("5분","5 minutes")}</option><option value={15*60_000}>{copy("15분","15 minutes")}</option><option value={30*60_000}>{copy("30분","30 minutes")}</option></Select></label>
        <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={!target||!targetFresh}/><span>{target?copy(`'${target.label}'만, 이 작업에, 정한 시간 동안 보여줍니다.`, `Show only '${target.label}', for this task, for the time I set.`):copy(`보여줄 ${targetNoun}을 고르면 여기서 확인합니다.`,`Choose a ${targetNoun} to confirm here.`)}</span></label>
        <button type="submit" disabled={granting||!oneId||!taskId||!knownTask||!target||!targetFresh||!consent||!targetReadReady||mode==="interact"&&!interactionReady||uncertainGrant}>{copy("보여주기","Show")}</button>
      </form>
      {value?.grants.map(item=><article className={styles.grant} key={item.grantId} data-one-context-grant={item.grantId} data-state={item.state}>
        <strong>{item.target.label}</strong><span>{item.mode==="observe"?copy("보기만","View only"):copy("보고 조작하기","View and control")} · {item.state==="revoked"?copy("그만 보여줌","Stopped"):item.state==="expired"||Date.parse(item.expiresAt)<=now?copy("시간 끝남","Time ended"):copy("보여주는 중","Showing")}</span>
        <small>{copy("끝나는 시각","Ends at")}: {new Date(item.expiresAt).toLocaleTimeString(ko?"ko-KR":"en-US")}</small>
        {active.some(grant=>grant.grantId===item.grantId)&&<div className={styles.actions}><button type="button" disabled={!!capturing||!metadataReady||!item.target.captureAvailable} onClick={()=>void capture(item)}>{copy("지금 한 번 보기","View once now")}</button><button type="button" onClick={()=>void stop(item.grantId)}>{copy("이 창 그만 보여주기","Stop showing this")}</button></div>}
      </article>)}
      {latest&&<p className={styles.notice} role="status">{preview?copy("방금 본 화면","Just viewed"):copy("화면이 오래됐거나 볼 수 없습니다. 이전 화면은 지금 화면으로 쓰지 않습니다.","The screen is out of date or unavailable. An earlier view is not used as the current screen.")} · {new Date(latest.capturedAt).toLocaleTimeString(ko?"ko-KR":"en-US")}</p>}
      {preview&&<figure className={styles.preview}><img src={preview.dataUrl} alt={copy("Hope에게 보여준 화면 미리보기","Preview of the screen shown to Hope")}/><figcaption>{copy("이 창에서만 보이며 대화에 자동으로 붙지 않습니다.","Shown only here and never attached to the conversation automatically.")}</figcaption></figure>}
      {feedback&&<p role="status" className={styles.notice}>{feedback}</p>}
    </div>
  </OneBottomSheet>;
}
