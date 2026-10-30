"use client";
import { MessageActions, MessageReplyPreview } from "../MessageActions";
import { composeMessageReply, displayMessageReply, type MessageReply } from "@/lib/message-reply";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc, ipcEvents, grantForDroppedFile, grantForPastedAttachment, grantForPastedImage } from "@/lib/ipc";
import { fitImageUnder } from "@/lib/attachment-image-fit";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { createStoreChangeThrottle, sameSnapshotIgnoring } from "@/lib/store-change-policy";
import { ChatContinuationProjector } from "@/lib/chat-continuations";
import { useT } from "@/lib/i18n";
import { Markdown, StreamingMarkdown, type LinkedFileArtifact } from "@/components/Markdown";
import { mapInlineVisualProse } from "@shared/inline-visual";
import { InlineUiInstances, useInlineUiInstances, inlineUiForReply } from "@/components/UiInstances";
import { IntellectUiActions } from "@/lib/intellect-ui-actions";
import { IconArrowUp, IconBrain, IconCheck, IconChevronRight, IconClose, IconMoreHorizontal, IconExpand, IconFileUp, IconLayers, IconPanelRight, IconPlus, IconPuzzle, IconSidebar, IconRefresh, IconSettings, IconSparkles } from "@/components/Icon";
import type { OneSupervisorSnapshot, SupervisorCommandReceipt, SupervisorTask, SupervisorDelegation, SupervisorReplyTurn } from "../../../shared/one-supervisor";
import { ONE_BUBBLE_COLORS, type OneBubbleColor, type OneProfile } from "../../../shared/one-profile";
import { stripAgentControlBlocks, stripAgentIdentityBadges, stripAgentRoutingBanners } from "../../../shared/agent-control-blocks";
import { ProductModeMenu } from "./ProductModeMenu";
import { OneBottomSheet } from "./OneBottomSheet";
import { OneSecurityFeatures } from "./OneSecurityFeatures";
import { PopupDetails } from "@/components/Popup";
import { OneMemorySheet } from "./OneMemorySheet";
import { OneCapabilitiesModal } from "./OneCapabilitiesModal";
import { OneAgentPortrait } from "./OneAgentPortrait";
import type { ChatHistoryEntry, OneMemoryState, RuntimeSelection } from "@/lib/types";
import { SupervisorOutbox, type PendingSupervisorWrite, type SupervisorWrite } from "@/lib/one-supervisor-outbox";
import { personalOnePendingAsk, personalOneReplyPresentation, personalOneTranscript } from "@/lib/personal-one-transcript";
import { PersonalOneAskCard } from "./PersonalOneAsk";
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
import { PersonalOneSupervisedApprovals } from "./PersonalOneSupervisedApprovals";
import { McpKeyRequestSheet } from "@/components/McpKeyRequestSheet";
import { bindAgentScreenScope } from "@/lib/agent-screen-scope";
import { AgiDefectChip, AgiIncidentReportButton } from "../agi/AgiBugReport";
import { PersonalOneCapabilities, type PersonalOneCapabilityTab } from "./PersonalOneCapabilities";
import { OneVoiceInputHelp } from "./OneVoiceInputHelp";
import { useChatSelectionIntent } from "@/lib/chat-selection-intent";
import { chatSelectionSendBlocked } from "@/lib/chat-selection-send-guard";
import { OneRuntimeChips } from "./OneRuntimeChips";
import { OneFrontChip, OneFrontNote, OneFrontNotice, OneFrontSetting, useOneFront } from "./PersonalOneFront";
import { personalOnePanelMaximum } from "@/lib/personal-one-result";
import { registerRouter } from "@/lib/navigation";
import { PersonalOneBudget, usePersonalOneBudgets, personalOneBudgetName } from "./PersonalOneBudget";
import { PersonalOneCheckins } from "./PersonalOneCheckins";
import dynamic from "next/dynamic";
import styles from "./PersonalOneWorkspace.module.css";
import { Select } from "@/components/Select";
import { useComposerEnter } from "@/lib/use-composer-enter";

const PersonalOneTaskResult=dynamic(()=>import("./PersonalOneTaskResult").then(module=>module.PersonalOneTaskResult),{ssr:false});

