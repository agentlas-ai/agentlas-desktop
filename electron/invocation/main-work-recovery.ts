import { createHash } from "node:crypto";
import { DesktopWorkRecoveryJournal, workUnitId } from "./work-recovery-store";
import { getDb } from "../store/db";
import { invocationAttemptBinding, recordRunEvent } from "../store/run-events";
import { ensureCanonicalTaskForChat, findCanonicalTaskForChat } from "../store/tasks";
import { getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { latestTaskCheckpoint } from "../long-run/checkpoint";
import { decideWorkRecovery, WORK_RECOVERY_POLICY_VERSION, type WorkUnit, type ExpectedWorkOutcome } from "../../shared/work-recovery";

type Result = { content: string; isError: boolean; visionMessage: unknown; artifactPaths?: readonly string[]; rawMcpResult?: Record<string, unknown> };
interface Scope { runId: string; taskId: string; revision: string; stepIds: string[]; defaultStepId: string }
interface Action { actionId: string; stepId: string; taskId: string; revision: string; methodId: string; inputDigest: string;
  originInvocationRunId: string; expected: ExpectedWorkOutcome; observational: boolean }
export interface MainWorkReference { action_id?: string; step_id?: string; regenerate_read?: true }
/**
 * How a call the host dispatched in this process ended without its answer, read from machine facts (the MCP transport boundary,
 * the run's abort signal, a typed timeout), never from message text. Recorded in the journal reason after `main_tool_outcome_unknown:`.
 */
export type MainWorkUnknownEnd = "timeout" | "aborted" | "transport" | "response_unreadable" | "dispatch_ended";
/** `returned`: the tool's own answer came back. `not_sent`: the request never left Main. Otherwise the call ended without its answer. */
export type MainWorkFinish = "returned" | "not_sent" | "unconfirmed" | MainWorkUnknownEnd;
const UNKNOWN_END = "main_tool_outcome_unknown:";
const TERMINAL = ["succeeded", "cancelled", "failed"];
const contexts = new WeakSet<object>();
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const RESULT_STORAGE = "agentlas.main-work-result-bytes.v1";

// The existing action/journal remains the execution authority. This table
// holds only its original result bytes, never a second queue or an admission.
function resultStore() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS main_work_result_bytes (
    event_id TEXT PRIMARY KEY REFERENCES run_events(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL, task_id TEXT NOT NULL, action_id TEXT NOT NULL,
    revision TEXT NOT NULL, method_id TEXT NOT NULL, input_digest TEXT NOT NULL,
    origin_run_id TEXT NOT NULL, generation INTEGER NOT NULL,
    owner_epoch TEXT NOT NULL, attempt_id TEXT NOT NULL,
    digest TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    result_bytes BLOB NOT NULL,
    CHECK(size_bytes > 0 AND size_bytes <= 33554432 AND size_bytes = length(result_bytes)),
    UNIQUE(run_id, action_id, generation)
  )`);
  return db;
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function decodeAction(payload:string):Action {
  const saved=JSON.parse(payload);
  // run_events adds its own runtimeEvidence envelope. Compare every field of
  // the immutable action manifest independently of that ledger envelope.
  return {actionId:saved.actionId,stepId:saved.stepId,taskId:saved.taskId,revision:saved.revision,
    methodId:saved.methodId,inputDigest:saved.inputDigest,originInvocationRunId:saved.originInvocationRunId,
    observational:saved.observational,expected:typeof saved.expected==="string" ? JSON.parse(saved.expected) : saved.expected};
}

/** Host-only port. Canonical task/plan steps and persisted action ordinals own
 * identity. A provider call id and the broker's ephemeral action UUID never do. */
export class MainWorkRecoveryContext {
  private readonly journal = new DesktopWorkRecoveryJournal();
  /**
   * Actions this run dispatched (admit with `live`) whose call has not ended: they are in flight in this process, so their outcome is
   * pending rather than lost. A code-mode program that calls tools side by side (`Promise.all`) has several at once; the first one
   * used to make the others "read the original outcome first" (Finance 1008 rs-T03, Light on the serving lane, 2026-10-22: four
   * bare `harness_call` lookups at once, one admitted, three refused, the program ended and the aborted one stayed `started`,
   * which blocked the whole step). Only an action that is no longer live yet has no outcome (aborted, lost, a previous run) blocks.
   */
  private readonly live = new Map<string, { unit: WorkUnit; observational: boolean }>();
  constructor(private readonly chatId: string, private readonly invocationRunId: string,
    private readonly assertCurrent: () => void) { contexts.add(this); }

  /**
   * The dispatch of this action ended, whichever way. If its started attempt was never closed (an exception between admission and
   * finish: an abort rethrown at result delivery, a run that stopped being current, a result that could not be stored), it is closed
   * here, so no action this process ran stays `started` (Finance 1008 rs7 rs-V40, 2026-10-23: a code-mode abort left one started and
   * every later call of the step was refused). `effectStarted` false means the request never left Main.
   * Never throws: closing the claim must not hide the dispatch's own error.
   */
  endDispatch(actionId: string, effectStarted: boolean): void {
    const entry = this.live.get(actionId);
    this.live.delete(actionId);
    if (!entry) return;
    try {
      const current = this.journal.read(entry.unit.runId, entry.unit.unitId);
      if (!current || current.state !== "started" || current.attemptId !== entry.unit.attemptId
        || current.generation !== entry.unit.generation) return;
      this.close(current, entry.observational, effectStarted ? "dispatch_ended" : "not_sent");
    } catch { /* the journal stays as it was; the dispatch's own error is what the caller sees */ }
  }

  /**
   * A call that ended without its answer. Never sent: no effect (cancelled). A read: no effect, a known end (failed), so it can run
   * again. Anything else: the effect is unknown, recorded as held with its cause; only an identical repeat waits (admit), the step
   * goes on (Finance 1008 rs7 rs-V02/V03, 2026-10-23: one World Bank fetch timed out at 30 s and every later call of the step was refused).
   */
  private close(unit: WorkUnit, observational: boolean, end: "not_sent" | MainWorkUnknownEnd): void {
    if (end === "not_sent") this.journal.transition(unit, "cancelled", { reason: "main_tool_request_not_sent" });
    else if (observational) this.journal.transition(unit, "failed", { reason: `main_tool_read_outcome_lost:${end}` });
    else this.journal.transition(unit, "held", { reason: `${UNKNOWN_END}${end}` });
  }

  /** The cause recorded when the host saw this held action's call end without an answer; null for any other state or reason. */
  private unknownEnd(runId: string, unitId: string): MainWorkUnknownEnd | null {
    const row = getDb().prepare(`SELECT json_extract(payload_json,'$.state') state, json_extract(payload_json,'$.reason') reason FROM run_events
      WHERE run_id=? AND kind='work_unit_transition' AND json_extract(payload_json,'$.unitId')=? ORDER BY seq DESC LIMIT 1`)
      .get(runId, unitId) as { state: string; reason: string | null } | undefined;
    return row?.state === "held" && typeof row.reason === "string" && row.reason.startsWith(UNKNOWN_END)
      ? row.reason.slice(UNKNOWN_END.length) as MainWorkUnknownEnd : null;
  }

  /**
   * `blocking`: non-read actions of the step whose outcome was lost with no record of how the call ended (started across a restart or
   * in another run, a held row from before this rule): every later non-read call of the step waits for them, as before. A read never
   * blocks (it has no effect). A call still in flight in this run (`live`) is pending, not lost.
   * `unknown`: actions of the task revision whose call this host saw end without an answer: only an identical repeat waits for them.
   */
  private outcomes(scope: Scope, actions: Action[], stepId: string) {
    const rows = actions.filter(item => !this.live.has(item.actionId)).map(action => {
      const state = this.journal.read(scope.runId, action.actionId)?.state ?? "held";
      return { action, state, end: state === "held" ? this.unknownEnd(scope.runId, action.actionId) : null };
    }).filter(row => !TERMINAL.includes(row.state));
    return { blocking: rows.filter(row => row.action.stepId === stepId && !row.action.observational && row.end === null),
      unknown: rows.filter(row => row.end !== null) };
  }

  private scope(): Scope {
    this.assertCurrent();
    const chat = getChat(this.chatId);
    const task = findCanonicalTaskForChat(this.chatId) ?? ensureCanonicalTaskForChat(this.chatId);
    if (!chat || chat.archivedAt || !task || task.archivedAt) throw new Error("main_work_scope_missing");
    // The controller attempt of this invocation, not whichever attempt row comes first (a specialist shares the id).
    const worker = invocationAttemptBinding(this.invocationRunId);
    const goalId=chat.goalId ?? worker?.goal_id;
    const goal = goalId ? getChatGoalRevision(goalId) : null;
    const checkpoint = goalId ? latestTaskCheckpoint(goalId) : null;
    const user = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(this.chatId) as {id:string} | undefined;
    const revision = goal ? `goal:${goal.goalId}:revision:${goal.revision}` : `user:${user?.id ?? task.id}`;
    const steps = checkpoint?.goalRevision === goal?.revision ? checkpoint?.capsule.plan?.steps.map(step => step.taskId) ?? [] : [];
    // "runtime" is the existing canonical task projection's run step. It
    // remains the default before a Goal has a typed checkpoint plan.
    return { runId:`main-work:${task.id}`, taskId:task.id, revision, stepIds:["runtime",...steps],
      defaultStepId:worker?.task_id && steps.includes(worker.task_id) ? worker.task_id : "runtime" };
  }

  /** The recovery packet for the prompt. With no action recorded there is nothing to recover: the packet is empty unless the caller asks for it (an error result keeps the step ids). */
  packet(options: { always?: boolean } = {}): string {
    if (!findCanonicalTaskForChat(this.chatId)) return "";
    const scope=this.scope(), actions=this.actions(scope);
    if (actions.length===0 && !options.always) return "";
    return JSON.stringify({ schemaVersion:"agentlas.main-work-recovery.v1", taskId:scope.taskId,
      revision:scope.revision, stepIds:scope.stepIds,
      totalActions:actions.length, historyComplete:actions.length<=64,
      actions:actions.slice(-64).map(action=>({actionId:action.actionId,stepId:action.stepId,methodId:action.methodId,
        state:this.journal.read(scope.runId,action.actionId)?.state,expected:action.expected})),
      instruction:"Use _agentlas_work.action_id for the same logical action after a model change or restart. Read its original outcome first. Only a confirmed completed observational action can request regenerate_read; its original identity and total-two method cap remain. Select a different canonical step for independent work. A provider call id is only transport correlation." });
  }

  /**
   * The recovery view a `main_work_read_original_outcome` refusal carries: the actions of that step whose outcome never came back and what
   * to do about them, not the whole history. The full packet (up to 64 actions with their expected-outcome descriptors) is about 28 KB;
   * every refused call added it to the conversation (Finance 1008 rs-Q09, Normal on the serving lane, 2026-10-22: a code run refused
   * twenty times, one task reaching 1.3M input tokens), and its instruction, "read its original outcome first", cannot be followed for an
   * action whose call was aborted or lost: no outcome was ever stored, so the read answers tool_result_reference_unknown. The prompt
   * packet above is unchanged.
   */
  refusalPacket(stepId?: string): string {
    if (!findCanonicalTaskForChat(this.chatId)) return "";
    const scope=this.scope(), actions=this.actions(scope), step=stepId ?? scope.defaultStepId;
    const unresolved=this.outcomes(scope,actions,step).blocking;
    return JSON.stringify({ schemaVersion:"agentlas.main-work-recovery.v1", taskId:scope.taskId, revision:scope.revision, stepIds:scope.stepIds,
      stepId:step, totalActions:actions.length, unresolvedTotal:unresolved.length,
      unresolved:unresolved.slice(-8).map(({action,state})=>({actionId:action.actionId,methodId:action.methodId,state,outcomeStored:false})),
      instruction:"These actions have no stored outcome: the call ended before its answer arrived, so reading main-tool-outcome:<actionId> answers tool_result_reference_unknown. Do not repeat them blindly. Non-read tools stay paused for this step until their effect is verified: check it with a read-only tool, or tell the person what is unconfirmed and ask. Independent work can select another step_id from stepIds. After a model change or restart, pass _agentlas_work.action_id to continue the same logical action. A provider call id is only transport correlation." });
  }

  /**
   * The view a `main_work_same_action_outcome_unknown` refusal carries: the identical earlier call, how it ended, and what can be done.
   * Under 1 KB; the step itself is not blocked, so it lists nothing else.
   */
  unknownOutcomePacket(actionIds: readonly string[]): string {
    if (!findCanonicalTaskForChat(this.chatId)) return "";
    const scope=this.scope(), byId=new Map(this.actions(scope).map(action=>[action.actionId,action]));
    return JSON.stringify({ schemaVersion:"agentlas.main-work-recovery.v1", taskId:scope.taskId, revision:scope.revision,
      unknown:actionIds.slice(-4).map(id=>({actionId:id,methodId:byId.get(id)?.methodId,state:"held",ended:this.unknownEnd(scope.runId,id),outcomeStored:false})),
      instruction:"An identical earlier call ended without its answer, so whether its effect happened is unknown, and it is not run again automatically. Other calls in this task can continue. Check the effect with a read-only tool, or tell the person what is unconfirmed and ask." });
  }

  private actions(scope: Scope): Action[] {
    return (getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND kind='main_work_action'
      AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.revision')=? ORDER BY seq`)
      .all(scope.runId,scope.taskId,scope.revision) as Array<{payload_json:string}>).map(row=>decodeAction(row.payload_json));
  }

  admit(input: { reference?: MainWorkReference; methodId: string; arguments: Record<string,unknown>; observational: boolean; live?: boolean }):
    { unit: WorkUnit; action: Action } | { reused: Result; action: Action } {
    assertMainWorkRecoveryContext(this);const scope=this.scope();
    return getDb().transaction(()=>{
      this.assertCurrent();const actions=this.actions(scope), stepId=input.reference?.step_id ?? scope.defaultStepId;
      if (!scope.stepIds.includes(stepId)) throw new Error("main_work_checkpoint_step_invalid");
      let action=input.reference?.action_id ? actions.find(item=>item.actionId===input.reference!.action_id) : undefined;
      if (input.reference?.action_id && !action) throw new Error("main_work_action_not_in_task");
      if (action && (input.reference?.step_id && action.stepId!==stepId || action.methodId!==input.methodId
        || action.inputDigest!==digest(input.arguments))) throw new Error("main_work_action_input_conflict");
      if (!action) {
        // Only a non-read action whose outcome was lost with no record of how its call ended (started across a restart or in
        // another run) blocks the next one of its step. A returned error (failed) or a call that never left Main (cancelled) has a
        // known end, a call still in flight in this run (a sibling of a code-mode program, see `live`) has a pending one, and a call
        // this host saw end without its answer (timeout, abort, lost transport: held with its cause) holds back only its identical repeat.
        const outcomes=this.outcomes(scope,actions,stepId), inputDigest=digest(input.arguments);
        if (!input.observational && outcomes.blocking.length) throw new Error(`main_work_read_original_outcome:${outcomes.blocking.map(row=>row.action.actionId).join(",")}`);
        const same=outcomes.unknown.filter(row=>row.action.methodId===input.methodId && row.action.inputDigest===inputDigest);
        if (!input.observational && same.length) throw new Error(`main_work_same_action_outcome_unknown:${same.map(row=>row.action.actionId).join(",")}`);
        const ordinal=Number((getDb().prepare("SELECT count(*) n FROM run_events WHERE run_id=? AND kind='main_work_action'").get(scope.runId) as {n:number}).n)+1;
        const actionId=workUnitId({runId:scope.runId,taskId:scope.taskId,stepId:`${stepId}:action:${ordinal}`,revision:scope.revision});
        action={actionId,stepId,taskId:scope.taskId,revision:scope.revision,methodId:input.methodId,inputDigest,
          originInvocationRunId:this.invocationRunId, observational:input.observational,
          expected:{unitId:actionId,revision:scope.revision,inputDigest,targetRef:`main-tool-outcome:${actionId}`,
            description:"The original approved tool action must return a durable, exact result. A result receipt alone does not confirm an external domain effect."}};
        recordRunEvent({runId:scope.runId,chatId:this.chatId,kind:"main_work_action",sourceEventId:`main-work-action:${actionId}`,
          payload:{...action,expected:JSON.stringify(action.expected)}});
        // The general event writer stores nested objects as text. Keep one
        // canonical decoded manifest, and confirm it by reading the ledger.
        const saved=this.readAction(scope,actionId);if (!saved || digest(saved)!==digest(action)) throw new Error("main_work_action_not_durable");
      }
      let unit=this.journal.read(scope.runId,action.actionId);
      if (!unit) {
        unit=this.journal.transition({runId:scope.runId,taskId:scope.taskId,unitId:action.actionId,parentUnitId:action.stepId,
          revision:scope.revision,inputDigest:action.inputDigest,methodId:action.methodId,state:"ready",generation:0,
          ownerEpoch:this.invocationRunId,attemptId:"",methodStarts:0,dependencyIds:[]},"ready",{reason:"canonical_main_action"});
        if (!unit) throw new Error("main_work_action_claim_failed");
      }
      if (unit.state==="succeeded") {
        const result=this.readResult(scope,unit);
        if (!result) throw new Error("main_work_result_read_unavailable");
        if(!input.reference?.regenerate_read)return {reused:result,action};
        if(!action.observational || !input.observational)throw new Error("main_work_read_regeneration_required");
        const proof=unit.resultRef!;
        const reopened=this.journal.reopenCompletedRead(unit,unit.inputDigest,proof);
        if(!reopened)throw new Error("main_work_same_method_limit");
        unit=reopened;
        // Explicit Host admission of a fresh observation invalidates only its
        // new generation's result. The old successful output remains readable;
        // a failed/unknown/remote mutation never enters this path.
        if(!this.journal.observe(unit,action.expected,{...action.expected,status:"absent",evidenceRef:proof,
          querySucceeded:true,complete:true,fresh:true,propagationSettled:true,remoteExecutionEnded:true}))throw new Error("main_work_read_regeneration_not_durable");
      }
      if (unit.state!=="ready") {
        const observed=this.journal.latestObservation(unit);
        const decision=decideWorkRecovery(unit,{policyVersion:WORK_RECOVERY_POLICY_VERSION,scopeCurrent:true,authorized:true,budgetAvailable:true,
          userStopped:false,methodRefused:false,worker:observed?.remoteExecutionEnded ? "terminated" : "unknown",
          alternateAvailable:false,requiresUser:false,questionCount:0,lastAskedAt:null,now:Date.now()},action.expected,observed);
        if (decision.action!=="retry") throw new Error(`main_work_${decision.reason}`);
      }
      const started=this.journal.transition(unit,"started",{reason:"main_canonical_tool_dispatch"});
      if (!started) throw new Error("main_work_same_method_limit_or_claim_changed");
      // Registered in the same synchronous step as the transition, so no sibling's admit can see a started action that is not yet live.
      if (input.live) this.live.set(action.actionId,{unit:started,observational:action.observational});
      return {unit:started,action};
    }).immediate();
  }

  private readAction(scope:Scope,id:string):Action|null {
    const row=getDb().prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='main_work_action' AND json_extract(payload_json,'$.actionId')=?")
      .get(scope.runId,id) as {payload_json:string}|undefined;
    return row ? decodeAction(row.payload_json) : null;
  }

  private readResult(scope:Scope,unit:WorkUnit):Result|null {
    this.assertCurrent();
    if (unit.state!=="succeeded" || unit.runId!==scope.runId || unit.taskId!==scope.taskId
      || unit.revision!==scope.revision) return null;
    const row=getDb().prepare(`SELECT id,payload_json FROM run_events WHERE run_id=? AND chat_id=?
      AND kind='main_work_result' AND json_extract(payload_json,'$.actionId')=? ORDER BY seq DESC LIMIT 1`)
      .get(scope.runId,this.chatId,unit.unitId) as {id:string;payload_json:string}|undefined;
    if (!row) return null;
    try {
      const p=JSON.parse(row.payload_json);
      if (unit.resultRef!==`main-work-result:${row.id}:${p.digest}`) return null;
      let serialized:string;
      if (p.storage===RESULT_STORAGE) {
        if (!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='main_work_result_bytes'").get()) return null;
        const action=this.readAction(scope,unit.unitId);
        if (!action || action.taskId!==scope.taskId || action.revision!==scope.revision
          || action.inputDigest!==unit.inputDigest || action.methodId!==unit.methodId) return null;
        const bytes=getDb().prepare(`SELECT digest,size_bytes,result_bytes FROM main_work_result_bytes
          WHERE event_id=? AND chat_id=? AND run_id=? AND task_id=? AND action_id=? AND revision=?
          AND method_id=? AND input_digest=? AND origin_run_id=? AND generation=? AND owner_epoch=? AND attempt_id=?`)
          .get(row.id,this.chatId,scope.runId,scope.taskId,unit.unitId,scope.revision,unit.methodId,
            unit.inputDigest,action.originInvocationRunId,unit.generation,unit.ownerEpoch,unit.attemptId) as
          {digest:string;size_bytes:number;result_bytes:Buffer}|undefined;
        if (!bytes || bytes.digest!==p.digest || bytes.size_bytes!==p.sizeBytes || !Buffer.isBuffer(bytes.result_bytes)
          || bytes.size_bytes<1 || bytes.size_bytes>MAX_RESULT_BYTES || bytes.result_bytes.length!==bytes.size_bytes
          || `sha256:${createHash("sha256").update(bytes.result_bytes).digest("hex")}`!==p.digest) return null;
        serialized=bytes.result_bytes.toString("utf8");
        if (!Buffer.from(serialized,"utf8").equals(bytes.result_bytes)) return null;
      } else {
        // Old inline receipts remain readable only when their original hash
        // matches. A historical digest-only receipt cannot invent an original.
        if (p.storage!==undefined || typeof p.result!=="string") return null;
        serialized=p.result;
      }
      const value=JSON.parse(serialized);
      if (!value || typeof value!=="object" || Array.isArray(value) || typeof value.content!=="string"
        || value.isError!==false || (value.artifactPaths!==undefined && (!Array.isArray(value.artifactPaths)
          || value.artifactPaths.some((item:unknown)=>typeof item!=="string")))
        || (value.rawMcpResult!==undefined && (!value.rawMcpResult || typeof value.rawMcpResult!=="object"
          || Array.isArray(value.rawMcpResult))) || digest(value)!==p.digest) return null;
      this.assertCurrent();
      return value;
    } catch {
      // Missing/corrupt bytes are an unavailable original, never permission to
      // repeat an external action or to return a bounded diagnostic instead.
      return null;
    }
  }

  /** The admitted call never left Main (a pre-dispatch refusal): no effect exists, so it closes as cancelled. */
  release(admission:{unit:WorkUnit;action:Action}):void {
    this.assertCurrent();const scope=this.scope();
    if(scope.runId!==admission.unit.runId || scope.revision!==admission.unit.revision)throw new Error("main_work_completion_scope_changed");
    this.journal.transition(admission.unit,"cancelled",{reason:"main_tool_not_dispatched"});
  }

  /** `returned`: the tool's own result came back (a builtin ended, an MCP server answered), so an error is a known
   * end (failed). `not_sent`: the request never left Main (cancelled). Otherwise the call ended before its result (timeout,
   * abort, lost transport; `unconfirmed` = transport): see close().
   * Measured 2026-10-17 (dev A/B4, BYOK Haiku): every error was held, and a held action blocks every later non-read
   * action of its step with no way to clear it, so one non-zero shell exit ended all writes for the task revision. */
  finish(admission:{unit:WorkUnit;action:Action},result:Result,outcome:MainWorkFinish="returned"):void {
    this.assertCurrent();const scope=this.scope();
    if(scope.runId!==admission.unit.runId || scope.revision!==admission.unit.revision)throw new Error("main_work_completion_scope_changed");
    const stored={content:result.content,isError:result.isError,visionMessage:result.visionMessage,
      ...(result.artifactPaths ? {artifactPaths:result.artifactPaths} : {}),...(result.rawMcpResult ? {rawMcpResult:result.rawMcpResult} : {})};
    const serialized=JSON.stringify(stored);
    if(outcome!=="returned") {
      this.close(admission.unit,admission.action.observational,outcome==="unconfirmed" ? "transport" : outcome);
      return;
    }
    if(result.isError) {
      this.journal.transition(admission.unit,"failed",{reason:"main_tool_error_returned"});
      return;
    }
    const bytes=Buffer.from(serialized,"utf8");
    if(bytes.length>MAX_RESULT_BYTES)throw new Error("main_work_result_too_large");
    getDb().transaction(()=>{
      this.assertCurrent();
      const action=this.readAction(scope,admission.unit.unitId);
      if(admission.unit.state!=="started" || admission.unit.taskId!==scope.taskId
        || admission.action.actionId!==admission.unit.unitId || !action || digest(action)!==digest(admission.action)
        || action.taskId!==scope.taskId || action.revision!==scope.revision
        || action.inputDigest!==admission.unit.inputDigest || action.methodId!==admission.unit.methodId)
        throw new Error("main_work_completion_action_changed");
      const db=resultStore(), resultDigest=digest(stored);
      const event=recordRunEvent({runId:scope.runId,chatId:this.chatId,kind:"main_work_result",
        payload:{actionId:action.actionId,digest:resultDigest,storage:RESULT_STORAGE,sizeBytes:bytes.length,
          ...(serialized.length<=1000 ? {result:serialized} : {})}});
      // Store the exact original in the same transaction as its existing
      // receipt and success CAS. Generic run-event redaction/previews stay as-is.
      db.prepare(`INSERT INTO main_work_result_bytes(event_id,chat_id,run_id,task_id,action_id,revision,
        method_id,input_digest,origin_run_id,generation,owner_epoch,attempt_id,digest,size_bytes,result_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id,this.chatId,scope.runId,scope.taskId,action.actionId,
          scope.revision,action.methodId,action.inputDigest,action.originInvocationRunId,admission.unit.generation+1,
          admission.unit.ownerEpoch,admission.unit.attemptId,resultDigest,bytes.length,bytes);
      const resultRef=`main-work-result:${event.id}:${resultDigest}`;
      const completed=this.journal.transition(admission.unit,"succeeded",{reason:"main_tool_result_confirmed",resultRef});
      if(!completed)throw new Error("main_work_completion_owner_changed");
      if(!this.readResult(scope,completed))throw new Error("main_work_result_not_durable");
      this.assertCurrent();
    }).immediate();
  }
}

export function assertMainWorkRecoveryContext(value:unknown):asserts value is MainWorkRecoveryContext {
  if(!value || typeof value!=="object" || !contexts.has(value))throw new Error("main_work_host_port_required");
}

export function mainWorkToolSchema(schema:unknown):unknown {
  if(!schema || typeof schema!=="object" || Array.isArray(schema))return schema;
  const object=schema as Record<string,unknown>;
  return {...object,properties:{...(object.properties as Record<string,unknown> ?? {}),_agentlas_work:{type:"object",
    description:"Optional host canonical action/step reference for recovery. Read existing action outcomes before repetition.",
    properties:{action_id:{type:"string"},step_id:{type:"string"},regenerate_read:{type:"boolean",description:"Request a fresh observation only after the host reads the exact completed observational result."}},additionalProperties:false}}};
}
