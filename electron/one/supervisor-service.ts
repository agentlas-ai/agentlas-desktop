import { randomUUID } from "node:crypto";
import type { ChatHistoryEntry, InvocationRunReceipt, McpInvocationRequest, RuntimeSelection } from "../../shared/types";
import {
  ONE_SUPERVISOR_SCHEMA, supervisorIdentifier, supervisorObject, supervisorText,
  type OneSupervisorSnapshot, type SupervisorCommandReceipt, type SupervisorControlInput,
  type SupervisorSendInput, type SupervisorTask, type SupervisorWorkInput, type SupervisorReplyTurn, type SupervisorLegacyHistory,
} from "../../shared/one-supervisor";
import { OneSupervisorStore, supervisorHash, type SupervisorRequestRow } from "./supervisor-store";
import { ONE_BUBBLE_COLORS, type OneBubbleColor } from '../../shared/one-profile';
import type { OneSupervisorWorkQueue } from "./supervisor-work-queue";

export interface SupervisorRuntime {
  start(request: McpInvocationRequest): {runId: string};
  attach(chatId: string): {runId: string} | null;
  receipt(runId: string): InvocationRunReceipt | null;
  cancel(runId: string): string;
  steer(request: McpInvocationRequest, expectedRunId: string): {queued: boolean; queuedRequestId?: string; runId?: string; activeRunId?: string};
  pauseGoal(chatId: string, goalId: string): void;
  cancelGoal(chatId: string, goalId: string): void;
  onSettled(listener: (event: {runId: string; chatId: string; receipt: InvocationRunReceipt}) => void): () => void;
}
export interface SupervisorDependencies {
  store: OneSupervisorStore;
  identity(): {oneId: string; displayName: string; avatarIcon?:string; bubbleColor?:OneBubbleColor;version?:number};
  createConversation(): string;
  history(chatId: string): ChatHistoryEntry[];
  appendUser(chatId: string, text: string): string;
  createWork(input: SupervisorWorkInput): {chatId: string; taskId: string};
  tasks(): SupervisorTask[];
  runtime: SupervisorRuntime;
  locale(): "ko" | "en";
  normalizeRuntimeSelection(value:unknown):RuntimeSelection|null;
  turns?(chatId:string,requests:SupervisorRequestRow[]):SupervisorReplyTurn[];
  appearance?(input:{expectedVersion:number;displayName:string;bubbleColor:OneBubbleColor}):void;
  legacyHistory?(oneId:string,chatId:string):SupervisorLegacyHistory;
  workQueue?: OneSupervisorWorkQueue;
  workIdentityMutable?: boolean;
  wakeWorkQueue?(): void;
  science?: {
    tasks(): Promise<SupervisorTask[]>;
    projects?():Array<{projectId:string;title:string}>;
    start(input: {commandId: string; projectId: string; text: string}): Promise<{taskId: string; runId: string}>;
    control(input: SupervisorControlInput, current: SupervisorTask): Promise<unknown>;
  };
}

const settled = (receipt: InvocationRunReceipt | null) => !!receipt && ["completed","failed","cancelled","interrupted"].includes(receipt.status);

