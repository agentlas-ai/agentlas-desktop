"use client";
import { MessageActions, MessageReplyPreview } from "../MessageActions";
import { composeMessageReply, displayMessageReply, type MessageReply } from "@/lib/message-reply";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc, ipcEvents, grantForDroppedFile } from "@/lib/ipc";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { useT } from "@/lib/i18n";
import { Markdown, StreamingMarkdown, type LinkedFileArtifact } from "@/components/Markdown";
import { mapIntellectUiProse } from "@shared/intellect-ui";
import { IconArrowUp, IconBrain, IconCheck, IconChevronRight, IconClose, IconMoreHorizontal, IconExpand, IconLayers, IconPanelRight, IconPlus, IconRefresh, IconSettings, IconSparkles } from "@/components/Icon";
import type { OneSupervisorSnapshot, SupervisorCommandReceipt, SupervisorTask, SupervisorDelegation } from "../../../shared/one-supervisor";
import { ONE_BUBBLE_COLORS, type OneBubbleColor, type OneProfile } from "../../../shared/one-profile";
import { readAppUiPreference } from "@/lib/app-ui-preferences";
import { stripAgentControlBlocks, stripAgentIdentityBadges, stripAgentRoutingBanners } from "../../../shared/agent-control-blocks";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneBottomSheet } from "./OneBottomSheet";
import { PopupDetails } from "@/components/Popup";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneAgentPortrait } from "./OneAgentPortrait";
import type { OneMemoryState } from "@/lib/types";
import { SupervisorOutbox, type PendingSupervisorWrite, type SupervisorWrite } from "@/lib/one-supervisor-outbox";
import { personalOneReplyPresentation, personalOneTranscript } from "@/lib/personal-one-transcript";
import { usePersonalOneReply } from "@/lib/use-personal-one-reply";
import { personalOneFile, type PersonalOneFile } from "@/lib/personal-one-file-preview";
import { TaskSidePanel } from "@/components/workspace/TaskSidePanel";
import { linkedLocalFileItem } from "@/lib/linked-local-file";
import { requestChatFileOpen, chatFilesBridge, chatFileItem, parseChatFileMessage, formatChatFileSize, type ChatFileDraft, type ChatFileItem } from "@/lib/chat-files";
import { ChatFileCards } from "@/components/ChatFileExperience";
import { ONE_ATTACHMENT_LIMITS } from "../../../shared/one-attachments";
import { ComposerDecisionSlot } from "@/components/ComposerDecisionPortal";
import { ToolApprovalInline } from "@/components/ToolApprovalInline";
import { BrowserActionApprovalSheet } from "@/components/BrowserActionApprovalSheet";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import { bindAgentScreenScope } from "@/lib/agent-screen-scope";
import { AgiDefectChip, AgiIncidentReportButton } from "../agi/AgiBugReport";
import { PersonalOneCapabilities, type PersonalOneCapabilityTab } from "./PersonalOneCapabilities";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { personalOnePanelMaximum } from "@/lib/personal-one-result";
import { registerRouter } from "@/lib/navigation";
import { PersonalOneBudget, usePersonalOneBudgets, personalOneBudgetName } from "./PersonalOneBudget";
import { PersonalOneContext, usePersonalOneContext, personalOneContextLabel } from "./PersonalOneContext";
import { PersonalOneCheckins } from "./PersonalOneCheckins";
import dynamic from "next/dynamic";
import styles from "./PersonalOneWorkspace.module.css";

const PersonalOneTaskResult=dynamic(()=>import("./PersonalOneTaskResult").then(module=>module.PersonalOneTaskResult),{ssr:false});

