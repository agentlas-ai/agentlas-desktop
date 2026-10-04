"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { Markdown, type LinkedFileArtifact } from "@/components/Markdown";
import { IconArrowUp, IconBrain, IconCheck, IconChevronRight, IconClose, IconLayers, IconPanelRight, IconPlus, IconRefresh, IconSettings, IconSparkles } from "@/components/Icon";
import type { OneSupervisorSnapshot, SupervisorCommandReceipt, SupervisorTask, SupervisorDelegation } from "../../../shared/one-supervisor";
import { ONE_BUBBLE_COLORS, type OneBubbleColor, type OneProfile } from "../../../shared/one-profile";
import { readStoredRuntimeSelection } from '@shared/runtime-selection';
import { stripAgentControlBlocks, stripAgentIdentityBadges, stripAgentRoutingBanners } from "../../../shared/agent-control-blocks";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneBottomSheet } from "./OneBottomSheet";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneAgentPortrait } from "./OneAgentPortrait";
import type { OneMemoryState } from "@/lib/types";
import { SupervisorOutbox, type PendingSupervisorWrite, type SupervisorWrite } from "@/lib/one-supervisor-outbox";
import { personalOneTranscript } from "@/lib/personal-one-transcript";
import { usePersonalOneReply } from "@/lib/use-personal-one-reply";
import { personalOneFile, type PersonalOneFile } from "@/lib/personal-one-file-preview";
import { TaskSidePanel } from "@/components/workspace/TaskSidePanel";
import { linkedLocalFileItem } from "@/lib/linked-local-file";
import { requestChatFileOpen } from "@/lib/chat-files";
import { ComposerDecisionSlot } from "@/components/ComposerDecisionPortal";
import { ToolApprovalInline } from "@/components/ToolApprovalInline";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import { bindAgentScreenScope } from "@/lib/agent-screen-scope";
import styles from "./PersonalOneWorkspace.module.css";

