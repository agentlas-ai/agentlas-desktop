import { SCIENCE_START_INVALID_ID_BEFORE_ADMISSION } from "../../shared/science-composer-admission";
import { supervisorError } from "../../shared/one-supervisor";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { DaemonScienceCommand } from "../daemon/science-service";
import type { SupervisorControlInput, SupervisorTask } from "../../shared/one-supervisor";
import { supervisorHash } from "./supervisor-store";
import { stableScienceRuntimeChatId } from "../runtime/science-transport-identity";
import { scienceTurnRunsForChat } from "../store/science-turn-ledger";

type Row=Record<string,unknown>;
const row=(value:unknown):Row=>value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows=(value:unknown):Row[]=>Array.isArray(value) ? value.map(row) : [];
const id=(value:unknown):string=>typeof value === "string" ? value : "";

const SCIENCE_REQUEST_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * The request id Science's composer.start accepts: a UUID (science-request-id-invalid otherwise). One's command ids are free-form
 * (3-200 characters) and the model picks readable ones ("science-pdl1-binder-owner-20261105-01"), so the first Science start of a
 * phone request was held as science-request-id-invalid (11-05 18:32 KST). A UUID passes through; any other id maps to the same
 * name-based UUID every time, so a retry of the same command id is the same request.
 */
