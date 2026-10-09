"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { SupervisorTask } from "@shared/one-supervisor";
import { ONE_HARNESS_ACTION_REJECTION_CODES, type OneHarnessResult, type OneHarnessActionRequest, type OneArtifactSelection } from "@shared/one-harness";
import type { OneSurfaceSemanticAction } from "@shared/one-surface";
import { Markdown, type LinkedFileArtifact } from "@/components/Markdown";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OneAdaptiveResult } from "./OneAdaptiveResult";
import { personalOneResultProjection, personalOneTextSelection, samePersonalOneResult } from "@/lib/personal-one-result";
import styles from "./PersonalOneWorkspace.module.css";

export function PersonalOneTaskResult({oneId,task,requestedRunId,locale,fallbackText,visible=true,onOpenLinkedFile,onRefresh}: {
  oneId:string;task:SupervisorTask;requestedRunId?:string|null;locale:"ko"|"en";fallbackText:string|null;visible?:boolean;
  onOpenLinkedFile(reference:LinkedFileArtifact):void;onRefresh():void;
}) {
  const ko=locale==="ko";const copy=(a:string,b:string)=>ko?a:b;
  const [shown,setShown]=useState<OneHarnessResult|null>(null);
  const [candidate,setCandidate]=useState<OneHarnessResult|null>(null);
  const [problem,setProblem]=useState(false);const [loading,setLoading]=useState(false);
  const [selection,setSelection]=useState<OneArtifactSelection|null>(null);
  const [direction,setDirection]=useState("");const [sending,setSending]=useState(false);
  const [rangeBlock,setRangeBlock]=useState("");
  const [rangeRow,setRangeRow]=useState("");const [rangeColumn,setRangeColumn]=useState("");
  const [chartSeries,setChartSeries]=useState("");const [chartPoint,setChartPoint]=useState("");
  const actionKey=`agentlas.one.result.command.${oneId}.${task.taskId}`;
  const [actionStatus,setActionStatus]=useState<string|null>(null);
  const [needsResultReview,setNeedsResultReview]=useState(false);const [needsSelectionReview,setNeedsSelectionReview]=useState(false);
  const pendingAction=useRef<OneHarnessActionRequest|null>(null);
  // Editor ownership belongs to the original command, not its latest retry.
  const edits=useRef({selection:0,direction:0});
  const pendingEditor=useRef<{commandId:string;selection:number|null;direction:number|null;binding:string}|null>(null);
  const actionFlight=useRef(0);const mounted=useRef(true);
  const [,renderAction]=useState(0);
  const root=useRef<HTMLDivElement>(null);const generation=useRef(0);
  const boundRun=useRef<string|null>(requestedRunId ?? task.runId);
  const binding=useRef(`${oneId}:${task.taskId}`);
  const shownRef=useRef(shown);shownRef.current=shown;
  const editorBinding=JSON.stringify([oneId,task.taskId,task.runId,requestedRunId,boundRun.current,shown?.runId,shown?.revision,shown?.controlVersion]);
  const editorBindingRef=useRef(editorBinding);editorBindingRef.current=editorBinding;
  useEffect(()=>{++actionFlight.current;setSending(false);},[editorBinding]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++actionFlight.current;};},[]);
  const active=useRef(visible);
  const visibleRef=useRef(visible);visibleRef.current=visible;
  const view=useRef<HTMLDivElement|null>(null);const mountedViewKey=useRef<string|null>(null);
  const checkpoint=useRef<{key:string;media:Map<string,number>;details:Map<string,boolean>}|null>(null);
  const restoreGeneration=useRef(0);
  const restoreEvents=useRef(new WeakMap<HTMLMediaElement,{key:string;generation:number;artifactKey:string;time:number;pause:boolean;seek:boolean}>());
  const viewKey=shown&&shown.oneId===oneId&&shown.taskId===task.taskId?JSON.stringify([oneId,task.taskId,shown.runId,shown.revision,shown.controlVersion,shown.surface?.manifestId]):null;
  const viewKeyRef=useRef(viewKey);viewKeyRef.current=viewKey;
  const mediaKey=(element:HTMLMediaElement)=>{
    const blockId=element.closest<HTMLElement>("[data-semantic-id]")?.dataset.semanticId;
    const block=shownRef.current?.surface?.blocks.find(item=>item.blockId===blockId&&item.type==="Media");
    return block?.type==="Media"&&viewKeyRef.current?JSON.stringify([viewKeyRef.current,block.blockId,block.primaryArtifactRef]):null;
  };
  const detailsKey=(element:HTMLDetailsElement)=>{
    if(element.classList.contains(styles.rangePicker))return "range";
    const section=element.closest<HTMLElement>("[data-semantic-id]");
    return section?.dataset.semanticId&&section.querySelectorAll("details").length===1?JSON.stringify(["block",section.dataset.semanticId]):null;
  };
  const attachView=useCallback((element:HTMLDivElement|null)=>{
    if(!element&&view.current){
      ++restoreGeneration.current;
      if(!visibleRef.current&&mountedViewKey.current&&mountedViewKey.current===viewKeyRef.current){
        const saved={key:mountedViewKey.current,media:new Map<string,number>(),details:new Map<string,boolean>()};
        view.current.querySelectorAll<HTMLMediaElement>("video,audio").forEach(media=>{const key=mediaKey(media);if(key&&saved.media.size<32&&Number.isFinite(media.currentTime)&&media.currentTime>=0)saved.media.set(key,media.currentTime);media.pause();});
        view.current.querySelectorAll<HTMLDetailsElement>("details").forEach(details=>{const key=detailsKey(details);if(key&&saved.details.size<32)saved.details.set(key,details.open);});
        checkpoint.current=saved;
      }else checkpoint.current=null;
    }
    view.current=element;
  },[]);
  const restoreMedia=(element:EventTarget)=>{
    if(!(element instanceof HTMLMediaElement)||!visibleRef.current||!view.current?.contains(element)||element.readyState<1)return;
    const saved=checkpoint.current,key=mediaKey(element),generation=restoreGeneration.current;
    if(!saved||saved.key!==viewKeyRef.current||!key||!saved.media.has(key))return;
    const observed=saved.media.get(key)!;const time=Number.isFinite(element.duration)?Math.min(observed,Math.max(0,element.duration)):observed;
    const pause=!element.paused,seek=Math.abs(element.currentTime-time)>.001;
    if(pause||seek)restoreEvents.current.set(element,{key:saved.key,generation,artifactKey:key,time,pause,seek});
    if(saved.key!==viewKeyRef.current||generation!==restoreGeneration.current)return;
    element.pause();if(seek)element.currentTime=time;saved.media.delete(key);
  };
  const clearRestore=(element:EventTarget)=>{if(element instanceof HTMLMediaElement)restoreEvents.current.delete(element);};
  useLayoutEffect(()=>{
    ++restoreGeneration.current;
    if(checkpoint.current?.key!==viewKey)checkpoint.current=null;
    if(!visible||!view.current||!viewKey)return;
    mountedViewKey.current=viewKey;
    const saved=checkpoint.current;
    if(saved)view.current.querySelectorAll<HTMLDetailsElement>("details").forEach(details=>{const key=detailsKey(details);if(key&&saved.details.has(key)){details.open=saved.details.get(key)!;saved.details.delete(key);}});
    view.current.querySelectorAll<HTMLMediaElement>("video,audio").forEach(restoreMedia);
    return()=>{++restoreGeneration.current;};
  },[visible,viewKey]);
  const load=useCallback(async()=>{
    if(!visibleRef.current)return;
    const runId=boundRun.current;const api=ipc()?.oneHarness;
    if(!api || !runId){setProblem(true);return;}
    const current=++generation.current;setLoading(true);
    try{
      const result=await api.getResult({oneId,taskId:task.taskId,runId,...(runId===task.runId?{expectedVersion:task.controlVersion}:{})});
      if(current!==generation.current || !active.current)return;
      if(result.oneId!==oneId || result.taskId!==task.taskId || result.runId!==runId || result.task.id!==task.taskId || (result.receipt && result.receipt.runId!==runId))throw new Error("result_binding_mismatch");
      const prior=shownRef.current;
      if(prior && !samePersonalOneResult(prior,result))setCandidate(result);
      else {setShown(result);setCandidate(null);}
      setProblem(false);return result;
    }catch{if(current===generation.current && active.current)setProblem(true);}
    finally{if(current===generation.current && active.current)setLoading(false);}
  },[oneId,task.taskId,task.runId,task.controlVersion]);
  useEffect(()=>{
    const next=`${oneId}:${task.taskId}`;
    if(binding.current!==next){binding.current=next;boundRun.current=requestedRunId ?? task.runId;shownRef.current=null;setShown(null);setCandidate(null);edits.current={selection:0,direction:0};setSelection(null);pendingAction.current=null;pendingEditor.current=null;setActionStatus(null);setDirection("");setRangeBlock("");setNeedsResultReview(false);setNeedsSelectionReview(false);}
    if(requestedRunId&&requestedRunId!==boundRun.current){boundRun.current=requestedRunId;shownRef.current=null;setShown(null);setCandidate(null);++edits.current.selection;setSelection(null);}
    try{const raw=window.localStorage.getItem(actionKey);if(raw){const saved=JSON.parse(raw) as OneHarnessActionRequest;if(saved.oneId===oneId&&saved.taskId===task.taskId&&saved.commandId&&saved.intent==="follow-up"&&pendingAction.current?.commandId!==saved.commandId){pendingAction.current=saved;
      const restored={commandId:saved.commandId,selection:null as number|null,direction:null as number|null,binding:JSON.stringify([oneId,task.taskId,task.runId,requestedRunId,boundRun.current,saved.runId,saved.revision,saved.expectedVersion])};pendingEditor.current=restored;
      setDirection(current=>{if(current||edits.current.direction!==0)return current;restored.direction=edits.current.direction;return saved.text;});
      setSelection(current=>{if(current||edits.current.selection!==0)return current;restored.selection=edits.current.selection;return saved.selection ?? null;});setActionStatus(copy("저장된 지시의 접수 확인이 필요합니다.","The saved direction needs reception confirmation."));}}}catch{setActionStatus(copy("저장된 요청을 읽지 못했습니다.","The saved request could not be read."));}
  },[oneId,task.taskId,task.runId,requestedRunId,actionKey]);
  useEffect(()=>{
    active.current=visible;
    if(!visible){++generation.current;setLoading(false);return;}
    void load();let timer:number|null=null;
    const off=ipcEvents()?.onStoreChanged?.(()=>{if(timer===null)timer=window.setTimeout(()=>{timer=null;void load();},150);});
    return()=>{active.current=false;++generation.current;off?.();if(timer!==null)window.clearTimeout(timer);};
  },[load,requestedRunId,visible]);
  const resultActionable=(value:OneHarnessResult)=>value.state.freshness==="current"&&value.state.result!=="stale"&&value.scope.authorization==="local-owner"&&value.state.effect!=="uncertain"&&!value.task.archivedAt;
  const select=(value:OneArtifactSelection|null)=>{++edits.current.selection;setSelection(value);setNeedsSelectionReview(false);};
  const reviewBinding=async()=>{const observed=await load();if(!observed)return;const current=shownRef.current;
    if(current&&observed.runId===current.runId&&observed.revision===current.revision&&resultActionable(observed)){setNeedsResultReview(false);setActionStatus(needsSelectionReview?copy("현재 결과를 관측했습니다. 선택 범위를 다시 고르거나 해제한 뒤 요청하세요.","The current result was observed. Reselect or clear the target before sending."):copy("현재 결과 연결을 관측했습니다. 보존된 지시로 새 요청을 보낼 수 있습니다.","The current result binding was observed. The preserved direction can now be sent as a new request."));}
    else setActionStatus(copy("현재 연결이 아직 요청 가능하지 않거나 새 버전이 준비됐습니다. 새 버전·실행을 직접 선택하고 현재 결과를 확인하세요.","The current binding is unavailable or a new revision is ready. Select the new revision or run and review the current result."));
  };
  const displayedText=shown?shown.text ?? shown.surface?.fallback.markdown ?? null:boundRun.current===task.runId?fallbackText:null;
  const projection=useMemo(()=>visible&&shown?personalOneResultProjection(shown):null,[shown,visible]);
  const captureSelection=()=>{if(root.current){const selected=personalOneTextSelection(root.current,window.getSelection());if(selected)select(selected);}};
  const action=async(retry=false,semanticText?:string)=>{
    if(sending || (!retry&&(needsResultReview||needsSelectionReview)) || (!retry&&!shown) || (!retry&&pendingAction.current) || (!retry&&!(semanticText ?? direction).trim()))return;
    const api=ipc()?.oneHarness;if(!api){setProblem(true);return;}
    const request=retry?pendingAction.current:shown?{commandId:crypto.randomUUID(),oneId,taskId:shown.taskId,runId:shown.runId,expectedVersion:shown.controlVersion,revision:shown.revision,intent:"follow-up" as const,text:(semanticText ?? direction).trim(),...(shown.surface?{manifestId:shown.surface.manifestId}:{}),...(selection?{selection}:{}),...(selection?.kind==="media"?{artifactRef:selection.artifactRef}:{})}:null;
    if(!request)return;
    if(!retry)pendingEditor.current={commandId:request.commandId,...edits.current,binding:editorBindingRef.current};
    const owner=pendingEditor.current?.commandId===request.commandId?pendingEditor.current:null;
    const flight=++actionFlight.current;const attemptBinding=editorBindingRef.current;
    const currentAttempt=()=>mounted.current&&flight===actionFlight.current&&attemptBinding===editorBindingRef.current;
    pendingAction.current=request;setSending(true);setActionStatus(null);
    try{window.localStorage.setItem(actionKey,JSON.stringify(request));}catch{setSending(false);pendingAction.current=null;pendingEditor.current=null;setActionStatus(copy("요청을 안전하게 저장하지 못했습니다. 접수하지 않았습니다.","The request could not be saved safely. It was not submitted."));return;}
    try{
      const receipt=await api.action(request);
      if(receipt.commandId!==request.commandId)throw new Error("receipt_binding_mismatch");
      if(receipt.acknowledgement==="unknown"){if(currentAttempt())setActionStatus(copy("접수 결과를 확인하지 못했습니다. 같은 저장 요청으로 다시 확인할 수 있습니다.","Reception was not confirmed. Check the same saved request again."));}
      else {
        let storageIssue=false;
        try{const stored=window.localStorage.getItem(actionKey);if(stored){if(JSON.parse(stored).commandId===request.commandId)window.localStorage.removeItem(actionKey);else storageIssue=true;}}catch{storageIssue=true;}
        const ownsPending=pendingAction.current?.commandId===request.commandId;
        if(ownsPending){pendingAction.current=null;pendingEditor.current=null;if(mounted.current)renderAction(value=>value+1);}
        if(!currentAttempt()||!ownsPending){if(ownsPending&&mounted.current)onRefresh();return;}
        if(receipt.state==="failed"&&receipt.acknowledgement==="settled"&&receipt.runId===null&&ONE_HARNESS_ACTION_REJECTION_CODES.some(code=>code===receipt.reason)){
          setNeedsResultReview(true);setNeedsSelectionReview(Boolean(request.selection)&&(!owner||owner.selection===edits.current.selection));
          setActionStatus(copy("요청이 실행 전에 거절됐습니다. 지시와 선택을 보존했습니다. 현재 결과 연결을 확인하고 선택 범위를 다시 고르거나 해제하세요.","The request was rejected before dispatch. Its direction and selection were preserved. Refresh the current result binding, then reselect or clear the target."));void load();
        }else{if(owner?.binding===editorBindingRef.current){if(owner.direction===edits.current.direction)setDirection(current=>current===request.text?"":current);if(owner.selection===edits.current.selection){++edits.current.selection;setSelection(null);}}setActionStatus(receipt.state==="held"||receipt.state==="failed"?copy("요청은 접수됐지만 실행을 확인해야 합니다.","The request was received, but its execution needs review."):copy("이 결과에 대한 지시를 접수했습니다. 실제 반영은 다음 결과에서 확인합니다.","The direction for this result was received. Its application will be checked in the next result."));}
        if(storageIssue)setActionStatus(current=>`${current ?? ""} ${copy("저장된 재시도 기록은 정리하지 못했습니다. 확인된 호스트 접수 결과는 유지됩니다.","The saved retry record could not be reconciled. The confirmed host receipt still applies.")}`);
        onRefresh();}
    }catch{if(currentAttempt())setActionStatus(copy("접수를 확인하지 못했습니다. 새 요청을 만들지 않고 같은 요청을 다시 확인하세요.","Reception was not confirmed. Check the same request without creating a new one."));}
    finally{if(currentAttempt())setSending(false);}
  };
  const semantic=(item:OneSurfaceSemanticAction)=>{
    if(!item.enabled||needsResultReview||needsSelectionReview)return;
    // Every generated intent keeps the selected host run/revision and is rechecked by Main.
    const instruction=["approve_decision","reject_decision","modify_decision","snooze_decision"].includes(item.intent)?copy("이 결과와 연결된 현재 결정 요청을 확인해 주세요. 생성된 결과 카드 자체를 승인 영수증으로 사용하지 말고 One의 실제 결정 영역에서 처리할 수 있게 준비하세요.","Review the current decision bound to this result. Prepare it in One’s canonical decision area; this generated card is not an approval receipt."):item.instruction ?? item.label;
    void action(false,`${instruction}${item.targetRef?`\n${copy("대상","Target")}: ${item.targetRef}`:""}`);

  };
  const captureMedia=(element:EventTarget,type:"pause"|"seeked")=>{
    if(!(element instanceof HTMLMediaElement))return;
    let restoring=restoreEvents.current.get(element);
    if(restoring&&(restoring.key!==viewKeyRef.current||restoring.generation!==restoreGeneration.current||restoring.artifactKey!==mediaKey(element))){restoreEvents.current.delete(element);restoring=undefined;}
    if(restoring&&((type==="pause"&&restoring.pause)||(type==="seeked"&&restoring.seek&&Math.abs(element.currentTime-restoring.time)<.05))){
      restoring[type==="pause"?"pause":"seek"]=false;if(!restoring.pause&&!restoring.seek)restoreEvents.current.delete(element);return;
    }
    if(restoring&&type==="seeked")restoreEvents.current.delete(element);
    if(!visibleRef.current||!view.current?.contains(element)||!shown?.surface||!Number.isFinite(element.currentTime))return;
    const blockId=element.closest<HTMLElement>("[data-semantic-id]")?.dataset.semanticId;
    const block=shown.surface.blocks.find(item=>item.blockId===blockId&&item.type==="Media");
    if(block?.type==="Media")select({kind:"media",artifactRef:block.primaryArtifactRef,timeSeconds:element.currentTime});
  };
  if(!visible)return null;
  return <div ref={attachView} onLoadedMetadataCapture={event=>restoreMedia(event.target)} onPointerDownCapture={event=>clearRestore(event.target)} onKeyDownCapture={event=>clearRestore(event.target)} onErrorCapture={event=>clearRestore(event.target)} onEmptiedCapture={event=>clearRestore(event.target)} className={styles.resultContents} data-one-exact-result="true" data-task-id={task.taskId} data-run-id={shown?.runId ?? boundRun.current ?? ""} data-result-revision={shown?.revision ?? ""}>
    {loading&&!shown&&<p role="status">{copy("이 실행의 결과를 확인하고 있습니다.","Checking the result of this run.")}</p>}
    {problem&&<p role="status" className={styles.feedback}>{copy("최신 결과 연결을 확인하지 못했습니다. 확인된 응답과 파일만 표시합니다.","The current result binding was not confirmed. Only the observed response and files are shown.")} <button type="button" onClick={()=>void load()}>{copy("다시 확인","Check again")}</button></p>}
    {boundRun.current!==task.runId&&<p role="status" className={styles.feedback}>{copy("이 작업은 새 실행으로 이어졌습니다. 지금 보는 결과는 이전 실행의 것입니다.","This task continued in a new run. The displayed result belongs to the previous run.")}<button type="button" onClick={()=>{boundRun.current=task.runId;shownRef.current=null;setShown(null);setCandidate(null);select(null);setNeedsResultReview(true);void load().then(value=>{if(value&&active.current&&value.runId===boundRun.current)setNeedsResultReview(!resultActionable(value));});}}>{copy("새 실행 보기","View new run")}</button></p>}
    {candidate&&<p role="status" className={styles.feedback}>{copy("새 결과 버전이 준비되었습니다.","A new result revision is available.")} <button type="button" onClick={()=>{setShown(candidate);setCandidate(null);select(null);setNeedsResultReview(!resultActionable(candidate));}}>{copy("새 버전 보기","View new revision")}</button></p>}
    {shown&&<div className={styles.resultState}><span>{shown.scope.label}</span><span>{shown.state.result==="partial"?copy("부분 결과","Partial result"):shown.state.result==="stale"||shown.state.freshness==="stale"?copy("이전 관측","Previous observation"):shown.state.result==="ready"?copy("결과 준비","Result ready"):copy("결과 확인 중","Checking result")}</span><small>{new Date(shown.observedAt).toLocaleTimeString()}</small></div>}
    {shown?.effect.state!=="settled"&&shown&&<p role="status" className={styles.feedback}>{shown.effect.state==="uncertain"?copy("외부 실행 결과를 아직 확인하지 못했습니다. 재실행 전에 결과 관측이 필요합니다.","The external outcome has not been confirmed. Observe it before repeating the action."):copy("외부 실행 결과를 확인하고 있습니다.","Checking the external outcome.")}</p>}
    <div ref={root} onMouseUp={captureSelection} onKeyUp={captureSelection} onSeekedCapture={event=>captureMedia(event.target,"seeked")} onPauseCapture={event=>captureMedia(event.target,"pause")}>
      {displayedText&&<ErrorBoundary resetKey={`text:${shown?.revision ?? boundRun.current}`}><Markdown text={displayedText} messageId={`one-result:${task.taskId}:${shown?.runId ?? boundRun.current}`} chatId={shown?.task.originChatId ?? task.chatId ?? undefined} onOpenLinkedFile={onOpenLinkedFile} uiActionsDisabled={sending||!!pendingAction.current||!shown||needsResultReview||needsSelectionReview} onUiFollowup={prompt=>{if(!shown||sending||pendingAction.current||needsResultReview||needsSelectionReview)return false;void action(false,prompt);return true;}}/></ErrorBoundary>}
      {shown?.surface&&projection&&<ErrorBoundary resetKey={shown.revision}><OneAdaptiveResult manifest={shown.surface} projection={projection} receipt={shown.receipt} locale={locale} omitNarrative onSemanticAction={sending||pendingAction.current||needsResultReview||needsSelectionReview?undefined:semantic} inOutputRail/></ErrorBoundary>}
    </div>
    {!shown&&pendingAction.current&&<button type="button" disabled={sending} onClick={()=>void action(true)}>{copy("저장된 요청 접수 확인","Check saved request reception")}</button>}
    {shown&&<form className={styles.resultDirection} onSubmit={event=>{event.preventDefault();void action();}}>
      {(shown.surface?.blocks.some(block=>block.type==="Table")||shown.charts.length>0)&&<details className={styles.rangePicker}><summary>{copy("표·차트 범위 선택","Select a table or chart range")}</summary>
        <label>{copy("대상 결과","Result target")}<select aria-label={copy("대상 결과","Result target")} value={rangeBlock} onChange={event=>{setRangeBlock(event.target.value);setRangeRow("");setRangeColumn("");setChartSeries("");setChartPoint("");}}><option value="">{copy("대상 선택","Choose target")}</option>{shown.surface?.blocks.filter(block=>block.type==="Table").map(block=><option key={block.blockId} value={block.blockId}>{block.title}</option>)}{shown.charts.map(chart=><option key={chart.blockId} value={chart.blockId}>{chart.title}</option>)}</select></label>
        {shown.surface?.blocks.flatMap(block=>block.type==="Table"&&block.blockId===rangeBlock?[<div key={block.blockId} className={styles.rangeFields}><label>{copy("행","Row")}<select aria-label={copy("행","Row")} value={rangeRow} onChange={event=>setRangeRow(event.target.value)}><option value="">{copy("전체 행","All rows")}</option>{block.rows.map((row,index)=><option key={row.rowId} value={row.rowId}>{index+1}: {String(row.cells[0]?.value ?? row.rowId).slice(0,60)}</option>)}</select></label><label>{copy("열","Column")}<select aria-label={copy("열","Column")} value={rangeColumn} onChange={event=>setRangeColumn(event.target.value)}><option value="">{copy("전체 열","All columns")}</option>{block.columns.map(column=><option key={column.columnId} value={column.columnId}>{column.label}</option>)}</select></label><button type="button" disabled={!block.rows.length||!block.columns.length||!rangeRow&&block.rows.length>200||!rangeColumn&&block.columns.length>200} onClick={()=>select({kind:"table",blockId:block.blockId,rowIds:rangeRow?[rangeRow]:block.rows.map(row=>row.rowId),columnIds:rangeColumn?[rangeColumn]:block.columns.map(column=>column.columnId)})}>{copy("이 범위 선택","Select this range")}</button></div>]:[])}
        {shown.charts.filter(chart=>chart.blockId===rangeBlock).map(chart=><div key={chart.blockId} className={styles.rangeFields}><label>{copy("계열","Series")}<select aria-label={copy("계열","Series")} value={chartSeries} onChange={event=>{setChartSeries(event.target.value);setChartPoint("");}}><option value="">{copy("전체 차트","Whole chart")}</option>{chart.series.map(series=><option key={series.seriesId} value={series.seriesId}>{series.label}</option>)}</select></label>{chartSeries&&<label>{copy("데이터 지점 (1부터)","Data point (starting at 1)")}<input type="number" min={1} max={chart.series.find(series=>series.seriesId===chartSeries)?.pointCount} value={chartPoint} onChange={event=>setChartPoint(event.target.value)} placeholder={copy("계열 전체","Entire series")}/></label>}<button type="button" disabled={!!chartPoint&&(!Number.isInteger(Number(chartPoint))||Number(chartPoint)<1||Number(chartPoint)>(chart.series.find(series=>series.seriesId===chartSeries)?.pointCount ?? 0))} onClick={()=>select({kind:"chart",blockId:chart.blockId,...(chartSeries?{seriesId:chartSeries}:{}),...(chartPoint?{pointIndex:Number(chartPoint)-1}:{})})}>{copy("이 범위 선택","Select this range")}</button></div>)}
      </details>}
      {shown.surface?.blocks.filter(block=>block.type==="Media").map(block=>block.type==="Media"&&<label key={block.blockId}>{copy(`${block.title} · 수정할 시각 (초)`,`${block.title} · Edit time (seconds)`)}<input type="number" min={0} max={block.durationSeconds} step={0.1} placeholder="0" onChange={event=>{const value=Number(event.target.value);if(event.target.value&&Number.isFinite(value)&&value>=0&&(block.durationSeconds===undefined||value<=block.durationSeconds))select({kind:"media",artifactRef:block.primaryArtifactRef,timeSeconds:value});}}/></label>)}
      {selection&&<div className={styles.selectionChip}><span>{selection.kind==="text"?copy(`선택 문단: ${selection.text.slice(0,80)}`,`Selected text: ${selection.text.slice(0,80)}`):selection.kind==="media"?copy(`영상·음성 ${selection.timeSeconds.toFixed(1)}초`,`Media ${selection.timeSeconds.toFixed(1)}s`):copy("선택 범위","Selected range")}</span><button type="button" onClick={()=>select(null)} aria-label={copy("선택 해제","Clear selection")}>×</button></div>}
      <label>{copy("이 결과에 대한 지시","Direction for this result")}<textarea value={direction} onChange={event=>{++edits.current.direction;setDirection(event.target.value);}} maxLength={4000} rows={2} placeholder={copy("선택한 부분을 고치거나 다음 작업을 요청하세요.","Revise the selection or request the next step.")}/></label>
      <button type="submit" disabled={sending||!direction.trim()||!!pendingAction.current||needsResultReview||needsSelectionReview}>{copy("이 결과에 적용 요청","Request revision")}</button>
      {pendingAction.current&&<button type="button" disabled={sending} onClick={()=>void action(true)}>{copy("같은 요청 접수 확인","Check the same request")}</button>}
      {needsResultReview&&<button type="button" disabled={loading} onClick={()=>void reviewBinding()}>{copy("현재 결과 연결 다시 확인","Refresh current result binding")}</button>}
      {needsSelectionReview&&<p role="status">{copy("선택 범위를 다시 고르거나 해제한 뒤 요청할 수 있습니다.","Reselect or clear the target before sending a new request.")}</p>}
      {actionStatus&&<p role="status" className={styles.feedback}>{actionStatus}</p>}
    </form>}
  </div>;
}
