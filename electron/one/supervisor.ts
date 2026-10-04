import { getDb, openedStoreMigrationRole } from "../store/db";
import { getOneProfile, getOneProfileOrigin, updateOneProfile } from "../store/one-profile";
import { createChat, getChat, appendChatMessage, listChatMessages, normalizeChatRuntimeSelection } from "../store/chats";
import { ensureCanonicalTaskForChat, listCanonicalTasks, getCanonicalTaskForChat, hasPassedTaskForceExecutionVerification } from "../store/tasks";
import { getProject } from "../store/projects";
import { getLongRunByGoalId } from "../store/long-runs";
import { invocationService } from "../invocation/service";
import { admitMainInvocation } from "../runtime/scheduled-root-context";
import { currentUiLocale } from "../ui-locale";
import { OneSupervisorStore, supervisorHash, personalSupervisorConversationInDb, supervisorStoppedGoalForTask } from "./supervisor-store";
import { OneSupervisorService } from "./supervisor-service";
import { SupervisorScienceAdapter } from "./supervisor-science";
import { supervisorExactResult, supervisorReplyTurns } from "./supervisor-presentation";
import { OneSupervisorLegacyMigration } from './supervisor-migration';
import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { SupervisorTask, SupervisorHostNoticePurpose } from "../../shared/one-supervisor";
import { OneSupervisorWorkQueue } from "./supervisor-work-queue";
import { OneSupervisorWorkExecutor } from "./supervisor-work-executor";
import { assertDesktopLongRunAdmissionOpen, desktopAppInstanceId, registerAppRuntimeParticipant } from "../long-run/app-runtime-coordinator";

let supervisor:OneSupervisorService|null=null;
let science:SupervisorScienceAdapter|undefined;
let workExecutor: OneSupervisorWorkExecutor | null = null;
export function configureOneSupervisorScience(client:ScienceDaemonClient):void {
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
    const active=!!invocationService.attach(chat.id,{includeEvents:false});
    const result=supervisorExactResult(getDb(),chat.id,receipt?.runId ?? null)?.text ?? null;
    return [{taskId:task.id,surface:chat.originSurface === "one" ? "one" as const : "work" as const,title:task.title,
      chatId:chat.id,projectId:chat.projectId,goalId:goal?.goalId ?? null,runId:receipt?.runId ?? null,state,
      controlVersion:supervisorHash([task.id,state,receipt?.runId,goal?.goalId,goal?.status,goal?.version]),observedAt:goal?.updatedAt ?? receipt?.updatedAt ?? task.updatedAt,
      owner:"desktop-main" as const,controls:!["cancelling","cancelled","completed","paused","pausing","failed"].includes(state)
        ? active ? ["steer" as const,"cancel" as const] : goal ? ["cancel" as const] : [] : [],
      result,resultVerified:!!result && task.status==="completed" && receipt?.status==="completed" && hasPassedTaskForceExecutionVerification(receipt.runId)}];
  });
}
export function oneSupervisor():OneSupervisorService {
  if (supervisor) return supervisor;
  const legacy=new OneSupervisorLegacyMigration(getDb());
  const store = new OneSupervisorStore(getDb());
  const schemaOwner = openedStoreMigrationRole() === "owner";
  const workQueue = new OneSupervisorWorkQueue(getDb(), schemaOwner);
  const startNative = (req: Parameters<typeof invocationService.start>[0], hostNoticePurpose?: SupervisorHostNoticePurpose) => {
    if (req.runtimeSelection) req={...req,runtimeSelection:normalizeChatRuntimeSelection(req.runtimeSelection) ?? undefined};
    return invocationService.start(req,undefined,undefined,undefined,hostNoticePurpose,admitMainInvocation(req.chatId,req.runId));
  };
  supervisor=new OneSupervisorService({
    store,identity:getOneProfile,workQueue,workIdentityMutable:schemaOwner,wakeWorkQueue:()=>workExecutor?.kick(),
    createConversation:()=>createChat({originSurface:"one",taskMode:"conversation",title:getOneProfile().displayName}).id,
    history:chatId=>listChatMessages(chatId,100),appendUser:(chatId,text)=>appendChatMessage(chatId,"user",text).id,
    createWork:input=>{
      if (input.projectId && !getProject(input.projectId)) throw new Error("supervisor_work_project_missing");
      const chat=createChat({originSurface:"work",taskMode:"task",projectId:input.projectId,title:input.text.split(/\r?\n/,1)[0].slice(0,120)});
      const task=ensureCanonicalTaskForChat(chat.id);
      if (!task) throw new Error("supervisor_work_task_missing");
      // The native Work invocation persists its own human input once. The
      // atomic supervisor request already durably owns this brief before dispatch.
      return {chatId:chat.id,taskId:task.id};
    },tasks:desktopTasks,locale:currentUiLocale,normalizeRuntimeSelection:normalizeChatRuntimeSelection,
    turns:(chatId,requests)=>supervisorReplyTurns(getDb(),chatId,requests,invocationService.attach(chatId)),
    appearance:input=>{updateOneProfile({expectedVersion:input.expectedVersion,patch:{displayName:input.displayName,bubbleColor:input.bubbleColor}});},
    legacyHistory:(oneId,chatId)=>legacy.inventory(oneId,chatId,new Set(invocationService.activeChatIds()),['inherited','machine'].includes(getOneProfileOrigin())),
    runtime:{
      start:startNative,attach:chatId=>invocationService.attach(chatId,{includeEvents:false}),receipt:runId=>invocationService.receipt(runId),
      cancel:runId=>invocationService.cancel(runId),pauseGoal:(chatId,goalId)=>invocationService.pauseGoal(chatId,goalId),
      cancelGoal:(chatId,goalId)=>invocationService.deleteGoal(chatId,goalId),
      steer:(req,runId)=>invocationService.steer(req,runId,undefined,undefined,admitMainInvocation(req.chatId)),
      onSettled:listener=>invocationService.onSettled(listener),
    },science:{
      tasks:()=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.tasks();},
      projects:()=>science?.projects() ?? [],
      start:input=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.start(input);},
      control:(input,task)=>{if(!science) return Promise.reject(new Error("science_daemon_unavailable"));return science.control(input,task);},
    },
  });
  supervisor.recover();
  if (schemaOwner) {
    workExecutor = new OneSupervisorWorkExecutor({store,queue:workQueue,
    ownerEpoch:desktopAppInstanceId(),ownerKind:"desktop-main",locale:currentUiLocale,
    assertOwner:()=>{assertDesktopLongRunAdmissionOpen();workQueue.setActiveIdentity(getOneProfile().oneId);},
    assertBinding:job=>{
      const chat=getChat(job.chat_id),task=getCanonicalTaskForChat(job.chat_id);
      if (!chat || chat.originSurface!=="work" || chat.kind!=="user" || task?.id!==job.task_id) throw new Error("supervisor_work_native_binding_changed");
    },runtime:{start:startNative,attach:chatId=>invocationService.attach(chatId,{includeEvents:false}),
      receipt:runId=>invocationService.receipt(runId),onSettled:listener=>invocationService.onSettled(listener)},
    onFailure:error=>console.warn("[one-supervisor] worker admission deferred",error instanceof Error ? error.message : "unknown"),
  });
  registerAppRuntimeParticipant("one-supervisor-work-queue", {
    closeAdmission:()=>workExecutor?.close(),interrupt:()=>workExecutor?.close(),isSettled:()=>true,
  });
  workExecutor.start();
  }
  return supervisor;
}
