import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { DaemonScienceCommand } from "../daemon/science-service";
import type { SupervisorControlInput, SupervisorTask } from "../../shared/one-supervisor";
import { supervisorHash } from "./supervisor-store";

type Row=Record<string,unknown>;
const row=(value:unknown):Row=>value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows=(value:unknown):Row[]=>Array.isArray(value) ? value.map(row) : [];
const id=(value:unknown):string=>typeof value === "string" ? value : "";

/** Observed native service only: discovery never boots Science or duplicates its executor. */
export class SupervisorScienceAdapter {
  private targets=new Map<string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}>();
  private observedProjects:Array<{projectId:string;title:string}>=[];
  projects():Array<{projectId:string;title:string}> {return this.observedProjects.map(project=>({...project}));}
  constructor(private readonly client:ScienceDaemonClient) {}
  private command(command:DaemonScienceCommand):Promise<unknown> {
    return this.client.commandObserved(command,{timeoutMs:3_000});
  }
  /** The last observation that answered, per project: a project whose service call misses its slot keeps its rows. */
  private lastProjectObservation=new Map<string,{tasks:SupervisorTask[];targets:Array<[string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}]>}>();
  /*
   * One observation of every project, inside one deadline. Each project's chain (loop, conversations, the open turn
   * and its messages) runs side by side with the others; before, up to 20 projects x (inspect + list + 4 x (attach +
   * messages)) waited for each other in sequence, so one slow reply (the Main loop busy for ~1.1 s, measured
   * 2026-10-05) used up the 2 s budget and the phone's supervisor status showed Science as unavailable. A project
   * whose chain misses the deadline keeps the rows its last answered observation produced; a project the service no
   * longer lists is dropped.
   */
  async tasks():Promise<SupervisorTask[]> {
    const deadline=Date.now()+2_000;
    const observe=(command:DaemonScienceCommand):Promise<unknown>=>{
      const remaining=deadline-Date.now();
      if (remaining <= 0) return Promise.reject(new Error("science_observation_deadline"));
      return this.client.commandObserved(command,{timeoutMs:remaining});
    };
    const projects=rows(await observe({op:"projects.list"})).slice(0,20);
    const observeProject=async(project:Row)=>{
      const projectId=id(project.id);
      const tasks:SupervisorTask[]=[];
      const targets:Array<[string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}]>=[];
      const [inspection,conversations]=await Promise.all([
        observe({op:"loops.inspect",input:{projectId}}).then(row),
        observe({op:"conversations.list",input:{projectId}}).then(rows),
      ]);
      const loop=row(inspection.session);
      if (id(loop.id)) {
        const taskId=`science-loop:${id(loop.id)}`;
        targets.push([taskId,{projectId,loop}]);
        tasks.push({taskId,surface:"science",title:id(project.title)||id(project.name)||"Science",chatId:null,projectId,
          runId:id(loop.activeRunId)||null,state:id(loop.status),controlVersion:supervisorHash([loop.id,loop.version,loop.stateSha256]),
          observedAt:id(loop.updatedAt)||new Date().toISOString(),owner:"science-daemon",controls:["queued","running","pausing","paused"].includes(id(loop.status)) ? ["cancel"] : [],result:null,resultVerified:false});
      }
      const turns=await Promise.all(conversations.slice(0,4).filter(conversation=>id(conversation.id)).map(async conversation=>{
        const conversationId=id(conversation.id);
        const attached=row(await observe({op:"composer.attach",input:{projectId,conversationId}}));
        const turn=row(attached.turn); if (!id(turn.id)) return null;
        const messages=rows(await observe({op:"messages.list",input:{projectId,conversationId}}));
        return {conversation,conversationId,turn,messages};
      }));
      for (const observed of turns) {
        if (!observed) continue;
        const {conversation,conversationId,turn,messages}=observed;
        const taskId=`science-turn:${id(turn.id)}`;
        const active=["queued","running","cancelling"].includes(id(turn.status));
        const result=messages.find(message=>message.role==="assistant" && message.visibility==="visible" && message.id===turn.assistantMessageId);
        targets.push([taskId,{projectId,conversationId,turnId:id(turn.id),...(loop.activeRunId===turn.invocationRunId ? {loop} : {})}]);
        tasks.push({taskId,surface:"science",title:id(conversation.title)||id(project.title)||id(project.name)||"Science",
          chatId:null,projectId,runId:id(turn.invocationRunId)||null,state:id(turn.status),controlVersion:supervisorHash([turn.id,turn.status,turn.updatedAt]),
          observedAt:id(turn.updatedAt)||new Date().toISOString(),owner:"science-daemon",controls:active ? (turn.status==="cancelling" ? [] : ["steer","cancel"]) : [],
          result:id(result?.content)||null,resultVerified:false,sourceCommandId:id(turn.requestId)||null});
      }
      return {tasks,targets};
    };
    const listed=projects.filter(project=>id(project.id));
    const settled=await Promise.allSettled(listed.map(observeProject));
    const tasks:SupervisorTask[]=[];
    const targets=new Map<string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}>();
    const kept=new Map<string,{tasks:SupervisorTask[];targets:Array<[string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}]>}>();
    settled.forEach((outcome,index)=>{
      const projectId=id(listed[index].id);
      const observation=outcome.status==="fulfilled" ? outcome.value : this.lastProjectObservation.get(projectId);
      if (!observation) return;
      kept.set(projectId,observation);
      tasks.push(...observation.tasks);
      for (const [taskId,target] of observation.targets) targets.set(taskId,target);
    });
    this.lastProjectObservation=kept;
    this.targets=targets;
    this.observedProjects=listed.map(project=>({projectId:id(project.id),title:id(project.title)||"Science"}));
    return tasks;
  }
  async start(input:{commandId:string;projectId:string;text:string;conversationId?:string}):Promise<{taskId:string;runId:string}> {
    const projects=rows(await this.command({op:"projects.list"}));
    if (!projects.some(project=>project.id===input.projectId)) throw new Error("supervisor_science_project_missing");
    const conversations=rows(await this.command({op:"conversations.list",input:{projectId:input.projectId}}));
    // A named conversation (thread) is the owner's choice; without one, the project's open conversation.
    const conversation=input.conversationId
      ? conversations.find(item=>id(item.id)===input.conversationId && !item.archivedAt)
      : conversations.find(item=>!item.archivedAt);
    if (input.conversationId && !conversation) throw new Error("supervisor_science_conversation_missing");
    if (!id(conversation?.id)) throw new Error("supervisor_open_science_conversation_first");
    const result=row(await this.command({op:"composer.start",input:{requestId:input.commandId,projectId:input.projectId,conversationId:id(conversation!.id),mode:"append-user-message",content:input.text}}));
    const turn=row(result.turn);
    if (!id(turn.id) || !id(turn.invocationRunId)) throw new Error("supervisor_science_start_unconfirmed");
    return {taskId:`science-turn:${id(turn.id)}`,runId:id(turn.invocationRunId)};
  }
  async control(input:SupervisorControlInput,current:SupervisorTask):Promise<unknown> {
    const target=this.targets.get(current.taskId);
    if (!target) throw new Error("supervisor_science_target_missing");
    if (input.action==="cancel" && target.loop) {
      const loop=target.loop;
      return this.command({op:"loops.transition",input:{requestId:input.commandId,projectId:target.projectId,loopSessionId:id(loop.id),action:"cancel",
        expectedLoopVersion:Number(loop.version),expectedLoopStateSha256:id(loop.stateSha256),reason:"Explicit cancellation from the personal agent workspace"}});
    }
    if (!target.conversationId || !target.turnId) throw new Error("supervisor_science_turn_unavailable");
    if (input.action==="cancel") return this.command({op:"composer.cancel",input:{projectId:target.projectId,conversationId:target.conversationId,turnId:target.turnId}});
    return this.command({op:"composer.steer",input:{requestId:input.commandId,projectId:target.projectId,conversationId:target.conversationId,targetTurnId:target.turnId,content:input.text!,intent:"steer"}});
  }
}