/** A Main-owned bridge, not a daemon worker scheduler. Provider state never owns the personal identity. */
export class OneSupervisorService {
  private draining = false;
  private closed = false;
  private readonly unsubscribe: () => void;
  constructor(private readonly deps: SupervisorDependencies) {
    this.unsubscribe = deps.runtime.onSettled(event => {
      if (this.closed) return;
      for (const row of deps.store.forRun(event.runId)) this.settle(row, event.receipt);
      this.drain();
    });
  }
  close(): void { this.closed = true; this.unsubscribe(); }
  private binding(expectedOneId?:unknown): {oneId: string; displayName: string; avatarIcon?:string; bubbleColor?:OneBubbleColor;version?:number; chatId: string} {
    const identity = this.deps.identity();
    if(expectedOneId!==undefined && supervisorIdentifier(expectedOneId)!==identity.oneId) throw new Error('supervisor_identity_changed');
    if (this.deps.workIdentityMutable !== false) this.deps.workQueue?.setActiveIdentity(identity.oneId);
    return {...identity,chatId: this.deps.store.bindConversation(identity.oneId, () => this.deps.createConversation())};
  }
  /** A capability from another personal identity must not follow an account switch. */
  assertConversation(chatId:string):void {
    if(this.binding().chatId!==chatId) throw new Error('supervisor_identity_changed');
  }
  private settle(row: SupervisorRequestRow, receipt: InvocationRunReceipt): void {
    if (!settled(receipt)) return;
    if (row.kind==='cancel' && JSON.parse(row.payload_json).boundGoalId) return;
    this.deps.store.db.transaction(() => {
      const cancelRequested = row.kind === "cancel" || row.kind === "stop-reply";
      this.deps.store.update(row, {
        state: receipt.status === "completed" ? "completed" : receipt.status === "cancelled" ? "cancelled" : "failed",
        acknowledgement: "settled", reason: receipt.status === "interrupted" ? "interrupted_requires_review" : cancelRequested && receipt.status !== "cancelled" ? "cancel_raced_terminal_outcome" : row.kind==='steer' ? "application_not_yet_observed" : null,
      });
      if (row.kind === "work") this.deps.store.notice(row, receipt.status);
    })();
  }
  /** Saved-but-unclaimed replies are safe. A claimed start without proof is held, never replayed. */
  recover(): void {
    const {oneId} = this.binding();
    for (const row of this.deps.store.pending(oneId)) {
      if (!["dispatching","accepted","held"].includes(row.state) || !row.run_id || row.kind === "science" || row.task_id?.startsWith("science-") || JSON.parse(row.payload_json).boundGoalId) continue;
      const receipt = this.deps.runtime.receipt(row.run_id);
      if (settled(receipt)) this.settle(row, receipt!);
      else if (row.state === "held" && (row.kind === "reply" || row.kind === "work") && receipt?.status === "running"
        && receipt.runId === row.run_id
        && receipt.chatId === (row.kind === "reply" ? row.origin_chat_id : JSON.parse(row.payload_json).workerChatId)
        && this.deps.runtime.attach(receipt.chatId)?.runId === row.run_id) {
        // A lost start ACK can hide a live reply. Exact native receipt plus its live owner
        // restores observation and control; it never re-dispatches the start or proves
        // that an uncertain steering/cancel command was applied.
        this.deps.store.update(row, {state:"accepted",acknowledgement:"delivered",reason:"recovered_from_native_receipt"});
      }
      else if ((!receipt || this.deps.runtime.attach(receipt.chatId)?.runId !== row.run_id) && row.state !== "held") {
        this.deps.store.update(row, {state:"held",acknowledgement:"unknown",reason:"dispatch_liveness_unconfirmed"});
      }
    }
    this.drain();
  }
  send(raw: SupervisorSendInput): SupervisorCommandReceipt {
    const value = supervisorObject(raw,["commandId","text","runtimeSelection","oneId","permissions"]);
    if(value.permissions!==undefined && !['read','write','full'].includes(String(value.permissions)))throw new TypeError('supervisor_permission_invalid');
    const runtimeSelection=this.deps.normalizeRuntimeSelection(value.runtimeSelection);
    const input = {commandId:supervisorIdentifier(value.commandId),text:supervisorText(value.text),
      ...(value.permissions?{permissions:value.permissions as 'read'|'write'|'full'}:{}),
      ...(runtimeSelection ? {runtimeSelection} : {})};
    const {oneId,chatId} = this.binding(value.oneId);
    const row = this.deps.store.receive({commandId:input.commandId,oneId,kind:"reply",payload:input,originChatId:chatId,runId:randomUUID()},
      () => this.deps.appendUser(chatId,input.text));
    this.drain();
    return JSON.parse(this.deps.store.get(row.command_id)!.receipt_json);
  }
  private drain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      const {oneId,chatId} = this.binding();
      // Never release a live chat lock or infer process death from an Abort signal.
      if (this.deps.runtime.attach(chatId)) return;
      if (this.deps.store.pending(oneId).some(row => row.kind === "reply" && ["dispatching","accepted","held"].includes(row.state))) return;
      const row = this.deps.store.list(oneId,"stored").find(item => item.kind === "reply");
      if (!row) return;
      const payload = JSON.parse(row.payload_json) as SupervisorSendInput;
      this.deps.store.update(row,{state:"dispatching"});
      try {
        this.deps.runtime.start({runId:row.run_id!,chatId,userPrompt:payload.text,promptOrigin:"system",oneMode:true,
          taskIntent:"conversation",permissions:payload.permissions ?? 'read',onePermissionMode:payload.permissions ?? 'read',locale:this.deps.locale(),runtimeSelection:payload.runtimeSelection});
        const current = this.deps.store.get(row.command_id)!;
        // A synchronous fixture/adapter can settle during start().
        if (current.state === "dispatching") this.deps.store.update(current,{state:"accepted",acknowledgement:"delivered"});
      } catch (error) {
        const current = this.deps.store.get(row.command_id)!;
        if (current.state === "dispatching") this.deps.store.update(current,{state:"held",acknowledgement:"unknown",reason:error instanceof Error ? error.message.slice(0,240) : "reply_start_unconfirmed"});
      }
    } finally { this.draining = false; }
  }
  private bindHandoffOrigin(row:SupervisorRequestRow, originReplyRunId:string|undefined):void {
    if (!originReplyRunId) return;
    // The server supplies this from its Main-minted capability. It is never a tool/renderer field.
    const source=this.deps.store.db.prepare(`SELECT 1 FROM one_supervisor_requests
      WHERE one_id=? AND origin_chat_id=? AND kind='reply' AND run_id=?`).get(row.one_id,row.origin_chat_id,originReplyRunId);
    if (!source) throw new Error('supervisor_handoff_origin_invalid');
    this.deps.store.db.prepare('UPDATE one_supervisor_requests SET source_reply_run_id=? WHERE command_id=?').run(originReplyRunId,row.command_id);
  }
  startWork(raw: SupervisorWorkInput, originReplyRunId?:string): SupervisorCommandReceipt {
    const value=supervisorObject(raw,["commandId","text","projectId","permissions","runtimeSelection","oneId"]);
    const permissions=value.permissions ?? "read";
    const runtimeSelection=this.deps.normalizeRuntimeSelection(value.runtimeSelection);
    if (!["read","write","full"].includes(String(permissions))) throw new TypeError("supervisor_permission_invalid");
    const input: SupervisorWorkInput={commandId:supervisorIdentifier(value.commandId),text:supervisorText(value.text),permissions:permissions as SupervisorWorkInput["permissions"],
      ...(value.projectId ? {projectId:supervisorIdentifier(value.projectId)} : {}),
      ...(runtimeSelection ? {runtimeSelection} : {})};
    const {oneId,chatId}=this.binding(value.oneId);
    const prior=this.deps.store.get(input.commandId);
    if (prior) return JSON.parse(this.deps.store.receive({commandId:input.commandId,oneId,kind:"work",payload:input,originChatId:chatId}).receipt_json);
    if (!this.deps.workQueue && this.deps.store.pending(oneId).filter(row=>row.kind==="work" && ["dispatching","accepted","held"].includes(row.state)).length >= 2) throw new Error("supervisor_work_capacity_two");
    let row!: SupervisorRequestRow;
    this.deps.store.db.transaction(() => {
      const work=this.deps.createWork(input);
      row=this.deps.store.receive({commandId:input.commandId,oneId,kind:"work",payload:input,originChatId:chatId,taskId:work.taskId,runId:randomUUID()});
      this.bindHandoffOrigin(row,originReplyRunId);
      if (!this.deps.workQueue) this.deps.store.update(row,{state:"dispatching"});
      // Target chat stays in the payload's host-sealed receipt, not a renderer-supplied identity.
      this.deps.store.db.prepare("UPDATE one_supervisor_requests SET payload_json=? WHERE command_id=?").run(JSON.stringify({...input,workerChatId:work.chatId}),row.command_id);
      this.deps.workQueue?.enqueue(this.deps.store.get(row.command_id)!, work.chatId);
    })();
    if (this.deps.workQueue) {
      // The periodic native executor also dispatches when no renderer is open.
      // A wake is an optimization, never the durable source of pending work.
      this.deps.wakeWorkQueue?.();
      return JSON.parse(this.deps.store.get(row.command_id)!.receipt_json);
    }
    const claimed=this.deps.store.get(row.command_id)!;
    try {
      const payload=JSON.parse(claimed.payload_json) as SupervisorWorkInput & {workerChatId:string};
      this.deps.runtime.start({runId:claimed.run_id!,chatId:payload.workerChatId,userPrompt:input.text,taskIntent:"task",permissions:input.permissions,
        locale:this.deps.locale(),runtimeSelection:input.runtimeSelection});
      const current=this.deps.store.get(row.command_id)!;
      return current.state === "dispatching" ? this.deps.store.update(current,{state:"accepted",acknowledgement:"delivered"}) : JSON.parse(current.receipt_json);
    } catch (error) {
      const current=this.deps.store.get(row.command_id)!;
      return current.state==='dispatching' ? this.deps.store.update(current,{state:"held",acknowledgement:"unknown",reason:error instanceof Error ? error.message.slice(0,240) : "work_start_unconfirmed"}) : JSON.parse(current.receipt_json);
    }
  }
  async startScience(raw: {commandId:string;text:string;projectId:string;oneId?:string}, originReplyRunId?:string): Promise<SupervisorCommandReceipt> {
    const value=supervisorObject(raw,["commandId","text","projectId","oneId"]);
    const input={commandId:supervisorIdentifier(value.commandId),text:supervisorText(value.text),projectId:supervisorIdentifier(value.projectId)};
    if (!this.deps.science) throw new Error("supervisor_science_unavailable");
    const {oneId,chatId}=this.binding(value.oneId);
    const prior=this.deps.store.get(input.commandId);
    const row=this.deps.store.db.transaction(()=>{
      const saved=this.deps.store.receive({commandId:input.commandId,oneId,kind:"science",payload:input,originChatId:chatId});
      if(!prior)this.bindHandoffOrigin(saved,originReplyRunId);
      return saved;
    })();
    if (prior) return JSON.parse(row.receipt_json);
    this.deps.store.update(row,{state:"dispatching"});
    try {
      const handle=await this.deps.science.start(input);
      return this.deps.store.update(this.deps.store.get(row.command_id)!,{state:"accepted",acknowledgement:"delivered",...handle});
    } catch (error) {
      return this.deps.store.update(this.deps.store.get(row.command_id)!,{state:"held",acknowledgement:"unknown",reason:error instanceof Error ? error.message.slice(0,240) : "science_start_unconfirmed"});
    }
  }
  async control(raw: SupervisorControlInput): Promise<SupervisorCommandReceipt> {
    const value=supervisorObject(raw,["commandId","taskId","expectedVersion","action","text","oneId"]);
    if (!["steer","cancel"].includes(String(value.action))) throw new TypeError("supervisor_action_invalid");
    const input:SupervisorControlInput={commandId:supervisorIdentifier(value.commandId),taskId:supervisorIdentifier(value.taskId),expectedVersion:supervisorIdentifier(value.expectedVersion),action:value.action as "steer"|"cancel",
      ...(value.action === "steer" ? {text:supervisorText(value.text)} : {})};
    const {oneId,chatId}=this.binding(value.oneId);
    const prior=this.deps.store.get(input.commandId);
    if (prior) return JSON.parse(this.deps.store.receive({commandId:input.commandId,oneId,kind:input.action,payload:input,originChatId:chatId,taskId:input.taskId}).receipt_json);
    const task=(await this.snapshot()).tasks.find(item=>item.taskId===input.taskId);
    this.assertConversation(chatId);
    const rejected = !task || task.controlVersion !== input.expectedVersion ? "supervisor_task_version_conflict"
      : !task.controls.includes(input.action) ? "supervisor_task_control_unavailable" : null;
    if (rejected) {
      const row=this.deps.store.receive({commandId:input.commandId,oneId,kind:input.action,payload:input,originChatId:chatId,taskId:input.taskId});
      return this.deps.store.update(row,{state:"failed",acknowledgement:"settled",reason:rejected});
    }
    if (!task) throw new Error("supervisor_task_missing");
    const unstarted = this.deps.workQueue?.forTask(task.taskId);
    if (input.action === "cancel" && unstarted && ["queued", "claimed"].includes(unstarted.phase)) {
      return this.deps.store.db.transaction(() => {
        const row = this.deps.store.receive({commandId:input.commandId,oneId,kind:"cancel",payload:input,originChatId:chatId,taskId:task.taskId,runId:unstarted.run_id});
        if (!this.deps.workQueue!.cancelUnstarted(unstarted)) return this.deps.store.update(row, {
          state:"failed", acknowledgement:"settled", reason:"supervisor_task_version_conflict",
        });
        const work = this.deps.store.get(unstarted.command_id)!;
        this.deps.store.update(work, {state:"cancelled",acknowledgement:"settled",reason:"cancelled_before_dispatch"});
        this.deps.store.notice(work, "cancelled");
        return this.deps.store.update(row, {state:"cancelled",acknowledgement:"settled",reason:"cancelled_before_dispatch"});
      }).immediate();
    }
    const row=this.deps.store.receive({commandId:input.commandId,oneId,kind:input.action,payload:input,originChatId:chatId,taskId:task.taskId,runId:task.runId ?? undefined});
    this.deps.store.update(row,{state:"dispatching"});
    if (input.action === "cancel" && task.goalId) {
      this.deps.store.db.prepare("UPDATE one_supervisor_requests SET payload_json=? WHERE command_id=?").run(JSON.stringify({...input,boundGoalId:task.goalId}),row.command_id);
    }
    try {
      if (task.surface === "science") {
        await this.deps.science!.control(input,task);
      } else {
        if (!task.chatId || !task.runId && !task.goalId) throw new Error("supervisor_task_run_missing");
        if (input.action === "cancel") {
          if (task.goalId) this.deps.runtime.cancelGoal(task.chatId,task.goalId);
          else if (this.deps.runtime.cancel(task.runId!) === "not-found") throw new Error("supervisor_task_run_settled");
        } else {
          const result=this.deps.runtime.steer({chatId:task.chatId,userPrompt:input.text!,taskIntent:"task",promptOrigin:"system",locale:this.deps.locale(),steeringMode:"queue"},task.runId!);
          if (!result.queued || (result.activeRunId && result.activeRunId !== task.runId)) throw new Error("supervisor_task_steer_unconfirmed");
        }
      }
      const current=this.deps.store.get(row.command_id)!;
      return current.state==='dispatching' ? this.deps.store.update(current,{state:"accepted",acknowledgement:"delivered",reason:input.action === "cancel" ? "cleanup_pending" : "application_not_yet_observed"}) : JSON.parse(current.receipt_json);
    } catch (error) {
      const current=this.deps.store.get(row.command_id)!;
      return current.state==='dispatching' ? this.deps.store.update(current,{state:"held",acknowledgement:"unknown",reason:error instanceof Error ? error.message.slice(0,240) : "control_outcome_unknown"}) : JSON.parse(current.receipt_json);
    }
  }
  stopReply(raw: {commandId:string;runId:string;oneId?:string}): SupervisorCommandReceipt {
    const value=supervisorObject(raw,["commandId","runId","oneId"]);
    const input={commandId:supervisorIdentifier(value.commandId),runId:supervisorIdentifier(value.runId)};
    const {oneId,chatId}=this.binding(value.oneId);
    const prior=this.deps.store.get(input.commandId);
    if (prior) return JSON.parse(this.deps.store.receive({commandId:input.commandId,oneId,kind:"stop-reply",payload:input,originChatId:chatId,runId:input.runId}).receipt_json);
    const row=this.deps.store.receive({commandId:input.commandId,oneId,kind:"stop-reply",payload:input,originChatId:chatId,runId:input.runId});
    if (this.deps.runtime.attach(chatId)?.runId !== input.runId) return this.deps.store.update(row,{state:"failed",acknowledgement:"settled",reason:"supervisor_reply_target_stale"});
    this.deps.store.update(row,{state:"dispatching"});
    try {
      if(this.deps.runtime.cancel(input.runId)==='not-found') throw new Error('supervisor_reply_target_stale');
      const current=this.deps.store.get(row.command_id)!;
      return current.state==='dispatching' ? this.deps.store.update(current,{state:"accepted",acknowledgement:"delivered",reason:"reply_cleanup_pending"}) : JSON.parse(current.receipt_json);
    } catch(error) {
      const current=this.deps.store.get(row.command_id)!;
      return current.state==='dispatching' ? this.deps.store.update(current,{state:"held",acknowledgement:"unknown",reason:error instanceof Error?error.message.slice(0,240):'reply_stop_unconfirmed'}) : JSON.parse(current.receipt_json);
    }
  }
  async snapshot(): Promise<OneSupervisorSnapshot> {
    this.recover();
    const binding=this.binding();
    let science:SupervisorTask[]=[]; let scienceError:string|null=null;
    try { science=await this.deps.science?.tasks() ?? []; } catch(error) {scienceError=error instanceof Error ? error.message.slice(0,240) : "science_observation_unavailable";}
    this.assertConversation(binding.chatId);
    const tasks=this.deps.tasks().filter(task=>task.chatId!==binding.chatId).concat(science);
    for (const job of this.deps.workQueue?.list(binding.oneId) ?? []) {
      const task = tasks.find(item => item.taskId === job.task_id && item.chatId === job.chat_id);
      if (task && ["queued", "claimed", "cancelled", "held"].includes(job.phase)
        && (task.runId === null || task.runId === job.run_id)) {
        task.state = job.phase === "claimed" ? "queued" : job.phase;
        task.runId = job.run_id;
        task.controlVersion = this.deps.workQueue!.version(job);
        task.controls = ["queued", "claimed"].includes(job.phase) ? ["cancel"] : [];
        task.observedAt = new Date(job.updated_at).toISOString();
      }
    }
    for (const row of this.deps.store.pending(binding.oneId).filter(row=>row.kind === "science" && !row.task_id)) {
      const projectId=JSON.parse(row.payload_json).projectId;
      const task=science.find(item=>item.sourceCommandId === row.command_id && item.projectId === projectId);
      if (task?.runId) this.deps.store.update(row,{taskId:task.taskId,runId:task.runId,state:"accepted",acknowledgement:"delivered",reason:"recovered_from_native_receipt"});
    }
    for (const row of this.deps.store.pending(binding.oneId).filter(row=>row.kind === "cancel")) {
      const goalId=JSON.parse(row.payload_json).boundGoalId;
      if (!goalId) continue;
      const task=tasks.find(item=>item.taskId === row.task_id && item.goalId === goalId);
      if (task && task.state === "cancelled" && (!task.chatId || this.deps.runtime.attach(task.chatId)?.runId !== row.run_id)) {
        this.deps.store.update(row,{state:"cancelled",acknowledgement:"settled",reason:"native_goal_stopped"});
      }
    }
    // Native Science outcomes reconcile the journal without starting or resuming execution.
    for (const row of this.deps.store.pending(binding.oneId)) {
      if (!row.task_id) continue;
      const task=science.find(item=>item.taskId===row.task_id && (item.runId===row.run_id || !item.runId && ["completed","failed","cancelled","interrupted"].includes(item.state)));
      if (task && ["completed","failed","cancelled","interrupted"].includes(task.state)) {
        this.deps.store.db.transaction(()=>{
          this.deps.store.update(row,{state:task.state === "completed" ? "completed" : task.state === "cancelled" ? "cancelled" : "failed",acknowledgement:"settled",reason:null});
          if (row.kind === "science") this.deps.store.notice(row,task.state);
        })();
      }
    }
    const controls=this.deps.store.pending(binding.oneId).filter(row=>row.kind==="cancel" && ["dispatching","accepted","held"].includes(row.state));
    for (const task of tasks) {
      const cancel=controls.find(row=>row.task_id===task.taskId && row.run_id===task.runId);
      if (cancel && !["completed","failed","cancelled","interrupted"].includes(task.state)) {task.state="cancelling"; task.controls=[]; task.controlVersion=supervisorHash([task.controlVersion,cancel.command_id]);}
    }
    return {schema:ONE_SUPERVISOR_SCHEMA,oneId:binding.oneId,displayName:binding.displayName,avatarIcon:binding.avatarIcon ?? 'character:orange-dino',bubbleColor:binding.bubbleColor ?? 'blue',profileVersion:binding.version ?? 1,conversationChatId:binding.chatId,
      observedAt:new Date().toISOString(),executor:"desktop-local",workOwner:"desktop-main",scienceAvailable:!!this.deps.science && !scienceError,scienceError,
      scienceProjects:scienceError ? [] : this.deps.science?.projects?.() ?? [],
      tasks,messages:this.deps.history(binding.chatId),requests:this.deps.store.list(binding.oneId).map(row=>JSON.parse(row.receipt_json)),notices:this.deps.store.notices(binding.oneId),
      turns:this.deps.turns?.(binding.chatId,this.deps.store.list(binding.oneId)) ?? [],
      ...(this.deps.legacyHistory?{legacyHistory:this.deps.legacyHistory(binding.oneId,binding.chatId)}:{}),
      delegations:this.deps.store.list(binding.oneId).filter(row=>row.kind==='work'||row.kind==='science').reverse().map(row=>({
        commandId:row.command_id,surface:row.kind as 'work'|'science',title:String(JSON.parse(row.payload_json).text).split(/\r?\n/,1)[0].slice(0,120),
        taskId:row.task_id,runId:row.run_id,originReplyRunId:row.source_reply_run_id,state:row.state,createdAt:row.created_at,
      }))};
  }
  appearance(raw:{commandId:string;oneId:string;expectedVersion:number;displayName:string;bubbleColor:OneBubbleColor}):SupervisorCommandReceipt {
    const value=supervisorObject(raw,['commandId','oneId','expectedVersion','displayName','bubbleColor']);
    if(!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion)<=0 || typeof value.displayName!=='string' || !value.displayName.trim() || value.displayName.length>64 || typeof value.bubbleColor!=='string' || !Object.hasOwn(ONE_BUBBLE_COLORS,value.bubbleColor)) throw new TypeError('supervisor_appearance_invalid');
    const input={commandId:supervisorIdentifier(value.commandId),oneId:supervisorIdentifier(value.oneId),expectedVersion:Number(value.expectedVersion),displayName:value.displayName.trim(),bubbleColor:value.bubbleColor as OneBubbleColor};
    const binding=this.binding();if(input.oneId!==binding.oneId) throw new Error('supervisor_identity_changed');
    return this.deps.store.db.transaction(()=>{
      const prior=this.deps.store.get(input.commandId);
      const row=this.deps.store.receive({commandId:input.commandId,oneId:binding.oneId,kind:'appearance',payload:input,originChatId:binding.chatId});
      if(prior)return JSON.parse(row.receipt_json);
      if(binding.version!==undefined && input.expectedVersion!==binding.version) return this.deps.store.update(row,{state:'failed',acknowledgement:'settled',reason:'supervisor_profile_version_conflict'});
      if(!this.deps.appearance)throw new Error('supervisor_appearance_unavailable');
      this.deps.appearance(input);
      return this.deps.store.update(row,{state:'completed',acknowledgement:'settled'});
    })();
  }
}