const visibleAnswer=(text:string)=>mapIntellectUiProse(text,prose=>stripAgentRoutingBanners(stripAgentIdentityBadges(stripAgentControlBlocks(prose,{streaming:true}))).trim());
const terminal=(state:string)=>["completed","cancelled","failed","interrupted"].includes(state);
// Personal One runs every turn with full access and Computer Use; Main decides that (owner 2026-10-05).
function storedOneRuntime() {
  return readAppUiPreference("oneRuntimeSelection");
}
export function PersonalOneWorkspace({ detached = false }: { detached?: boolean }) {
  const router=useRouter();const routeParams=useSearchParams();const requestedTaskId=routeParams.get("task");const consumedTask=useRef<string|null>(null);
  const {locale}=useT(); const ko=locale==="ko"; const copy=(a:string,b:string)=>ko?a:b;
  useEffect(()=>{registerRouter(router); return ()=>registerRouter(null);},[router]);
  const [checkinsOpen,setCheckinsOpen]=useState(false);
  const [contextOpen,setContextOpen]=useState(false);
  const [budgetsOpen,setBudgetsOpen]=useState(false);const [budgetId,setBudgetId]=useState("");
  const [capabilities,setCapabilities]=useState<PersonalOneCapabilityTab|null>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const headerMenuRef=useRef<HTMLElement>(null);const headerMenuTrigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!menuOpen)return;headerMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside=(event:PointerEvent)=>{if(!headerMenuRef.current?.contains(event.target as Node)&&!headerMenuTrigger.current?.contains(event.target as Node))setMenuOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setMenuOpen(false);headerMenuTrigger.current?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[menuOpen]);
  const [pinned,setPinned]=useState(false);
  const [windowError,setWindowError]=useState(false);
  const composerInput=useRef<HTMLTextAreaElement>(null);
  const [snapshot,setSnapshot]=useState<OneSupervisorSnapshot|null>(null);
  const historyScope=snapshot?.conversationChatId ?? null;
  const historyScopeRef=useRef(historyScope);historyScopeRef.current=historyScope;
  const groups=useMemo(()=>personalOneTranscript((snapshot?.messages ?? []).filter(message=>message.role!=="system"),snapshot?.turns ?? []),[snapshot?.messages,snapshot?.turns]);
  const groupIndexes=useMemo(()=>new Map(groups.map((group,index)=>[group.message.id,index])),[groups]);
  const [historyWindow,setHistoryWindow]=useState<{scope:string;ids:string[];expanded:boolean;followLatest:boolean}|null>(null);
  const candidateWindow=historyWindow?.scope===historyScope?historyWindow:null;
  const survivingHistoryIds=useMemo(()=>new Set(candidateWindow?.ids.filter(id=>groupIndexes.has(id)) ?? []),[candidateWindow,groupIndexes]);
  const scopedWindow=candidateWindow&&survivingHistoryIds.size?candidateWindow:null;
  const lastHistoryIndex=scopedWindow?Math.max(...Array.from(survivingHistoryIds,id=>groupIndexes.get(id)!)):-1;
  const historyGroups=useMemo(()=>scopedWindow
    ?groups.filter((group,index)=>survivingHistoryIds.has(group.message.id)||(scopedWindow.followLatest&&index>lastHistoryIndex))
    :groups.slice(-24),[groups,scopedWindow,survivingHistoryIds,lastHistoryIndex]);
  const historyStart=historyGroups.length?groupIndexes.get(historyGroups[0].message.id)!:0;
  const historyEnd=historyGroups.length?groupIndexes.get(historyGroups[historyGroups.length-1].message.id)!+1:0;
  const [ownVisibleCommands,setOwnVisibleCommands]=useState<{scope:string|null;ids:string[]}>({scope:null,ids:[]});
  const historyAnchor=useRef<{scope:string|null;id:string;top:number}|null>(null);
  const historyButtonStyle:CSSProperties={padding:"7px 12px",border:"1px solid var(--paper-edge)",borderRadius:10,background:"var(--paper-2)",color:"var(--ink)",font:"inherit",fontSize:12,cursor:"pointer"};
  const context=usePersonalOneContext(snapshot?.oneId);
  const budgets=usePersonalOneBudgets(snapshot?.oneId);
  const workBudget=budgets.items.find(item=>item.budgetId===budgetId);
  const budgetSelectionUnconfirmed=!!budgetId&&(budgets.unconfirmed||!workBudget||workBudget.limitUsd===null);
  const contextLabel=personalOneContextLabel(context.snapshot,context.unconfirmed,context.now,ko?"ko":"en");
  const [attachments,setAttachments]=useState<Array<{draft:ChatFileDraft;preview?:string}>>([]);
  const [attachmentError,setAttachmentError]=useState<string|null>(null);const [attachmentBusy,setAttachmentBusy]=useState(false);
  const attachmentPicker=useRef<HTMLInputElement>(null);
  const [messageFiles,setMessageFiles]=useState<Record<string,ChatFileItem[]>>({});
  const loadedGroups=useRef(new Set<string>());
  const attachmentsRef=useRef(attachments);attachmentsRef.current=attachments;
  useEffect(()=>()=>{for(const item of attachmentsRef.current)if(item.preview)URL.revokeObjectURL(item.preview);},[]);
  const pickAttachments=async(files:File[])=>{
    if(attachmentBusy)return;const next=[...attachments];
    try{for(const item of files){
      const grant=await grantForDroppedFile(item);if(!grant)throw new Error(copy("이 파일을 읽을 수 없습니다.","This file is unavailable."));
      if(next.length>=ONE_ATTACHMENT_LIMITS.maxCount || item.size>(item.type.startsWith("image/")?ONE_ATTACHMENT_LIMITS.maxImageBytes:ONE_ATTACHMENT_LIMITS.maxFileBytes) || next.reduce((sum,file)=>sum+file.draft.size,0)+item.size>ONE_ATTACHMENT_LIMITS.maxTotalBytes)throw new Error(copy("첨부는 최대 8개, 이미지 5 MB, 파일 64 MB, 전체 96 MB까지 가능합니다.","Attachments allow 8 items, 5 MB images, 64 MB files and 96 MB total."));
      next.push({draft:{grant,name:item.name,mediaType:item.type||"application/octet-stream",size:item.size,kind:"file"},...(item.type.startsWith("image/")?{preview:URL.createObjectURL(item)}:{})});
    }setAttachmentError(null);}catch(cause){setAttachmentError(cause instanceof Error?cause.message:String(cause));}
    setAttachments(next);
  };
  const [messageReply,setMessageReply]=useState<MessageReply|null>(null);
  useEffect(()=>setMessageReply(null),[snapshot?.conversationChatId]);
  const [text,setText]=useState(""); const [work,setWork]=useState("");
  const submitting=useRef(false);
  const draftIdentity=useRef<string|null>(null);
  const initialDraftEdit=useRef<{edited:boolean;value:string}>({edited:false,value:""});
  useEffect(()=>{
    if(!snapshot?.oneId)return;
    const key=`agentlas.one.draft.${snapshot.oneId}.${detached?"companion":"main"}`;
    if(draftIdentity.current!==key){const firstIdentity=draftIdentity.current===null;draftIdentity.current=key;try{
      const saved=window.sessionStorage.getItem(key) ?? "";
      const restored=firstIdentity&&initialDraftEdit.current.edited?initialDraftEdit.current.value:firstIdentity&&text!==""?text:saved;
      setText(restored);window.sessionStorage.setItem(key,restored);
    }catch{}}
  },[snapshot?.oneId,detached]);
  useEffect(()=>{if(draftIdentity.current)try{window.sessionStorage.setItem(draftIdentity.current,text);}catch{}},[text]);
  const [scienceProject,setScienceProject]=useState(""); const [selected,setSelected]=useState<string|null>(null); const [direction,setDirection]=useState("");
  const [error,setError]=useState(false);const [savedRequestError,setSavedRequestError]=useState(false); const [receipt,setReceipt]=useState<SupervisorCommandReceipt|null>(null);
  const [stopPending,setStopPending]=useState<string|null>(null);
  const [workPending,setWorkPending]=useState(false); const [controlPending,setControlPending]=useState(false); const [tasksOpen,setTasksOpen]=useState(false);
  const [taskPreviewOnly,setTaskPreviewOnly]=useState(false); const [selectedHandoff,setSelectedHandoff]=useState<string|null>(null); const [file,setFile]=useState<PersonalOneFile|null>(null);
  const [requestedTaskUnavailable,setRequestedTaskUnavailable]=useState(false);
  useEffect(()=>{if(!requestedTaskId||!snapshot||consumedTask.current===requestedTaskId)return;const exact=snapshot.tasks.find(item=>item.taskId===requestedTaskId);if(!exact){setRequestedTaskUnavailable(true);return;}consumedTask.current=requestedTaskId;setRequestedTaskUnavailable(false);setSelected(exact.taskId);setSelectedHandoff(null);setTaskPreviewOnly(true);setTasksOpen(true);setFile(null);},[requestedTaskId,snapshot]);
  const [artifactOpen,setArtifactOpen]=useState(false);
  const [panelWidth,setPanelWidth]=useState(360);const [autoPanelWidth,setAutoPanelWidth]=useState(true);
  const [viewportWidth,setViewportWidth]=useState(()=>typeof window==='undefined'?1360:window.innerWidth);
  const [composerHeight,setComposerHeight]=useState(96);
  const [contextBottom,setContextBottom]=useState(92);
  const workspaceRoot=useRef<HTMLDivElement>(null);const contextBar=useRef<HTMLDivElement>(null);
  const composerDock=useRef<HTMLDivElement>(null);
  useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);resize();return()=>window.removeEventListener('resize',resize);},[]);
  useLayoutEffect(()=>{const element=composerDock.current;if(!element)return;const measure=()=>{setComposerHeight(element.getBoundingClientRect().height);if(contextBar.current&&workspaceRoot.current)setContextBottom(contextBar.current.getBoundingClientRect().bottom-workspaceRoot.current.getBoundingClientRect().top);};measure();const observer=new ResizeObserver(measure);observer.observe(element);if(contextBar.current)observer.observe(contextBar.current);if(workspaceRoot.current)observer.observe(workspaceRoot.current);return()=>observer.disconnect();},[]);
  const panelMaxWidth=personalOnePanelMaximum(viewportWidth,detached);
  const shownPanelWidth=Math.min(panelMaxWidth,autoPanelWidth?Math.max(360,Math.round(viewportWidth*0.56)):panelWidth);
  const resizePanel=(width:number)=>{setAutoPanelWidth(false);setPanelWidth(Math.max(280,Math.min(panelMaxWidth,width)));};
  useEffect(()=>{if(!detached)return;let current=true;void ipc()?.oneWindow?.getState().then(value=>{if(current)setPinned(value.alwaysOnTop);}).catch(()=>{if(current)setWindowError(true);});return()=>{current=false;};},[detached]);
  const togglePinned=async()=>{try{const value=await ipc()?.oneWindow?.setAlwaysOnTop({value:!pinned});if(!value)throw new Error("window_controller_unavailable");setPinned(value.alwaysOnTop);setWindowError(false);}catch{setWindowError(true);}};
  const openMain=async(route:string)=>{if(!detached){router.push(route);return;}try{const value=await ipc()?.oneWindow?.showMain({route});if(!value)throw new Error("window_controller_unavailable");setMenuOpen(false);}catch{setWindowError(true);}};
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
  const mounted=useRef(true); const generation=useRef(0); const transcript=useRef<HTMLDivElement>(null); const nearBottom=useRef(true);
  const refreshCoordinator=useRef<ReturnType<typeof createCoalescedRefresh<void>>|null>(null);
  const readSnapshot=useCallback(async()=>{
    const current=++generation.current;
    try {
      const api=ipc()?.oneSupervisor;if(!api)throw new Error("desktop_unavailable");
      const value=await api.snapshot();if(!mounted.current || current!==generation.current)return;
      setSnapshot(value);setError(false);
      try{if(outboxOneId.current!==value.oneId){outbox.current=new SupervisorOutbox(value.oneId,window.localStorage);outboxOneId.current=value.oneId;setOptimistic([]);}
        outbox.current!.reconcile(value.requests);setSavedRequests(outbox.current!.list());setSavedRequestError(false);
      }catch{outbox.current=null;outboxOneId.current=null;setSavedRequestError(true);}
      const visible=new Set(value.messages.map(message=>message.id));
      const observed=new Set(value.turns?.filter(turn=>visible.has(turn.userMessageId)).map(turn=>turn.commandId));
      setOptimistic(prior=>prior.filter(item=>!observed.has(item.commandId)));
    } catch {if(mounted.current)setError(true);}
  },[]);
  const sync=useCallback(()=>refreshCoordinator.current?.request(undefined) ?? Promise.resolve(),[]);
  useEffect(()=>{
    const coordinator=createCoalescedRefresh<void>(readSnapshot,()=>undefined);refreshCoordinator.current=coordinator;
    mounted.current=true;void sync();const off=ipcEvents()?.onStoreChanged?.(()=>{void sync();});
    const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void sync();},5000);const focus=()=>{void sync();};window.addEventListener("focus",focus);
    const storage=(event:StorageEvent)=>{if(event.key?.startsWith("agentlas.one.supervisor.outbox.")){setSavedRequests(outbox.current?.list() ?? []);void sync();}};window.addEventListener("storage",storage);
    return()=>{coordinator.dispose();if(refreshCoordinator.current===coordinator)refreshCoordinator.current=null;mounted.current=false;++generation.current;window.clearInterval(timer);off?.();window.removeEventListener("focus",focus);window.removeEventListener("storage",storage);};
  },[sync,readSnapshot]);
  const observedCommands=useMemo(()=>{
    const messageIds=new Set(snapshot?.messages.map(message=>message.id));
    return new Set(snapshot?.turns?.filter(turn=>messageIds.has(turn.userMessageId)).map(turn=>turn.commandId));
  },[snapshot?.messages,snapshot?.turns]);
  const pendingMessages=useMemo(()=>{
    const optimisticIds=new Set(optimistic.map(item=>item.commandId));
    return [...optimistic,...savedRequests.filter(intent=>intent.method==="send"&&!observedCommands.has(intent.commandId)&&!optimisticIds.has(intent.commandId)).map(intent=>({commandId:intent.commandId,text:String(intent.input.text),acknowledged:false}))];
  },[optimistic,savedRequests,observedCommands]);
  const activeReply=snapshot?.requests.find(item=>item.kind==="reply" && ["dispatching","accepted"].includes(item.state));
  const prepareUiFollowup=useCallback((prompt:string)=>{
    if(!snapshot?.conversationChatId || activeReply || attachmentBusy)return false;
    setText(current=>current.trim()?`${current}\n\n${prompt}`:prompt);
    composerDock.current?.querySelector("textarea")?.focus();
    return true;
  },[snapshot?.conversationChatId,activeReply,attachmentBusy]);
  useLayoutEffect(()=>bindAgentScreenScope(snapshot?.conversationChatId ?? null),[snapshot?.conversationChatId]);
  const live=usePersonalOneReply(snapshot?.conversationChatId,activeReply?.runId ?? undefined,sync);
  const visibleGroups=useMemo(()=>{
    const active=activeReply?.runId?groups.find(group=>group.turn?.runId===activeReply.runId):undefined;
    const ownIds=new Set(ownVisibleCommands.scope===historyScope?ownVisibleCommands.ids:[]);
    const included=new Set(historyGroups.map(group=>group.message.id));
    for(const group of groups)if(group===active||group.turn&&ownIds.has(group.turn.commandId))included.add(group.message.id);
    return groups.filter(group=>included.has(group.message.id));
  },[groups,historyGroups,activeReply?.runId,historyScope,ownVisibleCommands]);
  const captureHistoryAnchor=()=>{
    const element=transcript.current;if(!element)return;
    const top=element.getBoundingClientRect().top;
    const row=Array.from(element.querySelectorAll<HTMLElement>("[data-personal-one-message-id]")).find(item=>item.getBoundingClientRect().bottom>top+1);
    historyAnchor.current=row?{scope:historyScope,id:row.dataset.personalOneMessageId!,top:row.getBoundingClientRect().top}:null;
  };
  const freezeHistory=()=>{
    nearBottom.current=false;captureHistoryAnchor();
    if(historyScope&&historyGroups.length)setHistoryWindow(current=>{
      const ids=historyGroups.map(group=>group.message.id);
      if(current&&current===scopedWindow&&!current.followLatest&&current.ids.length===ids.length&&current.ids.every((id,index)=>id===ids[index]))return current;
      return {scope:historyScope,ids,expanded:scopedWindow?.expanded ?? false,followLatest:false};
    });
  };
  const revealHistory=(direction:"earlier"|"later")=>{
    nearBottom.current=false;captureHistoryAnchor();
    const added=direction==="earlier"?groups.slice(Math.max(0,historyStart-24),historyStart):groups.slice(historyEnd,historyEnd+24);
    if(historyScope&&historyGroups.length){
      const included=new Set([...historyGroups,...added].map(group=>group.message.id));
      setHistoryWindow({scope:historyScope,ids:groups.filter(group=>included.has(group.message.id)).map(group=>group.message.id),expanded:true,followLatest:false});
    }
  };
  const handleHistoryWheel=(event:React.WheelEvent<HTMLDivElement>)=>{
    const element=event.currentTarget;
    if(Math.abs(event.deltaY)<=Math.abs(event.deltaX)||element.scrollHeight<=element.clientHeight+1)return;
    if(event.deltaY<0?element.scrollTop>0:element.scrollHeight-element.scrollTop-element.clientHeight>1)freezeHistory();
  };
  const handleHistoryScroll=(element:HTMLDivElement)=>{
    const distance=element.scrollHeight-element.scrollTop-element.clientHeight;
    if(distance<=4&&historyEnd===groups.length){
      nearBottom.current=true;captureHistoryAnchor();
      if(scopedWindow)setHistoryWindow(scopedWindow.expanded?{...scopedWindow,ids:historyGroups.map(group=>group.message.id),followLatest:true}:null);
    }else if(nearBottom.current&&distance>4)freezeHistory();
    else captureHistoryAnchor();
  };
  const latestHistory=()=>{
    const scope=historyScope;historyAnchor.current=null;nearBottom.current=true;setHistoryWindow(null);setOwnVisibleCommands({scope,ids:[]});
    requestAnimationFrame(()=>{if(historyScopeRef.current===scope)transcript.current?.scrollTo({top:transcript.current.scrollHeight});});
  };
  useLayoutEffect(()=>{
    if(historyAnchor.current?.scope!==historyScope){historyAnchor.current=null;nearBottom.current=true;}
    const element=transcript.current;if(!element)return;
    if(nearBottom.current)element.scrollTop=element.scrollHeight;
    else if(historyAnchor.current){const anchor=historyAnchor.current;const row=Array.from(element.querySelectorAll<HTMLElement>("[data-personal-one-message-id]")).find(item=>item.dataset.personalOneMessageId===anchor.id);if(row)element.scrollTop+=row.getBoundingClientRect().top-anchor.top;}
    captureHistoryAnchor();
  },[historyScope,visibleGroups,pendingMessages,live?.text,scopedWindow,messageFiles,viewportWidth,shownPanelWidth,tasksOpen,artifactOpen,file]);
  useEffect(()=>{loadedGroups.current.clear();setMessageFiles({});},[snapshot?.conversationChatId]);
  useEffect(()=>{
    const bridge=chatFilesBridge();if(!snapshot||!bridge)return;
    const groups=[...new Set(visibleGroups.flatMap(group=>[group.message,group.answer].flatMap(message=>message?parseChatFileMessage(message.text).groupIds:[])))].filter(group=>!loadedGroups.current.has(group));
    let disposed=false;
    void Promise.all(groups.map(async group=>{const files=await bridge.listGroup({chatId:snapshot.conversationChatId,groupId:group});if(disposed)return;loadedGroups.current.add(group);setMessageFiles(prior=>({...prior,[group]:files.map(file=>chatFileItem(file,"user-attachment"))}));}));
    return()=>{disposed=true;};
  },[historyScope,visibleGroups]);
  const navigateRail=(mode:"organisation"|"sessions"|"mail")=>{try{window.localStorage.setItem("agentlas.one.railMode",mode);}catch{}router.push("/one");};
  const showReceipt=(value:SupervisorCommandReceipt)=>setReceipt(value);
  const write=async(method:SupervisorWrite,input:Record<string,unknown>)=>{
    if(!outbox.current){
      // A damaged retry cache cannot disable terminal control. Main still validates the exact run.
      if(snapshot&&(method==="stopTask"||method==="stopReply"||method==="control"&&input.action==="cancel")){
        const action=ipc()?.oneSupervisor[method] as ((request:Record<string,unknown>)=>Promise<SupervisorCommandReceipt>)|undefined;
        if(action)return action({commandId:crypto.randomUUID(),oneId:snapshot.oneId,...input});
      }
      throw new Error("identity_unavailable");
    }const intent=outbox.current.prepare(method,input);setSavedRequests(outbox.current.list());
    const value=await outbox.current.deliver(ipc()!.oneSupervisor,intent);setSavedRequests(outbox.current.list());return value;
  };
  const send=async()=>{
    if(submitting.current)return;const submittedText=text;const submittedReply=messageReply;const rawMessage=text.trim();const message=composeMessageReply(rawMessage,submittedReply);if((!rawMessage&&!attachments.length)||!outbox.current||!snapshot||attachmentBusy)return;let intent:PendingSupervisorWrite;
    if(message.length>8000){setAttachmentError(copy("인용을 포함한 메시지가 너무 깁니다 (최대 8,000자). 답장을 줄이거나 인용을 취소해 주세요.","The message including its quotation is too long (8,000 characters maximum). Shorten your reply or cancel the quotation."));return;}
    submitting.current=true;setAttachmentBusy(true);
    try{const runtimeSelection=storedOneRuntime();let fileGroupId:string|undefined;
      if(attachments.length){const bridge=chatFilesBridge();if(!bridge)throw new Error("attachment_bridge_unavailable");const stored=await bridge.snapshot({chatId:snapshot.conversationChatId,files:attachments.map(item=>item.draft)});fileGroupId=stored.groupId;}
      intent=outbox.current.prepare("send",{text:message||copy("첨부 파일을 확인해 주세요.","Please review the attached files."),...(fileGroupId?{fileGroupId}:{}),...(runtimeSelection?{runtimeSelection}:{})});
      for(const item of attachments)if(item.preview)URL.revokeObjectURL(item.preview);setAttachments([]);setAttachmentError(null);
    }catch(cause){setAttachmentError(cause instanceof Error?cause.message:String(cause));setAttachmentBusy(false);submitting.current=false;return;}
    setAttachmentBusy(false);submitting.current=false;
    if(inFlight.current.has(intent.commandId))return;inFlight.current.add(intent.commandId);setOwnVisibleCommands(current=>({scope:historyScope,ids:[...(current.scope===historyScope?current.ids:[]),intent.commandId].slice(-24)}));setSavedRequests(outbox.current.list());setText(current=>current===submittedText?"":current);nearBottom.current=true;
    setOptimistic(prior=>prior.some(item=>item.commandId===intent.commandId)?prior:[...prior,{commandId:intent.commandId,text:message,acknowledged:false}]);
    try{const value=await outbox.current.deliver(ipc()!.oneSupervisor,intent);if(!mounted.current)return;setSavedRequests(outbox.current.list());showReceipt(value);
      if(value.acknowledgement!=="unknown"&&["stored","dispatching","accepted","completed"].includes(value.state))setMessageReply(current=>current===submittedReply?null:current);
      setOptimistic(prior=>prior.map(item=>item.commandId===intent.commandId?{...item,acknowledged:value.acknowledgement!=="unknown"}:item));void sync();
    }catch{if(mounted.current)setError(true);}finally{inFlight.current.delete(intent.commandId);}
  };
  const startWork=async(science=false)=>{
    if(!work.trim()||workPending||science&&!scienceProject||!science&&budgetSelectionUnconfirmed)return;setWorkPending(true);
    try{showReceipt(await write(science?"startScience":"startWork",{text:work.trim(),...(science?{projectId:scienceProject}:budgetId?{budgetId}:{})}));setWork("");void sync();}
    catch{setError(true);}finally{setWorkPending(false);}
  };
  const control=async(task:SupervisorTask,action:"steer"|"cancel")=>{
    if(controlPending)return;setControlPending(true);
    try{showReceipt(await write("control",{oneId:snapshot?.oneId,taskId:task.taskId,runId:task.runId,expectedVersion:task.controlVersion,action,...(action==="steer"?{text:direction.trim()}: {})}));setDirection("");void sync();}
    catch{setError(true);void sync();}finally{setControlPending(false);}
  };
  const stopTask=async(task:SupervisorTask)=>{
    if(stopPending===task.taskId)return;setStopPending(task.taskId);
    try{showReceipt(await write(task.runId?"stopTask":"control",{oneId:snapshot?.oneId,taskId:task.taskId,expectedVersion:task.controlVersion,...(task.runId?{runId:task.runId}:{action:"cancel"})}));void sync();}
    catch{setError(true);void sync();}finally{setStopPending(null);}
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
  const panelChatId=file?.chatId ?? task?.chatId ?? snapshot?.conversationChatId ?? null;
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
  const stateLabel=(state:string)=>({stored:copy("접수됨","Received"),dispatching:copy("시작 중","Starting"),accepted:copy("진행 중","In progress"),running:copy("진행 중","In progress"),queued:copy("대기 중","Queued"),cancelling:copy("정리 중","Stopping"),cancelled:copy("취소됨","Cancelled"),completed:copy("실행 종료","Run settled"),failed:copy("확인 필요","Needs review"),held:copy("실행 확인 필요","Checking execution"),interrupted:copy("중단됨","Interrupted"),paused:copy("일시 정지","Paused")} as Record<string,string>)[state] ?? copy("진행 중","In progress"); // an internal state name (waiting_tool…) is never shown
  const receiptCopy=(value:SupervisorCommandReceipt)=>value.reason==="supervisor_task_version_conflict"||value.reason==="supervisor_reply_target_stale"||value.reason==="supervisor_profile_version_conflict"
    ?copy("상태가 바뀌었습니다. 최신 상태를 확인해 주세요.","The state changed. Review the latest observation.")
    :value.state==="held"?copy("요청은 저장되었습니다. 실행 결과를 확인해야 합니다.","The request is saved. Its execution outcome needs confirmation.")
    :value.kind==="appearance"?copy("설정을 저장했습니다.","Settings saved.")
    :value.kind==="steer"&&value.reason==="applied_in_next_run"?copy("지시가 작업의 다음 실행에 들어갔습니다.","The direction went into the task's next run.")
    :value.kind==="steer"&&value.reason==="steer_withdrawn"?copy("이 지시는 실행 전에 거둬졌습니다.","This direction was withdrawn before it ran.")
    :value.kind==="steer"?copy("이 작업의 다음 지시로 접수했습니다.","Saved as the next direction for this task.")
    :value.kind==="cancel"||value.kind==="stop-reply"?value.control?.phase==="stopped"||value.control?.phase==="settled"?copy("이 실행의 중지를 확인했습니다.","Stopping was confirmed for this run."):copy("중지 요청을접수했습니다. 실제 실행 정리는 관측에서 확인합니다.","Stop request received. Actual execution settling is checked in the observation.")
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
  return <div ref={workspaceRoot} className={styles.root} data-personal-one-workspace="true" data-detached={detached} data-layout={viewportWidth>=860?"workbench":"companion"} onDragOver={event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();void pickAttachments(Array.from(event.dataTransfer.files));}}} style={{"--personal-bubble":ONE_BUBBLE_COLORS[snapshot?.bubbleColor ?? "blue"]} as CSSProperties}>
    {!detached&&<aside className={styles.navigation} aria-label={copy("One 탐색","One navigation")}>
      <div className="titlebar-drag" style={{height:28}}/><ProductModeMenu current="one" locale={ko?"ko":"en"}/>
      <button className={styles.personalEntry} data-personal-one-entry="true" aria-current="page"><OneAgentPortrait label={name} status="quiet" size="small" tone={snapshot?.avatarIcon ?? "character:orange-dino"}/><span className={styles.personalIdentity}><strong>{name}</strong><small>{copy("개인 에이전트","Personal agent")}</small></span></button>
      <nav className={styles.tabs}><button onClick={()=>navigateRail("organisation")}>{copy("에이전트","Agents")}</button><button onClick={()=>navigateRail("sessions")}>{copy("세션","Session")}</button><button onClick={()=>navigateRail("mail")}>{copy("메일","Mail")}</button></nav>
      <div className={styles.navigationLinks}><button onClick={()=>navigateRail("sessions")}>{copy("One으로 돌아가기","Back to One")}</button><button onClick={()=>void appearance()}><IconSettings size={16}/>{copy("이름과 말풍선","Name and bubbles")}</button><button onClick={()=>void openMemory()}><IconBrain size={16}/>{copy("메모리","Memory")}</button><button onClick={()=>setHistoryOpen(true)}>{copy("지난 One 대화","Previous One conversations")}</button></div>
      <p className={styles.localLabel}>{copy("이 컴퓨터에서 실행","Runs on this computer")}</p>
    </aside>}
    <main className={styles.conversation}>
      <header className={`${styles.header} ${detached?"titlebar-drag":""}`}>
        <div className={styles.headerIdentity}><h1>{name}</h1><small role="status">{!snapshot?copy("연결 확인 중","Checking connection"):error?copy("마지막 관측 표시","Last observation"):copy("이 컴퓨터에 연결됨","Connected to this computer")}</small></div>
        <div className="titlebar-nodrag">
          {detached&&<button className={styles.iconButton} type="button" aria-label={copy("항상 위에 두기","Always on top")} aria-pressed={pinned} title={copy("항상 위에 두기","Always on top")} onClick={()=>void togglePinned()}><span aria-hidden="true">⌖</span></button>}
          <button type="button" className={styles.iconButton} aria-label={copy("결과·작업 보기","Show results and work")} aria-expanded={tasksOpen} title={copy("결과·작업 보기","Show results and work")} onClick={()=>{setTasksOpen(value=>!value);setArtifactOpen(false);setTaskPreviewOnly(Boolean(selected));setFile(null);}}><IconPanelRight size={17}/></button>
          <button ref={headerMenuTrigger} type="button" className={styles.iconButton} aria-label={copy("One 메뉴","One menu")} aria-expanded={menuOpen} aria-controls="personal-one-menu" onClick={()=>setMenuOpen(value=>!value)}><IconMoreHorizontal size={19}/></button>
        </div>
      </header>
      {menuOpen&&<nav ref={headerMenuRef} id="personal-one-menu" className={styles.headerMenu} aria-label={copy("One 메뉴","One menu")} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setMenuOpen(false);headerMenuTrigger.current?.focus();}}}>
        <button type="button" onClick={()=>{setMenuOpen(false);setCapabilities("connections");}}>{copy("연결 도구","Connected tools")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setCapabilities("repeat");}}>{copy("반복 업무","Recurring work")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setContextOpen(true);}}>{copy("화면 공유","Screen sharing")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setBudgetsOpen(true);}}>{copy("실행 예산","Execution budgets")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setCheckinsOpen(true);}}>{copy("감시 조건","Monitoring")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void openMemory();}}>{copy("메모리","Memory")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void appearance();}}>{copy("이름과 말풍선","Name and bubbles")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setHistoryOpen(true);}}>{copy("지난 대화","Previous conversations")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void sync();}}>{copy("연결 상태 다시 확인","Refresh connection")}</button>
        {detached&&<button type="button" onClick={()=>void openMain("/one?personal=1")}>{copy("Desktop 열기","Open Desktop")}<IconExpand size={14}/></button>}
      </nav>}
      <div ref={contextBar} className={styles.contextBar} aria-label={copy("현재 업무 맥락","Current work context")}><span>{copy("개인","Personal")}</span>{task?.projectId&&<span title={task.projectId}>{copy("프로젝트 업무","Project work")}</span>}{snapshot?.tasks.some(item=>!terminal(item.state))&&<button type="button" onClick={()=>{setTasksOpen(true);setTaskPreviewOnly(false);}}>{copy("진행","Working")} {snapshot.tasks.filter(item=>!terminal(item.state)).length}</button>}<div className={styles.contextSharing}><button type="button" title={contextLabel} aria-label={copy("화면 공유 범위 열기","Open screen sharing scope")+": "+contextLabel} onClick={()=>setContextOpen(true)}><span>{contextLabel}</span></button>{snapshot?.oneId&&<button type="button" aria-label={copy("모든 화면 공유 중지","Stop all screen sharing")} onClick={()=>void context.stop().catch(()=>undefined)}>{copy("중지","Stop")}</button>}</div></div>
      {savedRequestError&&<p role="status" className={styles.feedback}>{copy("저장된 요청을 읽지 못했습니다. 새 요청은 잠시 보류하며 작업 중지는 계속 사용할 수 있습니다.","Saved requests could not be read. New requests are held while task stopping remains available.")}</p>}
      {requestedTaskUnavailable&&<p role="status" className={styles.feedback}>{copy("알림이 가리킨 작업을 현재 관측에서 찾지 못했습니다. 같은 작업의 관측을 기다리고 있습니다.","The task referenced by the notification is absent from the current observation. Waiting for that exact task.")}</p>}
      {windowError&&<p role="status" className={styles.feedback}>{copy("창 동작을 확인하지 못했습니다. 창 크기는 가장자리를 끌어 조절할 수 있습니다.","The window action was not confirmed. Drag the window edge to resize it.")}</p>}

      <div ref={transcript} className={styles.transcript} data-personal-one-transcript="true" style={{overflowAnchor:"none"}} onWheel={handleHistoryWheel} onTouchStart={event=>{if(!(event.target as Element).closest("button"))freezeHistory();}} onPointerDown={event=>{if(event.target===event.currentTarget)freezeHistory();}} onScroll={event=>handleHistoryScroll(event.currentTarget)} aria-live="polite">
        <div className={styles.thread}>
          {!snapshot?.messages.length&&!pendingMessages.length&&<div className={styles.empty}><h2>{copy("무엇을 함께 할까요?","What shall we work on?")}</h2></div>}
          {historyStart>0&&<button type="button" style={historyButtonStyle} data-personal-one-history="earlier" onClick={()=>revealHistory("earlier")}>{copy("이전 대화 24개 보기","Show 24 earlier turns")}</button>}
          {groups.length>24&&<button type="button" style={historyButtonStyle} data-personal-one-history="collapse" onClick={latestHistory}>{copy("최근 대화로 접기","Fold to recent turns")}</button>}
          {visibleGroups.map(({message,turn,answer})=>{
            const replyPresentation=turn?personalOneReplyPresentation(turn,Boolean(answer),activeReply?.runId):null;
            const replyText=answer?visibleAnswer(answer.text):live&&turn&&live.runId===turn.runId?visibleAnswer(live.text):"";
            const replyUiId=turn?`supervisor-reply:${turn.runId}`:answer?.id ?? message.id;
            return <div className={styles.turn} key={message.id} data-personal-one-message-id={message.id} data-command-id={turn?.commandId}>
            <MessageActions messageId={message.id} author={message.role==="user"?copy("나","You"):name} text={message.role==="assistant"?visibleAnswer(message.text):displayMessageReply(parseChatFileMessage(message.text).visibleText,locale)} locale={locale} onReply={reply=>{setMessageReply(reply);composerDock.current?.querySelector("textarea")?.focus();}}><article className={styles.bubble} data-role={message.role}><Markdown text={message.role==="assistant"?visibleAnswer(message.text):displayMessageReply(parseChatFileMessage(message.text).visibleText,locale)} messageId={message.id} chatId={snapshot?.conversationChatId} onOpenLinkedFile={reference=>openFile(reference,snapshot!.conversationChatId)} onUiFollowup={message.role==="assistant"?prepareUiFollowup:undefined} uiActionsDisabled={Boolean(activeReply||attachmentBusy)}/></article></MessageActions>
            {message.role==="user"&&message.imageDataUrls?.map((src,index)=><img key={src} src={src} alt={copy("첨부 이미지 ","Attached image ")+(index+1)} style={{maxWidth:240,maxHeight:180,borderRadius:10}}/>)}
            {parseChatFileMessage(message.text).groupIds.map(group=><ChatFileCards key={group} files={messageFiles[group] ?? []} locale={ko?"ko":"en"} onOpen={requestChatFileOpen}/>)}
            {replyText&&<MessageActions messageId={answer?.id ?? replyUiId} author={name} text={replyText} locale={locale} onReply={reply=>{setMessageReply(reply);composerDock.current?.querySelector("textarea")?.focus();}}><article className={styles.bubble} data-role="assistant" data-run-id={turn?.runId}><StreamingMarkdown text={replyText} messageId={replyUiId} chatId={snapshot?.conversationChatId} onOpenLinkedFile={reference=>openFile(reference,snapshot!.conversationChatId)} onUiFollowup={prepareUiFollowup} uiActionsDisabled={Boolean(activeReply||attachmentBusy)}/></article></MessageActions>}
            {turn&&snapshot?.delegations?.filter(item=>item.originReplyRunId===turn.runId).map(delegation)}
            {/* Owner 2026-10-04: no activity log under a reply ("이런건 없어도 되는"). While One answers, three dots. */}
            {replyPresentation==="answering"&&!(live&&live.runId===turn?.runId&&live.text)&&<div className={styles.typing} role="status" aria-label={copy("답하는 중","Answering")}><span/><span/><span/></div>}
            {replyPresentation&&replyPresentation!=="answering"&&<p className={styles.delivery} role="status" data-reply-state={replyPresentation}>{replyPresentation==="queued"?copy("대기 중","Queued"):replyPresentation==="held"?copy("실행 확인 필요","Checking execution"):replyPresentation==="failed"?copy("답변이 중단되었습니다","Reply interrupted"):copy("취소됨","Cancelled")}</p>}
            {turn?.state==="failed"&&<AgiIncidentReportButton key={turn.runId} locale={ko?"ko":"en"} draft={{
              chatId:snapshot?.conversationChatId,runId:turn.runId,failureCode:"one_supervisor_reply_failed",category:"other",
              title:"[Supervisor] Reply failed",summary:"The Supervisor reply failed before normal completion.",
              steps:["Send a message to Supervisor","The reply state became failed"],
            }} />}
          </div>})}
          {historyEnd<groups.length&&<button type="button" style={historyButtonStyle} data-personal-one-history="later" onClick={()=>revealHistory("later")}>{copy("다음 대화 24개 보기","Show 24 later turns")}</button>}
          {pendingMessages.map(message=><div className={styles.turn} key={message.commandId} data-optimistic-message={message.commandId}><MessageActions messageId={message.commandId} author={copy("나","You")} text={displayMessageReply(message.text,locale)} locale={locale} onReply={reply=>{setMessageReply(reply);composerDock.current?.querySelector("textarea")?.focus();}}><article className={styles.bubble} data-role="user"><Markdown text={displayMessageReply(message.text,locale)} messageId={message.commandId}/></article></MessageActions></div>)}
          {snapshot?.delegations?.filter(item=>!item.originReplyRunId || !snapshot.turns?.some(turn=>turn.runId===item.originReplyRunId)).map(delegation)}
        </div>
      </div>
      <div ref={composerDock} className={styles.composerDock}>
        <div className={styles.decisionStack}>
          <ComposerDecisionSlot surface="one" />
          {/* Only Main's exact pending requests may authorize an action. A current
              local permission selection must not resolve a previous run's card. */}
          <ToolApprovalInline chatId={snapshot?.conversationChatId} compact chip composerWidth={Math.max(300,Math.min(736,viewportWidth-(detached?32:250)))} />
        </div>
        {error&&<p role="status" className={styles.feedback}>{copy("접수를 확인할 수 없습니다. 저장된 요청과 연결 상태를 확인해 주세요.","Reception could not be confirmed. Review the saved request and connection.")}</p>}
        <AgiDefectChip chatId={snapshot?.conversationChatId ?? null} locale={ko?"ko":"en"} />
        {receipt?.state==="failed"&&receipt.kind!=="reply"&&<AgiIncidentReportButton key={receipt.commandId} locale={ko?"ko":"en"} draft={{
          chatId:snapshot?.conversationChatId,runId:receipt.runId ?? receipt.commandId,failureCode:"one_supervisor_command_failed",category:"other",
          title:"[Supervisor] Request failed",summary:receipt.reason || "The Supervisor request state became failed.",
          steps:["Submit a Supervisor request",`Request kind: ${receipt.kind}`],
        }} />}
        {savedRequests.filter(intent=>!inFlight.current.has(intent.commandId)).map(intent=><button className={styles.retry} key={intent.commandId} onClick={()=>void outbox.current!.deliver(ipc()!.oneSupervisor,intent).then(value=>{showReceipt(value);setSavedRequests(outbox.current!.list());void sync();}).catch(()=>setError(true))}>{copy("같은 저장 요청 다시 확인","Retry the same saved request")} · {intent.method}</button>)}
        <input ref={attachmentPicker} type="file" multiple hidden onChange={event=>{if(event.target.files)void pickAttachments(Array.from(event.target.files));event.target.value="";}}/>
        {attachments.length>0&&<div className={styles.attachmentDrafts} aria-label={copy("선택한 첨부","Selected attachments")}>{attachments.map((item,index)=><div className={styles.attachmentDraft} key={index}>
          {item.preview&&<img src={item.preview} alt={item.draft.name}/>}
          <span>{item.draft.name}<small>{formatChatFileSize(item.draft.size)}</small></span>
          <button type="button" aria-label={copy("첨부 삭제: ","Remove attachment: ")+item.draft.name} onClick={()=>{if(item.preview)URL.revokeObjectURL(item.preview);setAttachments(prior=>prior.filter((_,position)=>position!==index));}}><IconClose size={14}/></button>
        </div>)}</div>}
        {attachmentError&&<p role="alert" className={styles.feedback}>{attachmentError}</p>}
        <MessageReplyPreview reply={messageReply} locale={locale} onDismiss={()=>setMessageReply(null)}/>
        <form className={styles.composer} onSubmit={event=>{event.preventDefault();void send();}}>
          <div ref={plusMenu} className={styles.plus}>
            <button type="button" className={styles.iconButton} aria-label={copy("추가","Add")} aria-haspopup="menu" aria-expanded={plusOpen} data-hover="own" onClick={()=>setPlusOpen(value=>!value)}><IconPlus size={19}/></button>
            {plusOpen&&<div className={styles.plusMenu} role="menu" aria-label={copy("추가","Add")}>
              <button type="button" role="menuitem" data-hover="own" disabled={attachmentBusy} onClick={()=>{setPlusOpen(false);attachmentPicker.current?.click();}}><span className={styles.plusIcon}><IconPlus size={15}/></span><strong>{copy("사진 및 파일 첨부","Attach photos and files")}</strong></button>
              <div className={styles.plusDivider}/>
              <div className={styles.plusSection}>{copy("맡기기","Hand off")}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);setTasksOpen(true);setTaskPreviewOnly(false);setSelected(null);setFile(null);}}><span className={styles.plusIcon}><IconLayers size={15}/></span><strong>{copy("Work에 맡기기","Hand to Work")}</strong></button>
              {!!snapshot?.scienceProjects?.length&&<button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);setTasksOpen(true);setTaskPreviewOnly(false);setSelected(null);setFile(null);}}><span className={styles.plusIcon}><IconSparkles size={15}/></span><strong>{copy("Science에 맡기기","Hand to Science")}</strong></button>}
              <div className={styles.plusDivider}/>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCapabilities("connections");}}>{copy("연결 도구","Connected tools")}</button>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCapabilities("repeat");}}>{copy("반복 업무","Recurring work")}</button>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCheckinsOpen(true);}}>{copy("감시 조건","Monitoring")}</button>
              <div className={styles.plusSection}>{name}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void openMemory();}}><span className={styles.plusIcon}><IconBrain size={15}/></span><strong>{copy("메모리","Memory")}</strong></button>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void appearance();}}><span className={styles.plusIcon}><IconSettings size={15}/></span><strong>{copy("이름과 말풍선","Name and bubbles")}</strong></button>
            </div>}
          </div>
          <textarea ref={composerInput} aria-label={ko?name+"에게 메시지":"Message "+name} value={text} onChange={event=>{if(draftIdentity.current===null)initialDraftEdit.current={edited:true,value:event.target.value};setText(event.target.value);event.currentTarget.style.height="auto";event.currentTarget.style.height=Math.min(140,event.currentTarget.scrollHeight)+"px";}} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}} maxLength={8000} rows={1} placeholder={copy("메시지 보내기","Send a message")}/>
          <OneVoiceInputHelp locale={ko?"ko":"en"} composerRef={composerInput} />
          <button className={styles.send} type="submit" aria-label={copy("보내기","Send")} disabled={!snapshot||savedRequestError||attachmentBusy||(!text.trim()&&!attachments.length)}><IconArrowUp size={18}/></button>
        </form>
        {activeReply?.runId&&<button className={styles.stopReply} onClick={()=>void write("stopReply",{runId:activeReply.runId!}).then(value=>{showReceipt(value);void sync();}).catch(()=>setError(true))}>{copy("이 답변 중지","Stop this reply")}</button>}
      </div>
    </main>
    <BrowserActionApprovalSheet chatId={snapshot?.conversationChatId ?? null} />
    {live?.keyRequest && live.keyRequest.runId!==dismissedKeyRun && <McpKeyRequestSheet key={live.keyRequest.runId}
      request={live.keyRequest} presentation="one" localeOverride={ko?"ko":"en"} onResolved={()=>setDismissedKeyRun(live.keyRequest!.runId)} />}
    <div className={styles.outputPanel} data-personal-one-output-panel="true" data-visible={tasksOpen||!!file||artifactOpen} style={{'--personal-panel-width':shownPanelWidth+'px','--personal-composer-height':composerHeight+'px','--personal-context-bottom':contextBottom+'px'} as CSSProperties}>
      <aside className={styles.taskDrawer} hidden={!tasksOpen||!!file||artifactOpen} aria-labelledby="one-task-heading" data-one-task-drawer="true" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setTasksOpen(false);composerInput.current?.focus();}}}>
        <div className={styles.panelResize} role="separator" tabIndex={0} aria-label={copy("결과 영역 너비","Result panel width")} aria-orientation="vertical" aria-valuemin={280} aria-valuemax={Math.round(panelMaxWidth)} aria-valuenow={Math.round(shownPanelWidth)}
          onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();resizePanel(shownPanelWidth+(event.key==="ArrowLeft"?24:-24));}}}
          onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();const element=event.currentTarget;const start=event.clientX;const width=element.parentElement?.getBoundingClientRect().width ?? shownPanelWidth;element.setPointerCapture(event.pointerId);const move=(next:PointerEvent)=>resizePanel(width+start-next.clientX);const end=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",end);element.removeEventListener("pointercancel",end);};element.addEventListener("pointermove",move);element.addEventListener("pointerup",end);element.addEventListener("pointercancel",end);}}/>
        <div className={styles.taskContents} aria-label={copy("독립 작업","Independent tasks")}><header><h2 id="one-task-heading">{copy("작업과 결과","Tasks and results")}</h2>{viewportWidth>=860&&<button type="button" aria-label={shownPanelWidth>=panelMaxWidth-1?copy("결과 너비 자동 맞춤","Fit result width automatically"):copy("결과 펼치기","Expand result")} aria-pressed={shownPanelWidth>=panelMaxWidth-1} title={copy("같은 결과를 넓게 보기","Review the same result at full available width")} onClick={()=>shownPanelWidth>=panelMaxWidth-1?setAutoPanelWidth(true):resizePanel(panelMaxWidth)}><IconExpand size={16}/></button>}{taskPreviewOnly&&<button type="button" onClick={()=>setTaskPreviewOnly(false)}>{copy("모든 작업","All tasks")}</button>}<button type="button" aria-label={copy("작업 닫기","Close tasks")} onClick={()=>setTasksOpen(false)}><IconClose size={17}/></button></header>
      {!taskPreviewOnly&&<>
      <label>{copy("Work에 맡길 일","Hand work to Work")}<textarea value={work} onChange={event=>setWork(event.target.value)} maxLength={8000}/></label>
      <label>{copy("이 Work 업무에 사용할 실행 예산","Execution budget for this Work task")}<select aria-label={copy("이 Work 업무에 사용할 실행 예산","Execution budget for this Work task")} value={budgetId} onChange={event=>setBudgetId(event.target.value)}><option value="">{copy("제한 없이 관측만 (기본)","Unrestricted observation (default)")}</option>{budgets.items.filter(item=>item.limitUsd!==null).map(item=><option key={item.budgetId} value={item.budgetId}>{personalOneBudgetName(item,ko?"ko":"en")}</option>)}{budgetSelectionUnconfirmed&&<option value={budgetId}>{copy("선택 예산 확인 필요","Selected budget needs review")}</option>}</select></label>
      <p className={styles.feedback}>{budgetSelectionUnconfirmed?copy("선택한 예산의 최신 정책을 확인하지 못했습니다. 예산 관측을 확인하거나 기본 관측으로 직접 변경해 주세요.","The selected budget policy is unconfirmed. Review budget observations or explicitly choose the default observation mode."):budgetId?copy("이 업무의 후속 실행도 같은 예산에서 예약합니다. 공급자의 실제 청구 상한을 보장하지 않습니다.","Follow-up runs reserve from the same task budget. Actual provider charges are not capped."):copy("예산을 선택하지 않으면 제한 없이 관측합니다. 실제 청구가 미확정일 수 있습니다.","Without a selected budget, execution is unrestricted observation. Actual billing may remain unconfirmed.")}</p>
      <button type="button" onClick={()=>setBudgetsOpen(true)}>{copy("예산 설정과 비용 관측","Budget settings and billing observations")}</button>
      <button disabled={workPending||!snapshot||!work.trim()||budgetSelectionUnconfirmed} onClick={()=>void startWork()}>{copy("Work 시작","Start Work")}</button><button onClick={()=>void openMain("/science")}>{copy("Science 열기","Open Science")}</button>
      {!!snapshot?.scienceProjects?.length&&<><label>{copy("Science 프로젝트","Science project")}<select value={scienceProject} onChange={event=>setScienceProject(event.target.value)}><option value="">{copy("프로젝트 선택","Choose a project")}</option>{snapshot.scienceProjects.map(project=><option key={project.projectId} value={project.projectId}>{project.title}</option>)}</select></label><button disabled={workPending||!scienceProject||!work.trim()} onClick={()=>void startWork(true)}>{copy("Science에 맡기기","Hand off to Science")}</button></>}
      {snapshot?.scienceError&&<p className={styles.feedback}>{copy("Science 관측 연결을 확인할 수 없습니다.","Science observation is unavailable.")}</p>}
      {receipt&&receipt.kind!=="reply"&&<p role="status" className={styles.feedback}>{receiptCopy(receipt)}</p>}
      <div className={styles.taskList}>{snapshot?.tasks.map(item=><button key={item.taskId} data-task-id={item.taskId} data-selected={selected===item.taskId} onClick={()=>{setSelected(item.taskId);setSelectedHandoff(null);setTaskPreviewOnly(true);}}><strong>{item.title}</strong><span>{item.surface==='science'?'Science':item.surface==='one'?'One':'Work'} · {stateLabel(item.state)}</span></button>)}</div>
      </>}
      {taskPreviewOnly&&!task&&<p role="status">{handoff?stateLabel(handoff.state):copy('작업 관측을 확인하고 있습니다.','Checking the task observation.')}</p>}
      {task&&<section className={styles.detail}><h3>{task.title}</h3><p>{task.surface==='science'?'Science':task.surface==='one'?'One':'Work'} · {stateLabel(task.state)}</p>
        {task.controls.includes("steer")&&<><textarea aria-label={copy("이 작업에 추가 지시","Direction for this task")} value={direction} onChange={event=>setDirection(event.target.value)} maxLength={8000}/><button disabled={controlPending||!direction.trim()} onClick={()=>void control(task,"steer")}>{copy("이 작업에 지시 전달","Send direction to this task")}</button></>}
        {(!terminal(task.state)||task.controls.includes("cancel"))&&<button disabled={stopPending===task.taskId} onClick={()=>void stopTask(task)}>{copy("이 작업 중지 요청","Request task stop")}</button>}
        <small>{task.owner==='science-daemon'?'Science':'Work'} · {copy('내 컴퓨터','This computer')} · {copy('관측','Observed')} {new Date(task.observedAt).toLocaleTimeString()}</small>
        {snapshot&&<PersonalOneTaskResult key={task.taskId} oneId={snapshot.oneId} task={task} requestedRunId={handoff?.runId ?? undefined} locale={ko?"ko":"en"} fallbackText={exactResult} visible={tasksOpen&&!file&&!artifactOpen} onOpenLinkedFile={reference=>{if(task.chatId)openFile(reference,task.chatId);}} onRefresh={()=>void sync()}/>}
        {!exactResult&&<p>{handoff&&task.runId!==handoff.runId?copy('이 작업은 새 실행으로 이어졌습니다. 원래 작업에서 확인하세요.','This task has moved to a new attempt. Review its originating work.'):copy('관측된 결과가 나오면 이곳에서 확인할 수 있습니다.','An observed result will appear here.')}</p>}
        {(task.chatId||task.surface==='science')&&<button className={styles.goToTask} onClick={()=>void openMain(taskRoute(task))}>{task.surface==='science'?copy('Science 열기','Open Science'):copy("원래 대화 열기","Go to chat")}</button>}
      </section>}
    </div>
      </aside>
      <TaskSidePanel key={panelChatId ?? "one-files"} items={[]} locale={ko?'ko':'en'} visible={!!file||artifactOpen} screenChatId={panelChatId} browserScopeKey={panelChatId ?? 'personal-one-unbound'} width={shownPanelWidth} minWidth={280} maxWidth={panelMaxWidth} onResize={resizePanel} onRequestReadableWidth={resizePanel} onRequestOpen={()=>setArtifactOpen(true)} onClose={()=>{setFile(null);setArtifactOpen(false);}}/>
    </div>
    <OneBottomSheet open={appearanceOpen} onClose={()=>setAppearanceOpen(false)} closeLabel={copy("설정 닫기","Close appearance")} ariaLabel={copy("나의 One","Your One")} title={copy("나의 One","Your One")} icon={<IconSettings size={20} />} size="compact" footer={<button className={styles.saveAppearance} disabled={!profile||savingProfile||!profileName.trim()} onClick={()=>void saveAppearance()}>{copy("저장","Save")}</button>}>
      <div className={styles.appearance}>{profileError&&<p role="status">{copy("저장을 확인하지 못했습니다. 최신 설정을 확인하고 다시 저장해 주세요.","The save could not be confirmed. Review the latest settings and save again.")}</p>}<label>{copy("이름","Name")}<input aria-label={copy("One 이름","One name")} value={profileName} onChange={event=>setProfileName(event.target.value)} maxLength={64}/></label><fieldset className={styles.bubbleChoices}><legend>{copy("말풍선 색","Bubble color")}</legend><div role="radiogroup" aria-label={copy("말풍선 색","Bubble color")}>{Object.keys(ONE_BUBBLE_COLORS).map(color=><button type="button" key={color} role="radio" aria-checked={bubbleColor===color} aria-label={({blue:copy("파랑","Blue"),green:copy("초록","Green"),purple:copy("보라","Purple"),rose:copy("장미","Rose"),amber:copy("호박","Amber"),slate:copy("회색","Slate")} as Record<string,string>)[color]} onClick={()=>setBubbleColor(color as OneBubbleColor)} style={{background:ONE_BUBBLE_COLORS[color as OneBubbleColor]}}>{bubbleColor===color&&<IconCheck size={18}/>}</button>)}</div></fieldset><p className={styles.preview} style={{background:ONE_BUBBLE_COLORS[bubbleColor]}}>{profileName||name}</p></div>
    </OneBottomSheet>
    <PersonalOneBudget open={budgetsOpen} oneId={snapshot?.oneId} locale={ko?"ko":"en"} items={budgets.items} unconfirmed={budgets.unconfirmed} onRefresh={budgets.refresh} onClose={()=>setBudgetsOpen(false)}/>
    <PersonalOneContext open={contextOpen} oneId={snapshot?.oneId} tasks={snapshot?.tasks ?? []} preferredTaskId={selected} locale={ko?"ko":"en"} value={context.snapshot} unconfirmed={context.unconfirmed} now={context.now} stopEpoch={context.stopEpoch} onStop={context.stop} onClose={()=>setContextOpen(false)} onRefresh={context.refresh}/>
    <PersonalOneCheckins open={checkinsOpen} oneId={snapshot?.oneId} locale={ko?"ko":"en"} onClose={()=>setCheckinsOpen(false)} onRefresh={()=>void sync()}/>
    <PersonalOneCapabilities oneId={snapshot?.oneId} open={capabilities} locale={ko?"ko":"en"} chatId={snapshot?.conversationChatId} onClose={()=>setCapabilities(null)} onPrompt={prompt=>{setText(prompt);composerInput.current?.focus();}}/>
    <OneMemorySheet open={memoryOpen} state={memory} locale={ko?"ko":"en"} useOnceTarget={null} onClose={closeMemory} onStateChange={setMemory} onUseOnceReady={()=>{}}/>
    <OneBottomSheet open={historyOpen} onClose={()=>setHistoryOpen(false)} closeLabel={copy('이전 대화 닫기','Close previous conversations')} ariaLabel={copy('지난 One 대화','Previous One conversations')} title={copy('지난 One 대화','Previous One conversations')} icon={<IconLayers size={20} />} size="compact">
      <div className={styles.appearance}>
        {snapshot?.legacyHistory?.linked.map(source=><button className={styles.historyItem} key={source.chatId} onClick={()=>void openMain('/one?chat='+encodeURIComponent(source.chatId))}><IconLayers size={18}/><span>{source.title}<small>{source.messageCount} {copy('메시지','messages')}</small></span><IconChevronRight size={16}/></button>)}
        {!!snapshot?.legacyHistory?.heldCount&&<PopupDetails label={copy(`이전 대화 ${snapshot.legacyHistory.heldCount}개 보존`,`Preserved ${snapshot.legacyHistory.heldCount} conversations`)}><p>{copy('소유자 정보가 없는 대화는 통합을 보류하며 기존 세션에서 확인할 수 있습니다.','Conversations without ownership records remain in their original sessions while integration is held.')}</p></PopupDetails>}
        {!snapshot?.legacyHistory?.heldCount&&!snapshot?.legacyHistory?.linked.length&&<p>{copy('확인된 이전 1:1 대화가 없습니다.','No previous one-to-one conversations have been confirmed.')}</p>}
        {snapshot?.legacyHistory?.limitReached&&<p>{copy('이전 대화가 많아 추가 이관 검사가 필요합니다.','Additional migration inventory is needed for older conversations.')}</p>}
        <button onClick={()=>detached?void openMain("/one"):navigateRail('sessions')}>{copy('기존 세션 열기','Open original sessions')}</button>
      </div>
    </OneBottomSheet>
  </div>;
}
