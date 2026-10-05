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
  async tasks():Promise<SupervisorTask[]> {
    const deadline=Date.now()+2_000;
    const observe=(command:DaemonScienceCommand):Promise<unknown>=>{
      const remaining=deadline-Date.now();
      if (remaining <= 0) throw new Error("science_observation_deadline");
      return this.client.commandObserved(command,{timeoutMs:Math.min(remaining,800)});
    };
    const projects=rows(await observe({op:"projects.list"})).slice(0,20);
    const tasks:SupervisorTask[]=[];
    const targets=new Map<string,{projectId:string;conversationId?:string;turnId?:string;loop?:Row}>();
    for (const project of projects) {
      const projectId=id(project.id); if (!projectId) continue;
      const inspection=row(await observe({op:"loops.inspect",input:{projectId}}));
      const loop=row(inspection.session);
      if (id(loop.id)) {
        const taskId=`science-loop:${id(loop.id)}`;
        targets.set(taskId,{projectId,loop});
        tasks.push({taskId,surface:"science",title:id(project.title)||id(project.name)||"Science",chatId:null,projectId,
          runId:id(loop.activeRunId)||null,state:id(loop.status),controlVersion:supervisorHash([loop.id,loop.version,loop.stateSha256]),
          observedAt:id(loop.updatedAt)||new Date().toISOString(),owner:"science-daemon",controls:["queued","running","pausing","paused"].includes(id(loop.status)) ? ["cancel"] : [],result:null,resultVerified:false});
      }
      for (const conversation of rows(await observe({op:"conversations.list",input:{projectId}})).slice(0,4)) {
        const conversationId=id(conversation.id); if (!conversationId) continue;
        const attached=row(await observe({op:"composer.attach",input:{projectId,conversationId}}));
        const turn=row(attached.turn); if (!id(turn.id)) continue;
        const taskId=`science-turn:${id(turn.id)}`;
        const active=["queued","running","cancelling"].includes(id(turn.status));
        const messages=rows(await observe({op:"messages.list",input:{projectId,conversationId}}));
        const result=messages.find(message=>message.role==="assistant" && message.visibility==="visible" && message.id===turn.assistantMessageId);
        targets.set(taskId,{projectId,conversationId,turnId:id(turn.id),...(loop.activeRunId===turn.invocationRunId ? {loop} : {})});
        tasks.push({taskId,surface:"science",title:id(conversation.title)||id(project.title)||id(project.name)||"Science",
          chatId:null,projectId,runId:id(turn.invocationRunId)||null,state:id(turn.status),controlVersion:supervisorHash([turn.id,turn.status,turn.updatedAt]),
          observedAt:id(turn.updatedAt)||new Date().toISOString(),owner:"science-daemon",controls:active ? (turn.status==="cancelling" ? [] : ["steer","cancel"]) : [],
          result:id(result?.content)||null,resultVerified:false,sourceCommandId:id(turn.requestId)||null});
      }
    }
    this.targets=targets;
    this.observedProjects=projects.filter(project=>id(project.id)).map(project=>({projectId:id(project.id),title:id(project.title)||"Science"}));
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
