"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { SupervisorTask } from "@shared/one-supervisor";
import type { OneContextGrant, OneContextSnapshot, OneContextTargetSelection } from "@shared/one-context";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./PersonalOneContext.module.css";

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
  if(unconfirmed)return copy("공유 상태 확인 필요","Sharing unconfirmed");
  if(!value)return copy("공유 상태 확인 중","Checking sharing");
  const active=activeOneContextGrants(value,now);
  if(!active.length)return value.grants.some(grant=>grant.state==="expired"||grant.state==="active"&&Date.parse(grant.expiresAt)<=now)?copy("공유 시간 만료","Sharing expired"):copy("화면 공유 꺼짐","Screen sharing off");
  if(value.readiness.session!=="awake")return copy("공유 일시 중지","Sharing paused");
  const latest=value.latest;
  const fresh=latest&&active.some(grant=>grant.grantId===latest.grantId)&&latest.state==="fresh"&&Date.parse(latest.staleAt)>now;
  return fresh?copy(`공유 · ${active[0].target.label}`,`Shared · ${active[0].target.label}`):copy(`허용됨 · ${active[0].target.label}`,`Allowed · ${active[0].target.label}`);
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
  useEffect(()=>{if(!open){++generation.current;setConsent(false);setListing(false);return;}setFeedback(null);setMode("observe");setSelection(null);setSourceId("");setTaskId(preferredTaskId&&tasks.some(task=>task.taskId===preferredTaskId)?preferredTaskId:"");void onRefresh();},[open,oneId]);
  useEffect(()=>{setConsent(false);},[taskId,kind,sourceId,mode,duration]);
  useEffect(()=>{++generation.current;setSelection(null);setSourceId("");setListing(false);},[taskId,kind]);
  const list=async()=>{
    if(!oneId||!taskId||!knownTask||listing||!metadataReady)return;const ticket=++generation.current;setListing(true);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");const result=await api.targets({oneId,taskId,kind});if(ticket!==generation.current)return;setSelection(result);setSourceId("");setConsent(false);}
    catch{if(ticket===generation.current)setFeedback(copy("선택 가능한 대상을 확인하지 못했습니다. 권한과 현재 업무를 확인하고 다시 목록을 읽어 주세요.","Available targets could not be confirmed. Check permissions and the current task, then refresh the list."));}
    finally{if(ticket===generation.current)setListing(false);}
  };
  const grant=async()=>{
    if(granting||!oneId||!taskId||!knownTask||!target||!selection||!targetFresh||Date.parse(selection.expiresAt)<=Date.now()||!consent||!targetReadReady||mode==="interact"&&!interactionReady||uncertainGrant)return;
    const epoch=stopEpoch.current;setGranting(true);setFeedback(null);setConsent(false);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await api.grant({oneId,taskId,selectionId:selection.selectionId,sourceId:target.sourceId,durationMs:duration,mode});
      // Stop also wins when a grant request was already in flight.
      if(epoch!==stopEpoch.current)await onStop();
      await onRefresh();setUncertainGrant(false);setFeedback(copy("공유 권한 요청을 처리했습니다. 아래의 현재 허용 범위를 확인하세요.","The sharing permission request was processed. Review its observed scope below."));
    }catch{setUncertainGrant(true);setFeedback(copy("공유 권한 요청 결과를 확인하지 못했습니다. 다시 허용하기 전에 현재 상태를 확인하거나 공유를 중지하세요.","The sharing permission outcome was not confirmed. Refresh current state or stop sharing before granting again."));}
    finally{setGranting(false);}
  };
  const stop=async(grantId?:string)=>{
    if(!oneId)return;setConsent(false);setStopping(true);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await onStop(grantId);await onRefresh();setUncertainGrant(false);setFeedback(copy("공유 중지를 요청했습니다. 아래에서 현재 상태를 확인하세요.","Sharing stop was requested. Check the current state below."));}
    catch{setFeedback(copy("공유 중지를 확인하지 못했습니다. 중지를 다시 요청하거나 현재 상태를 확인하세요.","Sharing stop could not be confirmed. Request stopping again or refresh the current state."));}
    finally{setStopping(false);}
  };
  const capture=async(grant:OneContextGrant)=>{
    if(!oneId||capturing||!metadataReady||grant.state!=="active"||Date.parse(grant.expiresAt)<=Date.now()||!grant.target.captureAvailable)return;setCapturing(grant.grantId);setFeedback(null);
    try{const api=ipc()?.oneContext;if(!api)throw new Error("one_context_bridge_unavailable");await api.capture({oneId,taskId:grant.taskId,grantId:grant.grantId});await onRefresh();}
    catch{setFeedback(copy("현재 대상을 읽지 못했습니다. 이전 캡처를 최신 화면으로 사용하지 않습니다.","The target could not be read. A previous capture is not treated as the current screen."));}
    finally{setCapturing(null);}
  };
  const latest=value?.latest;
  const preview=latest&&!unconfirmed&&readiness?.session==="awake"&&latest.state==="fresh"&&Date.parse(latest.staleAt)>now&&active.some(grant=>grant.grantId===latest.grantId)&&/^data:image\/(png|jpeg|webp);base64,/i.test(latest.dataUrl)?latest:null;
  return <OneBottomSheet open={open} onClose={onClose} closeLabel={copy("화면 공유 닫기","Close screen sharing")} ariaLabel={copy("공유할 화면과 허용 범위","Screen sharing scope")} title={copy("공유할 화면과 허용 범위","Screen sharing scope")} size="compact" footer={<div className={styles.root}><button type="button" className={styles.stop} aria-busy={stopping} disabled={!oneId} onClick={()=>void stop()}>{copy("모든 화면 공유 중지","Stop all screen sharing")}</button></div>}>
    <div className={styles.root}>
      <p>{copy("선택한 업무에만 지정한 창이나 화면을 한시적으로 허용합니다. 허용 자체가 화면 읽기나 입력 실행을 뜻하지 않습니다.","Allow a specific window or display for one selected task and a limited time. Permission itself does not capture the screen or operate it.")}</p>
      {unconfirmed&&<p role="status" className={styles.notice}>{copy("현재 공유 상태가 미확인입니다. 아래 중지 요청은 계속 사용할 수 있습니다.","Current sharing state is unconfirmed. The stop action below remains available.")}</p>}
      <div className={styles.readiness}>
        <strong>{copy("로컬 준비 상태","Local readiness")}</strong>
        <span>{readReady?copy("화면 읽기 준비 확인됨","Screen reading ready"):readiness?.session==="locked"?copy("컴퓨터 잠김","Computer locked"):readiness?.session==="sleeping"?copy("컴퓨터 잠자기 상태","Computer sleeping"):copy("화면 권한·연결 확인 필요","Screen permission or connection needs review")}</span>
        {readiness?.screenPermission!=="granted"&&<button type="button" onClick={()=>void ipc()?.oneContext?.openPermissions({kind:"screen"}).then(()=>setFeedback(copy("화면 권한 설정 열기를 요청했습니다. 변경 뒤 상태를 새로 확인하세요.","Screen permission settings were requested. Refresh status after making changes."))).catch(()=>setFeedback(copy("권한 설정 열기를 확인하지 못했습니다.","Opening permission settings was not confirmed.")))}>{copy("화면 권한 설정 열기","Open screen permission settings")}</button>}
        {readiness?.accessibility!=="granted"&&<button type="button" onClick={()=>void ipc()?.oneContext?.openPermissions({kind:"accessibility"}).then(()=>setFeedback(copy("입력 권한 설정 열기를 요청했습니다. 변경 뒤 상태를 새로 확인하세요.","Input permission settings were requested. Refresh status after making changes."))).catch(()=>setFeedback(copy("권한 설정 열기를 확인하지 못했습니다.","Opening permission settings was not confirmed.")))}>{copy("입력 권한 설정 열기","Open input permission settings")}</button>}
        {value?.lease.state!=="idle"&&value?.lease&&<span>{value.lease.state==="waiting"?copy("입력 실행이 현재 점유 해제를 기다립니다.","Interaction is waiting for current input ownership to be released."):copy("다른 실행이 입력을 사용 중입니다. 읽기 허용이 입력 점유 권한을 만들지는 않습니다.","An execution currently holds input access. Permission to observe does not acquire input control.")}</span>}
        {readiness?.humanBusy&&<span>{copy("사용자 입력을 관측했습니다. 입력 실행은 안전한 지점까지 대기합니다.","Owner input was observed. Interaction waits for a safe point.")}</span>}
        <button type="button" onClick={()=>void onRefresh()}>{copy("현재 상태 다시 확인","Refresh sharing status")}</button>
        {value?.observedAt&&<small>{copy("관측","Observed")}: {new Date(value.observedAt).toLocaleTimeString(ko?"ko-KR":"en-US")}</small>}
      </div>
      <form className={styles.form} onSubmit={event=>{event.preventDefault();void grant();}}>
        <label>{copy("이 맥락을 사용할 업무","Task using this context")}<select aria-label={copy("이 맥락을 사용할 업무","Task using this context")} value={taskId} onChange={event=>setTaskId(event.target.value)}><option value="">{copy("업무 선택","Choose a task")}</option>{tasks.map(task=><option key={task.taskId} value={task.taskId}>{task.title}</option>)}</select></label>
        {!tasks.length&&<p>{copy("먼저 One에서 업무를 시작한 뒤 그 업무에 화면을 연결할 수 있습니다.","Start a task in One first, then bind a screen to that task.")}</p>}
        <label>{copy("공유 대상 종류","Target type")}<select aria-label={copy("공유 대상 종류","Target type")} value={kind} onChange={event=>setKind(event.target.value as "window"|"display")}><option value="window">{copy("창 하나","One window")}</option><option value="display">{copy("화면 하나","One display")}</option></select></label>
        <button type="button" disabled={!oneId||!taskId||!knownTask||listing||!metadataReady} onClick={()=>void list()}>{listing?copy("대상 목록 확인 중","Reading target list"):copy("선택 가능한 대상 읽기","List available targets")}</button>
        {selection&&selection.targets.length===0&&<p>{copy("현재 확인된 대상이 없습니다. 권한이나 열린 창을 확인해 주세요.","No target was observed. Check permissions or open windows.")}</p>}
        {selection&&<label>{copy("허용할 정확한 대상","Exact target to allow")}<select aria-label={copy("허용할 정확한 대상","Exact target to allow")} value={sourceId} onChange={event=>setSourceId(event.target.value)}><option value="">{copy("대상 선택","Choose a target")}</option>{selection.targets.map(item=><option key={item.sourceId} value={item.sourceId}>{item.label}</option>)}</select></label>}
        {selection&&!targetFresh&&<p role="status">{copy("대상 목록의 유효 시간이 지났습니다. 현재 목록을 다시 읽어 주세요.","The target list expired. Read the current list again.")}</p>}
        <label>{copy("허용 범위","Allowed scope")}<select aria-label={copy("허용 범위","Allowed scope")} value={mode} onChange={event=>setMode(event.target.value as "observe"|"interact")}><option value="observe">{copy("선택 대상을 읽기만","Observe selected target only")}</option><option value="interact" disabled={!interactionReady}>{copy("선택 대상 읽기와 입력","Observe and operate selected target")}</option></select></label>
        {target&&!target.captureAvailable&&<p role="status">{copy("이 대상의 화면 읽기 권한을 확인하지 못했습니다. 현재 권한을 확인한 뒤 목록을 다시 읽어 주세요.","Screen reading permission for this target is unavailable. Review permissions, then refresh the target list.")}</p>}
        {target&&!interactionReady&&<p>{copy("이 대상의 입력 실행은 현재 사용할 수 없습니다. 읽기 허용은 별도로 선택할 수 있습니다.","Interaction with this target is unavailable. Observation can be allowed separately.")}</p>}
        {mode==="interact"&&<p>{copy("실제 입력 실행은 현재 권한과 입력 점유 상태를 다시 확인합니다. 사용자의 업무와 충돌하면 안전한 지점에서 멈춥니다.","Actual input execution rechecks permission and input ownership. It pauses at a safe point when it conflicts with the owner’s work.")}</p>}
        <label>{copy("허용 시간","Permission lifetime")}<select aria-label={copy("허용 시간","Permission lifetime")} value={duration} onChange={event=>setDuration(Number(event.target.value))}><option value={30_000}>{copy("30초","30 seconds")}</option><option value={5*60_000}>{copy("5분","5 minutes")}</option><option value={15*60_000}>{copy("15분","15 minutes")}</option><option value={30*60_000}>{copy("30분","30 minutes")}</option></select></label>
        <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={!target||!targetFresh}/><span>{target?copy(`'${target.label}'만 이 업무에 지정 시간 동안 허용합니다.`, `I allow only '${target.label}' for this task during the selected time.`):copy("대상과 범위를 확인한 뒤 직접 허용합니다.","I will explicitly allow the chosen target and scope.")}</span></label>
        <button type="submit" disabled={granting||!oneId||!taskId||!knownTask||!target||!targetFresh||!consent||!targetReadReady||mode==="interact"&&!interactionReady||uncertainGrant}>{copy("이 대상과 시간으로 허용","Allow this target and lifetime")}</button>
      </form>
      {value?.grants.map(item=><article className={styles.grant} key={item.grantId} data-one-context-grant={item.grantId} data-state={item.state}>
        <strong>{item.target.label}</strong><span>{item.mode==="observe"?copy("읽기만 허용","Observe only"):copy("읽기와 입력 허용","Observe and operate")} · {item.state==="revoked"?copy("공유 해제됨","Revoked"):item.state==="expired"||Date.parse(item.expiresAt)<=now?copy("허용 시간 만료","Expired"):copy("권한 허용됨","Permission active")}</span>
        <small>{copy("만료","Expires")}: {new Date(item.expiresAt).toLocaleTimeString(ko?"ko-KR":"en-US")}</small>
        {active.some(grant=>grant.grantId===item.grantId)&&<div className={styles.actions}><button type="button" disabled={!!capturing||!metadataReady||!item.target.captureAvailable} onClick={()=>void capture(item)}>{copy("이 대상 지금 한 번 읽기","Read this target once now")}</button><button type="button" onClick={()=>void stop(item.grantId)}>{copy("이 대상 공유 중지","Stop sharing this target")}</button></div>}
      </article>)}
      {latest&&<p className={styles.notice} role="status">{preview?copy("방금 관측한 화면","Fresh screen observation"):copy("화면 관측은 오래됐거나 사용할 수 없습니다. 이전 화면을 현재 입력으로 재사용하지 않습니다.","The screen observation is stale or unavailable. It is not reused as current input.")} · {new Date(latest.capturedAt).toLocaleTimeString(ko?"ko-KR":"en-US")}</p>}
      {preview&&<figure className={styles.preview}><img src={preview.dataUrl} alt={copy("직접 허용한 대상의 일시적 화면 관측","Ephemeral observation of the explicitly allowed target")}/><figcaption>{copy("이 화면에서만 표시하며 대화에 자동 첨부하지 않습니다.","Shown only in this sheet and never automatically attached to the conversation.")}</figcaption></figure>}
      {feedback&&<p role="status" className={styles.notice}>{feedback}</p>}
    </div>
  </OneBottomSheet>;
}