export function scienceRequestId(commandId:string):string {
  if (SCIENCE_REQUEST_UUID.test(commandId)) return commandId;
  const hash=createHash("sha256").update(`agentlas.one.science-request.v1:${commandId}`).digest();
  hash[6]=(hash[6]&0x0f)|0x50; hash[8]=(hash[8]&0x3f)|0x80;
  const hex=hash.subarray(0,16).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

/**
 * True when a failed Science start is known not to have started anything: this adapter refused before it sent composer.start (no such
 * project or conversation), or the daemon client says the command never went on the wire. Anything else (a lost reply, a remote
 * rejection that may carry receipts) is unknown and stays held, where a turn that did start is still paired by its request id.
 */
export function scienceStartNotSent(error:unknown):boolean {
  const failure=(error as {failure?:{outcome?:unknown;phase?:unknown;remoteSourceCode?:unknown}}|null)?.failure;
  if (failure?.outcome==="not-dispatched") return true;
  if (failure?.outcome==="rejected" && failure.phase==="remote"
      && failure.remoteSourceCode===SCIENCE_START_INVALID_ID_BEFORE_ADMISSION) return true;
  const code=(error as {code?:unknown}|null)?.code;
  return code==="supervisor_science_project_missing" || code==="supervisor_science_conversation_missing" || code==="supervisor_open_science_conversation_first";
}

/** Observed native service only: discovery never boots Science or duplicates its executor. */
const SCIENCE_OBSERVATION_IN_FLIGHT=4;

type Target={projectId:string;conversationId?:string;turnId?:string;loop?:Row};

/**
 * PLAN S9 B1b. The newest stamped Science turn run of one conversation in the common ledger: its run id, null when the
 * ledger has no stamped run for it (only runs from before the stamp existed), or "unknown" when the ledger cannot be read.
 * The ledger is only a change signal ("did a new turn start?"); the Science service stays the authority for what a turn
 * is and how it ended, so a turn is never reported from the ledger alone.
 */
export type ScienceTurnLedgerReader=(conversationId:string)=>string|null|"unknown";

/** Production default: reads the real store lazily, and anything unreadable is "unknown" (never a reason to serve the cache). */
export const readScienceNewestTurnRun:ScienceTurnLedgerReader=conversationId=>{
  try {
    const db=(require("../store/db") as typeof import("../store/db")).getDb(); // eslint-disable-line @typescript-eslint/no-require-imports
    const newest=scienceTurnRunsForChat(db,stableScienceRuntimeChatId(conversationId),1)[0];
    if (!newest) return null;
    // A stamp that names another conversation is not this conversation's signal.
    return newest.conversationId===conversationId && newest.invocationRunId ? newest.invocationRunId : "unknown";
  } catch { return "unknown"; }
};

/** The SDK's own end states of a turn. "interrupted" can resume and is not among them. */
const FINAL_TURN_STATES=["completed","failed","cancelled"];

/** What one observed conversation keeps between snapshots. Only a final entry is ever served. */
interface CachedTurn {
  projectId:string;conversationId:string;turnId:string;runId:string;
  /** The turn's invocationRunId exactly as the service sent it: the loop binding compares it with the loop's activeRunId. */
  rawRunId:unknown;
  task:SupervisorTask;
  final:boolean;
}

/** One conversation of a project as this snapshot saw it: reused from the cache, or freshly read from the service. */
type ObservedConversation={conversation:Row;conversationId:string}&({cached:CachedTurn}|{cached?:undefined;turn:Row;messages:Row[]});
interface ProjectObservation {tasks:SupervisorTask[];targets:Array<[string,Target]>;turns:CachedTurn[]}

export class SupervisorScienceAdapter {
  private targets=new Map<string,Target>();
  private observedProjects:Array<{projectId:string;title:string}>=[];
  projects():Array<{projectId:string;title:string}> {return this.observedProjects.map(project=>({...project}));}
  constructor(private readonly client:Pick<ScienceDaemonClient,"commandObserved">,private readonly ledger:ScienceTurnLedgerReader=readScienceNewestTurnRun) {}
  private static cacheKey(projectId:string,conversationId:string):string {return `${projectId}\u0000${conversationId}`;}
  /**
   * The cached turn of a conversation when the service need not be asked again: the entry is final (completed, failed or
   * cancelled by the SDK's own word) and the ledger shows no newer stamped run (its newest run is the entry's own run, or it has
   * none at all). A newer run, an unreadable ledger or a ledger that throws all send the conversation back to the service.
   * The cache is the `turns` of each project's last answered observation, so it holds only the conversations still listed
   * (at most 4 per project, 20 projects) and a project the service stops listing takes its entries with it.
   */
  private reusable(projectId:string,conversationId:string):CachedTurn|undefined {
    const entry=this.lastProjectObservation.get(projectId)?.turns.find(turn=>turn.conversationId===conversationId);
    if (!entry || !entry.final || entry.projectId!==projectId) return undefined;
    let newest:string|null;
    try { newest=this.ledger(conversationId); } catch { return undefined; }
    if (newest==="unknown") return undefined;
    return newest===null || newest===entry.runId ? entry : undefined;
  }
  /** A turn this adapter just started is queued before its run is stamped in the ledger: the next snapshot asks the service. */
  private forget(projectId:string,conversationId:string):void {
    const observation=this.lastProjectObservation.get(projectId);
    if (observation) observation.turns=observation.turns.filter(turn=>turn.conversationId!==conversationId);
  }
  /** One turn as the supervisor keeps it: its task, and whether the SDK has finished with it. */
  private turnEntry(projectId:string,conversationId:string,title:string,turn:Row,messages:Row[]):CachedTurn {
    const active=["queued","running","cancelling"].includes(id(turn.status));
    const result=messages.find(message=>message.role==="assistant" && message.visibility==="visible" && message.id===turn.assistantMessageId);
    return {projectId,conversationId,turnId:id(turn.id),runId:id(turn.invocationRunId),rawRunId:turn.invocationRunId,final:FINAL_TURN_STATES.includes(id(turn.status)),
      task:{taskId:`science-turn:${id(turn.id)}`,surface:"science",title,
        chatId:null,projectId,runId:id(turn.invocationRunId)||null,state:id(turn.status),controlVersion:supervisorHash([turn.id,turn.status,turn.updatedAt]),
        observedAt:id(turn.updatedAt)||new Date().toISOString(),owner:"science-daemon",controls:active ? (turn.status==="cancelling" ? [] : ["steer","cancel"]) : [],
        result:id(result?.content)||null,resultVerified:false,sourceCommandId:id(turn.requestId)||null}};
  }
  /**
   * A turn the snapshot's per-conversation read did not show: a follow-up turn (steering or loop continuation) can start within
   * milliseconds of the one One started, and composer.attach gives only the active turn, else the newest. Read by its id, in the named
   * conversation or in each of the project's first few; null when none has it. A transport failure throws (the caller backs off).
   */
  async turn(input:{projectId:string;turnId:string;conversationId?:string}):Promise<SupervisorTask|null> {
    const deadline=performance.now()+2_000;
    const observe=(command:DaemonScienceCommand)=>this.client.commandObserved(command,{observationDeadlineMs:deadline});
    const listed=rows(await observe({op:"conversations.list",input:{projectId:input.projectId}})).filter(conversation=>id(conversation.id) && (!input.conversationId || id(conversation.id)===input.conversationId)).slice(0,4);
    const read=await Promise.allSettled(listed.map(async conversation=>({conversation,turn:row(await observe({op:"composer.receipt",input:{projectId:input.projectId,conversationId:id(conversation.id),turnId:input.turnId}}))})));
    const hit=read.flatMap(outcome=>outcome.status==="fulfilled" && id(outcome.value.turn.id)===input.turnId ? [outcome.value] : [])[0];
    if (!hit) {
      const failed=read.find((outcome):outcome is PromiseRejectedResult=>outcome.status==="rejected" && !(outcome.reason instanceof Error && /science-turn-not-found/.test(outcome.reason.message)));
      if (failed) throw failed.reason;
      return null;
    }
    const conversationId=id(hit.conversation.id);
    // The result text is only read once the turn is over.
    const final=FINAL_TURN_STATES.includes(id(hit.turn.status));
    const messages=final ? rows(await observe({op:"messages.list",input:{projectId:input.projectId,conversationId}})) : [];
    const entry=this.turnEntry(input.projectId,conversationId,id(hit.conversation.title)||"Science",hit.turn,messages);
    this.targets.set(entry.task.taskId,{projectId:input.projectId,conversationId,turnId:entry.turnId});
    return {...entry.task,controls:[...entry.task.controls]};
  }
  private command(command:DaemonScienceCommand):Promise<unknown> {
    return this.client.commandObserved(command,{timeoutMs:3_000});
  }
  /** The last observation that answered, per project: a project whose service call misses its slot keeps its rows. */
  private lastProjectObservation=new Map<string,ProjectObservation>();
  /*
   * One observation of every project, inside one deadline. Each project's chain (loop, conversations, the open turn
   * and its messages) runs side by side with the others; before, up to 20 projects x (inspect + list + 4 x (attach +
   * messages)) waited for each other in sequence, so one slow reply (the Main loop busy for ~1.1 s, measured
   * 2026-10-05) used up the 2 s budget and the phone's supervisor status showed Science as unavailable. A project
   * whose chain misses the deadline keeps the rows its last answered observation produced; a project the service no
   * longer lists is dropped.
   */
  async tasks():Promise<SupervisorTask[]> {
    const deadline=performance.now()+2_000;
    // At most SCIENCE_OBSERVATION_IN_FLIGHT service calls at once. Running every project side by side without a cap
    // sent 19 science.command calls in the same millisecond when the phone connected, and all of them timed out
    // together (production 2026-10-05 20:18:18 UTC, reported by the monitoring peer session). A call whose turn comes
    // after the deadline is not sent; its project keeps its last answered rows.
    let inFlight=0;
    const waiting:Array<()=>void>=[];
    const observe=async(command:DaemonScienceCommand):Promise<unknown>=>{
      // A finishing call hands its slot straight to the next waiter, so a new caller cannot slip in between.
      if (inFlight >= SCIENCE_OBSERVATION_IN_FLIGHT) await new Promise<void>(resolve=>waiting.push(resolve));
      else inFlight+=1;
      try {
        const remaining=deadline-performance.now();
        if (remaining <= 0) throw new Error("science_observation_deadline");
        return await this.client.commandObserved(command,{observationDeadlineMs:deadline});
      } finally {
        const next=waiting.shift();
        if (next) next(); else inFlight-=1;
      }
    };
    const projects=rows(await observe({op:"projects.list"})).slice(0,20);
    const observeProject=async(project:Row)=>{
      const projectId=id(project.id);
      const tasks:SupervisorTask[]=[];
      const targets:Array<[string,Target]>=[];
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
      // A final turn the ledger shows no newer run for is not asked about again (zero service calls for that conversation);
      // every other conversation goes through the service exactly as before (composer.attach, then messages.list).
      const turns=await Promise.all(conversations.slice(0,4).filter(conversation=>id(conversation.id)).map(async (conversation):Promise<ObservedConversation|null>=>{
        const conversationId=id(conversation.id);
        const cached=this.reusable(projectId,conversationId);
        if (cached) return {conversation,conversationId,cached};
        const attached=row(await observe({op:"composer.attach",input:{projectId,conversationId}}));
        const turn=row(attached.turn); if (!id(turn.id)) return null;
        const messages=rows(await observe({op:"messages.list",input:{projectId,conversationId}}));
        return {conversation,conversationId,turn,messages};
      }));
      const entries:CachedTurn[]=[];
      for (const observed of turns) {
        if (!observed) continue;
        const {conversation,conversationId}=observed;
        // The title is the conversation list's, read this snapshot: a rename of a settled turn's conversation still shows.
        const title=id(conversation.title)||id(project.title)||id(project.name)||"Science";
        let entry:CachedTurn;
        if (observed.cached) entry=observed.cached;
        else {
          const {turn,messages}=observed;
          entry=this.turnEntry(projectId,conversationId,title,turn,messages);
        }
        entries.push(entry);
        // A cached turn still registers its control target, bound to the loop of this snapshot exactly as a fresh one is.
        targets.push([entry.task.taskId,{projectId,conversationId,turnId:entry.turnId,...(loop.activeRunId===entry.rawRunId ? {loop} : {})}]);
        tasks.push({...entry.task,title,controls:[...entry.task.controls]});
      }
      return {tasks,targets,turns:entries};
    };
    const listed=projects.filter(project=>id(project.id));
    const settled=await Promise.allSettled(listed.map(observeProject));
    const tasks:SupervisorTask[]=[];
    const targets=new Map<string,Target>();
    const kept=new Map<string,ProjectObservation>();
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
    if (!projects.some(project=>project.id===input.projectId)) throw supervisorError('supervisor_science_project_missing');
    const conversations=rows(await this.command({op:"conversations.list",input:{projectId:input.projectId}}));
    // A named conversation (thread) is the owner's choice; without one, the project's open conversation.
    const conversation=input.conversationId
      ? conversations.find(item=>id(item.id)===input.conversationId && !item.archivedAt)
      : conversations.find(item=>!item.archivedAt);
    if (input.conversationId && !conversation) throw supervisorError('supervisor_science_conversation_missing');
    if (!id(conversation?.id)) throw supervisorError('supervisor_open_science_conversation_first');
    let result:Row;
    try {
      result=row(await this.command({op:"composer.start",input:{requestId:scienceRequestId(input.commandId),projectId:input.projectId,conversationId:id(conversation!.id),mode:"append-user-message",content:input.text}}));
    } finally {
      // Settled or not (a timed-out start may still have queued a turn): the conversation's cached turn is no longer the newest.
      this.forget(input.projectId,id(conversation!.id));
    }
    const turn=row(result.turn);
    if (!id(turn.id) || !id(turn.invocationRunId)) throw supervisorError('supervisor_science_start_unconfirmed');
    return {taskId:`science-turn:${id(turn.id)}`,runId:id(turn.invocationRunId)};
  }
  async control(input:SupervisorControlInput,current:SupervisorTask):Promise<unknown> {
    const target=this.targets.get(current.taskId);
    if (!target) throw supervisorError('supervisor_science_target_missing');
    if (input.action==="cancel" && target.loop) {
      const loop=target.loop;
      return this.command({op:"loops.transition",input:{requestId:scienceRequestId(input.commandId),projectId:target.projectId,loopSessionId:id(loop.id),action:"cancel",
        expectedLoopVersion:Number(loop.version),expectedLoopStateSha256:id(loop.stateSha256),reason:"Explicit cancellation from the personal agent workspace"}});
    }
    if (!target.conversationId || !target.turnId) throw supervisorError('supervisor_science_turn_unavailable');
    if (input.action==="cancel") return this.command({op:"composer.cancel",input:{projectId:target.projectId,conversationId:target.conversationId,turnId:target.turnId}});
    return this.command({op:"composer.steer",input:{requestId:scienceRequestId(input.commandId),projectId:target.projectId,conversationId:target.conversationId,targetTurnId:target.turnId,content:input.text!,intent:"steer"}});
  }
}
