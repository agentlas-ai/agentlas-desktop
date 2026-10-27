import { withOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import { readOrdinaryOneTurn, type OrdinaryOneTurnSource } from "../invocation/ordinary-one-turn";
import { oneGoalRoomTurnOnDesktop } from "../invocation/goal-owner-route";
import { supervisorError } from "../../shared/one-supervisor";
import { createHash } from 'node:crypto';
import { chatFilePrompt, chatFileImages, validateChatAttachmentSelection } from "../store/chat-message-attachments";
import { getDb, openedStoreMigrationRole } from "../store/db";
import { getOneProfile, getOneProfileOrigin, updateOneProfile } from "../store/one-profile";
import { oneFrontRuntimeSelection } from "./front";
import { createChat, createProjectWorkChat, getChat, appendChatMessage, listChatMessages, normalizeChatRuntimeSelection, getChatWorkingFolder, setChatWorkingFolder } from "../store/chats";
import { ensurePersonalOneWorkspace, exportPersonalSession } from "./personal-workspace";
import { ensureCanonicalTaskForChat, listCanonicalTasks, getCanonicalTaskForChat, hasPassedTaskForceExecutionVerification } from "../store/tasks";
import { getProject } from "../store/projects";
import { grantChatAlwaysApproval } from "../store/capability-grants";
import { queuedSteerState } from "../store/invocation-steers";
import { getLongRunByGoalId } from "../store/long-runs";
import { invocationService } from "../invocation/service";
import { admitMainInvocation } from "../runtime/scheduled-root-context";
import { canonicalInvocationRequestJson, getInvocationAdmission, INVOCATION_ADMISSION_DIGEST_VERSION } from '../store/invocation-admissions';
import { currentUiLocale } from "../ui-locale";
import { OneSupervisorStore, supervisorHash, personalSupervisorConversationInDb, supervisorStoppedGoalForTask, type SupervisorRequestRow } from "./supervisor-store";
import { OneSupervisorService, SupervisorStartDeferred, type SupervisorRuntime } from "./supervisor-service";
import { SupervisorScienceAdapter } from "./supervisor-science";
import { supervisorExactResult, supervisorQuietRun, supervisorReplyTurns } from "./supervisor-presentation";
import { onAskUserLifecycle } from "../confirm/ask-user";
import { registerOneGraphResultWake, registerOneHostAlertSink, registerOneTeamResultSink } from "./host-alerts";
import { personalGraphTasks } from "./graph-review";
import { getAutomationLiveRunId, getAutomationLiveRunState, listAutomations } from "../store/automations";
import { OneSupervisorLegacyMigration } from './supervisor-migration';
import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { SupervisorTask, SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { OneSupervisorWorkQueue } from "./supervisor-work-queue";
import { OneSupervisorWorkExecutor } from "./supervisor-work-executor";
import { OneSupervisorOwner } from "./supervisor-owner";
import {OneBudgetStore} from "./budget-store";
import {OneBudgetRuntime} from "./budget-runtime";
import { createSupervisorNativeRuntime, oneSupervisorNativeRuntime, startSupervisorPreparedInvocation } from "./supervisor-native-runtime";
import { invocationRunOwners, invocationProcessOwner } from "../store/invocation-run-owners";
import { assertDesktopLongRunAdmissionOpen, desktopAppInstanceId, registerAppRuntimeParticipant } from "../long-run/app-runtime-coordinator";
import { assertOnePersonalDataInvocationCurrent, collectOnePersonalDataResult, recoverOnePersonalDataResults } from './personal-data-runtime';
import { assertOneHistoryCommandCurrent, wakeOnePersonalIntegrationsFromExistingCheckin, closeOnePersonalIntegrations } from './personal-integrations-runtime';

interface SupervisorHostOptions { executor?:"desktop-local"|"agentlas-cloud"; ownerKind:'desktop-main'|'work-daemon';ownerEpoch:string;assertAuthority():void }
let hostOptions:SupervisorHostOptions|undefined;
let hostOwner:OneSupervisorOwner|null=null;
let stopProactiveHost:(()=>void)|undefined;
let stopBudgetHost:(()=>void)|undefined;
let supervisor:OneSupervisorService|null=null;
/** Set once this process handed the One domain to the daemon; Desktop keeps no personal-domain owner afterwards. */
let domainHandedToDaemon=false;
export function configureOneSupervisorDaemonHost(options:SupervisorHostOptions):void {
  if(supervisor || options.ownerKind!=='work-daemon')throw supervisorError('supervisor_host_already_initialized');
  options.assertAuthority();hostOptions=options;
}
export function closeOneSupervisorHostAdmission():void {
  closeOnePersonalIntegrations();
  hostOwner?.closeAdmission();workExecutor?.close();stopProactiveHost?.();stopBudgetHost?.();supervisor?.close();nativeRuntime?.close();
}
/**
 * True while the background daemon holds the personal One domain, whether this Main handed it over or lost the race
 * for it at start (the daemon adopted it first). Main must then neither build its own supervisor nor treat the
 * unconfirmed ownership as a failure of an owner action (production 1.3.5, 2026-10-12T22:15Z: a question-card answer
 * in a Goal room was refused supervisor_owner_unconfirmed). Only a live work-daemon row counts; a dead or released
 * owner is taken over by oneSupervisor() as before.
 */
export function personalDomainHeldByDaemon():boolean {
  if(domainHandedToDaemon)return true;
  if(supervisor||hostOptions)return false;
  try {
    const row=getDb().prepare("SELECT owner_kind,owner_pid,phase FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as {owner_kind:string;owner_pid:number;phase:string}|undefined;
    if(!row||row.owner_kind!=='work-daemon'||row.phase==='released'||row.owner_pid===process.pid)return false;
    try { process.kill(row.owner_pid,0); return true; }
    catch(error){ return (error as NodeJS.ErrnoException)?.code!=='ESRCH'; }
  } catch { return false; }
}
export function supervisorRunsInDaemon():boolean { return hostOptions?.ownerKind==='work-daemon'; }
export function prepareOneSupervisorDaemonHandoff():{oneId:string;ownerEpoch:string;generation:number}|null {
  if(!supervisor || !hostOwner)return null;
  if(hostOptions || invocationService.activeChatIds().length || nativeRuntime?.pendingCount || oneSupervisorNativeRuntime()?.owner.retainedCount)return null;
  const token=hostOwner.current();if(!token || token.phase!=='active')return null;
  hostOwner.closeAdmission();workExecutor?.close();stopProactiveHost?.();stopBudgetHost?.();supervisor.close();nativeRuntime?.close();hostOwner.release();
  closeOnePersonalIntegrations();
  domainHandedToDaemon=true;
  return {oneId:token.oneId,ownerEpoch:token.ownerEpoch,generation:token.generation};
}
let science:SupervisorScienceAdapter|undefined;
let workExecutor: OneSupervisorWorkExecutor | null = null;
let nativeWorkQueue: OneSupervisorWorkQueue | null = null;
let nativeBudget: OneBudgetStore | null = null;
const nativeBudgetAdmissions = new Map<string,string>();
let nativeRuntime: ReturnType<typeof createSupervisorNativeRuntime> | null = null;
export function configureOneSupervisorScience(client:Pick<ScienceDaemonClient,"commandObserved">):void {
  science=new SupervisorScienceAdapter(client);
}
/** An unset working folder becomes the personal output folder; a folder the owner chose stays (21 G2). */
function bindPersonalFolder(chatId:string):void {
  try {
    if(!getChatWorkingFolder(chatId))setChatWorkingFolder(chatId,ensurePersonalOneWorkspace(getOneProfile().oneId,chatId).output);
  } catch(error){console.warn("[one-supervisor] personal folder deferred",error instanceof Error?error.message:"unknown");}
}
export function isPersonalSupervisorConversation(chatId:string):boolean {
  return personalSupervisorConversationInDb(getDb(),getOneProfile().oneId,chatId);
}
function discoveredDesktopTasks() {
  const discovered=new Map(listCanonicalTasks({limit:100,reconcile:false}).map(task=>[task.id,task]));
  for(const chatId of invocationService.activeChatIds()) {const task=getCanonicalTaskForChat(chatId);if(task) discovered.set(task.id,task);}
  return discovered;
}
function desktopTaskProjection(task:ReturnType<typeof listCanonicalTasks>[number]):SupervisorTask[] {
    const chat=task.originChatId ? getChat(task.originChatId) : null;
    if (!chat || chat.kind==="division") return [];
    const receipt=invocationService.latestReceipt(chat.id);
    const goalId=chat.goalId ?? supervisorStoppedGoalForTask(getDb(),task.id,receipt?.runId ?? null);
    const goal=goalId ? getLongRunByGoalId(goalId) : null;
    const state=goal?.status ?? receipt?.status ?? task.status;
    const nativeOwner=invocationRunOwners.getActiveOwner(chat.id);
    const active=!!invocationService.attach(chat.id,{includeEvents:false}) || !!nativeRuntime?.attach(chat.id);
    const result=supervisorExactResult(getDb(),chat.id,receipt?.runId ?? null)?.text ?? null;
    return [{taskId:task.id,surface:chat.originSurface === "one" ? "one" as const : "work" as const,title:task.title,
      chatId:chat.id,projectId:chat.projectId,goalId:goal?.goalId ?? null,runId:receipt?.runId ?? null,state,
      controlVersion:supervisorHash([task.id,state,receipt?.runId,goal?.goalId,goal?.status,goal?.version]),observedAt:goal?.updatedAt ?? receipt?.updatedAt ?? task.updatedAt,
      owner:nativeOwner?.ownerKind==="daemon" ? "work-daemon" as const : "desktop-main" as const,controls:!["cancelling","cancelled","completed","paused","pausing","failed"].includes(state)
        ? active ? ["steer" as const,"cancel" as const] : goal ? ["cancel" as const] : [] : [],
      result,resultVerified:!!result && task.status==="completed" && receipt?.status==="completed" && hasPassedTaskForceExecutionVerification(receipt.runId)}];
}
function desktopTasks():SupervisorTask[] {
  return [...discoveredDesktopTasks().values()].flatMap(desktopTaskProjection);
}
/** Same native task projection as Supervisor controls; no async snapshot cache or new version. */
export function currentOneNativeWorkControl(row:Readonly<SupervisorRequestRow>,purpose:'active'|'result'='active'):string|null {
  if(!row.task_id||!row.run_id||row.one_id!==getOneProfile().oneId)return null;
  if(getDb().prepare("SELECT 1 FROM one_supervisor_requests WHERE task_id=? AND run_id=? AND kind='cancel' AND state<>'failed'").get(row.task_id,row.run_id))return null;
  // Keep the exact listing eligibility, but read chat/Goal/result custody only for this task.
  const canonicalTask=discoveredDesktopTasks().get(row.task_id);
  const task=canonicalTask ? desktopTaskProjection(canonicalTask)[0] : undefined;
  if(!task || task.runId!==row.run_id)return null;
  if(purpose==='result')return row.state==='completed'&&task.state==='completed'&&task.resultVerified?task.controlVersion:null;
  if(['completed','cancelled','failed','interrupted','cancelling'].includes(task.state))return null;
  const job=nativeWorkQueue?.get(row.command_id);
  return job&&job.run_id===row.run_id&&['queued','claimed','held'].includes(job.phase)?nativeWorkQueue!.version(job):task.controlVersion;
}
/** The existing admission owner proves this exact reservation; this never reserves a second budget. */
export function currentOneNativeWorkBudget(commandId:string,budgetId:string):{admitted:boolean;revision:number|null}|null {
  if(!nativeBudget||!nativeWorkQueue)return null;
  const row=getDb().prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(commandId) as SupervisorRequestRow|undefined;
  const job=nativeWorkQueue.get(commandId);
  if(!row||!job||row.one_id!==getOneProfile().oneId||row.task_id!==job.task_id||row.run_id!==job.run_id
    ||row.one_id!==job.one_id||!['dispatching','accepted','completed'].includes(row.state)
    ||!['starting','running','completed'].includes(job.phase))return null;
  const reservation=nativeBudget.forRun(job.run_id),policy=nativeBudget.snapshot({oneId:row.one_id,budgetId})[0];
  if(!reservation||!policy||reservation.command_id!==commandId||reservation.one_id!==row.one_id
    ||reservation.task_id!==job.task_id||reservation.chat_id!==job.chat_id||reservation.budget_id!==budgetId
    ||reservation.policy_revision!==policy.revision
    ||nativeBudget.taskBudget(row.one_id,job.task_id)!==budgetId
    ||policy.limitUsd!==null&&policy.knownSubtotalUsd>policy.limitUsd)return null;
  if(nativeBudgetAdmissions.get(job.run_id)!==reservation.binding_hash) {
    // Restart recovery is read/publication only. A missing active-run capability never starts work.
    if(row.state!=='completed'||job.phase!=='completed'||!currentOneNativeWorkControl(row,'result'))return null;
    const custody=invocationRunOwners.getRunOwner(job.chat_id,job.run_id),admission=getInvocationAdmission(job.run_id);
    if(custody?.state!=='released'||admission?.status!=='admitted'||admission.chatId!==job.chat_id)return null;
    const db=getDb();if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get())return null;
    const persisted=db.prepare('SELECT value_json FROM one_history_native_bindings WHERE command_id=?').get(commandId) as {value_json:string}|undefined;
    try {const witness=JSON.parse(persisted?.value_json??'{}').nativeBudgetAdmission;
      if(!witness||witness.commandId!==commandId||witness.oneId!==row.one_id||witness.taskId!==job.task_id||witness.runId!==job.run_id||witness.chatId!==job.chat_id||witness.payloadHash!==row.payload_hash||witness.reservationBindingHash!==reservation.binding_hash||witness.nativeInputDigest!==admission.inputDigest)return null;
    }catch{return null;}
  }
  return {admitted:true,revision:reservation.policy_revision};
}
/** Nothing was started for a run when the admission ledger has no row for it, or has rejected it (owner-start-boundary-not-crossed). */
function noStartProof(runId:string):boolean {
  try { const admission=getInvocationAdmission(runId); return !admission || admission.status==='rejected'; } catch { return false; }
}
export function oneSupervisor():OneSupervisorService {
  if (supervisor) return supervisor;
  if(!hostOptions && invocationProcessOwner().ownerKind==="daemon")throw Object.assign(supervisorError('supervisor_daemon_domain_not_adopted'),{code:"supervisor_daemon_domain_not_adopted"});
  const legacy=new OneSupervisorLegacyMigration(getDb());
  const store = new OneSupervisorStore(getDb());
  const owner = new OneSupervisorOwner(getDb(),{ownerEpoch:hostOptions?.ownerEpoch ?? desktopAppInstanceId(),ownerKind:hostOptions?.ownerKind ?? 'desktop-main'});
  hostOptions?.assertAuthority();hostOwner=owner;
  owner.assert(getOneProfile().oneId);
  if(!hostOptions)nativeRuntime=createSupervisorNativeRuntime({store,owner,identity:()=>getOneProfile().oneId,receipt:runId=>invocationService.receipt(runId)});
  const attach=(chatId:string)=>nativeRuntime?.attach(chatId) ?? invocationService.attach(chatId,{includeEvents:false});
  const receipt=(runId:string)=>nativeRuntime?.receipt(runId) ?? invocationService.receipt(runId);
  const onSettled:SupervisorRuntime["onSettled"]=listener=>{const local=invocationService.onSettled(listener),native=nativeRuntime?.onSettled(listener);return ()=>{local();native?.();};};
  // Schema migration role does not confer execution authority. The fenced
  // Supervisor domain owner alone may run the durable queue in either host.
  const hostsWork = openedStoreMigrationRole() !== null;
  const workQueue = new OneSupervisorWorkQueue(getDb(), hostsWork);
  nativeWorkQueue=workQueue;
  const assertBudgetOwner=(oneId:string)=>{
    hostOptions?.assertAuthority();
    if(oneId!==getOneProfile().oneId)throw supervisorError("supervisor_budget_identity_changed");
    owner.assert(oneId,true);
  };
  const budget=new OneBudgetStore(getDb(),assertBudgetOwner);
  nativeBudget=budget;
  const budgetRuntime=new OneBudgetRuntime({budget,store,oneId:()=>getOneProfile().oneId,assertOwner:()=>assertBudgetOwner(getOneProfile().oneId),receipt});
  const startNative = async (req: Parameters<typeof invocationService.start>[0], hostNoticePurpose?: SupervisorHostNoticePurpose) => {
    if (hostOptions?.executor === "agentlas-cloud" && (req.goalMode || getChat(req.chatId)?.goalId)) throw supervisorError("managed_one_goal_unavailable");
    if (getDb().inTransaction) throw supervisorError('supervisor_native_uncommitted_request');
    hostOptions?.assertAuthority();owner.assert(getOneProfile().oneId);
    if(req.runId)try { await (await import('../finance/daily-briefing')).assertFinanceDailyReview(req.runId); }
    catch(error) {
      if(error instanceof Error && error.message==='finance_daily_review_denied') {
        // This rejection is before budget/native admission: retry only the other notices in a mixed review.
        store.db.transaction(()=>{
          const row=store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'").get(getOneProfile().oneId,req.runId) as SupervisorRequestRow|undefined;
          if(row){store.retryReview(req.runId!,'finance_daily_review_denied');store.update(row,{state:'failed',acknowledgement:'settled',reason:'finance_daily_review_denied'});}
        }).immediate();
      }
      // Billing could not be reached: nothing was decided and the schedule is kept. The service returns the review's
      // results to the queue (with backoff) and records this typed cause.
      if(error instanceof Error && error.message==='finance_daily_access_unavailable')throw new SupervisorStartDeferred('finance_monitoring_access_unavailable');
      throw error;
    }
    hostOptions?.assertAuthority();owner.assert(getOneProfile().oneId);
    if (req.runId) {
      const command = store.db.prepare('SELECT command_id FROM one_supervisor_requests WHERE run_id=?').get(req.runId) as {command_id:string}|undefined;
      if (command) assertOnePersonalDataInvocationCurrent(command.command_id);
      if(command && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_native_bindings'").get()
        && store.db.prepare('SELECT 1 FROM one_personal_data_native_bindings WHERE command_id=?').get(command.command_id)) {
        req={...req,oneMode:true,onePermissionMode:'read'};
      }
    }
    if (req.runtimeSelection) req={...req,runtimeSelection:normalizeChatRuntimeSelection(req.runtimeSelection) ?? undefined};
    // The target's persisted surface owns its execution contract. A handoff into
    // an existing One room must not accidentally enter the Work-only route.
    if (getChat(req.chatId)?.originSurface === "one") req={...req,oneMode:true,onePermissionMode:req.onePermissionMode ?? req.permissions};
    return budgetRuntime.dispatch(req,()=>{
      const row=store.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND state='dispatching'").get(getOneProfile().oneId,req.runId) as SupervisorRequestRow|undefined;
      if(!row||!req.runId)throw supervisorError('supervisor_budget_original_command_required');
      const digest=supervisorHash({commandId:row.command_id,oneId:row.one_id,taskId:row.task_id,runId:req.runId,chatId:req.chatId,bindingHash:canonicalInvocationRequestJson(req)});
      if(budget.forRun(req.runId)?.binding_hash!==digest)throw supervisorError('supervisor_budget_reservation_conflict');
      if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get()) {
        const bound=store.db.prepare('SELECT value_json FROM one_history_native_bindings WHERE command_id=?').get(row.command_id) as {value_json:string}|undefined;
        if(bound){const binding=JSON.parse(bound.value_json),witness={commandId:row.command_id,oneId:row.one_id,taskId:row.task_id,runId:req.runId,chatId:req.chatId,payloadHash:row.payload_hash,reservationBindingHash:digest,nativeInputDigest:createHash('sha256').update(INVOCATION_ADMISSION_DIGEST_VERSION+'\0').update(canonicalInvocationRequestJson(req)).digest('hex')};
          if(binding.nativeBudgetAdmission&&supervisorHash(binding.nativeBudgetAdmission)!==supervisorHash(witness))throw supervisorError('supervisor_budget_original_command_required');
          if(!binding.nativeBudgetAdmission&&store.db.prepare('UPDATE one_history_native_bindings SET value_json=? WHERE command_id=? AND value_json=?').run(JSON.stringify({...binding,nativeBudgetAdmission:witness}),row.command_id,bound.value_json).changes!==1)throw supervisorError('supervisor_budget_original_command_required');
        }
      }
      const previousAdmission=nativeBudgetAdmissions.get(req.runId);
      nativeBudgetAdmissions.set(req.runId,digest);
      try {assertOneHistoryCommandCurrent(row.command_id, 'dispatch');}
      catch(error){
        if(previousAdmission===undefined)nativeBudgetAdmissions.delete(req.runId);
        else nativeBudgetAdmissions.set(req.runId,previousAdmission);
        throw error;
      }
      while(nativeBudgetAdmissions.size>1000)nativeBudgetAdmissions.delete(nativeBudgetAdmissions.keys().next().value!);
      if(hostOptions){hostOptions.assertAuthority();return startSupervisorPreparedInvocation({store,owner,oneId:getOneProfile().oneId,request:req,purpose:hostNoticePurpose,epoch:hostOptions.ownerEpoch});}
      if(oneSupervisorNativeRuntime())return nativeRuntime!.start(req,hostNoticePurpose);
      // A local personal reply or delegated Work run without a domain host
      // still needs the original Main preparation. Plain start has no durable
      // invocation admission, so later native result custody cannot prove the
      // exact input/owner epoch. The prepared path retains this process's
      // original budget, owner and run identity for both command kinds.
      if(row.kind==="reply"||row.kind==="work")return startSupervisorPreparedInvocation({store,owner,oneId:getOneProfile().oneId,request:req,purpose:hostNoticePurpose,epoch:invocationProcessOwner().ownerId});
      return invocationService.start(req,undefined,undefined,undefined,hostNoticePurpose,admitMainInvocation(req.chatId,req.runId));
    });
  };
  supervisor=new OneSupervisorService({
    store,owner,budget,executor:hostOptions?.executor,identity:getOneProfile,assertAuthority:()=>hostOptions?.assertAuthority(),workQueue,workIdentityMutable:hostsWork,wakeWorkQueue:()=>queueMicrotask(()=>workExecutor?.kick()),
    createConversation:()=>{const id=createChat({originSurface:"one",taskMode:"conversation",title:getOneProfile().displayName}).id;bindPersonalFolder(id);return id;},
    history:chatId=>listChatMessages(chatId,100),appendUser:(chatId,text,images)=>{
      const groupId=/<!-- agentlas-chat-files:v1:([0-9a-f-]{36}) -->/i.exec(text)?.[1];
      validateChatAttachmentSelection(chatId,groupId,images);
      const allImages=[...(images ?? []),...chatFileImages(chatId,groupId)];
      return appendChatMessage(chatId,"user",text,allImages.length ? {images:allImages} : undefined).id;
    },attachmentPrompt:chatFilePrompt,
    createWork:input=>{
      if (input.projectId && !getProject(input.projectId)) throw supervisorError('supervisor_work_project_missing');
      const title=input.text.split(/\r?\n/,1)[0].slice(0,120);
      const chat=input.projectId ? createProjectWorkChat({projectId:input.projectId,title}) : createChat({originSurface:"work",taskMode:"task",title});
      if (hostOptions?.executor === "agentlas-cloud") bindPersonalFolder(chat.id);
      const task=ensureCanonicalTaskForChat(chat.id);
      if (!task) throw supervisorError('supervisor_work_task_missing');
      // The native Work invocation persists its own human input once. The
      // atomic supervisor request already durably owns this brief before dispatch.
      return {chatId:chat.id,taskId:task.id};
    },graphTasks:oneId=>personalGraphTasks(getDb(),oneId,{automations:listAutomations,
      liveRunId:id=>getAutomationLiveRunState(id)==="running" ? getAutomationLiveRunId(id) : null}),
    alwaysApprove:chatId=>grantChatAlwaysApproval(chatId,"one-delegation"),quietRun:runId=>supervisorQuietRun(getDb(),runId),
    // The question card a settled worker run left for the owner (D4): the same durable reader the cards use, whichever host ran it.
    questionWait:(chatId,runId)=>{const view=(require("../confirm") as typeof import("../confirm")).readQuestionDecision(chatId);
      return view && view.sourceRunId===runId && view.awaitingOwner && !view.committed ? {sourceMessageId:view.sourceMessageId,
        detail:view.questions.map(q=>[q.question,...(q.options.length?[`options: ${q.options.map(o=>o.label).join(" / ")}`]:[])].join("\n")).join("\n")} : null;},tasks:desktopTasks,locale:currentUiLocale,normalizeRuntimeSelection:normalizeChatRuntimeSelection,frontRuntime:oneFrontRuntimeSelection,
    turns:(chatId,requests)=>supervisorReplyTurns(getDb(),chatId,requests,invocationService.attach(chatId)),
    appearance:input=>{updateOneProfile({expectedVersion:input.expectedVersion,patch:{displayName:input.displayName,bubbleColor:input.bubbleColor}});},
    legacyHistory:(oneId,chatId)=>legacy.inventory(oneId,chatId,new Set(invocationService.activeChatIds()),['inherited','machine'].includes(getOneProfileOrigin())),
    runtime:{
      start:startNative,attach,receipt,noStartProof,
      cancel:runId=>!hostOptions && (invocationRunOwners.getOwnerByRunId(runId)?.ownerKind==='daemon' || nativeRuntime?.ownsPending(runId)) ? nativeRuntime!.cancel(runId) : invocationService.cancel(runId),pauseGoal:(chatId,goalId)=>invocationService.pauseGoal(chatId,goalId),
      cancelGoal:(chatId,goalId)=>invocationService.deleteGoal(chatId,goalId),
      steer:(req,runId)=>!hostOptions && invocationRunOwners.getOwnerByRunId(runId)?.ownerKind==='daemon' ? nativeRuntime!.steer(req,runId) : invocationService.steerFromSupervisor(req,runId,admitMainInvocation(req.chatId)),
      steerState:id=>queuedSteerState(id),
      onSettled,
    },science:{
      tasks:()=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.tasks();},
      projects:()=>science?.projects() ?? [],
      start:input=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.start(input);},
      control:(input,task)=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.control(input,task);},
    },
  });
  const observeBudget=(runId?:string,nativeReceipt?:ReturnType<typeof receipt>)=>{
    try{if(runId)budgetRuntime.reconcileRun(runId,nativeReceipt);else budgetRuntime.reconcile();}
    catch(error){console.warn("[one-supervisor] usage reconciliation pending",error instanceof Error?error.message:"unknown");}
  };
  // The personal conversation works in its own folder and keeps a revisioned raw export (docs native-harness 21 G2).
  const personalChat=store.conversation(getOneProfile().oneId);
  if(personalChat)bindPersonalFolder(personalChat);
  const stopBudgetEvents=onSettled(event=>{observeBudget(event.runId,event.receipt);
    if(event.chatId===store.conversation(getOneProfile().oneId))queueMicrotask(()=>{try{exportPersonalSession(getOneProfile().oneId,event.chatId);}catch(error){console.warn("[one-supervisor] personal session export deferred",error instanceof Error?error.message:"unknown");}});if(event.receipt.status==='completed')queueMicrotask(()=>{try{collectOnePersonalDataResult(event.runId);}catch{/* A denied/stale result stays a proposal blocker; never retries inference. */}});});
  const budgetTimer=setInterval(()=>observeBudget(),30_000);budgetTimer.unref?.();
  stopBudgetHost=()=>{clearInterval(budgetTimer);stopBudgetEvents();};
  observeBudget();
  supervisor.recover();
  if (hostsWork) {
    workExecutor = new OneSupervisorWorkExecutor({store,queue:workQueue,
    ownerEpoch:hostOptions?.ownerEpoch ?? desktopAppInstanceId(),ownerKind:hostOptions?.ownerKind ?? "desktop-main",locale:currentUiLocale,
    assertOwner:()=>{if(hostOptions)hostOptions.assertAuthority();else assertDesktopLongRunAdmissionOpen();owner.assert(getOneProfile().oneId);workQueue.setActiveIdentity(getOneProfile().oneId);},
    assertBinding:job=>{
      assertOnePersonalDataInvocationCurrent(job.command_id);
      assertOneHistoryCommandCurrent(job.command_id, 'claim');
      const chat=getChat(job.chat_id),task=getCanonicalTaskForChat(job.chat_id);
      if (!chat || chat.originSurface!=="work" || chat.kind!=="user" || task?.id!==job.task_id) throw supervisorError('supervisor_work_native_binding_changed');
    },runtime:{start:startNative,attach,receipt,onSettled,noStartProof},
    onFailure:error=>console.warn("[one-supervisor] worker admission deferred",error instanceof Error ? error.message : "unknown"),
  });
  // Dots parity (owner 2026-10-04): One speaks first on a check-in it was asked to run, or when a worker it
  // delegated to is waiting for the owner. The listener is not an answer surface (it returns false).
  let checkinBusy=false;
  const fireCheckins=async()=>{if(checkinBusy)return;checkinBusy=true;try{
    // Finance permission/consent is rechecked before the existing One scheduler admits a due briefing.
    const heldCheckins=await (await import('../finance/daily-briefing')).wakeFinanceDailyBriefing();
    supervisor?.fireDueCheckins(Date.now(),heldCheckins);recoverOnePersonalDataResults();wakeOnePersonalIntegrationsFromExistingCheckin();
  }catch(error){console.warn("[one-supervisor] check-ins deferred",error instanceof Error ? error.message : "unknown");}finally{checkinBusy=false;}};
  const checkinTimer=setInterval(fireCheckins,30_000);checkinTimer.unref?.();
  const stopQuestions=onAskUserLifecycle(event=>{
    if (event.chatId && event.expiresAt > Date.now()) {
      try {
        const options=event.options.map(option=>option.label).filter(Boolean);
        supervisor?.workerNeedsOwner(event.chatId,event.requestId,[event.question,...(options.length ? [`options: ${options.join(" / ")}`] : [])].join("\n"));
      } catch (error) { console.warn("[one-supervisor] waiting-worker notice deferred",error instanceof Error ? error.message : "unknown"); }
    }
    return false;
  });
  // Host problems from other rooms reach the owner through One, not only as cards there (owner 2026-10-05).
  const stopHostAlerts=registerOneHostAlertSink(alert=>supervisor?.hostNeedsOwner(alert) ?? false);
  // A teammate started by One's own message to a room reports back to One for review (docs native-harness 22 O1).
  const stopTeamResults=registerOneTeamResultSink(result=>{try{return supervisor?.teamResult(result) ?? false;}catch(error){console.warn("[one-supervisor] team result deferred",error instanceof Error ? error.message : "unknown");return false;}});
  // A graph that answers this conversation (or a Work session One delegated) is queued for review by the scheduler's
  // delivery; in this process the review starts now (native-harness notyet NH16). Elsewhere the tick above picks it up.
  const stopGraphResults=registerOneGraphResultWake(()=>{try{supervisor?.reviewQueuedResults();}catch(error){console.warn("[one-supervisor] graph result review deferred",error instanceof Error ? error.message : "unknown");}});
  const stopProactive=()=>{clearInterval(checkinTimer);stopQuestions();stopHostAlerts();stopTeamResults();stopGraphResults();};stopProactiveHost=stopProactive;
  registerAppRuntimeParticipant("one-supervisor-work-queue", {
    closeAdmission:()=>{owner.closeAdmission();workExecutor?.close();stopProactive();},
    interrupt:()=>{owner.closeAdmission();workExecutor?.close();stopProactive();},
    isSettled:()=>{if(invocationService.activeChatIds().length)return false;stopBudgetHost?.();owner.release();supervisor?.close();nativeRuntime?.close();return true;},
  });
  workExecutor.start();
  fireCheckins(); // a check-in due while the app was closed runs once now
  }
  return supervisor;
}

// Same-process bootstrap only. Resolve the actual current domain owner for
// each original capture; no opaque capability crosses the daemon protocol.
const observeOrdinaryOneNativeSource = (source: OrdinaryOneTurnSource) => {
  // A One Goal room's owner turn starts on Desktop, where its Goal is held (goal-owner-route.ts). After the daemon
  // adopted the One domain, Desktop has no personal-domain owner, so the turn runs like the Goal's own Desktop
  // wake-ups: outside the personal domain, without personal native capabilities. Any other One turn still needs it.
  if (personalDomainHeldByDaemon() && oneGoalRoomTurnOnDesktop(readOrdinaryOneTurn(source, "scope").request.chatId)) return undefined;
  const observed = oneSupervisor().observeOrdinaryNativeTurn(source);
  if (!observed) return undefined;
  return { ...observed, wrap<T>(body: () => T): T {
    return withOnePersonalNativeOriginal(observed.origin, observed.request, body);
  } };
};
// InvocationService can still be initializing through the existing import cycle.
// Register the same observer after synchronous module evaluation completes.
queueMicrotask(() => invocationService.configureOrdinaryOneTurnObserver(observeOrdinaryOneNativeSource));