const visibleAnswer=(text:string)=>mapInlineVisualProse(text,prose=>stripAgentRoutingBanners(stripAgentIdentityBadges(stripAgentControlBlocks(prose,{streaming:true}))).trim());
const terminal=(state:string)=>["completed","cancelled","failed","interrupted"].includes(state);
// Single-row composer: the + and send columns (28px each) plus the pill's 8px side padding; below COMPOSER_MIN_TEXT_PX of text the
// placeholder no longer fits on one line, so the composer takes its two-row shape.
const COMPOSER_ROW_FIXED_PX=28+28+16;
const COMPOSER_MIN_TEXT_PX=200;
type PersonalOneConversationMessage = ChatHistoryEntry & {
  displayKey: string;
  historyGroupId?: string;
  replyTurn?: SupervisorReplyTurn;
  hasDurableAnswer?: boolean;
  pendingCommandId?: string;
};
// Personal One runs every turn with full access and Computer Use; Main decides that (owner 2026-10-05).
// Its model is the conversation's chip (OneRuntimeChips): a message names no runtime, and Main runs the chip's pin for
// it as for every host-started or phone turn of this conversation (electron/runtime/room-chip-runtime.ts).
// With the owner's opt-in front (shared/one-front.ts) Main runs the conversation on Agentlas's light model instead, and
// the chip is a fixed label that opens the setting.
export function PersonalOneWorkspace({ detached = false }: { detached?: boolean }) {
  const router=useRouter();const routeParams=useSearchParams();const requestedTaskId=routeParams.get("task");const consumedTask=useRef<string|null>(null);
  const {locale}=useT(); const ko=locale==="ko"; const copy=(a:string,b:string)=>ko?a:b;
  const front=useOneFront();
  useEffect(()=>{registerRouter(router); return ()=>registerRouter(null);},[router]);
  const [checkinsOpen,setCheckinsOpen]=useState(false);
  const [budgetsOpen,setBudgetsOpen]=useState(false);const [budgetId,setBudgetId]=useState("");
  const [capabilitiesModal,setCapabilitiesModal]=useState(false);
  const [capabilities,setCapabilities]=useState<PersonalOneCapabilityTab|null>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  const [securityOpen,setSecurityOpen]=useState(false);
  // Sidebar: owner choice persists; below 860px it is collapsed unless the owner opens it for this session.
  const [navPref,setNavPref]=useState<"open"|"closed"|null>(()=>{try{const v=window.localStorage.getItem("agentlas.one.personal.nav");return v==="open"||v==="closed"?v:null;}catch{return null;}});
  const headerMenuRef=useRef<HTMLElement>(null);const headerMenuTrigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!menuOpen)return;headerMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside=(event:PointerEvent)=>{if(!headerMenuRef.current?.contains(event.target as Node)&&!headerMenuTrigger.current?.contains(event.target as Node))setMenuOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setMenuOpen(false);headerMenuTrigger.current?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[menuOpen]);
  const [pinned,setPinned]=useState(false);
  const [windowError,setWindowError]=useState(false);
  const composerInput=useRef<HTMLTextAreaElement>(null);
  // One line stays a single pill; a second line (typed or wrapped) opens the two-row composer and it stays open until the draft is empty.
  const [composerExpanded,setComposerExpanded]=useState(false);
  // A pill too narrow for its own controls also takes the two-row shape. The controls keep their width in one row, so a narrow
  // window or an open result panel squeezed the text to ~100px and the empty placeholder wrapped to two lines.
  const [composerNarrow,setComposerNarrow]=useState(false);
  const composerForm=useRef<HTMLFormElement>(null);const composerTrail=useRef<HTMLDivElement>(null);
  const [snapshot,setSnapshot]=useState<OneSupervisorSnapshot|null>(null);
  const historyScope=snapshot?.conversationChatId ?? null;
  const desiredSelection=useChatSelectionIntent(historyScope);
  const selectionSendBlocked=!front.view?.effective&&Boolean(desiredSelection)&&chatSelectionSendBlocked(historyScope);
  const inlineUi=useInlineUiInstances(snapshot?.conversationChatId);
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
  const budgets=usePersonalOneBudgets(snapshot?.oneId);
  const workBudget=budgets.items.find(item=>item.budgetId===budgetId);
  const budgetSelectionUnconfirmed=!!budgetId&&(budgets.unconfirmed||!workBudget||workBudget.limitUsd===null);
  const [attachments,setAttachments]=useState<Array<{draft:ChatFileDraft;preview?:string}>>([]);
  const [attachmentError,setAttachmentError]=useState<string|null>(null);const [attachmentBusy,setAttachmentBusy]=useState(false);
  const attachmentPicker=useRef<HTMLInputElement>(null);
  const [messageFiles,setMessageFiles]=useState<Record<string,ChatFileItem[]>>({});
  const loadedGroups=useRef(new Set<string>());
  const attachmentsRef=useRef(attachments);attachmentsRef.current=attachments;
  useEffect(()=>()=>{for(const item of attachmentsRef.current)if(item.preview)URL.revokeObjectURL(item.preview);},[]);
  const pickAttachments=async(files:File[])=>{
    if(attachmentBusy)return;const next=[...attachments];
    try{for(const original of files){
      // A large photo or screenshot is shrunk to fit the image limit instead of refused (owner 2026-10-14).
      const item=await fitImageUnder(original,ONE_ATTACHMENT_LIMITS.maxImageBytes);
      // A Finder file carries its path; a pasted screenshot, clip or generated file has none, so Main pins its bytes to
      // a private file and issues the same exact-file grant (the One composer's path).
      const grant=await grantForDroppedFile(item)??await grantForPastedAttachment(item)??(item.type.startsWith("image/")?await grantForPastedImage(item):null);
      if(!grant)throw new Error(copy("이 파일을 읽을 수 없습니다.","This file is unavailable."));
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
  const [workRuntime,setWorkRuntime]=useState<RuntimeSelection|null>(null);
  useEffect(()=>{setWorkRuntime(null);},[snapshot?.oneId]);
  const [workPending,setWorkPending]=useState(false); const [controlPending,setControlPending]=useState(false); const [tasksOpen,setTasksOpen]=useState(false);
  const [taskPreviewOnly,setTaskPreviewOnly]=useState(false); const [selectedHandoff,setSelectedHandoff]=useState<string|null>(null); const [file,setFile]=useState<PersonalOneFile|null>(null);
  const [requestedTaskUnavailable,setRequestedTaskUnavailable]=useState(false);
  const [artifactOpen,setArtifactOpen]=useState(false);
  const [outputPanelEmpty,setOutputPanelEmpty]=useState(false);
  const taskDrawerVisible=tasksOpen&&!file&&!artifactOpen;
  const outputPanelVisible=taskDrawerVisible||((!!file||artifactOpen)&&!outputPanelEmpty);
  const showTaskDrawer=useCallback(()=>{setTasksOpen(true);setArtifactOpen(false);setFile(null);},[]);
  useEffect(()=>{if(!requestedTaskId||!snapshot||consumedTask.current===requestedTaskId)return;const exact=snapshot.tasks.find(item=>item.taskId===requestedTaskId);if(!exact){setRequestedTaskUnavailable(true);return;}consumedTask.current=requestedTaskId;setRequestedTaskUnavailable(false);setSelected(exact.taskId);setSelectedHandoff(null);setTaskPreviewOnly(true);showTaskDrawer();},[requestedTaskId,snapshot,showTaskDrawer]);
  const [panelWidth,setPanelWidth]=useState(360);const [autoPanelWidth,setAutoPanelWidth]=useState(true);
  const [viewportWidth,setViewportWidth]=useState(()=>typeof window==='undefined'?1360:window.innerWidth);
  const [composerHeight,setComposerHeight]=useState(96);
  const [narrowNavOpen,setNarrowNavOpen]=useState(false);
  const navCollapsed=viewportWidth<860?!narrowNavOpen:navPref==="closed";
  const toggleNav=()=>{if(viewportWidth<860){setNarrowNavOpen(value=>!value);return;}const next=navCollapsed?"open":"closed";setNavPref(next);try{window.localStorage.setItem("agentlas.one.personal.nav",next);}catch{}};
  const [contextBottom,setContextBottom]=useState(92);
  const workspaceRoot=useRef<HTMLDivElement>(null);const contextBar=useRef<HTMLDivElement>(null);
  const composerDock=useRef<HTMLDivElement>(null);
  useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);resize();return()=>window.removeEventListener('resize',resize);},[]);
  useLayoutEffect(()=>{
    const input=composerInput.current;if(!input)return;
    const resize=()=>{
      // Reset before measuring so both soft-wrapped text and restored drafts can grow and shrink.
      input.style.height="auto";
      const height=input.scrollHeight;
      input.style.height=Math.min(140,height)+"px";
      input.style.overflowY=height>140?"auto":"hidden";
      if(!text)setComposerExpanded(false);
      else if(text.includes("\n")||height>28)setComposerExpanded(true);
    };
    resize();
    // Moving the sidebar or result panel changes wrap points without changing the draft.
    let width=input.clientWidth;
    const observer=new ResizeObserver(()=>{if(input.clientWidth!==width){width=input.clientWidth;resize();}});
    observer.observe(input);
    return()=>observer.disconnect();
  },[text,composerExpanded,attachments.length]);
  useLayoutEffect(()=>{
    const form=composerForm.current,trail=composerTrail.current;if(!form||!trail)return;
    // The trail's natural width is the same in both shapes, so this never flips back and forth: only the space left for text decides.
    const measure=()=>setComposerNarrow(form.clientWidth-trail.scrollWidth-COMPOSER_ROW_FIXED_PX<COMPOSER_MIN_TEXT_PX);
    measure();const observer=new ResizeObserver(measure);observer.observe(form);observer.observe(trail);return()=>observer.disconnect();
  },[]);
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
  const conversationChatIdRef=useRef<string|null>(null);conversationChatIdRef.current=snapshot?.conversationChatId ?? null;
  const readSnapshot=useCallback(async()=>{
    const current=++generation.current;
    try {
      const api=ipc()?.oneSupervisor;if(!api)throw new Error("desktop_unavailable");
      const value=await api.snapshot();if(!mounted.current || current!==generation.current)return;
      // A read that found nothing new keeps the same object, so the whole workspace does not re-render.
      setSnapshot(prior=>sameSnapshotIgnoring(prior,value,["observedAt"])?prior:value);setError(false);
      try{if(outboxOneId.current!==value.oneId){outbox.current=new SupervisorOutbox(value.oneId,window.localStorage);outboxOneId.current=value.oneId;setOptimistic([]);}
        outbox.current!.reconcile(value.requests);setSavedRequests(outbox.current!.list());setSavedRequestError(false);
      }catch{outbox.current=null;outboxOneId.current=null;setSavedRequestError(true);}
      const visible=new Set(value.messages.map(message=>message.id));
      const observed=new Set(value.turns?.filter(turn=>visible.has(turn.userMessageId)).map(turn=>turn.commandId));
      setOptimistic(prior=>prior.filter(item=>!observed.has(item.commandId)));
    } catch {if(mounted.current)setError(true);}
  },[]);
  const sync=useCallback(()=>refreshCoordinator.current?.request(undefined) ?? Promise.resolve(),[]);
  // A saved request Main has not confirmed yet is delivered again quietly (same command id, so Main answers with the
  // receipt it already has instead of running it twice). No banner, no retry button: the message is already shown.
  const redelivery=useRef(new Map<string,{n:number;at:number}>());
  const redeliverSaved=useCallback(()=>{
    const box=outbox.current;const bridge=ipc()?.oneSupervisor;if(!box||!bridge)return;
    for(const intent of box.list()){
      if(inFlight.current.has(intent.commandId))continue;
      const state=redelivery.current.get(intent.commandId)??{n:0,at:0};
      if(state.n>=6||Date.now()<state.at)continue;
      redelivery.current.set(intent.commandId,{n:state.n+1,at:Date.now()+Math.min(60000,2000*2**state.n)});
      inFlight.current.add(intent.commandId);
      void box.deliver(bridge,intent).then(()=>{if(mounted.current){setSavedRequests(box.list());void sync();}}).catch(()=>undefined).finally(()=>{inFlight.current.delete(intent.commandId);});
    }
  },[sync]);
  useEffect(()=>{
    const coordinator=createCoalescedRefresh<void>(readSnapshot,()=>undefined);refreshCoordinator.current=coordinator;
    // Its own conversation refreshes at once; any other store change at most once per 2 s (perf review R-01).
    const storeChanges=createStoreChangeThrottle({throttleMs:2000,run:()=>{void sync();},
      immediate:change=>change.entity==="chat"&&(!change.id||change.id===conversationChatIdRef.current)});
    mounted.current=true;void sync();const off=ipcEvents()?.onStoreChanged?.(change=>storeChanges.notify(change));
    const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden"){void sync();redeliverSaved();}},5000);const focus=()=>{void sync();};window.addEventListener("focus",focus);
    const storage=(event:StorageEvent)=>{if(event.key?.startsWith("agentlas.one.supervisor.outbox.")){setSavedRequests(outbox.current?.list() ?? []);void sync();}};window.addEventListener("storage",storage);
    return()=>{coordinator.dispose();if(refreshCoordinator.current===coordinator)refreshCoordinator.current=null;mounted.current=false;++generation.current;window.clearInterval(timer);off?.();storeChanges.dispose();window.removeEventListener("focus",focus);window.removeEventListener("storage",storage);};
  },[sync,readSnapshot,redeliverSaved]);
  const observedCommands=useMemo(()=>{
    const messageIds=new Set(snapshot?.messages.map(message=>message.id));
    return new Set(snapshot?.turns?.filter(turn=>messageIds.has(turn.userMessageId)).map(turn=>turn.commandId));
  },[snapshot?.messages,snapshot?.turns]);
  const pendingMessages=useMemo(()=>{
    const optimisticIds=new Set(optimistic.map(item=>item.commandId));
    return [...optimistic,...savedRequests.filter(intent=>intent.method==="send"&&!observedCommands.has(intent.commandId)&&!optimisticIds.has(intent.commandId)).map(intent=>({commandId:intent.commandId,text:String(intent.input.text),acknowledged:false}))];
  },[optimistic,savedRequests,observedCommands]);
  const activeReply=snapshot?.requests.find(item=>item.kind==="reply" && ["dispatching","accepted"].includes(item.state));
  const pendingAsk=useMemo(()=>personalOnePendingAsk(groups,pendingMessages.length),[groups,pendingMessages.length]);
  const [dismissedAskId,setDismissedAskId]=useState<string|null>(null);
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
  const continuationProjector=useRef(new ChatContinuationProjector());
  const observedReplyTexts=useRef(new Map<string,string>());
  const conversationMessages=useMemo(()=>{
    if(live?.text){
      const key=`${historyScope}:${live.runId}`;
      observedReplyTexts.current.set(key,live.text);
      while(observedReplyTexts.current.size>200)observedReplyTexts.current.delete(observedReplyTexts.current.keys().next().value!);
    }
    const messages:PersonalOneConversationMessage[]=groups.flatMap(({message,turn,answer})=>{
      const rows:PersonalOneConversationMessage[]=[{...message,historyGroupId:message.id,
        displayKey:turn?`supervisor-command:${turn.commandId}`:message.id}];
      if(turn)rows.push({...answer,id:answer?.id ?? `supervisor-reply:${turn.runId}`,role:"assistant",
        // The live hook clears its buffer before the terminal snapshot arrives.
        // Keep the observed reply through that gap under the same exact owner.
        text:answer?.text ?? (activeReply?.runId===turn.runId
          ?(live?.runId===turn.runId&&live.text?live.text:observedReplyTexts.current.get(`${historyScope}:${turn.runId}`) ?? ""):""),
        createdAt:answer?.createdAt ?? turn.createdAt,
        displayKey:`supervisor-reply:${turn.runId}`,historyGroupId:message.id,replyTurn:turn,hasDurableAnswer:Boolean(answer)});
      return rows;
    });
    return [...messages,...pendingMessages.map((message):PersonalOneConversationMessage=>({
      id:message.commandId,role:"user",text:message.text,createdAt:"",displayKey:`supervisor-command:${message.commandId}`,
      pendingCommandId:message.commandId,
    }))];
  },[activeReply?.runId,groups,historyScope,live?.runId,live?.text,pendingMessages]);
  const conversationRows=useMemo(()=>{
    const visible=new Set(visibleGroups.map(group=>group.message.id));
    return continuationProjector.current.project(historyScope ?? "personal-one-pending",conversationMessages,{
      key:message=>message.displayKey,role:message=>message.role,
      text:message=>message.role==="assistant"?visibleAnswer(message.text):message.text,
      active:message=>Boolean(message.replyTurn&&!message.hasDurableAnswer&&message.replyTurn.runId===activeReply?.runId),
      createdAt:message=>message.createdAt || undefined,run:message=>message.replyTurn?.runId,
    }).filter(row=>Boolean(row.message.pendingCommandId)||visible.has(row.message.historyGroupId!));
  },[activeReply?.runId,conversationMessages,historyScope,visibleGroups]);
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
  },[historyScope,conversationRows,scopedWindow,messageFiles,viewportWidth,shownPanelWidth,tasksOpen,artifactOpen,file]);
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
  const enter=useComposerEnter(()=>{void send();});
  const send=async(answer?:string)=>{
    // An active turn's question answer has its own custody. Only a new composer
    // submission waits, before attachments, outbox IDs or draft state change.
    if(answer===undefined&&!front.view?.effective&&chatSelectionSendBlocked(snapshot?.conversationChatId ?? null))return;
    // A question-card answer goes out alone: never with the composer's quotation, draft or attachments.
    const outgoing=answer===undefined?attachments:[];
    if(submitting.current)return;const submittedText=answer??text;const submittedReply=answer===undefined?messageReply:null;const rawMessage=submittedText.trim();const message=composeMessageReply(rawMessage,submittedReply);if((!rawMessage&&!outgoing.length)||!outbox.current||!snapshot||attachmentBusy)return;let intent:PendingSupervisorWrite;
    if(message.length>8000){setAttachmentError(copy("인용을 포함한 메시지가 너무 깁니다 (최대 8,000자). 답장을 줄이거나 인용을 취소해 주세요.","The message including its quotation is too long (8,000 characters maximum). Shorten your reply or cancel the quotation."));return;}
    submitting.current=true;setAttachmentBusy(true);
    try{let fileGroupId:string|undefined;
      if(outgoing.length){const bridge=chatFilesBridge();if(!bridge)throw new Error("attachment_bridge_unavailable");const stored=await bridge.snapshot({chatId:snapshot.conversationChatId,files:outgoing.map(item=>item.draft)});fileGroupId=stored.groupId;}
      intent=outbox.current.prepare("send",{text:message||copy("첨부 파일을 확인해 주세요.","Please review the attached files."),...(fileGroupId?{fileGroupId}:{})});
      if(answer===undefined){for(const item of attachments)if(item.preview)URL.revokeObjectURL(item.preview);setAttachments([]);}setAttachmentError(null);
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
    try{showReceipt(await write(science?"startScience":"startWork",{text:work.trim(),...(science?{projectId:scienceProject}:{...(budgetId?{budgetId}:{}),...(workRuntime?{runtimeSelection:workRuntime}:{})})}));setWork("");if(!science)setWorkRuntime(null);void sync();}
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
  const openConversationFile=useCallback((reference:LinkedFileArtifact)=>{
    if(snapshot?.conversationChatId)openFile(reference,snapshot.conversationChatId);
  },[openFile,snapshot?.conversationChatId]);
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
  const openTask=(taskId:string|null,handoffId:string|null=null)=>{setSelected(taskId);setSelectedHandoff(handoffId);setTaskPreviewOnly(true);showTaskDrawer();};
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
    {!detached&&<aside id="personal-one-navigation" className={styles.navigation} data-collapsed={navCollapsed} hidden={navCollapsed} aria-label={copy("One 탐색","One navigation")}>
      <div className="titlebar-drag" style={{height:28}}/><ProductModeMenu current="one" locale={ko?"ko":"en"}/>
      <button className={styles.personalEntry} data-personal-one-entry="true" aria-current="page"><OneAgentPortrait label={name} status="quiet" size="small" tone={snapshot?.avatarIcon ?? "character:orange-dino"}/><span className={styles.personalIdentity}><strong>{name}</strong><small>{copy("개인 에이전트","Personal agent")}</small></span></button>
      <nav className={styles.tabs}><button onClick={()=>navigateRail("organisation")}>{copy("에이전트","Agents")}</button><button onClick={()=>navigateRail("sessions")}>{copy("세션","Session")}</button><button onClick={()=>navigateRail("mail")}>{copy("메일","Mail")}</button></nav>
      <div className={styles.navigationLinks}><button onClick={()=>navigateRail("sessions")}>{copy("One으로 돌아가기","Back to One")}</button><button onClick={()=>void appearance()}><IconSettings size={16}/>{copy("이름과 말풍선","Name and bubbles")}</button><button onClick={()=>void openMemory()}><IconBrain size={16}/>{copy("메모리","Memory")}</button><button type="button" data-one-capabilities-entry="true" onClick={()=>setCapabilitiesModal(true)}><IconPuzzle size={16}/>{copy("능력","Capabilities")}</button><button onClick={()=>setHistoryOpen(true)}>{copy("지난 One 대화","Previous One conversations")}</button></div>
      <p className={styles.localLabel}>{copy("이 컴퓨터에서 실행","Runs on this computer")}</p>
    </aside>}
    <main className={styles.conversation}>
      <header ref={contextBar} className={`${styles.header} ${detached?"titlebar-drag":""}`}>
        <div className={styles.headerIdentity}>{!detached&&<button type="button" className={styles.iconButton} data-personal-one-nav-toggle="true" aria-label={navCollapsed?copy("사이드바 열기","Open sidebar"):copy("사이드바 접기","Collapse sidebar")} title={navCollapsed?copy("사이드바 열기","Open sidebar"):copy("사이드바 접기","Collapse sidebar")} aria-expanded={!navCollapsed} aria-controls="personal-one-navigation" onClick={toggleNav}><IconSidebar size={18}/></button>}<h1>{name}</h1><small role="status">{!snapshot?copy("연결 확인 중","Checking connection"):error?copy("마지막 관측 표시","Last observation"):copy("이 컴퓨터에 연결됨","Connected to this computer")}</small></div>
        <div className="titlebar-nodrag">
          {detached&&<button className={styles.iconButton} type="button" aria-label={copy("항상 위에 두기","Always on top")} aria-pressed={pinned} title={copy("항상 위에 두기","Always on top")} onClick={()=>void togglePinned()}><span aria-hidden="true">⌖</span></button>}
          <button type="button" className={styles.iconButton} aria-label={copy("결과·작업 보기","Show results and work")} aria-expanded={taskDrawerVisible} title={copy("결과·작업 보기","Show results and work")} onClick={()=>{if(taskDrawerVisible)setTasksOpen(false);else showTaskDrawer();setTaskPreviewOnly(Boolean(selected));}}><IconPanelRight size={17}/></button>
          <button ref={headerMenuTrigger} type="button" className={styles.iconButton} aria-label={copy("One 메뉴","One menu")} aria-expanded={menuOpen} aria-controls="personal-one-menu" onClick={()=>setMenuOpen(value=>!value)}><IconMoreHorizontal size={19}/></button>
        </div>
      </header>
      {menuOpen&&<nav ref={headerMenuRef} id="personal-one-menu" className={styles.headerMenu} aria-label={copy("One 메뉴","One menu")} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setMenuOpen(false);headerMenuTrigger.current?.focus();}}}>
        <button type="button" onClick={()=>{setMenuOpen(false);setCapabilities("connections");}}>{copy("연결 도구","Connected tools")}</button>
        <button type="button" data-personal-one-security-entry="true" onClick={()=>{setMenuOpen(false);setSecurityOpen(true);}}>{copy("보안과 연결 관리","Security and connections")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setCapabilities("repeat");}}>{copy("반복 업무","Recurring work")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setBudgetsOpen(true);}}>{copy("실행 예산","Execution budgets")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setCheckinsOpen(true);}}>{copy("감시 조건","Monitoring")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void openMemory();}}>{copy("메모리","Memory")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setCapabilitiesModal(true);}}>{copy("능력","Capabilities")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void appearance();}}>{copy("이름과 말풍선","Name and bubbles")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);setHistoryOpen(true);}}>{copy("지난 대화","Previous conversations")}</button>
        <button type="button" onClick={()=>{setMenuOpen(false);void sync();}}>{copy("연결 상태 다시 확인","Refresh connection")}</button>
        {detached&&<button type="button" onClick={()=>void openMain("/one?personal=1")}>{copy("Desktop 열기","Open Desktop")}<IconExpand size={14}/></button>}
      </nav>}
      {savedRequestError&&<p role="status" className={styles.feedback}>{copy("저장된 요청을 읽지 못했습니다. 새 요청은 잠시 보류하며 작업 중지는 계속 사용할 수 있습니다.","Saved requests could not be read. New requests are held while task stopping remains available.")}</p>}
      {requestedTaskUnavailable&&<p role="status" className={styles.feedback}>{copy("알림이 가리킨 작업을 현재 관측에서 찾지 못했습니다. 같은 작업의 관측을 기다리고 있습니다.","The task referenced by the notification is absent from the current observation. Waiting for that exact task.")}</p>}
      {windowError&&<p role="status" className={styles.feedback}>{copy("창 동작을 확인하지 못했습니다. 창 크기는 가장자리를 끌어 조절할 수 있습니다.","The window action was not confirmed. Drag the window edge to resize it.")}</p>}

      <IntellectUiActions.Provider value={{prepareFollowup:prepareUiFollowup,disabled:Boolean(activeReply||attachmentBusy)}}>
      <div ref={transcript} className={styles.transcript} data-personal-one-transcript="true" style={{overflowAnchor:"none"}} onWheel={handleHistoryWheel} onTouchStart={event=>{if(!(event.target as Element).closest("button"))freezeHistory();}} onPointerDown={event=>{if(event.target===event.currentTarget)freezeHistory();}} onScroll={event=>handleHistoryScroll(event.currentTarget)} aria-live="polite">
        <div className={styles.thread}>
          {!snapshot?.messages.length&&!pendingMessages.length&&<div className={styles.empty}><h2>{copy("무엇을 함께 할까요?","What shall we work on?")}</h2></div>}
          {historyStart>0&&<button type="button" style={historyButtonStyle} data-personal-one-history="earlier" onClick={()=>revealHistory("earlier")}>{copy("이전 대화 24개 보기","Show 24 earlier turns")}</button>}
          {groups.length>24&&<button type="button" style={historyButtonStyle} data-personal-one-history="collapse" onClick={latestHistory}>{copy("최근 대화로 접기","Fold to recent turns")}</button>}
          {conversationRows.map(row=>{
            const message=row.message,turn=message.replyTurn;
            const sourceMessageId=row.sourceId;
            const displayId=row.continuation?row.id:message.displayKey;
            const contentId=row.continuation?displayId:message.displayKey;
            const displayedText=message.role==="assistant"?row.text:displayMessageReply(parseChatFileMessage(row.text).visibleText,locale);
            const markdownText=message.role==="assistant"?row.markdownText ?? displayedText:displayedText;
            const replyPresentation=turn?personalOneReplyPresentation(turn,Boolean(message.hasDurableAnswer),activeReply?.runId):null;
            const typing=row.tail&&replyPresentation==="answering"&&!displayedText;
            const delegated=row.tail&&turn?snapshot?.delegations?.filter(item=>item.originReplyRunId===turn.runId) ?? []:[];
            const imageUrls=row.tail?message.imageDataUrls ?? []:[];
            const fileGroups=row.tail?parseChatFileMessage(message.text).groupIds:[];
            const failed=row.tail&&turn?.state==="failed";
            const ownedUi=message.role==="assistant"&&turn&&!row.continuation ? inlineUiForReply(inlineUi,turn.runId,message.text) : [];
            if(!ownedUi.length&&!markdownText&&!typing&&!failed&&!delegated.length&&!imageUrls.length&&!fileGroups.length)return null;
            return <div className={styles.turn} key={displayId} data-personal-one-message-id={displayId} data-personal-one-source-id={sourceMessageId} data-personal-one-history-id={message.historyGroupId} data-command-id={turn?.commandId} data-optimistic-message={message.pendingCommandId}>
            {(markdownText||ownedUi.length>0)&&<MessageActions messageId={sourceMessageId} author={message.role==="user"?copy("나","You"):name} text={displayedText} locale={locale} onReply={reply=>{setMessageReply(reply);composerDock.current?.querySelector("textarea")?.focus();}}><article className={styles.bubble} data-role={message.role} data-run-id={turn?.runId}>
              {message.role==="assistant"&&turn
                ?<StreamingMarkdown text={markdownText} messageId={contentId} chatId={snapshot?.conversationChatId} onOpenLinkedFile={openConversationFile} onUiFollowup={prepareUiFollowup} uiActionsDisabled={Boolean(activeReply||attachmentBusy)}/>
                :<Markdown text={markdownText} messageId={contentId} chatId={snapshot?.conversationChatId} onOpenLinkedFile={openConversationFile} onUiFollowup={message.role==="assistant"?prepareUiFollowup:undefined} uiActionsDisabled={Boolean(activeReply||attachmentBusy)}/>}
              <InlineUiInstances chatId={snapshot?.conversationChatId} instances={ownedUi} turnIds={turn?[turn.runId]:[]} locale={ko?"ko":"en"}/>
            </article></MessageActions>}
            {imageUrls.map((src,index)=><img key={src} src={src} alt={copy("첨부 이미지 ","Attached image ")+(index+1)} style={{maxWidth:240,maxHeight:180,borderRadius:10}}/>)}
            {fileGroups.map(group=><ChatFileCards key={group} files={messageFiles[group] ?? []} locale={ko?"ko":"en"} onOpen={requestChatFileOpen}/>)}
            {delegated.map(delegation)}
            {/* Owner 2026-10-04: while One answers, three dots without an activity log. */}
            {typing&&<div className={styles.typing} role="status" aria-label={copy("답하는 중","Answering")}><span/><span/><span/></div>}
            {failed&&turn&&<AgiIncidentReportButton key={turn.runId} locale={ko?"ko":"en"} draft={{
              chatId:snapshot?.conversationChatId,runId:turn.runId,failureCode:"one_supervisor_reply_failed",category:"other",
              title:"[Supervisor] Reply failed",summary:"The Supervisor reply failed before normal completion.",
              steps:["Send a message to Supervisor","The reply state became failed"],
            }} />}
          </div>})}
          {historyEnd<groups.length&&<button type="button" style={historyButtonStyle} data-personal-one-history="later" onClick={()=>revealHistory("later")}>{copy("다음 대화 24개 보기","Show 24 later turns")}</button>}
          {snapshot?.delegations?.filter(item=>!item.originReplyRunId || !snapshot.turns?.some(turn=>turn.runId===item.originReplyRunId)).map(delegation)}
        </div>
      </div>
      </IntellectUiActions.Provider>
      <div ref={composerDock} className={styles.composerDock}>
        <OneFrontNote view={front.view} locale={ko?"ko":"en"} onOpenSetting={()=>void appearance()}/>
        <div className={styles.decisionStack}>
          {pendingAsk&&pendingAsk.sourceMessageId!==dismissedAskId&&<PersonalOneAskCard key={pendingAsk.sourceMessageId} ask={pendingAsk} locale={ko?"ko":"en"} disabled={Boolean(activeReply)||attachmentBusy} onAnswer={answer=>void send(answer)} onDismiss={()=>setDismissedAskId(pendingAsk.sourceMessageId)} />}
          <ComposerDecisionSlot surface="one" />
          {/* Only Main's exact pending requests may authorize an action. A current
              local permission selection must not resolve a previous run's card. */}
          <ToolApprovalInline chatId={snapshot?.conversationChatId} compact chip composerWidth={Math.max(300,Math.min(736,viewportWidth-(detached?32:250)))} />
          {/* Owner 2026-10-27: the rooms this personal agent oversees show their waiting approvals here too, after this
              conversation's own cards; each card still answers its own room. */}
          <PersonalOneSupervisedApprovals conversationChatId={snapshot?.conversationChatId} locale={ko?"ko":"en"}
            composerWidth={Math.max(300,Math.min(736,viewportWidth-(detached?32:250)))} onOpenRoom={href=>void openMain(href)} />
        </div>
        <AgiDefectChip chatId={snapshot?.conversationChatId ?? null} locale={ko?"ko":"en"} />
        {receipt?.state==="failed"&&receipt.kind!=="reply"&&<AgiIncidentReportButton key={receipt.commandId} locale={ko?"ko":"en"} draft={{
          chatId:snapshot?.conversationChatId,runId:receipt.runId ?? receipt.commandId,failureCode:"one_supervisor_command_failed",category:"other",
          title:"[Supervisor] Request failed",summary:receipt.reason || "The Supervisor request state became failed.",
          steps:["Submit a Supervisor request",`Request kind: ${receipt.kind}`],
        }} />}
        <input ref={attachmentPicker} type="file" multiple hidden onChange={event=>{if(event.target.files)void pickAttachments(Array.from(event.target.files));event.target.value="";}}/>
        {attachmentError&&<p role="alert" className={styles.feedback}>{attachmentError}</p>}
        {selectionSendBlocked&&<p role="status" className={styles.feedback}>{copy("모델 선택을 확인한 뒤 보내세요. 작성한 내용과 첨부는 그대로 유지됩니다.","Send after the model selection is confirmed. Your draft and attachments are unchanged.")}</p>}
        <MessageReplyPreview reply={messageReply} locale={locale} onDismiss={()=>setMessageReply(null)}/>
        {front.view&&!front.view.effective&&<p className={styles.feedback} data-one-personal-model-scope="true" title={copy("개인 One과의 대화에 사용할 모델입니다. Work 업무의 실행 모델은 업무별로 선택합니다.","The model for your personal One conversation. Choose the execution model separately for each Work task.")}>{copy("개인 대화 모델","Personal chat model")}</p>}
        <form ref={composerForm} className={styles.composer} data-one-composer="true" data-expanded={composerExpanded||composerNarrow} data-has-files={attachments.length>0} onSubmit={event=>{event.preventDefault();void send();}}>
          {attachments.length>0&&<div className={styles.attachmentDrafts} aria-label={copy("선택한 첨부","Selected attachments")}>{attachments.map((item,index)=><div className={styles.attachmentDraft} data-kind={item.preview?"image":"file"} key={index} title={item.draft.name}>
            {item.preview?<img src={item.preview} alt={item.draft.name}/>:<span className={styles.attachmentFile}><IconFileUp size={18}/><strong>{item.draft.name}</strong><small>{formatChatFileSize(item.draft.size)}</small></span>}
            <button type="button" aria-label={copy("첨부 삭제: ","Remove attachment: ")+item.draft.name} onClick={()=>{if(item.preview)URL.revokeObjectURL(item.preview);setAttachments(prior=>prior.filter((_,position)=>position!==index));}}><IconClose size={12}/></button>
          </div>)}</div>}
          <div ref={plusMenu} className={styles.plus}>
            <button type="button" className={styles.iconButton} aria-label={copy("추가","Add")} aria-haspopup="menu" aria-expanded={plusOpen} data-hover="own" onClick={()=>setPlusOpen(value=>!value)}><IconPlus size={20}/></button>
            {plusOpen&&<div className={styles.plusMenu} role="menu" aria-label={copy("추가","Add")}>
              <button type="button" role="menuitem" data-hover="own" disabled={attachmentBusy} onClick={()=>{setPlusOpen(false);attachmentPicker.current?.click();}}><span className={styles.plusIcon}><IconPlus size={15}/></span><strong>{copy("사진 및 파일 첨부","Attach photos and files")}</strong></button>
              <div className={styles.plusDivider}/>
              <div className={styles.plusSection}>{copy("맡기기","Hand off")}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);showTaskDrawer();setTaskPreviewOnly(false);setSelected(null);}}><span className={styles.plusIcon}><IconLayers size={15}/></span><strong>{copy("Work에 맡기기","Hand to Work")}</strong></button>
              {!!snapshot?.scienceProjects?.length&&<button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);showTaskDrawer();setTaskPreviewOnly(false);setSelected(null);}}><span className={styles.plusIcon}><IconSparkles size={15}/></span><strong>{copy("Science에 맡기기","Hand to Science")}</strong></button>}
              <div className={styles.plusDivider}/>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCapabilities("connections");}}>{copy("연결 도구","Connected tools")}</button>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCapabilities("repeat");}}>{copy("반복 업무","Recurring work")}</button>
              <button type="button" role="menuitem" onClick={()=>{setPlusOpen(false);setCheckinsOpen(true);}}>{copy("감시 조건","Monitoring")}</button>
              <div className={styles.plusSection}>{name}</div>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void openMemory();}}><span className={styles.plusIcon}><IconBrain size={15}/></span><strong>{copy("메모리","Memory")}</strong></button>
              <button type="button" role="menuitem" data-hover="own" onClick={()=>{setPlusOpen(false);void appearance();}}><span className={styles.plusIcon}><IconSettings size={15}/></span><strong>{copy("이름과 말풍선","Name and bubbles")}</strong></button>
            </div>}
          </div>
          <textarea ref={composerInput} aria-label={ko?name+"에게 메시지":"Message "+name} value={text} onChange={event=>{if(draftIdentity.current===null)initialDraftEdit.current={edited:true,value:event.target.value};setText(event.target.value);}} onCompositionUpdate={enter.onCompositionUpdate} onCompositionEnd={enter.onCompositionEnd} onKeyDown={event=>{enter.handleEnter(event);}} onPaste={event=>{
            // Clipboard files (screenshots, Finder copies, audio, video, documents) become attachments; plain text pastes as text.
            const clipboard=event.clipboardData;if(!clipboard)return;const files:File[]=[];const seen=new Set<string>();
            const add=(file:File|null)=>{if(!file)return;const id=`${file.name}|${file.size}|${file.type}`;if(seen.has(id))return;seen.add(id);files.push(file);};
            for(const file of Array.from(clipboard.files))add(file);
            if(!files.length)for(const item of Array.from(clipboard.items))if(item.kind==="file")add(item.getAsFile());
            if(!files.length)return;event.preventDefault();void pickAttachments(files);
          }} maxLength={8000} rows={1} placeholder={copy("메시지 보내기","Send a message")}/>
          <div ref={composerTrail} className={styles.trail}>
            {front.view?.effective?<OneFrontChip locale={ko?"ko":"en"} onOpenSetting={()=>void appearance()}/>:<OneRuntimeChips chatId={snapshot?.conversationChatId ?? null} locale={ko?"ko":"en"} disabled={!snapshot} />}
            <div className={styles.voice}><OneVoiceInputHelp locale={ko?"ko":"en"} composerRef={composerInput} /></div>
          </div>
          <button className={styles.send} type="submit" aria-label={copy("보내기","Send")} disabled={!snapshot||savedRequestError||attachmentBusy||selectionSendBlocked||(!text.trim()&&!attachments.length)}><IconArrowUp size={16}/></button>
        </form>
        {activeReply?.runId&&<button className={styles.stopReply} onClick={()=>void write("stopReply",{runId:activeReply.runId!}).then(value=>{showReceipt(value);void sync();}).catch(()=>setError(true))}>{copy("이 답변 중지","Stop this reply")}</button>}
      </div>
    </main>
    <BrowserActionApprovalSheet chatId={snapshot?.conversationChatId ?? null} />
    {live?.keyRequest && live.keyRequest.runId!==dismissedKeyRun && <McpKeyRequestSheet key={live.keyRequest.runId}
      request={live.keyRequest} presentation="one" localeOverride={ko?"ko":"en"} onResolved={()=>setDismissedKeyRun(live.keyRequest!.runId)} />}
    <div className={styles.outputPanel} data-personal-one-output-panel="true" data-visible={outputPanelVisible} style={{'--personal-panel-width':shownPanelWidth+'px','--personal-composer-height':composerHeight+'px','--personal-context-bottom':contextBottom+'px'} as CSSProperties}>
      <aside className={styles.taskDrawer} hidden={!taskDrawerVisible} aria-labelledby="one-task-heading" data-one-task-drawer="true" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setTasksOpen(false);composerInput.current?.focus();}}}>
        <div className={styles.panelResize} role="separator" tabIndex={0} aria-label={copy("결과 영역 너비","Result panel width")} aria-orientation="vertical" aria-valuemin={280} aria-valuemax={Math.round(panelMaxWidth)} aria-valuenow={Math.round(shownPanelWidth)}
          onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();resizePanel(shownPanelWidth+(event.key==="ArrowLeft"?24:-24));}}}
          onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();const element=event.currentTarget;const start=event.clientX;const width=element.parentElement?.getBoundingClientRect().width ?? shownPanelWidth;element.setPointerCapture(event.pointerId);const move=(next:PointerEvent)=>resizePanel(width+start-next.clientX);const end=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",end);element.removeEventListener("pointercancel",end);};element.addEventListener("pointermove",move);element.addEventListener("pointerup",end);element.addEventListener("pointercancel",end);}}/>
        <div className={styles.taskContents} aria-label={copy("독립 작업","Independent tasks")}><header><h2 id="one-task-heading">{copy("작업과 결과","Tasks and results")}</h2>{viewportWidth>=860&&<button type="button" aria-label={shownPanelWidth>=panelMaxWidth-1?copy("결과 너비 자동 맞춤","Fit result width automatically"):copy("결과 펼치기","Expand result")} aria-pressed={shownPanelWidth>=panelMaxWidth-1} title={copy("같은 결과를 넓게 보기","Review the same result at full available width")} onClick={()=>shownPanelWidth>=panelMaxWidth-1?setAutoPanelWidth(true):resizePanel(panelMaxWidth)}><IconExpand size={16}/></button>}{taskPreviewOnly&&<button type="button" onClick={()=>setTaskPreviewOnly(false)}>{copy("모든 작업","All tasks")}</button>}<button type="button" aria-label={copy("작업 닫기","Close tasks")} onClick={()=>setTasksOpen(false)}><IconClose size={17}/></button></header>
      {!taskPreviewOnly&&<>
      <label>{copy("Work에 맡길 일","Hand work to Work")}<textarea value={work} onChange={event=>setWork(event.target.value)} maxLength={8000}/></label>
      <div role="group" aria-label={copy("이 Work 업무의 실행 모델","Execution model for this Work task")} data-one-work-runtime="true">
        <p>{copy("이 Work 업무의 실행 모델","Execution model for this Work task")}</p>
        {taskDrawerVisible&&<OneRuntimeChips chatId={null} locale={ko?"ko":"en"} disabled={workPending||!snapshot} draftSelection={{value:workRuntime,onChange:setWorkRuntime}} />}
      </div>
      <label>{copy("이 Work 업무에 사용할 실행 예산","Execution budget for this Work task")}<Select aria-label={copy("이 Work 업무에 사용할 실행 예산","Execution budget for this Work task")} value={budgetId} onChange={event=>setBudgetId(event.target.value)}><option value="">{copy("제한 없이 관측만 (기본)","Unrestricted observation (default)")}</option>{budgets.items.filter(item=>item.limitUsd!==null).map(item=><option key={item.budgetId} value={item.budgetId}>{personalOneBudgetName(item,ko?"ko":"en")}</option>)}{budgetSelectionUnconfirmed&&<option value={budgetId}>{copy("선택 예산 확인 필요","Selected budget needs review")}</option>}</Select></label>
      <p className={styles.feedback}>{budgetSelectionUnconfirmed?copy("선택한 예산의 최신 정책을 확인하지 못했습니다. 예산 관측을 확인하거나 기본 관측으로 직접 변경해 주세요.","The selected budget policy is unconfirmed. Review budget observations or explicitly choose the default observation mode."):budgetId?copy("이 업무의 후속 실행도 같은 예산에서 예약합니다. 공급자의 실제 청구 상한을 보장하지 않습니다.","Follow-up runs reserve from the same task budget. Actual provider charges are not capped."):copy("예산을 선택하지 않으면 제한 없이 관측합니다. 실제 청구가 미확정일 수 있습니다.","Without a selected budget, execution is unrestricted observation. Actual billing may remain unconfirmed.")}</p>
      <button type="button" onClick={()=>setBudgetsOpen(true)}>{copy("예산 설정과 비용 관측","Budget settings and billing observations")}</button>
      <button disabled={workPending||!snapshot||!work.trim()||budgetSelectionUnconfirmed} onClick={()=>void startWork()}>{copy("Work 시작","Start Work")}</button><button onClick={()=>void openMain("/science")}>{copy("Science 열기","Open Science")}</button>
      {!!snapshot?.scienceProjects?.length&&<><label>{copy("Science 프로젝트","Science project")}<Select value={scienceProject} onChange={event=>setScienceProject(event.target.value)}><option value="">{copy("프로젝트 선택","Choose a project")}</option>{snapshot.scienceProjects.map(project=><option key={project.projectId} value={project.projectId}>{project.title}</option>)}</Select></label><button disabled={workPending||!scienceProject||!work.trim()} onClick={()=>void startWork(true)}>{copy("Science에 맡기기","Hand off to Science")}</button></>}
      {snapshot?.scienceError&&<p className={styles.feedback}>{copy("Science 관측 연결을 확인할 수 없습니다.","Science observation is unavailable.")}</p>}
      {receipt&&receipt.kind!=="reply"&&<p role="status" className={styles.feedback}>{receiptCopy(receipt)}</p>}
      <div className={styles.taskList}>{snapshot?.tasks.map(item=><button key={item.taskId} data-task-id={item.taskId} data-selected={selected===item.taskId} onClick={()=>{setSelected(item.taskId);setSelectedHandoff(null);setTaskPreviewOnly(true);}}><strong>{item.title}</strong><span>{item.surface==='science'?'Science':item.surface==='one'?'One':'Work'} · {stateLabel(item.state)}</span></button>)}</div>
      </>}
      {taskPreviewOnly&&!task&&<p role="status">{handoff?stateLabel(handoff.state):copy('작업 관측을 확인하고 있습니다.','Checking the task observation.')}</p>}
      {task&&<section className={styles.detail}><h3>{task.title}</h3><p>{task.surface==='science'?'Science':task.surface==='one'?'One':'Work'} · {stateLabel(task.state)}</p>
        {task.controls.includes("steer")&&<><textarea aria-label={copy("이 작업에 추가 지시","Direction for this task")} value={direction} onChange={event=>setDirection(event.target.value)} maxLength={8000}/><button disabled={controlPending||!direction.trim()} onClick={()=>void control(task,"steer")}>{copy("이 작업에 지시 전달","Send direction to this task")}</button></>}
        {(!terminal(task.state)||task.controls.includes("cancel"))&&<button disabled={stopPending===task.taskId} onClick={()=>void stopTask(task)}>{copy("이 작업 중지 요청","Request task stop")}</button>}
        <small>{task.owner==='science-daemon'?'Science':'Work'} · {copy('내 컴퓨터','This computer')} · {copy('관측','Observed')} {new Date(task.observedAt).toLocaleTimeString()}</small>
        {snapshot&&<PersonalOneTaskResult key={task.taskId} oneId={snapshot.oneId} task={task} requestedRunId={handoff?.runId ?? undefined} locale={ko?"ko":"en"} fallbackText={exactResult} visible={taskDrawerVisible} onOpenLinkedFile={reference=>{if(task.chatId)openFile(reference,task.chatId);}} onRefresh={()=>void sync()}/>}
        {!exactResult&&<p>{handoff&&task.runId!==handoff.runId?copy('이 작업은 새 실행으로 이어졌습니다. 원래 작업에서 확인하세요.','This task has moved to a new attempt. Review its originating work.'):copy('관측된 결과가 나오면 이곳에서 확인할 수 있습니다.','An observed result will appear here.')}</p>}
        {(task.chatId||task.surface==='science')&&<button className={styles.goToTask} onClick={()=>void openMain(taskRoute(task))}>{task.surface==='science'?copy('Science 열기','Open Science'):copy("원래 대화 열기","Go to chat")}</button>}
      </section>}
    </div>
      </aside>
      <TaskSidePanel key={panelChatId ?? "one-files"} items={[]} locale={ko?'ko':'en'} visible={!!file||artifactOpen} onEmptyChange={setOutputPanelEmpty} screenChatId={panelChatId} browserScopeKey={panelChatId ?? 'personal-one-unbound'} width={shownPanelWidth} minWidth={280} maxWidth={panelMaxWidth} onResize={resizePanel} onRequestReadableWidth={resizePanel} onRequestOpen={()=>setArtifactOpen(true)} onClose={()=>{setFile(null);setArtifactOpen(false);}}/>
    </div>
    <OneBottomSheet open={appearanceOpen} onClose={()=>setAppearanceOpen(false)} closeLabel={copy("설정 닫기","Close appearance")} ariaLabel={copy("나의 One","Your One")} title={copy("나의 One","Your One")} icon={<IconSettings size={20} />} size="compact" footer={<button className={styles.saveAppearance} disabled={!profile||savingProfile||!profileName.trim()} onClick={()=>void saveAppearance()}>{copy("저장","Save")}</button>}>
      <div className={styles.appearance}>{profileError&&<p role="status">{copy("저장을 확인하지 못했습니다. 최신 설정을 확인하고 다시 저장해 주세요.","The save could not be confirmed. Review the latest settings and save again.")}</p>}<label>{copy("이름","Name")}<input aria-label={copy("One 이름","One name")} value={profileName} onChange={event=>setProfileName(event.target.value)} maxLength={64}/></label><fieldset className={styles.bubbleChoices}><legend>{copy("말풍선 색","Bubble color")}</legend><div role="radiogroup" aria-label={copy("말풍선 색","Bubble color")}>{Object.keys(ONE_BUBBLE_COLORS).map(color=><button type="button" key={color} role="radio" aria-checked={bubbleColor===color} aria-label={({blue:copy("파랑","Blue"),green:copy("초록","Green"),purple:copy("보라","Purple"),rose:copy("장미","Rose"),amber:copy("호박","Amber"),slate:copy("회색","Slate")} as Record<string,string>)[color]} onClick={()=>setBubbleColor(color as OneBubbleColor)} style={{background:ONE_BUBBLE_COLORS[color as OneBubbleColor]}}>{bubbleColor===color&&<IconCheck size={18}/>}</button>)}</div></fieldset><p className={styles.preview} style={{background:ONE_BUBBLE_COLORS[bubbleColor]}}>{profileName||name}</p><OneFrontSetting controller={front} locale={ko?"ko":"en"}/></div>
    </OneBottomSheet>
    <OneFrontNotice controller={front} locale={ko?"ko":"en"}/>
    <PersonalOneBudget open={budgetsOpen} oneId={snapshot?.oneId} locale={ko?"ko":"en"} items={budgets.items} unconfirmed={budgets.unconfirmed} onRefresh={budgets.refresh} onClose={()=>setBudgetsOpen(false)}/>
    <PersonalOneCheckins open={checkinsOpen} oneId={snapshot?.oneId} locale={ko?"ko":"en"} onClose={()=>setCheckinsOpen(false)} onRefresh={()=>void sync()}/>
    <OneCapabilitiesModal open={capabilitiesModal} locale={ko?"ko":"en"} onClose={()=>setCapabilitiesModal(false)}/>
    <PersonalOneCapabilities oneId={snapshot?.oneId} open={capabilities} locale={ko?"ko":"en"} chatId={snapshot?.conversationChatId} onClose={()=>setCapabilities(null)} onPrompt={prompt=>{setText(prompt);composerInput.current?.focus();}}/>
    <OneMemorySheet open={memoryOpen} state={memory} locale={ko?"ko":"en"} useOnceTarget={null} onClose={closeMemory} onStateChange={setMemory} onUseOnceReady={()=>{}}/>
    <OneBottomSheet open={securityOpen} onClose={()=>setSecurityOpen(false)} closeLabel={copy("닫기","Close")} ariaLabel={copy("보안과 연결 관리","Security and connections")} title={copy("보안과 연결 관리","Security and connections")} size="compact"><OneSecurityFeatures/></OneBottomSheet>
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
