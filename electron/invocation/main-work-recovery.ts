import { createHash } from "node:crypto";
import { DesktopWorkRecoveryJournal, workUnitId } from "./work-recovery-store";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
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
  constructor(private readonly chatId: string, private readonly invocationRunId: string,
    private readonly assertCurrent: () => void) { contexts.add(this); }

  private scope(): Scope {
    this.assertCurrent();
    const chat = getChat(this.chatId);
    const task = findCanonicalTaskForChat(this.chatId) ?? ensureCanonicalTaskForChat(this.chatId);
    if (!chat || chat.archivedAt || !task || task.archivedAt) throw new Error("main_work_scope_missing");
    const worker = getDb().prepare(`SELECT a.task_id,r.goal_id FROM long_run_worker_attempts a
      JOIN long_runs r ON r.id=a.run_id WHERE a.invocation_run_id=? LIMIT 1`).get(this.invocationRunId) as
      {task_id:string|null;goal_id:string}|undefined;
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

  packet(): string {
    if (!findCanonicalTaskForChat(this.chatId)) return "";
    const scope=this.scope(), actions=this.actions(scope);
    return JSON.stringify({ schemaVersion:"agentlas.main-work-recovery.v1", taskId:scope.taskId,
      revision:scope.revision, stepIds:scope.stepIds,
      totalActions:actions.length, historyComplete:actions.length<=64,
      actions:actions.slice(-64).map(action=>({actionId:action.actionId,stepId:action.stepId,methodId:action.methodId,
        state:this.journal.read(scope.runId,action.actionId)?.state,expected:action.expected})),
      instruction:"Use _agentlas_work.action_id for the same logical action after a model change or restart. Read its original outcome first. Only a confirmed completed observational action can request regenerate_read; its original identity and total-two method cap remain. Select a different canonical step for independent work. A provider call id is only transport correlation." });
  }

  private actions(scope: Scope): Action[] {
    return (getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND kind='main_work_action'
      AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.revision')=? ORDER BY seq`)
      .all(scope.runId,scope.taskId,scope.revision) as Array<{payload_json:string}>).map(row=>decodeAction(row.payload_json));
  }

  admit(input: { reference?: MainWorkReference; methodId: string; arguments: Record<string,unknown>; observational: boolean }):
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
        const unresolved=actions.filter(item=>item.stepId===stepId && !["succeeded","cancelled"].includes(this.journal.read(scope.runId,item.actionId)?.state ?? "held"));
        if (!input.observational && unresolved.length) throw new Error(`main_work_read_original_outcome:${unresolved.map(item=>item.actionId).join(",")}`);
        const ordinal=Number((getDb().prepare("SELECT count(*) n FROM run_events WHERE run_id=? AND kind='main_work_action'").get(scope.runId) as {n:number}).n)+1;
        const actionId=workUnitId({runId:scope.runId,taskId:scope.taskId,stepId:`${stepId}:action:${ordinal}`,revision:scope.revision});
        const inputDigest=digest(input.arguments);
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

  finish(admission:{unit:WorkUnit;action:Action},result:Result):void {
    this.assertCurrent();const scope=this.scope();
    if(scope.runId!==admission.unit.runId || scope.revision!==admission.unit.revision)throw new Error("main_work_completion_scope_changed");
    const stored={content:result.content,isError:result.isError,visionMessage:result.visionMessage,
      ...(result.artifactPaths ? {artifactPaths:result.artifactPaths} : {}),...(result.rawMcpResult ? {rawMcpResult:result.rawMcpResult} : {})};
    const serialized=JSON.stringify(stored);
    if(result.isError) {this.journal.transition(admission.unit,"held",{reason:"original_tool_outcome_unconfirmed"});return;}
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