const visibleAnswer=(text:string)=>stripAgentRoutingBanners(stripAgentIdentityBadges(stripAgentControlBlocks(text,{streaming:true}))).trim();
const terminal=(state:string)=>["completed","cancelled","failed","interrupted"].includes(state);
function storedOnePermission():'read'|'write'|'full' {
  // Match the existing One product default and honor a narrower saved choice.
  // Reading this preference never changes a grant, setting, or goal authority.
  if(typeof window==='undefined')return 'full';
  try{const value=window.localStorage.getItem('agentlas.one.permission-mode.v1');return value==='auto'?'read':value==='read'||value==='write'||value==='full'?value:'full';}catch{return 'read';}
}
function storedOneRuntime() {
  if(typeof window==='undefined')return null;
  try{return readStoredRuntimeSelection(JSON.parse(window.localStorage.getItem('agentlas.one.runtime-selection.v1') ?? 'null'),{source:undefined,role:'orchestrator',inherit:false});}catch{return null;}
}
export function PersonalOneWorkspace() {
  const router=useRouter(); const {locale}=useT(); const ko=locale==="ko"; const copy=(a:string,b:string)=>ko?a:b;
  const [snapshot,setSnapshot]=useState<OneSupervisorSnapshot|null>(null);
  const [text,setText]=useState(""); const [work,setWork]=useState(""); const [permission,setPermission]=useState<"read"|"write"|"full">(storedOnePermission);
  const [scienceProject,setScienceProject]=useState(""); const [selected,setSelected]=useState<string|null>(null); const [direction,setDirection]=useState("");
  const [error,setError]=useState(false); const [receipt,setReceipt]=useState<SupervisorCommandReceipt|null>(null);
  const [workPending,setWorkPending]=useState(false); const [controlPending,setControlPending]=useState(false); const [tasksOpen,setTasksOpen]=useState(false);
  const [taskPreviewOnly,setTaskPreviewOnly]=useState(false); const [selectedHandoff,setSelectedHandoff]=useState<string|null>(null); const [file,setFile]=useState<PersonalOneFile|null>(null);
  const [panelWidth,setPanelWidth]=useState(360);
  const [viewportWidth,setViewportWidth]=useState(()=>typeof window==='undefined'?1360:window.innerWidth);
  const [composerHeight,setComposerHeight]=useState(96);
  const composerDock=useRef<HTMLDivElement>(null);
  useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useLayoutEffect(()=>{const element=composerDock.current;if(!element)return;const measure=()=>setComposerHeight(element.getBoundingClientRect().height);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  const panelMaxWidth=Math.max(280,Math.min(800,viewportWidth-218-360));
  const [appearanceOpen,setAppearanceOpen]=useState(false); const [profile,setProfile]=useState<OneProfile|null>(null); const [profileName,setProfileName]=useState("");
  const [bubbleColor,setBubbleColor]=useState<OneBubbleColor>("blue"); const [savingProfile,setSavingProfile]=useState(false);
  const [profileError,setProfileError]=useState(false);
  const [memoryOpen,setMemoryOpen]=useState(false); const [memory,setMemory]=useState<OneMemoryState|null>(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [plusOpen,setPlusOpen]=useState(false); const plusMenu=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!plusOpen)return;
    const outside=(event:PointerEvent)=>{if(!plusMenu.current?.contains(event.target as Node))setPlusOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setPlusOpen(false);};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[plusOpen]);
  const [dismissedKeyRun,setDismissedKeyRun]=useState<string|null>(null);
  const closeMemory=useCallback(()=>setMemoryOpen(false),[]);
  const [savedRequests,setSavedRequests]=useState<PendingSupervisorWrite[]>([]);
  const [optimistic,setOptimistic]=useState<Array<{commandId:string;text:string;acknowledged:boolean}>>([]);
  const outbox=useRef<SupervisorOutbox|null>(null); const outboxOneId=useRef<string|null>(null); const inFlight=useRef(new Set<string>());
  const mounted=useRef(true); const generation=useRef(0); const refreshing=useRef(false); const transcript=useRef<HTMLDivElement>(null); const nearBottom=useRef(true);
  const sync=useCallback(async()=>{
    if(refreshing.current)return;refreshing.current=true;const current=++generation.current;
    try {
      const api=ipc()?.oneSupervisor;if(!api)throw new Error("desktop_unavailable");
      const value=await api.snapshot();if(!mounted.current || current!==generation.current)return;
      if(outboxOneId.current!==value.oneId){outbox.current=new SupervisorOutbox(value.oneId,window.localStorage);outboxOneId.current=value.oneId;setOptimistic([]);}
      outbox.current!.reconcile(value.requests);setSavedRequests(outbox.current!.list());setSnapshot(value);setError(false);
      const visible=new Set(value.messages.map(message=>message.id));
      const observed=new Set(value.turns?.filter(turn=>visible.has(turn.userMessageId)).map(turn=>turn.commandId));
      setOptimistic(prior=>prior.filter(item=>!observed.has(item.commandId)));
    } catch {if(mounted.current)setError(true);}finally{refreshing.current=false;}
  },[]);
  useEffect(()=>{
    mounted.current=true;void sync();const off=ipcEvents()?.onStoreChanged?.(()=>{void sync();});
    const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void sync();},5000);const focus=()=>{void sync();};window.addEventListener("focus",focus);
    return()=>{mounted.current=false;++generation.current;window.clearInterval(timer);off?.();window.removeEventListener("focus",focus);};
  },[sync]);
  const activeReply=snapshot?.requests.find(item=>item.kind==="reply" && ["dispatching","accepted"].includes(item.state));
  useLayoutEffect(()=>bindAgentScreenScope(snapshot?.conversationChatId ?? null),[snapshot?.conversationChatId]);
  const live=usePersonalOneReply(snapshot?.conversationChatId,activeReply?.runId ?? undefined,sync);
  useEffect(()=>{if(nearBottom.current)transcript.current?.scrollTo({top:transcript.current.scrollHeight});},[snapshot?.messages,optimistic,live?.text]);
  const navigateRail=(mode:"organisation"|"sessions"|"mail")=>{try{window.localStorage.setItem("agentlas.one.railMode",mode);}catch{}router.push("/one");};
  const showReceipt=(value:SupervisorCommandReceipt)=>setReceipt(value);
  const write=async(method:SupervisorWrite,input:Record<string,unknown>)=>{
    if(!outbox.current)throw new Error("identity_unavailable");const intent=outbox.current.prepare(method,input);setSavedRequests(outbox.current.list());
    const value=await outbox.current.deliver(ipc()!.oneSupervisor,intent);setSavedRequests(outbox.current.list());return value;
  };
  const send=async()=>{
    const message=text.trim();if(!message || !outbox.current)return;let intent:PendingSupervisorWrite;
    try{const runtimeSelection=storedOneRuntime();intent=outbox.current.prepare("send",{text:message,permissions:permission,...(runtimeSelection?{runtimeSelection}:{})});}catch{setError(true);return;}
    if(inFlight.current.has(intent.commandId))return;inFlight.current.add(intent.commandId);setSavedRequests(outbox.current.list());setText("");nearBottom.current=true;
    setOptimistic(prior=>prior.some(item=>item.commandId===intent.commandId)?prior:[...prior,{commandId:intent.commandId,text:message,acknowledged:false}]);
    try{const value=await outbox.current.deliver(ipc()!.oneSupervisor,intent);if(!mounted.current)return;setSavedRequests(outbox.current.list());showReceipt(value);
      setOptimistic(prior=>prior.map(item=>item.commandId===intent.commandId?{...item,acknowledged:true}:item));void sync();
    }catch{if(mounted.current)setError(true);}finally{inFlight.current.delete(intent.commandId);}
  };
  const startWork=async(science=false)=>{
    if(!work.trim()||workPending||science&&!scienceProject)return;setWorkPending(true);
    try{showReceipt(await write(science?"startScience":"startWork",{text:work.trim(),...(science?{projectId:scienceProject}:{permissions:permission})}));setWork("");void sync();}
    catch{setError(true);}finally{setWorkPending(false);}
  };
  const control=async(task:SupervisorTask,action:"steer"|"cancel")=>{
    if(controlPending)return;setControlPending(true);
    try{showReceipt(await write("control",{taskId:task.taskId,expectedVersion:task.controlVersion,action,...(action==="steer"?{text:direction.trim()}: {})}));setDirection("");void sync();}
    catch{setError(true);void sync();}finally{setControlPending(false);}
  };
  const appearance=async()=>{setProfileError(false);setAppearanceOpen(true);try{const value=await ipc()!.oneProfile.get();setProfile(value);setProfileName(value.displayName);setBubbleColor(value.bubbleColor ?? "blue");}catch{setProfileError(true);}};
  const saveAppearance=async()=>{
    if(!profile||savingProfile)return;setSavingProfile(true);
    try{const value=await write('appearance',{oneId:profile.oneId,expectedVersion:profile.version,displayName:profileName,bubbleColor});showReceipt(value);
      if(value.state==='completed')setAppearanceOpen(false);else {setProfileError(true);setProfile(await ipc()!.oneProfile.get());}void sync();}
    catch{setProfileError(true);}finally{setSavingProfile(false);}
  };
  const openMemory=async()=>{setMemoryOpen(true);try{setMemory(await ipc()!.oneMemory.getState());}catch{setError(true);}};
  const openFile=useCallback((reference:LinkedFileArtifact,chatId:string)=>{try{setFile(personalOneFile(reference,chatId));setTasksOpen(false);}catch{setError(true);}},[]);
  const task=snapshot?.tasks.find(item=>item.taskId===selected);const name=snapshot?.displayName||"One";
  const panelChatId=file?.chatId ?? (tasksOpen&&taskPreviewOnly&&task ? task.chatId : snapshot?.conversationChatId) ?? null;
  useEffect(()=>{
    if(!file || file.chatId!==panelChatId)return;
    const linked=linkedLocalFileItem({path:file.path,name:file.name},file.chatId);
    if(!linked){setError(true);return;}
    let current=true;
    // TaskSidePanel installs its exact-chat listeners before this effect runs.
    // Reuse the same file tab and Main-authorized reads as One and Work.
    if(linked.textPath){
      void ipc()?.fs.readTextFile(linked.textPath,{kind:'chat-assets',chatId:file.chatId}).then(preview=>{
        if(!current)return;
        const available=preview&&!['missing','denied','error','not-read'].includes(preview.reason ?? '');
        requestChatFileOpen({...linked.item,size:preview?.size ?? 0,viewer:{...linked.item.viewer,content:available?preview.content:'',truncated:preview?.truncated ?? false,size:preview?.size ?? 0,available:!!available,reason:available?undefined:'not-read'}});
      }).catch(()=>{if(current)requestChatFileOpen({...linked.item,viewer:{...linked.item.viewer,available:false,reason:'not-read'}});});
    }else requestChatFileOpen(linked.item);
    return()=>{current=false;};
  },[file,panelChatId]);
  const handoff=snapshot?.delegations?.find(item=>item.commandId===selectedHandoff);
  const exactResult=task?.result && (!handoff || handoff.runId===task.runId) ? task.result : null;
  const openTask=(taskId:string|null,handoffId:string|null=null)=>{setSelected(taskId);setSelectedHandoff(handoffId);setTasksOpen(true);setTaskPreviewOnly(true);setFile(null);};
  const taskRoute=(item:SupervisorTask)=>item.surface==='science'?'/science':item.surface==='one'?'/one?chat='+encodeURIComponent(item.chatId!):'/workspace/task?id='+encodeURIComponent(item.chatId!);
  const stateLabel=(state:string)=>({stored:copy("접수됨","Received"),dispatching:copy("시작 중","Starting"),accepted:copy("진행 중","In progress"),running:copy("진행 중","In progress"),queued:copy("대기 중","Queued"),cancelling:copy("정리 중","Stopping"),cancelled:copy("취소됨","Cancelled"),completed:copy("완료","Completed"),failed:copy("확인 필요","Needs review"),held:copy("실행 확인 필요","Checking execution"),interrupted:copy("중단됨","Interrupted"),paused:copy("일시 정지","Paused")} as Record<string,string>)[state] ?? copy("진행 중","In progress"); // an internal state name (waiting_tool…) is never shown
  const receiptCopy=(value:SupervisorCommandReceipt)=>value.reason==="supervisor_task_version_conflict"||value.reason==="supervisor_reply_target_stale"||value.reason==="supervisor_profile_version_conflict"
    ?copy("상태가 바뀌었습니다. 최신 상태를 확인해 주세요.","The state changed. Review the latest observation.")
    :value.state==="held"?copy("요청은 저장되었습니다. 실행 결과를 확인해야 합니다.","The request is saved. Its execution outcome needs confirmation.")
    :value.kind==="appearance"?copy("설정을 저장했습니다.","Settings saved.")
    :value.kind==="steer"&&value.reason==="applied_in_next_run"?copy("지시가 작업의 다음 실행에 들어갔습니다.","The direction went into the task's next run.")
    :value.kind==="steer"&&value.reason==="steer_withdrawn"?copy("이 지시는 실행 전에 거둬졌습니다.","This direction was withdrawn before it ran.")
    :value.kind==="steer"?copy("이 작업의 다음 지시로 접수했습니다.","Saved as the next direction for this task.")
    :value.kind==="cancel"||value.kind==="stop-reply"?terminal(value.state)?stateLabel(value.state):copy("중지를 요청했습니다. 실행 정리를 기다립니다.","Stop requested. Waiting for execution to settle.")
    :copy("작업을 맡겼습니다. 여기서 대화를 이어갈 수 있습니다.","Task handed off. You can keep talking here.");
  // A hand-off reads as a link to the session One opened (owner 2026-10-04: icons, no filler text).
  const delegation=(item:SupervisorDelegation)=>{
    const owned=snapshot?.tasks.find(task=>task.taskId===item.taskId); const state=owned?.state ?? item.state;
    return <button key={item.commandId} type="button" className={styles.delegation} data-handoff-command={item.commandId} data-state={state} data-hover="own" onClick={()=>openTask(item.taskId,item.commandId)}>
      <span className={styles.delegationIcon} aria-hidden="true">{item.surface==='science'?<IconSparkles size={15}/>:<IconLayers size={15}/>}</span>
      <span className={styles.delegationCopy}><strong>{item.title}</strong><small>{item.surface==='science'?'Science':'Work'} · {stateLabel(state)}</small></span>
      <span className={styles.delegationMeta} aria-hidden="true">{state==="completed"&&<IconCheck size={14}/>}<IconChevronRight size={14}/></span>
    </button>;
  };
  const observedCommands=new Set(snapshot?.turns?.filter(turn=>snapshot.messages.some(message=>message.id===turn.userMessageId)).map(turn=>turn.commandId));
  const pendingMessages=[...optimistic,...savedRequests.filter(intent=>intent.method==="send"&&!observedCommands.has(intent.commandId)&&!optimistic.some(item=>item.commandId===intent.commandId)).map(intent=>({commandId:intent.commandId,text:String(intent.input.text),acknowledged:false}))];
  return <div className={styles.root} data-personal-one-workspace="true" style={{"--personal-bubble":ONE_BUBBLE_COLORS[snapshot?.bubbleColor ?? "blue"]} as CSSProperties}>
    <aside className={styles.navigation} aria-label={copy("One 탐색","One navigation")}>
      <div className="titlebar-drag" style={{height:28}}/><ProductModeMenu current="one" locale={ko?"ko":"en"}/>
      <button className={styles.personalEntry} data-personal-one-entry="true" aria-current="page"><OneAgentPortrait label={name} status="quiet" size="small" tone={snapshot?.avatarIcon ?? "character:orange-dino"}/><span className={styles.personalIdentity}><strong>{name}</strong><small>{copy("개인 에이전트","Personal agent")}</small></span></button>
      <nav className={styles.tabs}><button onClick={()=>navigateRail("organisation")}>Agents</button><button onClick={()=>navigateRail("sessions")}>Session</button><button onClick={()=>navigateRail("mail")}>Mail</button></nav>
      <div className={styles.navigationLinks}><button onClick={()=>void appearance()}><IconSettings size={16}/>{copy("이름과 말풍선","Name and bubbles")}</button><button onClick={()=>void openMemory()}><IconBrain size={16}/>{copy("메모리","Memory")}</button><button onClick={()=>setHistoryOpen(true)}>{copy("지난 One 대화","Previous One conversations")}</button><button onClick={()=>navigateRail("sessions")}>{copy("세션 및 One 기능","Sessions and One features")}</button></div>
      <p className={styles.localLabel}>{copy("이 컴퓨터에서 실행","Runs on this computer")}</p>
    </aside>
    <main className={styles.conversation}>
      <header className={styles.header}><h1>{name}</h1><div><button className={styles.iconButton} aria-label={copy("새로고침","Refresh")} title={copy("새로고침","Refresh")} onClick={()=>void sync()}><IconRefresh size={17}/></button><button className={styles.iconButton} aria-label={copy("One 설정","One appearance")} onClick={()=>void appearance()}><IconSettings size={17}/></button><button className={styles.iconButton} aria-label={copy("One 메모리","One memory")} onClick={()=>void openMemory()}><IconBrain size={17}/></button><button aria-label={copy("작업 열기","Open tasks")} aria-expanded={tasksOpen} onClick={()=>{setTasksOpen(value=>!value);setTaskPreviewOnly(false);setSelectedHandoff(null);setFile(null);}}><IconPanelRight size={17}/><span>{copy("작업","Tasks")}</span></button></div></header>
      <div ref={transcript} className={styles.transcript} onScroll={event=>{const element=event.currentTarget;nearBottom.current=element.scrollHeight-element.scrollTop-element.clientHeight<100;}} aria-live="polite">
        <div className={styles.thread}>
          {!snapshot?.messages.length&&!pendingMessages.length&&<div className={styles.empty}><h2>{copy("무엇을 함께 할까요?","What shall we work on?")}</h2></div>}
          {personalOneTranscript((snapshot?.messages ?? []).filter(message=>message.role!=="system"),snapshot?.turns ?? []).map(({message,turn,answer})=><div className={styles.turn} key={message.id} data-command-id={turn?.commandId}>
            <article className={styles.bubble} data-role={message.role}><Markdown text={message.role==="assistant"?visibleAnswer(message.text):message.text} messageId={message.id} chatId={snapshot?.conversationChatId} onOpenLinkedFile={reference=>openFile(reference,snapshot!.conversationChatId)}/></article>
            {answer&&<article className={styles.bubble} data-role="assistant" data-run-id={turn?.runId}><Markdown text={visibleAnswer(answer.text)} messageId={answer.id} chatId={snapshot?.conversationChatId} onOpenLinkedFile={reference=>openFile(reference,snapshot!.conversationChatId)}/></article>}
            {!answer&&live&&turn&&live.runId===turn.runId&&live.text&&<article className={styles.bubble} data-role="assistant" data-run-id={turn.runId}><Markdown text={visibleAnswer(live.text)} messageId={"live:"+turn.runId} chatId={snapshot?.conversationChatId} onOpenLinkedFile={reference=>openFile(reference,snapshot!.conversationChatId)}/></article>}
            {turn&&snapshot?.delegations?.filter(item=>item.originReplyRunId===turn.runId).map(delegation)}
            {/* Owner 2026-10-04: no activity log under a reply ("이런건 없어도 되는"). While One answers, three dots. */}
            {turn&&!answer&&!terminal(turn.state)&&(turn.state==="stored"
              ?<p className={styles.delivery}>{copy("대기 중","Queued")}</p>
              :!(live&&live.runId===turn.runId&&live.text)&&<div className={styles.typing} role="status" aria-label={copy("답하는 중","Answering")}><span/><span/><span/></div>)}
          </div>)}
          {pendingMessages.map(message=><div className={styles.turn} key={message.commandId} data-optimistic-message={message.commandId}><article className={styles.bubble} data-role="user"><Markdown text={message.text} messageId={message.commandId}/></article><p className={styles.delivery}>{message.acknowledged?copy("접수됨","Received"):copy("접수 확인 중","Confirming reception")}</p></div>)}
          {snapshot?.delegations?.filter(item=>!item.originReplyRunId || !snapshot.turns?.some(turn=>turn.runId===item.originReplyRunId)).map(delegation)}
        </div>
      </div>
      <div ref={composerDock} className={styles.composerDock}>
        <div className={styles.decisionStack}>
          <ComposerDecisionSlot surface="one" />
          {/* Only Main's exact pending requests may authorize an action. A current
              local permission selection must not resolve a previous run's card. */}
          <ToolApprovalInline chatId={snapshot?.conversationChatId} compact chip composerWidth={736} />
        </div>
        {error&&<p role="status" className={styles.feedback}>{copy("접수를 확인할 수 없습니다. 저장된 요청과 연결 상태를 확인해 주세요.","Reception could not be confirmed. Review the saved request and connection.")}</p>}
        {savedRequests.filter(intent=>!inFlight.current.has(intent.commandId)).map(intent=><button className={styles.retry} key={intent.commandId} onClick={()=>void outbox.current!.deliver(ipc()!.oneSupervisor,intent).then(value=>{showReceipt(value);setSavedRequests(outbox.current!.list());void sync();}).catch(()=>setError(true))}>{copy("같은 저장 요청 다시 확인","Retry the same saved request")} · {intent.method}</button>)}
        <form className={styles.composer} onSubmit={event=>{event.preventDefault();void send();}}>
          <div ref={plusMenu} className={styles.plus}>
            <button type="button" className={styles.iconButton} aria-label={copy("추가","Add")} aria-haspopup="menu" aria-expanded={plusOpen} data-hover="own" onClick={()=>setPlusOpen(value=>!value)}><IconPlus size={19}/></button>
            {plusOpen&&<div className={styles.plusMenu} role="menu" aria-label={copy("추가","Add")}>
              <div className={styles.plusSection}>{copy("맡기기","Hand off")}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);setTasksOpen(true);setTaskPreviewOnly(false);setSelected(null);setFile(null);}}><span className={styles.plusIcon}><IconLayers size={15}/></span><strong>{copy("Work에 맡기기","Hand to Work")}</strong></button>
              {!!snapshot?.scienceProjects?.length&&<button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);setTasksOpen(true);setTaskPreviewOnly(false);setSelected(null);setFile(null);}}><span className={styles.plusIcon}><IconSparkles size={15}/></span><strong>{copy("Science에 맡기기","Hand to Science")}</strong></button>}
              <div className={styles.plusDivider}/>
              <div className={styles.plusSection}>{name}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void openMemory();}}><span className={styles.plusIcon}><IconBrain size={15}/></span><strong>{copy("메모리","Memory")}</strong></button>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void appearance();}}><span className={styles.plusIcon}><IconSettings size={15}/></span><strong>{copy("이름과 말풍선","Name and bubbles")}</strong></button>
            </div>}
          </div>
          <textarea aria-label={ko?name+"에게 메시지":"Message "+name} value={text} onChange={event=>{setText(event.target.value);event.currentTarget.style.height="auto";event.currentTarget.style.height=Math.min(140,event.currentTarget.scrollHeight)+"px";}} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}} maxLength={8000} rows={1} placeholder={copy("메시지 보내기","Send a message")}/>
          <button className={styles.send} type="submit" aria-label={copy("보내기","Send")} disabled={!snapshot||!text.trim()}><IconArrowUp size={18}/></button>
        </form>
        {activeReply?.runId&&<button className={styles.stopReply} onClick={()=>void write("stopReply",{runId:activeReply.runId!}).then(value=>{showReceipt(value);void sync();}).catch(()=>setError(true))}>{copy("이 답변 중지","Stop this reply")}</button>}
      </div>
    </main>
    <BrowserActionApprovalSheet chatId={snapshot?.conversationChatId ?? null} />
    {live?.keyRequest && live.keyRequest.runId!==dismissedKeyRun && <McpKeyRequestSheet key={live.keyRequest.runId}
      request={live.keyRequest} presentation="one" localeOverride={ko?"ko":"en"} onResolved={()=>setDismissedKeyRun(live.keyRequest!.runId)} />}
    <div className={styles.outputPanel} data-personal-one-output-panel="true" data-visible={tasksOpen||!!file} style={{'--personal-panel-width':Math.min(panelMaxWidth,panelWidth)+'px','--personal-composer-height':composerHeight+'px'} as CSSProperties}>
    <TaskSidePanel key={panelChatId ?? task?.projectId ?? 'personal-one-unbound'} items={[]} locale={ko?'ko':'en'} visible={tasksOpen||!!file}
      screenChatId={panelChatId} browserScopeKey={panelChatId ?? task?.projectId ?? 'personal-one-unbound'}
      width={Math.min(panelMaxWidth,panelWidth)} minWidth={280} maxWidth={panelMaxWidth}
      onResize={setPanelWidth} onRequestReadableWidth={setPanelWidth} onRequestOpen={()=>setTasksOpen(true)}
      onBrowserObserved={()=>setTasksOpen(true)} onClose={()=>{setTasksOpen(false);setFile(null);}}
      resultKey={`supervisor:${selectedHandoff ?? selected ?? 'list'}`} result={<div className={styles.taskContents} aria-label={copy("독립 작업","Independent tasks")}><header><h2>{copy("작업","Tasks")}</h2></header>
      {!taskPreviewOnly&&<>
      <label>{copy("Work에 맡길 일","Hand work to Work")}<textarea value={work} onChange={event=>setWork(event.target.value)} maxLength={8000}/></label>
      <label>{copy("작업 권한","Work permission")}<select value={permission} onChange={event=>setPermission(event.target.value as typeof permission)}><option value="read">{copy("읽기","Read")}</option><option value="write">{copy("쓰기","Write")}</option><option value="full">{copy("전체","Full")}</option></select></label>
      <button disabled={workPending||!snapshot||!work.trim()} onClick={()=>void startWork()}>{copy("Work 시작","Start Work")}</button><button onClick={()=>router.push("/science")}>{copy("Science 열기","Open Science")}</button>
      {!!snapshot?.scienceProjects?.length&&<><label>{copy("Science 프로젝트","Science project")}<select value={scienceProject} onChange={event=>setScienceProject(event.target.value)}><option value="">{copy("프로젝트 선택","Choose a project")}</option>{snapshot.scienceProjects.map(project=><option key={project.projectId} value={project.projectId}>{project.title}</option>)}</select></label><button disabled={workPending||!scienceProject||!work.trim()} onClick={()=>void startWork(true)}>{copy("Science에 맡기기","Hand off to Science")}</button></>}
      {snapshot?.scienceError&&<p className={styles.feedback}>{copy("Science 관측 연결을 확인할 수 없습니다.","Science observation is unavailable.")}</p>}
      {receipt&&receipt.kind!=="reply"&&<p role="status" className={styles.feedback}>{receiptCopy(receipt)}</p>}
      <div className={styles.taskList}>{snapshot?.tasks.map(item=><button key={item.taskId} data-task-id={item.taskId} data-selected={selected===item.taskId} onClick={()=>setSelected(item.taskId)}><strong>{item.title}</strong><span>{item.surface==='science'?'Science':item.surface==='one'?'One':'Work'} · {stateLabel(item.state)}</span></button>)}</div>
      </>}
      {taskPreviewOnly&&!task&&<p role="status">{handoff?stateLabel(handoff.state):copy('작업 관측을 확인하고 있습니다.','Checking the task observation.')}</p>}
      {task&&<section className={styles.detail}><h3>{task.title}</h3><p>{task.surface==='science'?'Science':task.surface==='one'?'One':'Work'} · {stateLabel(task.state)}</p>
        {task.controls.includes("steer")&&<><textarea aria-label={copy("이 작업에 추가 지시","Direction for this task")} value={direction} onChange={event=>setDirection(event.target.value)} maxLength={8000}/><button disabled={controlPending||!direction.trim()} onClick={()=>void control(task,"steer")}>{copy("이 작업에 지시 전달","Send direction to this task")}</button></>}
        {task.controls.includes("cancel")&&<button disabled={controlPending} onClick={()=>void control(task,"cancel")}>{copy("이 작업 취소","Cancel this task")}</button>}
        <small>{task.owner==='science-daemon'?'Science':'Work'} · {copy('내 컴퓨터','This computer')} · {copy('관측','Observed')} {new Date(task.observedAt).toLocaleTimeString()}</small>
        {exactResult&&<><p>{task.resultVerified?copy("검증된 결과","Verified result"):copy("작업 응답 · 검증 여부 확인 필요","Worker response · verification not confirmed")}</p><Markdown text={exactResult} messageId={"result:"+task.taskId+":"+task.runId} chatId={task.chatId ?? undefined} onOpenLinkedFile={task.chatId?reference=>openFile(reference,task.chatId!):undefined}/></>}
        {!exactResult&&<p>{handoff&&task.runId!==handoff.runId?copy('이 작업은 새 실행으로 이어졌습니다. 원래 작업에서 확인하세요.','This task has moved to a new attempt. Review its originating work.'):copy('관측된 결과가 나오면 이곳에서 확인할 수 있습니다.','An observed result will appear here.')}</p>}
        {(task.chatId||task.surface==='science')&&<button className={styles.goToTask} onClick={()=>router.push(taskRoute(task))}>{task.surface==='science'?copy('Science 열기','Open Science'):copy("원래 대화 열기","Go to chat")}</button>}
      </section>}
    </div>}/>
    </div>
    <OneBottomSheet open={appearanceOpen} onClose={()=>setAppearanceOpen(false)} closeLabel={copy("설정 닫기","Close appearance")} title={copy("나의 One","Your One")} size="compact" closeDisabled={savingProfile} closeOnEscape={!savingProfile} closeOnBackdrop={!savingProfile} footer={<button className={styles.saveAppearance} disabled={!profile||savingProfile||!profileName.trim()} onClick={()=>void saveAppearance()}>{copy("저장","Save")}</button>}>
      <div className={styles.appearance}>{profileError&&<p role="status">{copy("저장을 확인하지 못했습니다. 최신 설정을 확인하고 다시 저장해 주세요.","The save could not be confirmed. Review the latest settings and save again.")}</p>}<label>{copy("이름","Name")}<input aria-label={copy("One 이름","One name")} value={profileName} onChange={event=>setProfileName(event.target.value)} maxLength={64}/></label><label>{copy("말풍선 색","Bubble color")}<select aria-label={copy("말풍선 색","Bubble color")} value={bubbleColor} onChange={event=>setBubbleColor(event.target.value as OneBubbleColor)}>{Object.keys(ONE_BUBBLE_COLORS).map(color=><option key={color} value={color}>{({blue:copy("파랑","Blue"),green:copy("초록","Green"),purple:copy("보라","Purple"),rose:copy("장미","Rose"),amber:copy("호박","Amber"),slate:copy("회색","Slate")} as Record<string,string>)[color]}</option>)}</select></label><p className={styles.preview} style={{background:ONE_BUBBLE_COLORS[bubbleColor]}}>{profileName||name}</p></div>
    </OneBottomSheet>
    <OneMemorySheet open={memoryOpen} state={memory} locale={ko?"ko":"en"} useOnceTarget={null} onClose={closeMemory} onStateChange={setMemory} onUseOnceReady={()=>{}}/>
    <OneBottomSheet open={historyOpen} onClose={()=>setHistoryOpen(false)} closeLabel={copy('이전 대화 닫기','Close previous conversations')} title={copy('지난 One 대화','Previous One conversations')} size="compact">
      <div className={styles.appearance}>
        {snapshot?.legacyHistory?.linked.map(source=><button key={source.chatId} onClick={()=>router.push('/one?chat='+encodeURIComponent(source.chatId))}><span>{source.title}</span><small>{source.messageCount} {copy('메시지','messages')}</small></button>)}
        {!!snapshot?.legacyHistory?.heldCount&&<p>{copy('이전 1:1 대화 '+snapshot.legacyHistory.heldCount+'개를 보존했습니다. 소유자 정보가 없는 대화는 통합을 보류하고 기존 세션에서 확인할 수 있습니다.','Preserved '+snapshot.legacyHistory.heldCount+' previous one-to-one conversations. Conversations without ownership records remain in their original sessions while integration is held.')}</p>}
        {!snapshot?.legacyHistory?.heldCount&&!snapshot?.legacyHistory?.linked.length&&<p>{copy('확인된 이전 1:1 대화가 없습니다.','No previous one-to-one conversations have been confirmed.')}</p>}
        {snapshot?.legacyHistory?.limitReached&&<p>{copy('이전 대화가 많아 추가 이관 검사가 필요합니다.','Additional migration inventory is needed for older conversations.')}</p>}
        <button onClick={()=>navigateRail('sessions')}>{copy('기존 세션 열기','Open original sessions')}</button>
      </div>
    </OneBottomSheet>
  </div>;
}
