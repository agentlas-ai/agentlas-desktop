import { withOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import type { OrdinaryOneTurnSource } from "../invocation/ordinary-one-turn";
import { supervisorError } from "../../shared/one-supervisor";
import { createHash } from 'node:crypto';
import { chatFilePrompt, chatFileImages, validateChatAttachmentSelection } from "../store/chat-message-attachments";
import { getDb, openedStoreMigrationRole } from "../store/db";
import { getOneProfile, getOneProfileOrigin, updateOneProfile } from "../store/one-profile";
import { createChat, getChat, appendChatMessage, listChatMessages, normalizeChatRuntimeSelection } from "../store/chats";
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
import { OneSupervisorService, type SupervisorRuntime } from "./supervisor-service";
import { SupervisorScienceAdapter } from "./supervisor-science";
import { supervisorExactResult, supervisorQuietRun, supervisorReplyTurns } from "./supervisor-presentation";
import { onAskUserLifecycle } from "../confirm/ask-user";
import { registerOneHostAlertSink } from "./host-alerts";
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

interface SupervisorHostOptions { ownerKind:'desktop-main'|'work-daemon';ownerEpoch:string;assertAuthority():void }
let hostOptions:SupervisorHostOptions|undefined;
let hostOwner:OneSupervisorOwner|null=null;
let stopProactiveHost:(()=>void)|undefined;
let stopBudgetHost:(()=>void)|undefined;
let supervisor:OneSupervisorService|null=null;
export function configureOneSupervisorDaemonHost(options:SupervisorHostOptions):void {
  if(supervisor || options.ownerKind!=='work-daemon')throw supervisorError('supervisor_host_already_initialized');
  options.assertAuthority();hostOptions=options;
}
export function closeOneSupervisorHostAdmission():void {
  closeOnePersonalIntegrations();
  hostOwner?.closeAdmission();workExecutor?.close();stopProactiveHost?.();stopBudgetHost?.();supervisor?.close();nativeRuntime?.close();
}
export function supervisorRunsInDaemon():boolean { return hostOptions?.ownerKind==='work-daemon'; }
export function prepareOneSupervisorDaemonHandoff():{oneId:string;ownerEpoch:string;generation:number}|null {
  if(!supervisor || !hostOwner)return null;
  if(hostOptions || invocationService.activeChatIds().length || nativeRuntime?.pendingCount || oneSupervisorNativeRuntime()?.owner.retainedCount)return null;
  const token=hostOwner.current();if(!token || token.phase!=='active')return null;
  hostOwner.closeAdmission();workExecutor?.close();stopProactiveHost?.();stopBudgetHost?.();supervisor.close();nativeRuntime?.close();hostOwner.release();
  closeOnePersonalIntegrations();
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
export function isPersonalSupervisorConversation(chatId:string):boolean {
  return personalSupervisorConversationInDb(getDb(),getOneProfile().oneId,chatId);
}
function desktopTasks():SupervisorTask[] {
  const discovered=new Map(listCanonicalTasks({limit:100,reconcile:false}).map(task=>[task.id,task]));
  for(const chatId of invocationService.activeChatIds()) {const task=getCanonicalTaskForChat(chatId);if(task) discovered.set(task.id,task);}
  return [...discovered.values()].flatMap(task=>{
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
  });
}
/** Same native task projection as Supervisor controls; no async snapshot cache or new version. */
export function currentOneNativeWorkControl(row:Readonly<SupervisorRequestRow>,purpose:'active'|'result'='active'):string|null {
  if(!row.task_id||!row.run_id||row.one_id!==getOneProfile().oneId)return null;
  if(getDb().prepare("SELECT 1 FROM one_supervisor_requests WHERE task_id=? AND run_id=? AND kind='cancel' AND state<>'failed'").get(row.task_id,row.run_id))return null;
  const task=desktopTasks().find(value=>value.taskId===row.task_id&&value.runId===row.run_id);
  if(!task)return null;
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
  const startNative = (req: Parameters<typeof invocationService.start>[0], hostNoticePurpose?: SupervisorHostNoticePurpose) => {
    if (getDb().inTransaction) throw supervisorError('supervisor_native_uncommitted_request');
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
      return invocationService.start(req,undefined,undefined,undefined,hostNoticePurpose,admitMainInvocation(req.chatId,req.runId));
    });
  };
  supervisor=new OneSupervisorService({
    store,owner,budget,identity:getOneProfile,assertAuthority:()=>hostOptions?.assertAuthority(),workQueue,workIdentityMutable:hostsWork,wakeWorkQueue:()=>queueMicrotask(()=>workExecutor?.kick()),
    createConversation:()=>createChat({originSurface:"one",taskMode:"conversation",title:getOneProfile().displayName}).id,
    history:chatId=>listChatMessages(chatId,100),appendUser:(chatId,text,images)=>{
      const groupId=/<!-- agentlas-chat-files:v1:([0-9a-f-]{36}) -->/i.exec(text)?.[1];
      validateChatAttachmentSelection(chatId,groupId,images);
      const allImages=[...(images ?? []),...chatFileImages(chatId,groupId)];
      return appendChatMessage(chatId,"user",text,allImages.length ? {images:allImages} : undefined).id;
    },attachmentPrompt:chatFilePrompt,
    createWork:input=>{
      if (input.projectId && !getProject(input.projectId)) throw supervisorError('supervisor_work_project_missing');
      const chat=createChat({originSurface:"work",taskMode:"task",projectId:input.projectId,title:input.text.split(/\r?\n/,1)[0].slice(0,120)});
      const task=ensureCanonicalTaskForChat(chat.id);
      if (!task) throw supervisorError('supervisor_work_task_missing');
      // The native Work invocation persists its own human input once. The
      // atomic supervisor request already durably owns this brief before dispatch.
      return {chatId:chat.id,taskId:task.id};
    },alwaysApprove:chatId=>grantChatAlwaysApproval(chatId,"one-delegation"),quietRun:runId=>supervisorQuietRun(getDb(),runId),tasks:desktopTasks,locale:currentUiLocale,normalizeRuntimeSelection:normalizeChatRuntimeSelection,
    turns:(chatId,requests)=>supervisorReplyTurns(getDb(),chatId,requests,invocationService.attach(chatId)),
    appearance:input=>{updateOneProfile({expectedVersion:input.expectedVersion,patch:{displayName:input.displayName,bubbleColor:input.bubbleColor}});},
    legacyHistory:(oneId,chatId)=>legacy.inventory(oneId,chatId,new Set(invocationService.activeChatIds()),['inherited','machine'].includes(getOneProfileOrigin())),
    runtime:{
      start:startNative,attach,receipt,
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
  const stopBudgetEvents=onSettled(event=>{observeBudget(event.runId,event.receipt);if(event.receipt.status==='completed')queueMicrotask(()=>{try{collectOnePersonalDataResult(event.runId);}catch{/* A denied/stale result stays a proposal blocker; never retries inference. */}});});
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
    },runtime:{start:startNative,attach,receipt,onSettled},
    onFailure:error=>console.warn("[one-supervisor] worker admission deferred",error instanceof Error ? error.message : "unknown"),
  });
  // Dots parity (owner 2026-10-04): One speaks first on a check-in it was asked to run, or when a worker it
  // delegated to is waiting for the owner. The listener is not an answer surface (it returns false).
  const fireCheckins=()=>{try{supervisor?.fireDueCheckins();recoverOnePersonalDataResults();wakeOnePersonalIntegrationsFromExistingCheckin();}catch(error){console.warn("[one-supervisor] check-ins deferred",error instanceof Error ? error.message : "unknown");}};
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
  const stopProactive=()=>{clearInterval(checkinTimer);stopQuestions();stopHostAlerts();};stopProactiveHost=stopProactive;
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
  const observed = oneSupervisor().observeOrdinaryNativeTurn(source);
  if (!observed) return undefined;
  return { ...observed, wrap<T>(body: () => T): T {
    return withOnePersonalNativeOriginal(observed.origin, observed.request, body);
  } };
};
// InvocationService can still be initializing through the existing import cycle.
// Register the same observer after synchronous module evaluation completes.
queueMicrotask(() => invocationService.configureOrdinaryOneTurnObserver(observeOrdinaryOneNativeSource));
