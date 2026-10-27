import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Chat, InstalledAgent, InstalledFirm, InvocationRunReceipt, McpInvocationRequest, OrchestrationTarget, Project, ProjectAgentPoolMember, RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { executionFailureReport, readExecutionFailureCause, type ExecutionFailureReport } from "../../shared/execution-effect-contract";
import { innermostTypedCode, STORE_BUSY_CODE } from "../../shared/turn-settlement";
import { normalizeWorkloadAllocation, resolveWorkloadAllocationAcrossRuntimes, workloadRuntimeInventory, type WorkloadAllocation } from "../runtime/workload-routing";
import { composeDeclaredPrompt } from "../runtime/prompt-order";
import { workSessionReadPermissionCall } from "../../shared/work-session-tools";
import type { DurableQueuedSteer } from "../store/invocation-steers";
import type { WorkSessionHostClaim, WorkSessionHostState, WorkSessionRunOwnerState } from "./session-host";
import type { InvocationService, InvocationSettledEnvelope } from "../invocation/service";

/** Host capability data, never accepted from a tool's JSON arguments. */
export interface WorkSessionCaller {
  chatId: string;
  runId: string;
  permission: "read" | "write" | "full";
  runtimes?: RuntimeStatus[];
  runtimeSelection?: RuntimeSelection;
  /** Canonical workspace sealed by the host; never read from tool arguments. */
  workspace?: string;
}
type Service = Pick<InvocationService, "start" | "receipt" | "steerFromOwner" | "ownerSteerReceipt" | "cancel" | "onSettled"> & Partial<Pick<InvocationService,"unsteerQueuedById">>;
export interface WorkSessionDispatchPorts {
  db(): Database.Database;
  service: Service;
  chat(id: string): Chat | null;
  project(id: string): Project | null;
  agent(id: string): InstalledAgent | null;
  firm(id: string): InstalledFirm | null;
  createChild(input: { internalId: string; agentId: string; firmId?: string; projectId: string; parentChatId: string; title: string; kind: "division"; originSurface: "work" }): Chat;
  bindChild(childId: string, parentId: string): void;
  workingFolder(chatId: string): string | null;
  queuedSteer(id: string): Pick<DurableQueuedSteer,"id"|"chatId"|"promptHash"|"drainedRunId"|"status"> | null;
  setChildWorkingFolder(chatId: string, workspace: string): void;
  hostClaim(): WorkSessionHostClaim;
  hostState(claim: WorkSessionHostClaim): WorkSessionHostState;
  runOwnerState(chatId: string, runId: string, claim?: WorkSessionHostClaim): WorkSessionRunOwnerState;
  cancelRun(runId: string): unknown | Promise<unknown>;
  steerFromOwner(request: Parameters<Service["steerFromOwner"]>[0], intentId: string): (ReturnType<Service["steerFromOwner"]> & {workSessionHost?:WorkSessionHostClaim}) | Promise<ReturnType<Service["steerFromOwner"]> & {workSessionHost?:WorkSessionHostClaim}>;
  detectRuntimes(): Promise<RuntimeStatus[]>;
  remoteTarget(member: ProjectAgentPoolMember): Promise<OrchestrationTarget>;
  ownerScope(): string;
  result(chatId: string, runId: string): { messageId: string; text: string } | null;
  failureReports?(chatId:string,runId:string):ExecutionFailureReport[];
  /** Only an adapter/host marker can prove that a refused start had no effects. */
  notDispatched(error: unknown): boolean;
  /** Close the idle resident CLI seat of a finished child chat. `busy` means a turn still holds it (try again shortly). */
  releaseChildSeat?(chatId: string): { busy: boolean } | undefined;
  /** Write an ordinary assistant reply into the parent conversation (the last-resort delivery of a result). */
  postParentMessage?(chatId: string, text: string): void;
}
type State = "queued" | "starting" | "running" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted" | "uncertain";
interface DispatchRow {
  id: string; parent_chat_id: string; parent_run_id: string; project_id: string; owner_scope: string;
  request_id: string; request_json: string; request_digest: string; target_json: string; workspace_path: string | null; admission_host_json: string|null;
  child_chat_id: string; child_run_id: string; state: State; start_attempted: number; cancel_requested: number;
  result_json: string | null; failure_json: string | null; result_summary_json: string | null; failure_summary_json: string | null; result_available?: number; target_key?: string; report_json: string | null; reported_at: string | null;
  report_error: string | null; report_revision: number; report_attempts: number; report_attempt_at: string | null; steering_json:string; failure_reports_json:string; effect_uncertain:number; uncertain_run_id:string|null; created_at: string; updated_at: string;
}
interface Target { key: string; member: ProjectAgentPoolMember; agentId: string; firmId?: string; target?: OrchestrationTarget; available: boolean; code?: string }
const ACTIVE: readonly State[] = ["starting", "running", "waiting_input"];
const TERMINAL: readonly State[] = ["completed", "failed", "cancelled", "interrupted", "uncertain"];
/** How many children may run at once is not this module's to decide: the harness already queues execution (run slots sized to the
 * machine, resident seats, writer admission) and a child waits there. The only limit here is a backstop against a runaway fan-out:
 * open (not yet finished) children per conversation, enforced when a delegation is accepted. */
const MAX_PENDING = 64;
/** A report to the parent is pushed as a durable owner steer. When that steer ends without being consumed (failed or cancelled), or
 * the send itself throws, the report is sent again under a new identity with growing waits, then abandoned: the child's result
 * stays complete and readable (work_session_status), the parent's completion notification stops waiting for it, and the cause is
 * logged. The abandoned prefix is a typed marker in report_error; the notification query (workSessionParentHasPendingChildren)
 * reads it without needing the attempt columns. */
const REPORT_MAX_ATTEMPTS = 6, REPORT_RETRY_MS = [15_000, 60_000, 180_000, 600_000, 1_800_000] as const;
const REPORT_ABANDONED = "work_session_report_abandoned";
/** Reports share the parent's steer queue (depth 8 in the invocation service) with the owner's own messages, and each queued steer
 * becomes one parent turn. So at most REPORT_INFLIGHT_MAX reports wait there at a time (the owner's input always has room), and
 * results that are ready together travel in one report, up to REPORT_BATCH_MAX: twenty children finishing at once reach the parent
 * as a few turns, not twenty. A batch member is claimed by its leader through a `batch:<leader>:<revision>` pointer in report_json. */
const REPORT_INFLIGHT_MAX = 2, REPORT_BATCH_MAX = 10;
const REPORT_BATCH_PREFIX = "batch:";
const reportBatchPointer = (leaderId: string, revision: number) => `${REPORT_BATCH_PREFIX}${leaderId}:${revision}`;
/** Why a report's steer ended, in the steer store's own vocabulary (store/invocation-steers.ts REPORT_DELIVERED_CAUSES and
 * OWNER_STOP_CAUSES): neither is a lost report. Delivered: a waiting Goal parked it and its next turn carries it, a newer report
 * replaced it, or it was handed back. Owner stop: the owner withdrew it (Stop, Goal pause or delete) and it is never carried again. */
const REPORT_STEER_DELIVERED = ["parked-for-waiting-goal", "host-report-superseded", "held-returned-to-owner"] as const;
const REPORT_STEER_OWNER_STOP = ["run-stopped", "goal-stopped", "owner-withdrawn"] as const;
/** The same two sets read for a correction sent to a child: ended this way it is not a lost direction (this module's own withdrawal on
 * Stop is the store's "host-report-superseded"); ended any other way the main AI is told once (steer_end in the row's view). */
const STEER_END_NOT_LOST: readonly string[] = [...REPORT_STEER_DELIVERED, ...REPORT_STEER_OWNER_STOP];
/** A locked store (SQLITE_BUSY and kin) is transient and says nothing about the delegation it interrupted. What it interrupted (starting
 * a queued child, reading a settled one, reporting its result) is looked at again with growing waits through the single-flight
 * recovery. After the last wait the next ordinary wake (a settlement, a status read) is the trigger; a claimed start that never got
 * going ends as the failed start it then is. */
const STORE_BUSY_RETRY_MS = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000] as const;
const isStoreBusy = (error: unknown) => innermostTypedCode(error) === STORE_BUSY_CODE;
/** How often an unstarted correction is looked at again (a queued steer's start or failure raises no event of its own). */
const STEER_WATCH_MS = [5_000, 15_000, 60_000, 180_000, 600_000] as const;
const sqlStrings = (values: readonly string[]) => values.map(value => `'${value}'`).join(",");
const reportRetryDelay = (attempts: number) => REPORT_RETRY_MS[Math.min(Math.max(attempts, 1), REPORT_RETRY_MS.length) - 1];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function failure(code: string, delivery: "not-dispatched" | "dispatched" | "unknown", phase: "preparation" | "execution" | "verification" = "execution"): ExecutionFailureReport {
  return executionFailureReport({ outcome: delivery === "not-dispatched" ? "blocked" : "failed", causes: [{ phase, code, delivery,
    recovery: delivery === "not-dispatched" ? "retry-preparation" : delivery === "unknown" ? "inspect-effect" : "continue-work" }] });
}
function causeCode(error: unknown): string {
  for (let current = error, depth = 0; current && depth < 6; depth++) {
    if (typeof current === "object" && "code" in current && typeof current.code === "string") return current.code;
    current = typeof current === "object" && "cause" in current ? current.cause : null;
  }
  return "work_session_dispatch_unclassified_failure";
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw Object.assign(new Error("work_session_input_invalid"), { code: "work_session_input_invalid" });
  return input as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/u.test(value)) throw Object.assign(new Error("work_session_input_invalid"), { code: "work_session_input_invalid" });
  return value;
}
function assignmentTitle(requestJson: string): string {
  const request = JSON.parse(requestJson) as McpInvocationRequest;
  return Array.from(request.userPrompt.trim().split(/\r?\n/u, 1)[0]).slice(0, 80).join("");
}
const RESPONSE_BYTES = 96 * 1024, DEFAULT_TEXT_BYTES = 32 * 1024;
const wireBytes = (value: unknown) => Buffer.byteLength(JSON.stringify({content:[{type:"text",text:JSON.stringify(value)}]}),"utf8");
const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)??"", "utf8");
function shortText(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : "", raw = Buffer.from(text);
  let end = Math.min(raw.length, maxBytes);
  while (end > 0 && end < raw.length && (raw[end] & 0xc0) === 0x80) end--;
  return raw.subarray(0, end).toString("utf8");
}
function pageInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw Object.assign(new Error("work_session_page_invalid"), {code:"work_session_page_invalid"});
  return Number(value);
}
function pageSnapshot(actual: string, requested: unknown) {
  if (requested !== undefined && requested !== actual) throw Object.assign(new Error("work_session_page_snapshot_changed"), {code:"work_session_page_snapshot_changed"});
}
/** Offset/limit are UTF-8 bytes, never split a code point. The JSON wire budget
 * also counts escaping, so control characters cannot overflow MCP framing. */
function textPage(text: string, arg: Record<string, unknown>, metadata: Record<string, unknown>) {
  const raw = Buffer.from(text, "utf8"), offset = pageInteger(arg.offset, 0), limit = Math.max(4, pageInteger(arg.limit, DEFAULT_TEXT_BYTES, 65536));
  if (offset > raw.length || (offset < raw.length && (raw[offset] & 0xc0) === 0x80)) throw Object.assign(new Error("work_session_page_invalid"), {code:"work_session_page_invalid"});
  const snapshot_id = hash(text); pageSnapshot(snapshot_id, arg.snapshot_id);
  let total_chars = 0; for (const _char of text) total_chars++;
  const endBoundary = (end: number) => { while (end > offset && end < raw.length && (raw[end] & 0xc0) === 0x80) end--; return end; };
  const make = (end: number) => ({...metadata, snapshot_id, offset_unit:"utf8-bytes", offset, limit, total_chars, total_bytes:raw.length,
    page_bytes:end-offset, text:raw.subarray(offset,end).toString("utf8"), truncated:offset>0||end<raw.length, next_offset:end<raw.length?end:null});
  let low=offset, high=Math.min(raw.length,offset+limit), end=endBoundary(high);
  while(wireBytes(make(end))>RESPONSE_BYTES && high>low){high=Math.floor((low+high)/2);end=endBoundary(high);}
  if(end===offset&&offset<raw.length){end=offset+1;while(end<raw.length&&(raw[end]&0xc0)===0x80)end++;}
  const result=make(end);
  if(wireBytes(result)>RESPONSE_BYTES)throw Object.assign(new Error("work_session_page_metadata_oversize"),{code:"work_session_page_metadata_oversize"});
  return result;
}
function itemPage<T>(items: T[], arg: Record<string, unknown>, metadata: Record<string, unknown>, field: string) {
  const offset=pageInteger(arg.offset,0),limit=Math.max(1,Math.min(64,pageInteger(arg.limit,16,65536)));
  if(offset>items.length)throw Object.assign(new Error("work_session_page_invalid"),{code:"work_session_page_invalid"});
  const selected:T[]=[];
  const make=()=>({...metadata,offset_unit:"items",offset,limit,total:items.length,[field]:selected,truncated:offset>0||offset+selected.length<items.length,next_offset:offset+selected.length<items.length?offset+selected.length:null});
  for(const item of items.slice(offset,offset+limit)){selected.push(item);if(wireBytes(make())>RESPONSE_BYTES){selected.pop();break;}}
  if(!selected.length&&offset<items.length)throw Object.assign(new Error("work_session_page_item_oversize"),{code:"work_session_page_item_oversize"});
  return make();
}
function resultSummary(result: {messageId:string;text:string}|null) {
  return result ? {messageId:result.messageId,text:shortText(result.text,768),total_chars:(()=>{let count=0;for(const _char of result.text)count++;return count;})(),total_bytes:bytes(result.text),
    is_excerpt:bytes(result.text)>768} : null;
}
function diagnosticSummary(detail: ExecutionFailureReport|null, reports: ExecutionFailureReport[]) {
  const evidence=reports.length?reports:detail?[detail]:[], first=evidence.flatMap(report=>report.causes).at(0);
  const primary=first?Object.fromEntries(Object.entries(first).filter(([key,value])=>["phase","code","providerCode","delivery","recovery","requiredPermission","actualPermission","httpStatus","retryAfterMs"].includes(key)&&["string","number"].includes(typeof value))
    .map(([key,value])=>[key,typeof value==="string"?shortText(value,256):value])):null;
  return {primary_cause:primary,primary_cause_truncated:!!first&&Object.entries(first).some(([key,value])=>["phase","code","providerCode","delivery","recovery","requiredPermission","actualPermission"].includes(key)&&typeof value==="string"&&bytes(value)>256),report_count:reports.length,cause_count:evidence.reduce((count,report)=>count+report.causes.length,0),
    effect_count:evidence.reduce((count,report)=>count+report.effects.length,0),outcome:detail?.outcome??reports[0]?.outcome??null};
}
function hostClaimOf(item: DispatchRow): WorkSessionHostClaim | undefined {
  try {const value=JSON.parse(item.admission_host_json??"null");return value&&typeof value.ownerId==="string"&&!!value.ownerId.trim()
    &&["desktop","daemon","terminal"].includes(value.ownerKind)&&Number.isSafeInteger(value.pid)&&value.pid>0?value:undefined;}catch{return undefined;}
}
const sameHost = (a: WorkSessionHostClaim,b:WorkSessionHostClaim) => a.ownerId===b.ownerId&&a.ownerKind===b.ownerKind&&a.pid===b.pid;
const keyOf = (member: ProjectAgentPoolMember) => `${member.source}:${member.entityKind}:${member.targetId}:${member.releaseId ?? "local"}`;
/** One correction sent to a child. `runId` is the run it started; `endStatus`/`endReason` (the steer store's own status and machine cause)
 * are written when it ended without starting one. */
interface SteerDirection { requestId: string; intentId: string; hash: string; contract?: string; runId?: string; hostConfirmed?: boolean; endStatus?: "failed" | "cancelled" | "held"; endReason?: string | null }
function readDirections(json: string | null | undefined): SteerDirection[] {
  try { const value = JSON.parse(json ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
/** Ended without starting, other than by the owner's Stop: the main AI never saw this correction run. A held one is parked for an owner
 * decision in a hidden chat and never starts by itself. */
const steerEndLost = (direction: SteerDirection) => !direction.runId && !!direction.endStatus
  && !(direction.endStatus === "cancelled" && STEER_END_NOT_LOST.includes(direction.endReason ?? ""));
/** Still waiting for the child's chat to start it (the steer store has not ended it and no run is bound). */
const steerUnresolved = (direction: SteerDirection) => !direction.runId && (!direction.endStatus || direction.endStatus === "held");

type WorkSessionChildReadPorts = Pick<WorkSessionDispatchPorts, "db" | "chat" | "project" | "ownerScope" | "workingFolder" | "queuedSteer">;
/** Host-read assignment facts, never a model-provided permission or a grant.
 * Consumers must bind them to the exact live native run and cap current authority. */
export interface WorkSessionChildAssignmentEvidence {
  readonly dispatchId: string;
  readonly parentChatId: string;
  readonly ownerScope: string;
  readonly acceptedPermission: "read" | "write" | "full";
  readonly projectId: string;
  readonly workspace: string;
}
function currentWorkParent(ports: WorkSessionChildReadPorts, chatId: string, strict = false): boolean {
  try {
    const chat = ports.chat(chatId);
    const transport = ports.db().prepare("SELECT parent_chat_id FROM chats WHERE id=?").get(chatId) as {parent_chat_id:string|null}|undefined;
    return !!chat && !!transport && chat.originSurface === "work" && (chat.kind === "user" || chat.kind == null) && !transport.parent_chat_id && !!chat.projectId
      && !chat.archivedAt && !!ports.project(chat.projectId)
      && !!ports.db().prepare("SELECT 1 FROM tasks WHERE id=? AND origin_chat_id=? AND project_id=? AND archived_at IS NULL AND status<>'archived'").get(`task_${chatId}`, chatId, chat.projectId);
  } catch (error) { if (strict) throw error; return false; }
}
/** Exact durable ownership only. Missing/unreadable evidence keeps the ordinary
 * notification path; this read never creates a queue or an invocation service. */
class WorkSessionAssignmentError extends Error {
  readonly turnDelivery = "not-dispatched";
  constructor(readonly code: "work_session_assignment_store_unavailable" | "work_session_assignment_not_current" | "work_session_assignment_workspace_unbound", cause?: unknown) {
    super(code, cause === undefined ? undefined : {cause});
  }
}
function findWorkSessionChildRun(ports: WorkSessionChildReadPorts, chatId: string, runId: string, strict = false): DispatchRow | null {
  const invalid = (): null => { if (strict) throw new WorkSessionAssignmentError("work_session_assignment_not_current"); return null; };
  try {
    if (!chatId || !runId) return null;
    if (!ports.db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_session_dispatches'").get()) return null;
    const hasWorkspace=(ports.db().prepare("PRAGMA table_info(work_session_dispatches)").all() as {name:string}[]).some(column=>column.name==="workspace_path");
    const candidates = ports.db().prepare(`SELECT id,parent_chat_id,project_id,owner_scope,child_run_id,request_json,steering_json,${hasWorkspace?"workspace_path":"NULL AS workspace_path"},cancel_requested,state FROM work_session_dispatches WHERE child_chat_id=?`).all(chatId) as DispatchRow[];
    if (!candidates.length) return null;
    if (candidates.length !== 1) return invalid();
    const item = candidates[0];
    const request = JSON.parse(item.request_json) as unknown, directions = JSON.parse(item.steering_json) as unknown;
    if (!request || typeof request !== "object" || Array.isArray(request) || (request as McpInvocationRequest).chatId !== chatId
      || typeof (request as McpInvocationRequest).runId !== "string" || !Array.isArray(directions)
      || directions.some(value => !value || typeof value !== "object" || Array.isArray(value)
        || (value.runId !== undefined && typeof value.runId !== "string"))) return invalid();
    const child = ports.chat(chatId);
    const transport = ports.db().prepare("SELECT parent_chat_id FROM chats WHERE id=?").get(chatId) as {parent_chat_id:string|null}|undefined;
    if (item.owner_scope !== ports.ownerScope() || !child || child.originSurface !== "work" || child.kind !== "division" || child.archivedAt
      || transport?.parent_chat_id !== item.parent_chat_id || child.projectId !== item.project_id
      || !currentWorkParent(ports, item.parent_chat_id, strict) || ports.chat(item.parent_chat_id)?.projectId !== item.project_id) return invalid();
    const projected=item.child_run_id===runId||(request as McpInvocationRequest).runId===runId||directions.some(direction=>direction.runId===runId);
    const draining=!projected&&[...directions].reverse().some(direction=>{
      // The receiver seals drainedRunId before start(), while its ACK and our
      // direction.runId projection may arrive later. Read that canonical store
      // receipt directly, never initialize an InvocationService to infer it.
      if(typeof direction.intentId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(direction.intentId)
        ||!/^work-steer:[a-f0-9]{64}$/.test(direction.intentId)||typeof direction.hash!=="string"||!/^[a-f0-9]{64}$/.test(direction.hash))return false;
      const id=`owner:${direction.intentId}`,receipt=ports.queuedSteer(id);
      return !!receipt&&receipt.id===id&&receipt.chatId===chatId&&receipt.promptHash===direction.hash
        &&receipt.drainedRunId===runId&&(receipt.status==="draining"||receipt.status==="started");
    });
    return projected||draining?item:invalid();
  } catch (error) {
    if (!strict) return null;
    if (error instanceof WorkSessionAssignmentError) throw error;
    throw new WorkSessionAssignmentError("work_session_assignment_store_unavailable", error);
  }
}
function readWorkSessionChildRun(ports: WorkSessionChildReadPorts, chatId: string, runId: string, strict = false): boolean {
  return findWorkSessionChildRun(ports, chatId, runId, strict) !== null;
}
function childAssignmentEvidence(ports: WorkSessionChildReadPorts, chatId: string, runId: string): WorkSessionChildAssignmentEvidence | null {
  const item = findWorkSessionChildRun(ports, chatId, runId, true);
  if (!item) return null;
  if (item.cancel_requested || item.state === "cancelled") throw new WorkSessionAssignmentError("work_session_assignment_not_current");
  try {
    const permission = (JSON.parse(item.request_json) as McpInvocationRequest).permissions;
    if (permission !== "read" && permission !== "write" && permission !== "full") throw new WorkSessionAssignmentError("work_session_assignment_not_current");
    if (typeof item.workspace_path !== "string" || !item.workspace_path.trim() || item.workspace_path.includes("\0"))
      throw new WorkSessionAssignmentError("work_session_assignment_workspace_unbound");
    if (ports.workingFolder(chatId) !== item.workspace_path) throw new WorkSessionAssignmentError("work_session_assignment_not_current");
    return Object.freeze({ dispatchId: item.id, parentChatId: item.parent_chat_id, ownerScope: item.owner_scope,
      acceptedPermission: permission, projectId: item.project_id, workspace: item.workspace_path });
  } catch (error) {
    if (error instanceof WorkSessionAssignmentError) throw error;
    throw new WorkSessionAssignmentError("work_session_assignment_store_unavailable", error);
  }
}

/** One dispatcher over the existing InvocationService; no second provider loop or Goal engine. */
export function createWorkSessionDispatcher(ports: WorkSessionDispatchPorts) {
  const inventory = new WeakMap<WorkSessionCaller, Promise<RuntimeStatus[]>>();
  const inventories = new WeakMap<WorkSessionCaller, Map<string, Target>>();
  let ready = false, installed = false, recovering: Promise<void> | null = null;
  const draining = new Set<string>();
  const liveChildren = new Map<string, Map<string, string>>();
  const stoppedParents = new Set<string>();
  const stoppedDispatches = new Set<string>();
  const acceptedByParent = new Map<string,Set<string>>();
  const remember = (parent:string,id:string) => {let ids=acceptedByParent.get(parent);if(!ids){ids=new Set();acceptedByParent.set(parent,ids);}ids.add(id);};
  const parentRuns = new Map<string,Set<string>>();
  const pendingDirections=new Map<string,{parentChatId:string;dispatchId:string;childChatId:string;queuedRequestId:string}>();
  const stopDelivery=new Map<string,{status:"pending"|"requested"|"unavailable";cause?:string}>();
  /** Per parent: waits already spent on a busy store / on watching an unstarted correction; cleared by a pass that met neither. */
  const storeBusyRetries=new Map<string,number>(), steerWatchAttempts=new Map<string,number>();
  /** Claimed rows whose start never began because the store was busy (nothing was dispatched): they go back to queued, with a bound. */
  const startRetry=new Set<string>(), startAttempts=new Map<string,number>();
  const stopRun=(runId:string)=>{
    stopDelivery.set(runId,{status:"pending"});
    try{Promise.resolve(ports.cancelRun(runId)).then(result=>{stopDelivery.set(runId,result==="requested"||result==="already-requested"?{status:"requested"}:{status:"unavailable",cause:"work_session_native_stop_owner_unavailable"});},error=>{
      stopDelivery.set(runId,{status:"unavailable",cause:causeCode(error)});console.warn("[work-session] native stop deferred",causeCode(error));});
    }catch(error){stopDelivery.set(runId,{status:"unavailable",cause:causeCode(error)});console.warn("[work-session] native stop deferred",causeCode(error));}
  };
  const db = () => ports.db();
  function ensure() {
    if (ready) return;
    db().transaction(() => {
    db().exec(`CREATE TABLE IF NOT EXISTS work_session_dispatches (
      id TEXT PRIMARY KEY,parent_chat_id TEXT NOT NULL,parent_run_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_scope TEXT NOT NULL,
      request_id TEXT NOT NULL,request_json TEXT NOT NULL,request_digest TEXT NOT NULL,target_json TEXT NOT NULL,workspace_path TEXT,admission_host_json TEXT,
      child_chat_id TEXT NOT NULL,child_run_id TEXT NOT NULL,state TEXT NOT NULL,start_attempted INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,result_json TEXT,failure_json TEXT,result_summary_json TEXT,failure_summary_json TEXT,report_json TEXT,reported_at TEXT,report_error TEXT,report_revision INTEGER NOT NULL DEFAULT 0,steering_json TEXT NOT NULL DEFAULT '[]',
      failure_reports_json TEXT NOT NULL DEFAULT '[]',effect_uncertain INTEGER NOT NULL DEFAULT 0,uncertain_run_id TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_scope,parent_chat_id,request_id));
      CREATE INDEX IF NOT EXISTS work_session_dispatch_parent ON work_session_dispatches(parent_chat_id,state);
      CREATE UNIQUE INDEX IF NOT EXISTS work_session_dispatch_child ON work_session_dispatches(child_run_id);`);
    // Old preview queues retain their records. Missing accepted workspace is
    // never guessed from today's project folder or promoted to full authority.
    if (!(db().prepare("PRAGMA table_info(work_session_dispatches)").all() as {name:string}[]).some(column => column.name === "workspace_path"))
      db().exec("ALTER TABLE work_session_dispatches ADD COLUMN workspace_path TEXT");
    for(const column of ["result_summary_json","failure_summary_json","admission_host_json"])
      if(!(db().prepare("PRAGMA table_info(work_session_dispatches)").all() as {name:string}[]).some(item=>item.name===column))db().exec(`ALTER TABLE work_session_dispatches ADD COLUMN ${column} TEXT`);
    for(const [column,type] of [["report_attempts","INTEGER NOT NULL DEFAULT 0"],["report_attempt_at","TEXT"]] as const)
      if(!(db().prepare("PRAGMA table_info(work_session_dispatches)").all() as {name:string}[]).some(item=>item.name===column))db().exec(`ALTER TABLE work_session_dispatches ADD COLUMN ${column} ${type}`);
    }).immediate();
    ready = true;
  }
  const metaColumns = `id,parent_chat_id,parent_run_id,project_id,owner_scope,request_id,workspace_path,admission_host_json,child_chat_id,child_run_id,state,start_attempted,cancel_requested,
    reported_at,report_error,report_revision,report_attempts,report_attempt_at,effect_uncertain,uncertain_run_id,created_at,updated_at,result_summary_json,failure_summary_json,steering_json,
    json_extract(target_json,'$.key') AS target_key,(result_json IS NOT NULL) AS result_available,NULL AS result_json,NULL AS failure_json,'[]' AS failure_reports_json`;
  const row = (id: string) => db().prepare("SELECT * FROM work_session_dispatches WHERE id=?").get(id) as DispatchRow | undefined;
  const controlRow = (id:string) => db().prepare(`SELECT ${metaColumns},request_json,target_json,report_json FROM work_session_dispatches WHERE id=?`).get(id) as DispatchRow|undefined;
  const allowed = (chatId: string) => currentWorkParent(ports, chatId);
  function callerCurrent(caller: WorkSessionCaller): Chat {
    if (!allowed(caller.chatId)) throw Object.assign(new Error("work_session_parent_invalid"), { code: "work_session_parent_invalid" });
    const receipt = ports.service.receipt(caller.runId);
    if (!receipt || receipt.chatId !== caller.chatId || receipt.status !== "running") throw Object.assign(new Error("work_session_caller_stale"), { code: "work_session_caller_stale" });
    const rank = { read: 0, write: 1, full: 2 };
    if (!Object.hasOwn(rank,caller.permission) || (receipt.executionPermission && rank[caller.permission] > rank[receipt.executionPermission])) throw Object.assign(new Error("work_session_permission_changed"), { code: "work_session_permission_changed" });
    return ports.chat(caller.chatId)!;
  }
  const currentOwner = (item: DispatchRow) => item.owner_scope === ports.ownerScope() && allowed(item.parent_chat_id)
    && ports.chat(item.parent_chat_id)?.projectId === item.project_id;
  const rows = (parentChatId?: string, condition="1", limit?:number) => db().prepare(`SELECT ${metaColumns} FROM work_session_dispatches WHERE ${parentChatId?"parent_chat_id=? AND ":""}(${condition}) ORDER BY rowid ${limit?`LIMIT ${limit}`:""}`).all(...(parentChatId?[parentChatId]:[])) as DispatchRow[];
  function view(item: DispatchRow) {
    const result=item.result_summary_json?JSON.parse(item.result_summary_json):item.result_json?resultSummary(JSON.parse(item.result_json)):null;
    const claim=hostClaimOf(item);let admission_host_state:WorkSessionHostState|"unbound"="unbound";
    if(claim){try{admission_host_state=ports.hostState(claim);}catch{admission_host_state="unknown";}}
    const diagnostics=item.failure_summary_json?JSON.parse(item.failure_summary_json):diagnosticSummary(item.failure_json?JSON.parse(item.failure_json):null,JSON.parse(item.failure_reports_json??"[]"));
    const lostSteers=readDirections(item.steering_json).filter(steerEndLost),lastLost=lostSteers.at(-1);
    return {session_id:item.id,dispatch_id:item.id,request_id:item.request_id,target:shortText(item.target_key??JSON.parse(item.target_json).key,512),status:item.state,
      child_chat_id:item.child_chat_id,child_run_id:item.child_run_id,result_available:!!(item.result_available||item.result_json||result),result,
      primary_cause:diagnostics.primary_cause,primary_cause_truncated:diagnostics.primary_cause_truncated??false,diagnostics:{is_summary:true,report_count:diagnostics.report_count,cause_count:diagnostics.cause_count,effect_count:diagnostics.effect_count,outcome:diagnostics.outcome},
      effect_reconciliation_required:item.effect_uncertain===1,admission_host_state,native_stop:stopDelivery.get(item.child_run_id)??null,cancel_requested:!!item.cancel_requested||stoppedDispatches.has(item.id),
      cancel_persistence_pending:stoppedDispatches.has(item.id)&&!item.cancel_requested,report:item.reported_at?"accepted":item.report_error?"held":"pending",report_cause:item.report_error?shortText(item.report_error,256):null,report_cause_truncated:!!item.report_error&&bytes(item.report_error)>256,
      // A correction sent to this session that never started a run (typed cause, no prose). Absent unless it happened.
      ...(lastLost?{steer_end:{count:lostSteers.length,request_id:shortText(lastLost.requestId,128),status:lastLost.endStatus,cause:shortText(lastLost.endReason??"work_session_steer_cause_unknown",64)}}:{}),
      readers:{tool:"work_session_status",session_id:item.id,sections:["summary","result","diagnostics"]}};
  }
  /** `quiet`: the caller is the tool call that just sent the correction, so its receipt already told the main AI; the end is recorded, not reported again. */
  function syncSteers(item:DispatchRow,quiet=false):DispatchRow {
    return db().transaction(()=>{
    item=controlRow(item.id)??item;
    const directions=readDirections(item.steering_json);
    for(const direction of directions){
      const receipt=ports.service.ownerSteerReceipt(item.child_chat_id,direction.intentId);
      if(receipt?.chatId!==item.child_chat_id||receipt.promptHash!==direction.hash)continue;
      if(receipt.status==="started"&&receipt.runId&&!direction.runId){
        direction.runId=receipt.runId;delete direction.endStatus;delete direction.endReason;
        let children=liveChildren.get(item.parent_chat_id);if(!children){children=new Map();liveChildren.set(item.parent_chat_id,children);}children.set(item.id,receipt.runId);
        pendingDirections.delete(direction.intentId);
        if(stoppedDispatches.has(item.id))stopRun(receipt.runId);
        db().prepare("UPDATE work_session_dispatches SET child_run_id=?,admission_host_json=CASE WHEN ? THEN admission_host_json ELSE NULL END,state='running',result_json=NULL,failure_json=NULL,result_summary_json=NULL,failure_summary_json=NULL,report_json=NULL,reported_at=NULL,report_error=NULL,report_revision=report_revision+1,report_attempts=0,report_attempt_at=NULL,steering_json=?,updated_at=? WHERE id=?")
          .run(receipt.runId,direction.hostConfirmed?1:0,JSON.stringify(directions),new Date().toISOString(),item.id);
        item=controlRow(item.id)!;
      } else if(!direction.runId&&(receipt.status==="failed"||receipt.status==="cancelled"||receipt.status==="held")){
        // The correction ended without ever starting a run. Nothing else raises an event for that, so it is recorded here with the
        // steer store's machine cause; one the owner's Stop withdrew is just closed, any other is a new fact for the main AI.
        const end=steerEnd(item.child_chat_id,direction.intentId,receipt.status);
        if(direction.endStatus===end.status&&(direction.endReason??null)===end.reason)continue;
        direction.endStatus=end.status;direction.endReason=end.reason;pendingDirections.delete(direction.intentId);
        const again=!quiet&&steerEndLost(direction)&&!item.cancel_requested&&!stoppedDispatches.has(item.id);
        db().prepare(`UPDATE work_session_dispatches SET steering_json=?${again?",report_revision=report_revision+1,report_json=NULL,reported_at=NULL,report_error=NULL,report_attempts=0,report_attempt_at=NULL":""},updated_at=? WHERE id=?`)
          .run(JSON.stringify(directions),new Date().toISOString(),item.id);
        if(again)console.warn("[work-session] correction ended without starting",item.id,end.status,end.reason??"work_session_steer_cause_unknown");
        item=controlRow(item.id)!;
      }
    }
    return item;
    }).immediate();
  }
  /** How the steer store ended (or holds) a correction: its status and machine cause, read from the row (the receipt carries no cause). */
  function steerEnd(childChatId:string,intentId:string,status:"failed"|"cancelled"|"held"):{status:"failed"|"cancelled"|"held";reason:string|null}{
    let reason:string|null=null;
    try{
      const found=db().prepare("SELECT recovery_reason FROM invocation_steers WHERE id=? AND chat_id=?").get(`owner:${intentId}`,childChatId) as {recovery_reason:string|null}|undefined;
      if(typeof found?.recovery_reason==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(found.recovery_reason))reason=found.recovery_reason;
    }catch{/* The status alone still says it did not start. */}
    return {status,reason};
  }
  async function runtimes(caller: WorkSessionCaller) {
    let value = inventory.get(caller);
    if (!value) { value = Promise.resolve(caller.runtimes ?? ports.detectRuntimes()).then(found => structuredClone(found)); inventory.set(caller, value); }
    return value;
  }
  async function targets(caller: WorkSessionCaller): Promise<Target[]> {
    const chat = callerCurrent(caller), project = ports.project(chat.projectId!)!;
    const result: Target[] = [];
    for (const member of project.agentPool) {
      const target: Target = { key: keyOf(member), member, agentId: chat.agentId, available: false };
      try {
        if (member.source !== "local") {
          target.target = await ports.remoteTarget(member); target.available = true;
        } else if (member.entityKind === "agent" && member.agentId) {
          const agent = ports.agent(member.agentId); if (agent) { target.agentId = agent.id; target.available = true; }
        } else if (member.entityKind === "team" && member.firmId) {
          const firm = ports.firm(member.firmId); if (firm && ports.agent(firm.ceoAgentId)) { target.agentId = firm.ceoAgentId; target.firmId = firm.id; target.available = true; }
        }
        if (!target.available) target.code = "work_session_target_unavailable";
      } catch (error) { target.code = causeCode(error); }
      if (!result.some(item => item.key === target.key)) result.push(target);
    }
    callerCurrent(caller); inventories.set(caller, new Map(result.map(item => [item.key, item]))); return result;
  }
  function settle(item: DispatchRow, receipt: InvocationRunReceipt) {
    db().transaction(()=>{
    const latest=controlRow(item.id);if(!latest)return;item=latest;
    if (receipt.chatId !== item.child_chat_id || receipt.runId !== item.child_run_id || !currentOwner(item)) return;
    if (["running", "cancelling"].includes(receipt.status)) {
      if(item.state==="starting")db().prepare("UPDATE work_session_dispatches SET state='running' WHERE id=? AND state='starting'").run(item.id);
      return;
    }
    // A stopped session has nobody left to answer its question: it ends cancelled instead of waiting for input forever.
    const state: State = receipt.status === "waiting_input" ? (item.cancel_requested || stoppedDispatches.has(item.id) ? "cancelled" : "waiting_input") : receipt.status === "completed" ? "completed"
      : receipt.status === "cancelled" ? "cancelled" : receipt.status === "interrupted" ? "interrupted" : "failed";
    const result = ports.result(item.child_chat_id, item.child_run_id);
    const observedReports=ports.failureReports?.(item.child_chat_id,item.child_run_id)??[];
    const reports=observedReports.length?observedReports:JSON.parse((db().prepare("SELECT failure_reports_json FROM work_session_dispatches WHERE id=?").get(item.id) as {failure_reports_json:string}).failure_reports_json) as ExecutionFailureReport[];
    const code = receipt.runtimeFailure?.cause?.providerCode ?? receipt.runtimeFailure?.providerCode ?? receipt.errorCode ?? `work_session_child_${state}`;
    const runtimeCause=receipt.runtimeFailure?.cause??receipt.runtimeFailure;
    const delivery=state==="interrupted"||receipt.executionPermission!=="read"?"unknown" as const:"dispatched" as const;
    const detail = state === "completed" ? (result ? null : failure("work_session_result_anchor_missing", "unknown", "verification"))
      : executionFailureReport({outcome:state==="waiting_input"?"blocked":"failed",causes:[{phase:"execution",code,delivery,
        ...(runtimeCause?.providerCode?{providerCode:runtimeCause.providerCode}:{}),...(receipt.executionPermission?{actualPermission:receipt.executionPermission}:{}),
        recovery:runtimeCause?.kind==="auth"?"request-authority":runtimeCause?.kind==="quota"||runtimeCause?.kind==="rate_limit"?"wait-capacity":delivery==="unknown"?"inspect-effect":"continue-work"}]});
    if(TERMINAL.includes(state))liveChildren.get(item.parent_chat_id)?.delete(item.id);
    if(item.state!==state&&item.report_json)db().prepare("UPDATE work_session_dispatches SET report_revision=report_revision+1,report_json=NULL,reported_at=NULL,report_error=NULL,report_attempts=0,report_attempt_at=NULL WHERE id=?").run(item.id);
    // A new outcome of the same dispatch starts its report's attempts over, also right after a failed report cleared report_json.
    else if(item.state!==state)db().prepare("UPDATE work_session_dispatches SET report_attempts=0,report_attempt_at=NULL,report_error=NULL WHERE id=? AND reported_at IS NULL").run(item.id);
    db().prepare("UPDATE work_session_dispatches SET state=?,result_json=?,failure_json=?,updated_at=? WHERE id=?").run(state,
      result ? JSON.stringify(result) : null,
      detail ? JSON.stringify(detail) : null, new Date().toISOString(), item.id);
    if(reports.length)db().prepare("UPDATE work_session_dispatches SET failure_reports_json=? WHERE id=?").run(JSON.stringify(reports),item.id);
    db().prepare("UPDATE work_session_dispatches SET result_summary_json=?,failure_summary_json=? WHERE id=?").run(JSON.stringify(resultSummary(result)),JSON.stringify(diagnosticSummary(detail,reports)),item.id);
    const evidence=reports.length?reports:detail?[detail]:[];
    if(evidence.some(report=>report.causes.some(cause=>cause.delivery==="unknown")||report.effects.some(effect=>effect.state==="attempted"||effect.state==="uncertain")))
      db().prepare("UPDATE work_session_dispatches SET effect_uncertain=1,uncertain_run_id=COALESCE(uncertain_run_id,?) WHERE id=?").run(item.child_run_id,item.id);
    }).immediate();
  }
  const reportTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>();
  /** Nothing else in this dispatcher is timer-driven: without this a waiting retry would only run at the next settlement or heartbeat.
   * One timer per parent, always the earliest due; a recovery already in flight is awaited first (recover is single-flight, so a
   * call made meanwhile would be handed that run and never look at this parent). */
  function scheduleReportRetry(parentChatId: string, delayMs: number) {
    const at = Date.now() + Math.max(delayMs, 1_000), current = reportTimers.get(parentChatId);
    if (current && current.at <= at) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      reportTimers.delete(parentChatId);
      void (async () => {
        while (recovering) { try { await recovering; } catch { /* that run's own failure is its own */ } }
        await recover(parentChatId || undefined);   // "" is the whole-store pass
      })().catch(() => undefined);
    }, at - Date.now());
    timer.unref?.();
    reportTimers.set(parentChatId, { timer, at });
  }
  /** The last way a finished child's answer still reaches the owner when its report never could be delivered: its text goes into the
   * parent conversation as an ordinary reply (no status wording, never a Goal answer). Best effort; the row stays readable either way. */
  function postResultToParent(item: DispatchRow) {
    try {
      if (item.state !== "completed" || !ports.postParentMessage) return;
      const text = ports.result(item.child_chat_id, item.child_run_id)?.text?.trim();
      if (text) ports.postParentMessage(item.parent_chat_id, Buffer.byteLength(text, "utf8") > 12_000 ? `${text.slice(0, 4_000)}…` : text);
    } catch (error) { console.warn("[work-session] result could not be posted to the parent conversation", causeCode(error)); }
  }
  /** Count one failed delivery of this result. `newIdentity`: the report's steer is terminal (or its binding changed), so the next
   * attempt must be a new steer; a send that threw before any steer existed keeps its identity. */
  function retryReport(item: DispatchRow, cause: string, newIdentity: boolean) {
    const attempts = (item.report_attempts ?? 0) + 1, now = new Date().toISOString();
    if (attempts >= REPORT_MAX_ATTEMPTS) {
      db().prepare("UPDATE work_session_dispatches SET report_error=?,report_attempts=?,report_attempt_at=? WHERE id=? AND reported_at IS NULL")
        .run(`${REPORT_ABANDONED}:${cause}`.slice(0, 200), attempts, now, item.id);
      console.warn("[work-session] result report abandoned; the result stays readable through work_session_status", item.id, cause);
      postResultToParent(item);
      scheduleReportRetry(item.parent_chat_id, 1_000);   // results this one carried are released and go out on their own
      return;
    }
    db().prepare(`UPDATE work_session_dispatches SET report_error=?,report_attempts=?,report_attempt_at=?${newIdentity ? ",report_revision=report_revision+1,report_json=NULL" : ""} WHERE id=? AND reported_at IS NULL`)
      .run(cause.slice(0, 200), attempts, now, item.id);
    scheduleReportRetry(item.parent_chat_id, reportRetryDelay(attempts));
  }
  /** The report's steer as the store holds it when it ended without being consumed. A row retired while `recovery_state` is still
   * 'held' reads 'held' through the receipt, so the row's own status decides. */
  function endedReportSteer(identity: string): { status: string; reason: string | null } | null {
    const row = db().prepare("SELECT status,recovery_reason FROM invocation_steers WHERE id=?").get(`owner:${identity}`) as { status: string; recovery_reason: string | null } | undefined;
    return row && (row.status === "cancelled" || row.status === "failed") ? { status: row.status, reason: row.recovery_reason } : null;
  }
  /** Reports of this parent that wait in its steer queue now (a started one has already become a turn). A held row is parked by the
   * service outside that queue and may stay for a long time, so it does not count against the room left for new reports. */
  const inflightReports = (parentChatId: string) => (db().prepare("SELECT count(*) n FROM invocation_steers WHERE chat_id=? AND id LIKE 'owner:work-report:%' AND status IN ('queued','draining') AND recovery_state='ready'").get(parentChatId) as { n: number }).n;
  /** The leader's report was accepted (or delivered by other means): so were the results it carries. */
  function markReported(leader: DispatchRow) {
    const at = new Date().toISOString();
    db().transaction(() => {
      db().prepare("UPDATE work_session_dispatches SET reported_at=?,report_error=NULL WHERE id=?").run(at, leader.id);
      db().prepare("UPDATE work_session_dispatches SET reported_at=?,report_error=NULL WHERE report_json=? AND reported_at IS NULL").run(at, reportBatchPointer(leader.id, leader.report_revision));
    }).immediate();
  }
  /** Results that are ready to travel with this leader: same parent and owner, finished, not yet reported or claimed, not in backoff. */
  function readyReports(leader: DispatchRow): DispatchRow[] {
    if (!/^[A-Za-z0-9_-]+$/.test(leader.id)) return [];
    const now = Date.now();
    return rows(leader.parent_chat_id, `id<>'${leader.id}' AND cancel_requested=0 AND reported_at IS NULL AND report_json IS NULL
      AND state IN ('completed','failed','cancelled','interrupted','uncertain','waiting_input') AND (report_error IS NULL OR report_error NOT LIKE '${REPORT_ABANDONED}%')`, REPORT_BATCH_MAX * 3)
      .filter(row => row.owner_scope === leader.owner_scope && currentOwner(row) && !stoppedDispatches.has(row.id)
        && !((row.report_attempts ?? 0) > 0 && row.report_attempt_at && Date.parse(row.report_attempt_at) + reportRetryDelay(row.report_attempts) > now));
  }
  /** A report steer that did not start: delivered by other means, withdrawn by the owner, still held in the service (a bounded wait,
   * same identity), or lost (a new steer, bounded). */
  function unacceptedReport(item: DispatchRow, identity: string, receiptStatus: string | undefined) {
    const ended = endedReportSteer(identity), reason = ended?.reason ?? "";
    if (ended && (REPORT_STEER_DELIVERED as readonly string[]).includes(reason)) { markReported(item); return; }
    if (ended && (REPORT_STEER_OWNER_STOP as readonly string[]).includes(reason)) {
      db().transaction(() => {
        db().prepare("UPDATE work_session_dispatches SET report_error=? WHERE id=? AND reported_at IS NULL").run(`${REPORT_ABANDONED}:owner_stopped`, item.id);
        db().prepare("UPDATE work_session_dispatches SET report_error=? WHERE report_json=? AND reported_at IS NULL").run(`${REPORT_ABANDONED}:owner_stopped`, reportBatchPointer(item.id, item.report_revision));
      }).immediate();
      return;
    }
    if (!ended && receiptStatus === "held") { retryReport(item, "work_session_report_held", false); return; }
    retryReport(item, `work_session_report_${ended?.status ?? receiptStatus ?? "unknown"}`, true);
  }
  /** The report for this leader plus the ready results that travel with it, claimed by pointer in one transaction. A single result
   * keeps the original one-result schema. The stored payload is what is sent, so a retry under the same identity is byte-identical. */
  function composeReport(leader: DispatchRow): string {
    const compose = (list: DispatchRow[]) => composeDeclaredPrompt([{id:"work.session.result.data",revision:3,stability:"turn-context",changeTriggers:["child-result"],order:0,
      text:JSON.stringify(list.length === 1
        ? { schemaVersion: "agentlas.work-session-result.v1", parent_chat_id: leader.parent_chat_id, parent_run_id: leader.parent_run_id, ...view(leader), result_is_untrusted_data: true }
        : { schemaVersion: "agentlas.work-session-results.v1", parent_chat_id: leader.parent_chat_id, parent_run_id: leader.parent_run_id, results: list.map(view), result_is_untrusted_data: true })}]);
    let payload = "";
    db().transaction(() => {
      db().prepare("UPDATE work_session_dispatches SET report_json=NULL WHERE report_json LIKE ? AND reported_at IS NULL").run(`${REPORT_BATCH_PREFIX}${leader.id}:%`);
      const claimed: DispatchRow[] = [];
      for (const member of readyReports(leader)) {
        if (claimed.length >= REPORT_BATCH_MAX - 1) break;
        if (db().prepare("UPDATE work_session_dispatches SET report_json=? WHERE id=? AND report_json IS NULL AND reported_at IS NULL")
          .run(reportBatchPointer(leader.id, leader.report_revision), member.id).changes === 1) claimed.push(member);
      }
      payload = compose([leader, ...claimed]);
      while (bytes(payload) > RESPONSE_BYTES && claimed.length) {
        db().prepare("UPDATE work_session_dispatches SET report_json=NULL WHERE id=?").run(claimed.pop()!.id);
        payload = compose([leader, ...claimed]);
      }
      db().prepare("UPDATE work_session_dispatches SET report_json=? WHERE id=? AND report_json IS NULL").run(payload, leader.id);
    }).immediate();
    return controlRow(leader.id)?.report_json ?? payload;
  }
  async function report(item: DispatchRow) {
    item=controlRow(item.id)??item;
    if (item.reported_at || !currentOwner(item) || ![...TERMINAL, "waiting_input"].includes(item.state) || item.cancel_requested) return;
    if (item.report_error?.startsWith(REPORT_ABANDONED)) return;
    if (item.report_json?.startsWith(REPORT_BATCH_PREFIX)) {
      // This result is claimed by a leader's report. If that report was accepted this result was delivered with it; while the leader
      // still has a report to deliver or retry (it re-claims its results when it recomposes) this result waits for it; otherwise the
      // leader was abandoned, stopped, re-run or is gone, and the claim is released so this result goes out on its own.
      const [, leaderId, revision] = item.report_json.split(":");
      const leader = leaderId ? controlRow(leaderId) : undefined;
      if (leader?.reported_at && String(leader.report_revision) === revision) {
        db().prepare("UPDATE work_session_dispatches SET reported_at=?,report_error=NULL WHERE id=? AND reported_at IS NULL").run(leader.reported_at, item.id);
        return;
      }
      if (leader && !leader.reported_at && !leader.cancel_requested && !leader.report_error?.startsWith(REPORT_ABANDONED)
        && currentOwner(leader) && [...TERMINAL, "waiting_input"].includes(leader.state)) { scheduleReportRetry(item.parent_chat_id, 15_000); return; }
      db().prepare("UPDATE work_session_dispatches SET report_json=NULL WHERE id=? AND reported_at IS NULL").run(item.id);
      item = controlRow(item.id) ?? item;
    }
    if ((item.report_attempts ?? 0) > 0 && item.report_attempt_at) {
      const wait = Date.parse(item.report_attempt_at) + reportRetryDelay(item.report_attempts) - Date.now();
      if (wait > 0) { scheduleReportRetry(item.parent_chat_id, wait); return; }
    }
    // A pre-release oversized payload may already have an exact durable ACK.
    // Reconcile that identity; never resend it or silently replace a held turn.
    if(item.report_json&&bytes(item.report_json)>RESPONSE_BYTES){
      const previous=ports.service.ownerSteerReceipt(item.parent_chat_id,`work-report:${item.id}:${item.report_revision}`);
      if(previous){
        const accepted=previous.chatId===item.parent_chat_id&&previous.promptHash===hash(item.report_json)&&["queued","draining","started"].includes(previous.status??"");
        db().prepare("UPDATE work_session_dispatches SET reported_at=?,report_error=? WHERE id=?").run(accepted?new Date().toISOString():null,accepted?null:"work_session_legacy_report_delivery_unconfirmed",item.id);return;
      }
      db().prepare("UPDATE work_session_dispatches SET report_json=NULL,report_revision=report_revision+1 WHERE id=?").run(item.id);item=controlRow(item.id)!;
    }
    const identity = `work-report:${item.id}:${item.report_revision}`;
    let existing: ReturnType<Service["ownerSteerReceipt"]>;
    try { existing = ports.service.ownerSteerReceipt(item.parent_chat_id, identity); }
    catch (error) { retryReport(item, causeCode(error), false); return; }
    // A new steer must leave room for the owner's input in the parent's queue; a steer that already exists is only looked at again.
    if (!existing && inflightReports(item.parent_chat_id) >= REPORT_INFLIGHT_MAX) { scheduleReportRetry(item.parent_chat_id, 15_000); return; }
    // Stable data, not an imperative prompt. The existing parent model decides recovery and presentation.
    const payload = item.report_json ?? composeReport(item);
    try {
      const receipt = existing ?? await ports.steerFromOwner({ chatId: item.parent_chat_id, userPrompt: payload, promptOrigin: "system", taskIntent: "conversation",
        permissions: (JSON.parse(item.request_json) as McpInvocationRequest).permissions, oneMode: false, sessionRouting: false, hubMode: "local-only", steeringMode: "queue" }, identity);
      if (receipt.chatId !== item.parent_chat_id || receipt.promptHash !== hash(payload)) throw Object.assign(new Error("work_session_report_binding_changed"), { code: "work_session_report_binding_changed" });
      if (["queued", "draining", "started"].includes(receipt.status ?? "")) markReported(item);
      else unacceptedReport(item, identity, receipt.status);
    } catch (error) {
      const cause = causeCode(error);
      retryReport(item, cause, cause === "work_session_report_binding_changed");
    }
  }
  /** A dispatch that can no longer run needs none of the in-memory fences that guard a running one; dropping them keeps a long-lived
   * Main or daemon that has delegated many children from growing state. A stop that could not be written to the row
   * (cancel_requested still 0) keeps its fence, which is then the only record of it. */
  function reclaimDispatch(item: DispatchRow, state: State) {
    // `uncertain` is a finished row whose native run may still be alive (the start call threw, effects unknown): its Stop path stays.
    if (!TERMINAL.includes(state) || state === "uncertain") return;
    const live = liveChildren.get(item.parent_chat_id), accepted = acceptedByParent.get(item.parent_chat_id);
    live?.delete(item.id); accepted?.delete(item.id);
    if (item.cancel_requested) stoppedDispatches.delete(item.id);
    if (stopDelivery.get(item.child_run_id)?.status !== "pending") stopDelivery.delete(item.child_run_id);
    if (!live?.size) liveChildren.delete(item.parent_chat_id);
    if (!accepted?.size) {
      acceptedByParent.delete(item.parent_chat_id);
      if (!live?.size) for (const [runId, parents] of parentRuns) { parents.delete(item.parent_chat_id); if (!parents.size) parentRuns.delete(runId); }
    }
  }
  /** The same reclamation for every dispatch this process still remembers, from the rows (covers terminal paths other than a child's own settlement). */
  function reclaimTerminalMemory() {
    const ids = [...new Set([...[...acceptedByParent.values()].flatMap(set => [...set]), ...stoppedDispatches])];
    for (let at = 0; at < ids.length; at += 100) {
      const chunk = ids.slice(at, at + 100);
      for (const row of db().prepare(`SELECT ${metaColumns} FROM work_session_dispatches WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as DispatchRow[]) reclaimDispatch(row, row.state);
    }
  }
  /** A finished child keeps no CLI process: its idle resident seat is closed now (a later steer to the same child starts it again from
   * its native session). A seat a turn still holds is looked at again shortly. */
  function reclaimChildSeat(childChatId: string, attempt = 0) {
    try {
      const released = ports.releaseChildSeat?.(childChatId);
      if (released?.busy && attempt < 3) { const timer = setTimeout(() => reclaimChildSeat(childChatId, attempt + 1), 5_000); timer.unref?.(); }
    } catch { /* the shared seat budget and the idle sweep reclaim it at the latest */ }
  }
  function install() {
    if (installed) return; installed = true;
    ports.service.onSettled((event: InvocationSettledEnvelope) => {
      // The parent this event concerns, once known: where the settlement is looked at again if it could not be completed.
      let concerned: string | undefined;
      void (async () => {
        ensure();
        if ((event.receipt.status === "cancelled" && !event.receipt.interruptionCause && !event.receipt.hostStopCause)
          || ["goal_paused_by_user", "goal_deleted_by_user"].includes(event.receipt.hostStopCause ?? "")) cancel(event.chatId);
        for(const item of db().prepare(`SELECT ${metaColumns} FROM work_session_dispatches WHERE child_chat_id=?`).all(event.chatId) as DispatchRow[])if(currentOwner(item)){
          concerned=item.parent_chat_id;
          // This turn ending lets a correction queued behind it start (or fail to): that raises no event, so look for it.
          const synced=syncSteers(item);
          if(readDirections(synced.steering_json).some(steerUnresolved)){steerWatchAttempts.delete(item.parent_chat_id);watchSteers(item.parent_chat_id);}
          // A correction found ended without a run made this finished session's report new again; send it without waiting for another wake.
          if(synced.report_revision!==item.report_revision&&!synced.reported_at&&[...TERMINAL,"waiting_input"].includes(synced.state))scheduleReportRetry(item.parent_chat_id,1_000);
        }
        const childId=db().prepare("SELECT id FROM work_session_dispatches WHERE child_run_id=?").get(event.runId) as {id:string}|undefined;
        const child=childId?controlRow(childId.id):undefined;
        if (child) {
          concerned=child.parent_chat_id;
          settle(child, event.receipt); await report(controlRow(child.id)!); await drain(child.parent_chat_id);
          const done = controlRow(child.id);
          if (done && TERMINAL.includes(done.state)) { reclaimDispatch(done, done.state); reclaimChildSeat(done.child_chat_id); }
        }
        await recover(event.chatId);
      })().catch(error => {
        console.warn("[work-session] settlement deferred", causeCode(error));
        // A settlement that threw (a busy store, most often) left the row where it was; without this the next trigger would be some
        // unrelated wake. The parent's recovery reads the child's receipt again and finishes settle, report and drain.
        retryParent(concerned ?? parentOfEvent(event), error);
      });
    });
  }
  /** The parent of a dispatch this event may belong to, read again because the failure may have come before it was known. */
  function parentOfEvent(event: InvocationSettledEnvelope): string {
    try {
      const found = db().prepare("SELECT parent_chat_id FROM work_session_dispatches WHERE child_run_id=? OR child_chat_id=? LIMIT 1").get(event.runId, event.chatId) as { parent_chat_id: string } | undefined;
      return found?.parent_chat_id ?? event.chatId;
    } catch { return event.chatId; }
  }
  /** Look at this parent's rows again after a failure that left work undone, with growing waits and a bound; a pass that meets no failure
   * clears the count. Always through the single-flight recover, so settle, report and drain all run again. */
  function retryParent(parentChatId: string, error: unknown): boolean {
    const attempt = (storeBusyRetries.get(parentChatId) ?? 0) + 1;
    if (attempt > STORE_BUSY_RETRY_MS.length) { console.warn("[work-session] retry exhausted; the next settlement or status read looks again", causeCode(error)); return false; }
    storeBusyRetries.set(parentChatId, attempt);
    scheduleReportRetry(parentChatId, STORE_BUSY_RETRY_MS[attempt - 1]);
    return true;
  }
  /** A correction waiting in a child's queue raises no event when it starts or fails. Bounded; a child's own settlement re-arms it. */
  function watchSteers(parentChatId: string) {
    const attempt = (steerWatchAttempts.get(parentChatId) ?? 0) + 1;
    if (attempt > STEER_WATCH_MS.length) return;
    // A look already due as soon as this one would be is enough (status reads call recover often and must not use the waits up).
    const waiting = reportTimers.get(parentChatId);
    if (waiting && waiting.at <= Date.now() + STEER_WATCH_MS[attempt - 1]) return;
    steerWatchAttempts.set(parentChatId, attempt);
    scheduleReportRetry(parentChatId, STEER_WATCH_MS[attempt - 1]);
  }
  async function drain(parentChatId: string) {
    if (draining.has(parentChatId)) return; draining.add(parentChatId);
    let requeued = false;
    try {
      for (const candidate of rows(parentChatId,"state='queued'",MAX_PENDING)) {
        const item=controlRow(candidate.id)!;remember(parentChatId,item.id);
        if(stoppedDispatches.has(item.id)){try{db().prepare("UPDATE work_session_dispatches SET cancel_requested=1,state='cancelled',updated_at=? WHERE id=? AND state='queued'").run(new Date().toISOString(),item.id);}catch{/* The in-memory stop fence remains authoritative for admission. */}continue;}
        if (item.state !== "queued" || item.cancel_requested || stoppedParents.has(parentChatId) || !currentOwner(item)) continue;
        const admission=hostClaimOf(item),current=ports.hostClaim();
        if(!admission||!sameHost(admission,current)){
          if(admission&&ports.hostState(admission)!=="dead")continue;
          const detail=failure(admission?"work_session_admission_host_ended":"work_session_admission_host_unbound","not-dispatched","preparation");
          db().prepare("UPDATE work_session_dispatches SET state='failed',failure_json=?,failure_summary_json=?,updated_at=? WHERE id=? AND state='queued'").run(JSON.stringify(detail),JSON.stringify(diagnosticSummary(detail,[])),new Date().toISOString(),item.id);
          await report(controlRow(item.id)!);continue;
        }
        // No cap on children running at once: the harness queues the actual execution (run slots, resident seats, writer admission),
        // so a child is admitted the moment it is dispatched and waits there, not here.
        const claimed = db().transaction(() => {
          return db().prepare("UPDATE work_session_dispatches SET state='starting',start_attempted=1,updated_at=? WHERE id=? AND state='queued' AND cancel_requested=0")
            .run(new Date().toISOString(), item.id).changes === 1;
        }).immediate();
        if (!claimed) continue;
        let startCalled = false;
        try {
          const target = JSON.parse(item.target_json) as Target, request = JSON.parse(item.request_json) as McpInvocationRequest;
          if (!ports.chat(item.child_chat_id)) {
            ports.createChild({ internalId: item.child_chat_id, agentId: target.agentId, ...(target.firmId ? { firmId: target.firmId } : {}), projectId: item.project_id,
              parentChatId: item.parent_chat_id, kind: "division", originSurface: "work", title: assignmentTitle(item.request_json) });
            ports.bindChild(item.child_chat_id, item.parent_chat_id);
            if (item.workspace_path) ports.setChildWorkingFolder(item.child_chat_id, item.workspace_path);
          }
          if (item.workspace_path && ports.workingFolder(item.child_chat_id) !== item.workspace_path)
            throw Object.assign(new Error("work_session_child_workspace_changed"), {code:"work_session_child_workspace_changed",turnDelivery:"not-dispatched"});
          if (stoppedDispatches.has(item.id) || controlRow(item.id)?.cancel_requested || !currentOwner(item)) { db().prepare("UPDATE work_session_dispatches SET state='cancelled' WHERE id=?").run(item.id); continue; }
          // No child completion await: one admitted native writer, same lifecycle/permissions as every invocation.
          let children=liveChildren.get(parentChatId);if(!children){children=new Map();liveChildren.set(parentChatId,children);}children.set(item.id,item.child_run_id);
          startCalled = true;
          const started = ports.service.start(request);
          if (started.runId !== item.child_run_id) throw Object.assign(new Error("work_session_child_run_changed"), { code: "work_session_child_run_changed" });
          db().prepare("UPDATE work_session_dispatches SET state='running',updated_at=? WHERE id=? AND state='starting'").run(new Date().toISOString(), item.id);
          startAttempts.delete(item.id);
        } catch (error) {
          const receipt = ports.service.receipt(item.child_run_id);
          if (receipt) settle(item, receipt);
          else if (!startCalled && isStoreBusy(error) && (startAttempts.get(item.id) ?? 0) < STORE_BUSY_RETRY_MS.length && retryParent(parentChatId, error)) {
            // Nothing was dispatched: a busy store while the child was being prepared is this delegation waiting, not failing. It goes back
            // to queued (start_attempted 0) and is started again by the retry below; only when the waits run out is it the failed start it
            // then is (or when no retry could be scheduled any more). If even this write is refused the row stays claimed and recover() re-queues it from startRetry.
            startAttempts.set(item.id, (startAttempts.get(item.id) ?? 0) + 1); startRetry.add(item.id);
            db().prepare("UPDATE work_session_dispatches SET state='queued',start_attempted=0,updated_at=? WHERE id=? AND state='starting'").run(new Date().toISOString(), item.id);
            startRetry.delete(item.id); requeued = true;
            continue;
          }
          else {startAttempts.delete(item.id);const notDispatched = !startCalled || ports.notDispatched(error);if(notDispatched)liveChildren.get(parentChatId)?.delete(item.id);db().prepare("UPDATE work_session_dispatches SET state=?,failure_json=?,effect_uncertain=?,uncertain_run_id=?,updated_at=? WHERE id=?").run(notDispatched ? "failed" : "uncertain",
            JSON.stringify(executionFailureReport({outcome:"blocked",causes:[readExecutionFailureCause(error,{phase:"preparation",fallbackCode:causeCode(error),delivery:notDispatched?"not-dispatched":"unknown"})]})),notDispatched?0:1,notDispatched?null:item.child_run_id, new Date().toISOString(), item.id);}
          await report(controlRow(item.id)!);
        }
      }
      if (!requeued) storeBusyRetries.delete(parentChatId);   // a pass that met no locked store ends the wait progression
    } catch (error) {
      // The store refused a read or write around a start (before the row was claimed, or while recording its outcome). The queued rows
      // are looked at again shortly; the first refusal ends this pass because the next row would wait out the same lock.
      if (!isStoreBusy(error)) throw error;
      retryParent(parentChatId, error);
    } finally { draining.delete(parentChatId); }
  }
  async function recover(parentChatId?: string): Promise<void> {
    ensure(); install();
    if (recovering) return recovering;
    recovering = (async () => {
      // A report counts as delivered once its steer is accepted. If that steer then ends without being consumed (failed or
      // cancelled) the parent never received the result, so the report goes back to undelivered and is sent again.
      try {
        const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
        const lost = db().prepare(`SELECT d.id AS id,s.status AS status FROM work_session_dispatches d JOIN invocation_steers s
          ON s.id='owner:work-report:'||d.id||':'||d.report_revision
          WHERE ${parentChatId ? "d.parent_chat_id=? AND " : ""}d.cancel_requested=0 AND d.reported_at IS NOT NULL AND d.updated_at>=?
          AND s.status IN ('failed','cancelled')
          AND (s.recovery_reason IS NULL OR s.recovery_reason NOT IN (${sqlStrings([...REPORT_STEER_DELIVERED, ...REPORT_STEER_OWNER_STOP])}))
          ORDER BY d.rowid LIMIT 20`).all(...(parentChatId ? [parentChatId] : []), since) as { id: string; status: string }[];
        for (const entry of lost) {
          const item = controlRow(entry.id);
          if (!item || item.owner_scope !== ports.ownerScope() || !currentOwner(item) || stoppedDispatches.has(item.id)) continue;
          db().transaction(() => {
            // The results this report carried were not delivered either: they go back to undelivered and are batched again.
            db().prepare("UPDATE work_session_dispatches SET reported_at=NULL,report_json=NULL WHERE report_json=? AND reported_at IS NOT NULL").run(reportBatchPointer(item.id, item.report_revision));
            db().prepare("UPDATE work_session_dispatches SET reported_at=NULL WHERE id=? AND reported_at IS NOT NULL").run(item.id);
            retryReport({ ...item, reported_at: null }, `work_session_report_${entry.status}`, true);
          }).immediate();
        }
      } catch (error) { console.warn("[work-session] report reconciliation deferred", causeCode(error)); }
      const seen = new Set<string>(), busy = new Set<string>(), watch = new Set<string>();
      try {
      // A correction ended without a run (failed, withdrawn, held) is closed by syncSteers, so only an unstarted one keeps its row here.
      const pending = rows(parentChatId,"state IN ('starting','running','waiting_input') OR (cancel_requested=0 AND reported_at IS NULL AND (report_error IS NULL OR report_error NOT LIKE 'work_session_report_abandoned%') AND state IN ('completed','failed','cancelled','interrupted','uncertain')) OR EXISTS(SELECT 1 FROM json_each(steering_json) WHERE json_extract(value,'$.runId') IS NULL AND COALESCE(json_extract(value,'$.endStatus'),'held')='held')");
      for (let at = 0; at < pending.length; at++) {
        let item = pending[at];
        if(item.owner_scope!==ports.ownerScope())continue;
        seen.add(item.parent_chat_id);
        try {
        remember(item.parent_chat_id,item.id);
        if(item.cancel_requested||stoppedDispatches.has(item.id)){
          // Re-issue the stop, then read how the run actually ended: a stopped row whose settlement was lost (the host died or the
          // write failed after Stop) must still reach a final state, or it stays running, counts as open and silences the parent.
          cancel(item.parent_chat_id,item.id);
          item=controlRow(item.id)??item;
          if(!ACTIVE.includes(item.state))continue;
        }
        if (!currentOwner(item)) continue;
        item=syncSteers(item);
        if(readDirections(item.steering_json).some(steerUnresolved))watch.add(item.parent_chat_id);
        if (ACTIVE.includes(item.state)) {
          const admission=hostClaimOf(item),custody=ports.runOwnerState(item.child_chat_id,item.child_run_id,admission),physical=admission?ports.hostState(admission):"unknown";
          const receipt = ports.service.receipt(item.child_run_id);
          // Active/settling custody outranks a foreign ledger-only interrupted
          // projection. A live/unknown admission host also owns the start gap.
          if(custody!=="live"&&custody!=="unknown"){
          if(receipt){
            if(receipt.status!=="interrupted"||receipt.finishedAt||physical==="dead")settle(item, receipt);
          } else if (item.state==="starting"&&startRetry.has(item.id)) {
            // The start never began (busy store) and the write that would have re-queued the row was refused too: do it now.
            db().prepare("UPDATE work_session_dispatches SET state='queued',start_attempted=0,updated_at=? WHERE id=? AND state='starting'").run(new Date().toISOString(),item.id);
            startRetry.delete(item.id);
          } else if (item.start_attempted&&(physical==="dead"||(item.state==="starting"&&!!admission&&sameHost(admission,ports.hostClaim())&&!draining.has(item.parent_chat_id)))) {
            // Dead host, or this process claimed the row and no longer holds its start (the outcome write was lost): whether the child
            // was dispatched is unknown, so the effects are.
            const detail=failure("work_session_child_receipt_missing","unknown");
            db().prepare("UPDATE work_session_dispatches SET state='uncertain',failure_json=?,failure_summary_json=?,effect_uncertain=1,uncertain_run_id=COALESCE(uncertain_run_id,?),updated_at=? WHERE id=?").run(
              JSON.stringify(detail),JSON.stringify(diagnosticSummary(detail,[])),item.child_run_id,new Date().toISOString(),item.id);
          }
          }
        }
        await report(controlRow(item.id)!);
        } catch (error) {
          // A busy store leaves this row for the next pass, which is scheduled; the rest of this pass would wait out the same lock.
          if (!isStoreBusy(error)) throw error;
          for (const parent of new Set(pending.slice(at).map(row => row.parent_chat_id))) { busy.add(parent); retryParent(parent, error); }
          break;
        }
      }
      for (const parent of seen) {
        if (!busy.has(parent)) storeBusyRetries.delete(parent);
        if (watch.has(parent)) watchSteers(parent); else steerWatchAttempts.delete(parent);
      }
      for (const parent of new Set(rows(parentChatId,"state='queued'").map(item => item.parent_chat_id))) await drain(parent);
      } catch (error) {
        // The store refused the scan itself (or the queue read): nothing is lost, the whole pass is looked at again.
        if (!isStoreBusy(error)) throw error;
        retryParent(parentChatId ?? "", error);
      }
      try { reclaimTerminalMemory(); } catch (error) { console.warn("[work-session] memory reclamation deferred", causeCode(error)); }
    })().finally(() => { recovering = null; });
    return recovering;
  }
  /** A correction the child's chat may still start: sent, not ended, and not yet bound to a run. Anything unreadable counts as pending. */
  function hasPendingDirection(item: DispatchRow): boolean {
    try {
      for (const direction of readDirections(item.steering_json)) {
        if (direction.runId || direction.endStatus) continue;
        const receipt = ports.service.ownerSteerReceipt(item.child_chat_id, direction.intentId);
        if (!receipt || receipt.chatId !== item.child_chat_id || receipt.promptHash !== direction.hash || ["queued", "draining"].includes(receipt.status ?? "")) return true;
      }
      return false;
    } catch { return true; }
  }
  /** Over, with nothing left that could start: there is nothing for an owner's Stop to stop. (An `uncertain` row is over too; its native
   * run still gets the stop request.) Such a session stays steerable and its result stays reportable after a Stop. */
  const finishedIdle = (item: DispatchRow) => TERMINAL.includes(item.state) && !hasPendingDirection(item);
  /** A new owner instruction (a delegation, or a correction to a finished session) may admit new work after Stop, but cannot revive an
   * earlier assignment that is still queued or running only because its stop never reached the store: those stay fenced. */
  function fenceUnfinished(parentChatId: string) {
    if (stoppedParents.has(parentChatId)) for (const item of rows(parentChatId)) if (!finishedIdle(item)) stoppedDispatches.add(item.id);
  }
  function cancel(parentChatId: string, dispatchId?: string) {
    // Ids this call itself fenced because the process remembered them: the rows below say which of them are over and can be let go.
    const fencedNow=new Set<string>();
    if(dispatchId)stoppedDispatches.add(dispatchId);
    else{stoppedParents.add(parentChatId);for(const id of acceptedByParent.get(parentChatId)??[]){if(!stoppedDispatches.has(id))fencedNow.add(id);stoppedDispatches.add(id);}}
    const cancelled: string[] = [];let persistence:"recorded"|"deferred"="recorded",persistCause:string|undefined;
    // Stop the native lifetimes before store writes; a busy DB cannot veto Stop.
    for(const [id,runId] of liveChildren.get(parentChatId)??[])if(!dispatchId||id===dispatchId){stoppedDispatches.add(id);fencedNow.delete(id);stopRun(runId);cancelled.push(id);}
    for(const pending of pendingDirections.values())if(pending.parentChatId===parentChatId&&(!dispatchId||pending.dispatchId===dispatchId)){
      try{ports.service.unsteerQueuedById?.(pending.childChatId,pending.queuedRequestId);}catch{/* The native lifetime is already stopped; retain the durable request for reconciliation. */}
    }
    let candidates:DispatchRow[]=[],owner:string;
    try{ensure();candidates=rows(parentChatId);owner=ports.ownerScope();}catch(error){return {cancelled,persistence:"deferred" as const,cause:causeCode(error)};}
    // Descendants are limited to this module's exact child chats; One and unrelated sessions are untouched.
    for (let item of candidates.filter(item => !dispatchId || item.id === dispatchId)) {
      if (item.owner_scope!==owner) continue;
      const alreadyStopped=stoppedDispatches.has(item.id) && !fencedNow.has(item.id);
      stoppedDispatches.add(item.id);
      try{item=syncSteers(item);for(const direction of readDirections(item.steering_json)){if(direction.runId||direction.endStatus)continue;const receipt=ports.service.ownerSteerReceipt(item.child_chat_id,direction.intentId);if(receipt?.queuedRequestId&&["queued","draining"].includes(receipt.status??""))ports.service.unsteerQueuedById?.(item.child_chat_id,receipt.queuedRequestId);}
        // What the withdrawal left behind (a correction that did not start) is read once more, so the row's state below is the final one.
        item=syncSteers(item);}catch{/* Stop never depends on a readable queue. */}
      if(ACTIVE.includes(item.state) || item.state === "uncertain")stopRun(item.child_run_id);
      // The whole-parent Stop (the owner's Stop, a Goal pause) withdraws what can still run. A session that is already over, with no
      // correction waiting to start, has nothing to withdraw: sealing it would refuse every later correction to it (work_session_steer
      // after a failure is the contract) and drop a result not yet reported. Only the model's own work_session_cancel seals it.
      if(!dispatchId&&!alreadyStopped&&!item.cancel_requested&&finishedIdle(item)){stoppedDispatches.delete(item.id);continue;}
      try{db().prepare("UPDATE work_session_dispatches SET cancel_requested=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=? WHERE id=?").run(new Date().toISOString(), item.id);}catch(error){persistence="deferred";persistCause=causeCode(error);}
      cancel(item.child_chat_id); if(!cancelled.includes(item.id))cancelled.push(item.id);
    }
    return { cancelled,persistence,...(persistCause?{cause:persistCause}:{}) };
  }
  function cancelRun(runId:string){
    const parents=new Set(parentRuns.get(runId)??[]);
    try{ensure();for(const item of db().prepare("SELECT DISTINCT parent_chat_id FROM work_session_dispatches WHERE parent_run_id=? AND owner_scope=?").all(runId,ports.ownerScope()) as {parent_chat_id:string}[])parents.add(item.parent_chat_id);}catch{/* Memory ownership still stops live descendants. */}
    return {cancelled:[...new Set([...parents].flatMap(parent=>cancel(parent).cancelled))]};
  }
  async function dispatch(caller: WorkSessionCaller, name: string, input: unknown): Promise<unknown> {
    callerCurrent(caller); ensure(); install();
    if (name === "work_session_agents") {
      const arg=object(input,["section","offset","limit","snapshot_id"]),section=arg.section??"agents";
      if(!["agents","runtimes","sessions"].includes(String(section)))throw Object.assign(new Error("work_session_page_invalid"),{code:"work_session_page_invalid"});
      const metadata={schemaVersion:"agentlas.work-session-inventory.v1",section,concurrency:"managed-by-harness",open_session_limit:MAX_PENDING,
        readers:{tool:"work_session_agents",sections:["agents","runtimes","sessions"],item_sections:["agents","sessions"],text_sections:["runtimes"],text_offset_unit:"utf8-bytes"}};
      if(section==="sessions"){
        const offset=pageInteger(arg.offset,0),limit=Math.max(1,Math.min(64,pageInteger(arg.limit,16,65536)));
        let cutoff:number;
        if(arg.snapshot_id===undefined)cutoff=(db().prepare("SELECT COALESCE(max(rowid),0) n FROM work_session_dispatches WHERE parent_chat_id=? AND owner_scope=?").get(caller.chatId,ports.ownerScope()) as {n:number}).n;
        else{if(typeof arg.snapshot_id!=="string"||!/^sessions-v1:[0-9]+$/.test(arg.snapshot_id))throw Object.assign(new Error("work_session_page_invalid"),{code:"work_session_page_invalid"});cutoff=pageInteger(Number(arg.snapshot_id.slice(12)),0);}
        const total=(db().prepare("SELECT count(*) n FROM work_session_dispatches WHERE parent_chat_id=? AND owner_scope=? AND rowid<=?").get(caller.chatId,ports.ownerScope(),cutoff) as {n:number}).n;
        if(offset>total)throw Object.assign(new Error("work_session_page_invalid"),{code:"work_session_page_invalid"});
        const found=db().prepare(`SELECT ${metaColumns} FROM work_session_dispatches WHERE parent_chat_id=? AND owner_scope=? AND rowid<=? ORDER BY rowid LIMIT ? OFFSET ?`).all(caller.chatId,ports.ownerScope(),cutoff,limit,offset) as DispatchRow[];
        const sessions=found.map(item=>({session_id:item.id,target:shortText(item.target_key,512),target_truncated:bytes(item.target_key)>512,status:item.state,result_available:!!item.result_available,effect_reconciliation_required:item.effect_uncertain===1}));
        return {...metadata,snapshot_id:`sessions-v1:${cutoff}`,snapshot_consistency:"membership-high-water; states-sampled-on-read",offset_unit:"items",offset,limit,total,sessions,
          truncated:offset>0||offset+sessions.length<total,next_offset:offset+sessions.length<total?offset+sessions.length:null};
      }
      if(section==="runtimes"){
        const runtime=await runtimes(caller);callerCurrent(caller);
        return textPage(JSON.stringify(workloadRuntimeInventory(runtime)),arg,{...metadata,format:"json"});
      }
      const available=await targets(caller);callerCurrent(caller);
      const agents=available.map(item=>({target:shortText(item.key,512),target_truncated:bytes(item.key)>512,name:shortText(item.member.nameSnapshot,512),name_truncated:bytes(item.member.nameSnapshot)>512,
        source:item.member.source,entity_kind:item.member.entityKind,release_id:shortText(item.member.releaseId,128)||null,release_id_truncated:bytes(item.member.releaseId)>128,available:item.available&&item.key.length<=300,
        ...(item.key.length>300?{cause:"work_session_target_key_oversize"}:item.code?{cause:shortText(item.code,256)}:{})}));
      const snapshot_id=hash(canonical(agents));pageSnapshot(snapshot_id,arg.snapshot_id);
      return itemPage(agents,arg,{...metadata,snapshot_id},"agents");
    }
    if (name === "work_session_delegate") {
      const arg = object(input, ["target", "brief", "request_id", "allocation"]), targetKey = string(arg.target, 512), brief = string(arg.brief, 24_000), requestId = string(arg.request_id, 128);
      if(!workSessionReadPermissionCall({catalogId:"one-team",toolName:name,args:arg}))throw Object.assign(new Error("work_session_input_invalid"),{code:"work_session_input_invalid"});
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)) throw Object.assign(new Error("work_session_request_id_invalid"), { code: "work_session_request_id_invalid" });
      let workspace:string|null=null;
      if(caller.workspace!==undefined){try{workspace=realpathSync.native(string(caller.workspace,32_768));}catch(cause){throw Object.assign(new Error("work_session_workspace_unavailable",{cause}),{code:"work_session_workspace_unavailable",turnDelivery:"not-dispatched"});}}
      // A new owner instruction may admit new work after Stop, but cannot
      // revive older queued assignments whose durable cancellation was busy.
      fenceUnfinished(caller.chatId);
      const intentJson = canonical({ target: targetKey, brief, allocation: arg.allocation ?? null, permission: caller.permission, workspace });
      const matchesAcceptedRequest = (item: DispatchRow) => item.request_digest === hash(intentJson)
        || (workspace === null && item.workspace_path == null && item.request_digest === hash(canonical({ target: targetKey, brief, allocation: arg.allocation ?? null, permission: caller.permission })));
      const prior = db().prepare(`SELECT ${metaColumns},request_digest FROM work_session_dispatches WHERE owner_scope=? AND parent_chat_id=? AND request_id=?`).get(ports.ownerScope(), caller.chatId, requestId) as DispatchRow | undefined;
      if (prior) { if (!matchesAcceptedRequest(prior)) throw Object.assign(new Error("work_session_request_id_conflict"), { code: "work_session_request_id_conflict" }); return { ...view(prior), accepted:true, already_accepted: true }; }
      const available = inventories.get(caller) ?? new Map((await targets(caller)).map(item => [item.key, item]));
      const target = available.get(targetKey);
      if (!target?.available || !ports.project(ports.chat(caller.chatId)!.projectId!)?.agentPool.some(member => keyOf(member) === targetKey)) throw Object.assign(new Error("work_session_target_changed"), { code: "work_session_target_changed" });
      const runtime = await runtimes(caller); callerCurrent(caller);
      let runtimeSelection = caller.runtimeSelection;
      if (arg.allocation !== undefined) {
        const allocation: WorkloadAllocation = normalizeWorkloadAllocation(arg.allocation, "delegate");
        const fallback = runtime.find(item => item.kind === caller.runtimeSelection?.kind && item.model === caller.runtimeSelection?.model) ?? runtime[0];
        if (!fallback) throw Object.assign(new Error("work_session_runtime_inventory_empty"), { code: "work_session_runtime_inventory_empty" });
        const resolved = resolveWorkloadAllocationAcrossRuntimes({ allocation, runtimes: runtime, fallbackRuntime: fallback, phase: "delegate" });
        if (resolved.source !== "ai-assigned") throw Object.assign(new Error("work_session_allocation_invalid"), { code: "work_session_allocation_invalid" });
        runtimeSelection = { kind: resolved.runtime.kind, backend: resolved.runtime.backend, source: resolved.runtime.source, model: resolved.runtime.model ?? undefined,
          effort: resolved.runtime.effort ?? undefined, longContext: caller.runtimeSelection?.longContext, ...(resolved.runtime.acpAgentId?{acpAgentId:resolved.runtime.acpAgentId}:{}), role: "worker", inherit: false };
      }
      const admissionHost=JSON.stringify(ports.hostClaim());
      const id = `work-${randomUUID()}`, childChatId = randomUUID(), childRunId = randomUUID(), now = new Date().toISOString();
      const request: McpInvocationRequest = { runId: childRunId, chatId: childChatId, userPrompt: brief, promptOrigin: "system", permissions: caller.permission,
        taskIntent: "task", oneMode: false, sessionRouting: false, hubMode: "local-only", ...(runtimeSelection ? { runtimeSelection } : {}), ...(target.target ? { taskForceTargets: [target.target] } : {}) };
      let acceptedId=id;
      db().transaction(() => {
        const concurrent=db().prepare(`SELECT ${metaColumns},request_digest FROM work_session_dispatches WHERE owner_scope=? AND parent_chat_id=? AND request_id=?`).get(ports.ownerScope(),caller.chatId,requestId) as DispatchRow|undefined;
        if(concurrent){if(!matchesAcceptedRequest(concurrent))throw Object.assign(new Error("work_session_request_id_conflict"),{code:"work_session_request_id_conflict"});acceptedId=concurrent.id;return;}
        if ((db().prepare("SELECT count(*) n FROM work_session_dispatches WHERE parent_chat_id=? AND cancel_requested=0 AND state IN ('queued','starting','running','waiting_input')").get(caller.chatId) as {n:number}).n >= MAX_PENDING) throw Object.assign(new Error("work_session_queue_full"), { code: "work_session_queue_full" });
        db().prepare(`INSERT INTO work_session_dispatches(id,parent_chat_id,parent_run_id,project_id,owner_scope,request_id,request_json,request_digest,target_json,
          child_chat_id,child_run_id,workspace_path,admission_host_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, caller.chatId, caller.runId,
          ports.chat(caller.chatId)!.projectId, ports.ownerScope(), requestId, JSON.stringify(request), hash(intentJson), JSON.stringify(target), childChatId, childRunId, workspace, admissionHost, now, now);
      }).immediate();
      remember(caller.chatId,acceptedId);
      stoppedParents.delete(caller.chatId);
      let runParents=parentRuns.get(caller.runId);if(!runParents){runParents=new Set();parentRuns.set(caller.runId,runParents);}runParents.add(caller.chatId);
      queueMicrotask(() => { void drain(caller.chatId).catch(error => console.warn("[work-session] start deferred", causeCode(error))); });
      return { ...view(controlRow(acceptedId)!), accepted: true, ...(acceptedId!==id?{already_accepted:true}:{}) };
    }
    if (name === "work_session_status") {
      const arg=object(input,["dispatch_id","session_id","section","offset","limit","snapshot_id"]),id=handleId(arg),section=arg.section??"summary";
      if(!["summary","result","diagnostics"].includes(String(section)))throw Object.assign(new Error("work_session_page_invalid"),{code:"work_session_page_invalid"});
      await recover(caller.chatId);owned(caller,id);
      if(section==="summary")return view(controlRow(id)!);
      const item=row(id)!;
      if(section==="diagnostics")return textPage(JSON.stringify({failure:item.failure_json?JSON.parse(item.failure_json):null,failure_reports:JSON.parse(item.failure_reports_json),
        effect_reconciliation_required:item.effect_uncertain===1,uncertain_run_id:item.uncertain_run_id,target:JSON.parse(item.target_json)}),arg,{session_id:id,section,format:"json"});
      const saved=item.result_json?JSON.parse(item.result_json) as {messageId:string;text:string;is_excerpt?:boolean}:null;
      const result=saved?.is_excerpt?ports.result(item.child_chat_id,item.child_run_id)??saved:saved;
      return textPage(result?.text??"",arg,{session_id:id,section,available:!!result,source_truncated:!!saved?.is_excerpt&&result===saved,
        result_ref:{chat_id:item.child_chat_id,run_id:item.child_run_id,message_id:result?.messageId??null}});
    }
    if (name === "work_session_cancel") { const arg = object(input, ["dispatch_id","session_id"]); const id = handleId(arg); owned(caller, id); return cancel(caller.chatId, id); }
    if (name === "work_session_steer") {
      const arg = object(input, ["dispatch_id","session_id", "message", "request_id","recovery_mode"]), id = handleId(arg), message = string(arg.message, 24_000), requestId = string(arg.request_id, 128);
      owned(caller, id); const item = controlRow(id)!;
      if(stoppedDispatches.has(item.id)||item.cancel_requested||item.state==="cancelled"||item.state==="queued"||item.state==="starting")throw Object.assign(new Error("work_session_child_not_resumable"),{code:"work_session_child_not_resumable"});
      if(arg.recovery_mode!==undefined&&arg.recovery_mode!=="diagnose"&&arg.recovery_mode!=="continue")throw Object.assign(new Error("work_session_recovery_mode_invalid"),{code:"work_session_recovery_mode_invalid"});
      const mode=arg.recovery_mode??(item.effect_uncertain?"diagnose":"continue");
      // Unknown effects are facts for the main AI and the existing per-action
      // recovery guard, not a lock on this entire child. A fresh explicit plan
      // may inspect or repair other work; it never replays the original brief.
      const originalPermission=(JSON.parse(item.request_json) as McpInvocationRequest).permissions??"read";
      const rank={read:0,write:1,full:2};
      const permission=mode==="diagnose"?"read":rank[caller.permission]<rank[originalPermission]?caller.permission:originalPermission;
      const intentId=`work-steer:${hash(`${id}:${requestId}`)}`,digest=hash(message),contract=hash(canonical({message,mode,permission}));
      db().transaction(()=>{
        const latest=controlRow(id)!,directions=JSON.parse(latest.steering_json) as Array<{requestId:string;intentId:string;hash:string;contract?:string}>;
        const prior=directions.find(direction=>direction.requestId===requestId);
        if(prior&&(prior.hash!==digest||prior.contract!==contract))throw Object.assign(new Error("work_session_request_id_conflict"),{code:"work_session_request_id_conflict"});
        if(!prior){directions.push({requestId,intentId,hash:digest,contract});db().prepare("UPDATE work_session_dispatches SET steering_json=? WHERE id=?").run(JSON.stringify(directions),id);}
      }).immediate();
      if(!ports.chat(item.child_chat_id)&&!item.start_attempted){
        const target=JSON.parse(item.target_json) as Target;
        ports.createChild({internalId:item.child_chat_id,agentId:target.agentId,...(target.firmId?{firmId:target.firmId}:{}),projectId:item.project_id,parentChatId:item.parent_chat_id,title:assignmentTitle(item.request_json),kind:"division",originSurface:"work"});
        ports.bindChild(item.child_chat_id,item.parent_chat_id);if(item.workspace_path)ports.setChildWorkingFolder(item.child_chat_id,item.workspace_path);
      }
      // This correction is a new owner instruction: after a Stop it may start a new run in this finished session, so the Stop's
      // parent-wide fence is lifted (what was still running or queued at the Stop stays fenced), as a new delegation does.
      if(stoppedParents.has(caller.chatId)){fenceUnfinished(caller.chatId);stoppedDispatches.delete(item.id);stoppedParents.delete(caller.chatId);}
      const receipt=await ports.steerFromOwner({ ...JSON.parse(item.request_json), runId: undefined, userPrompt: message,permissions:permission, steeringMode: "queue" },intentId);
      if(receipt.workSessionHost)db().transaction(()=>{
        const directions=JSON.parse(controlRow(id)!.steering_json) as Array<{intentId:string;hostConfirmed?:boolean}>;
        const direction=directions.find(value=>value.intentId===intentId);if(direction)direction.hostConfirmed=true;
        db().prepare("UPDATE work_session_dispatches SET admission_host_json=?,steering_json=? WHERE id=?").run(JSON.stringify(receipt.workSessionHost),JSON.stringify(directions),item.id);
      }).immediate();
      if(receipt.queuedRequestId&&["queued","draining"].includes(receipt.status??""))pendingDirections.set(intentId,{parentChatId:caller.chatId,dispatchId:id,childChatId:item.child_chat_id,queuedRequestId:receipt.queuedRequestId});
      // Its receipt (below) already told the main AI how it went; a correction that starts later, or ends without starting, is watched.
      if(readDirections(syncSteers(controlRow(id)!,true).steering_json).some(steerUnresolved)){steerWatchAttempts.delete(caller.chatId);watchSteers(caller.chatId);}
      const publicReceipt={...receipt};delete publicReceipt.workSessionHost;return publicReceipt;
    }
    throw Object.assign(new Error("work_session_tool_unknown"), { code: "work_session_tool_unknown" });
  }
  function handleId(arg:Record<string,unknown>):string{if(arg.session_id&&arg.dispatch_id&&arg.session_id!==arg.dispatch_id)throw Object.assign(new Error("work_session_handle_conflict"),{code:"work_session_handle_conflict"});return string(arg.session_id??arg.dispatch_id,160);}
  function owned(caller: WorkSessionCaller, id: string) { const item = controlRow(id); if (!item || item.parent_chat_id !== caller.chatId || !currentOwner(item)) throw Object.assign(new Error("work_session_dispatch_not_owned"), { code: "work_session_dispatch_not_owned" }); return view(item); }
  return { allowed, dispatch, recover, cancel, cancelRun, isChildRun: (chatId: string, runId: string, strict = false) => readWorkSessionChildRun(ports, chatId, runId, strict),
    readChildAssignment: (chatId: string, runId: string) => {
      const evidence = childAssignmentEvidence(ports, chatId, runId);
      if (evidence && (stoppedParents.has(evidence.parentChatId)||stoppedDispatches.has(evidence.dispatchId))) throw new WorkSessionAssignmentError("work_session_assignment_not_current");
      return evidence;
    } };
}

/** Exact-run typed facts are retained in full. Wire bounds belong to the
 * paged reader, never to the number of accepted causes or ledger events. */
export function readWorkSessionFailureReports(database: Pick<Database.Database,"prepare">, chatId:string, runId:string): ExecutionFailureReport[] {
  const events=database.prepare("SELECT kind,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind IN ('execution_failure','task_force_execution_receipt','firm_invocation_failed') ORDER BY seq").all(runId,chatId) as {kind:string;payload_json:string}[];
  return events.flatMap(event=>{
    try{
      const data=JSON.parse(event.payload_json) as Record<string,unknown>;
      const read=(value:unknown)=>typeof value==="string"?JSON.parse(value):value;
      const selected=event.kind==="execution_failure"?[data]:data.failureReport?[read(data.failureReport)]:data.failureReports?read(data.failureReports):[];
      if(!Array.isArray(selected))throw new Error("invalid_failure_contract");
      return selected.map((value:unknown)=>{
        if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_failure_contract");
        const raw=value as Record<string,unknown>,causes=read(raw.causes),effects=read(raw.effects);
        if(raw.schemaVersion!=="agentlas.execution-failure.v1"||!["failed","partial","blocked"].includes(String(raw.outcome))||!Array.isArray(causes)||!Array.isArray(effects)
          ||causes.some(cause=>!cause||typeof cause.code!=="string"||typeof cause.phase!=="string"||typeof cause.recovery!=="string")
          ||effects.some(effect=>!effect||!["required","not-required","unspecified"].includes(effect.requirement)
            ||!["not-attempted","withheld","attempted","uncertain","verified"].includes(effect.state)
            ||typeof effect.satisfied!=="boolean"||typeof effect.requiresFollowup!=="boolean"||typeof effect.code!=="string"||typeof effect.recovery!=="string"))throw new Error("invalid_failure_contract");
        return {schemaVersion:"agentlas.execution-failure.v1",outcome:raw.outcome,causes,effects} as ExecutionFailureReport;
      });
    }catch{return [failure("work_session_failure_contract_unreadable","unknown","verification")];}
  });
}

let instance: ReturnType<typeof createWorkSessionDispatcher> | undefined;
function production() {
  if (instance) return instance;
  const store = require("../store/db") as typeof import("../store/db"), chats = require("../store/chats") as typeof import("../store/chats");
  instance = createWorkSessionDispatcher({ db: store.getDb, service: (require("../invocation/service") as typeof import("../invocation/service")).invocationService,
    chat: chats.getChat, project: (require("../store/projects") as typeof import("../store/projects")).getProject,
    agent: (require("../mcp/registry") as typeof import("../mcp/registry")).getAgentById,
    workingFolder: chats.getChatWorkingFolder, setChildWorkingFolder: chats.setChatWorkingFolder,
    queuedSteer: id => (require("../store/invocation-steers") as typeof import("../store/invocation-steers")).getDurableQueuedSteer(id),
    hostClaim: () => (require("./session-host") as typeof import("./session-host")).currentWorkSessionHost(),
    hostState: claim => (require("./session-host") as typeof import("./session-host")).workSessionHostState(claim),
    runOwnerState: (chatId,runId,claim) => (require("./session-host") as typeof import("./session-host")).workSessionRunOwnerState(chatId,runId,claim),
    cancelRun: runId => (require("./session-host") as typeof import("./session-host")).cancelWorkSessionRun(runId),
    steerFromOwner: (request,intentId) => (require("./session-host") as typeof import("./session-host")).steerWorkSessionOwnerTurn(request,intentId),
    firm: (require("../store/firms") as typeof import("../store/firms")).getFirm, createChild: chats.createChat,
    bindChild: (child, parent) => (require("../runtime/session-scope") as typeof import("../runtime/session-scope")).inheritWorkingSessionScope(store.getDb(), child, parent),
    detectRuntimes: () => (require("../runtime/detect") as typeof import("../runtime/detect")).detectRuntimes(),
    ownerScope: () => { const owner = (require("../runtime/agent-context-admission") as typeof import("../runtime/agent-context-admission")).agentContextOwnerBinding(); return `${owner.ownerScope}:${owner.serviceIdentity}`; },
    remoteTarget: async member => {
      const { getCargoSource } = require("../marketplace") as typeof import("../marketplace");
      const source = getCargoSource(); if (!source || member.source !== "cloud") throw Object.assign(new Error("work_session_remote_exact_release_unavailable"), { code: "work_session_remote_exact_release_unavailable" });
      const { getSessionCookieHeader, webBaseUrl } = require("../auth") as typeof import("../auth");
      const { ExperienceCloudHttpClient } = require("../experience/cloud") as typeof import("../experience/cloud");
      const cookieHeader = getSessionCookieHeader(); if (!cookieHeader) throw Object.assign(new Error("source_unauthorized"), { code: "source_unauthorized" });
      const client = new ExperienceCloudHttpClient({ baseUrl: webBaseUrl(), cookieHeader });
      const [target] = await (require("../mcp/project-cloud-roster") as typeof import("../mcp/project-cloud-roster")).resolveProjectCloudRoster([member], {
        listOwnerCloud: async () => (await source.listMyCloudPackages(undefined, { requireComplete: true })).rows,
        listDefinitions: () => client.listAgentDefinitionIdentities(), resolveBase: input => client.resolveBase(input),
      });
      if (!target?.agentDefinitionId || !target.agentReleaseId) throw Object.assign(new Error("work_session_remote_exact_release_unavailable"), { code: "work_session_remote_exact_release_unavailable" });
      return { source: "cloud", entityKind: target.entityKind, slug: target.slug, release: { agentDefinitionId: target.agentDefinitionId, agentReleaseId: target.agentReleaseId, packageHash: target.packageHash } };
    },
    result: (chatId, runId) => {
      const terminal = store.getDb().prepare("SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='mcp_final' ORDER BY seq DESC LIMIT 1").get(runId, chatId) as { payload_json: string } | undefined;
      const messageId = terminal ? JSON.parse(terminal.payload_json).durableMessageId : null;
      if (typeof messageId !== "string") return null;
      const message = store.getDb().prepare("SELECT id,text FROM chat_messages WHERE id=? AND chat_id=? AND role='assistant'").get(messageId, chatId) as { id: string; text: string } | undefined;
      return message ? { messageId: message.id, text: message.text } : null;
    },
    failureReports: (chatId,runId) => readWorkSessionFailureReports(store.getDb(),chatId,runId),
    notDispatched: error => (require("../runtime/runner") as typeof import("../runtime/runner")).runnerRefusedBeforeDispatch(error),
    postParentMessage: (chatId, text) => { chats.appendChatMessage(chatId, "assistant", text, { noGoalResult: true }); },
    releaseChildSeat: chatId => {
      const { busy } = (require("../runtime/agent-residency") as typeof import("../runtime/agent-residency")).releaseIdleAgentResidencyForChat(chatId);
      return { busy };
    },
  });
  return instance;
}
function productionChildReadPorts(): WorkSessionChildReadPorts {
  return {
    db: (require("../store/db") as typeof import("../store/db")).getDb,
    chat: (require("../store/chats") as typeof import("../store/chats")).getChat,
    workingFolder: (require("../store/chats") as typeof import("../store/chats")).getChatWorkingFolder,
    queuedSteer: id => (require("../store/invocation-steers") as typeof import("../store/invocation-steers")).getDurableQueuedSteer(id),
    project: (require("../store/projects") as typeof import("../store/projects")).getProject,
    ownerScope: () => { const owner = (require("../runtime/agent-context-admission") as typeof import("../runtime/agent-context-admission")).agentContextOwnerBinding(); return `${owner.ownerScope}:${owner.serviceIdentity}`; },
  };
}
/** Read-only notification ownership probe, including after host restart. No
 * production() call: unrelated/unknown runs must not initialize a dispatcher. */
export function isWorkSessionChildRun(chatId: string, runId: string, strict?: boolean, ports?: WorkSessionChildReadPorts): boolean;
export function isWorkSessionChildRun(chatId: string, runId: string, ports?: WorkSessionChildReadPorts): boolean;
export function isWorkSessionChildRun(chatId: string, runId: string, strictOrPorts: boolean|WorkSessionChildReadPorts = false, ports?: WorkSessionChildReadPorts): boolean {
  const strict=typeof strictOrPorts==="boolean"?strictOrPorts:false,readPorts=typeof strictOrPorts==="boolean"?ports:strictOrPorts;
  try { return readWorkSessionChildRun(readPorts ?? productionChildReadPorts(), chatId, runId, strict); }
  catch (error) {
    if(!strict)return false;
    if(error instanceof WorkSessionAssignmentError)throw error;
    throw new WorkSessionAssignmentError("work_session_assignment_store_unavailable",error);
  }
}
/** This is evidence only. The authority owner must verify the current opaque
 * native execution and current request permission before minting any grant. */
export function readWorkSessionChildAssignment(chatId: string, runId: string, ports?: WorkSessionChildReadPorts): WorkSessionChildAssignmentEvidence | null {
  try {
    if (!ports && instance) return instance.readChildAssignment(chatId, runId);
    return childAssignmentEvidence(ports ?? productionChildReadPorts(), chatId, runId);
  } catch (error) {
    if (error instanceof WorkSessionAssignmentError) throw error;
    throw new WorkSessionAssignmentError("work_session_assignment_store_unavailable", error);
  }
}
/** A main turn ending is not completion of work still owned by its children or
 * waiting in its result inbox. This is notification policy only, never a Goal
 * acceptance gate or a reason to keep the model turn alive. */
export function workSessionParentHasPendingChildren(chatId: string, runId: string, ports?: WorkSessionChildReadPorts): boolean {
  const read = ports ?? productionChildReadPorts();
  if (!currentWorkParent(read, chatId, true)) return false;
  const db = read.db();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_session_dispatches'").get()) return false;
  const owner = read.ownerScope();
  // A session the owner stopped (cancel_requested) is not work the parent is still waiting for, however long its run takes to wind down.
  if (db.prepare(`SELECT 1 FROM work_session_dispatches WHERE parent_chat_id=? AND owner_scope=? AND cancel_requested=0
    AND (state IN ('queued','starting','running','waiting_input','uncertain')
      OR (reported_at IS NULL AND (report_error IS NULL OR report_error NOT LIKE '${REPORT_ABANDONED}%'))) LIMIT 1`).get(chatId, owner)) return true;
  return !!db.prepare(`SELECT 1 FROM work_session_dispatches d JOIN invocation_steers s
    ON s.id='owner:work-report:' || d.id || ':' || d.report_revision
    WHERE d.parent_chat_id=? AND d.owner_scope=? AND d.cancel_requested=0
    AND (s.status IN ('queued','draining') OR (s.status='started' AND d.parent_run_id=? AND s.drained_run_id<>?)) LIMIT 1`)
    .get(chatId, owner, runId, runId);
}
export const workSessionDispatchAllowedFor = (chatId: string): boolean => production().allowed(chatId);
export const dispatchWorkSessionTool = (caller: WorkSessionCaller, name: string, input: unknown): Promise<unknown> => production().dispatch(caller, name, input);
export const recoverWorkSessionDispatches = (parentChatId?: string): Promise<void> => production().recover(parentChatId);
export const cancelWorkSessionDispatches = (parentChatId: string): { cancelled: string[] } => production().cancel(parentChatId);
/** Lifecycle stop hooks must not initialize a service or store for unrelated One/Science runs. */
export function stopWorkSessionChatIfLoaded(parentChatId:string):{cancelled:string[]}{try{return instance?.cancel(parentChatId)??{cancelled:[]};}catch(error){console.warn("[work-session] chat stop cleanup deferred",causeCode(error));return {cancelled:[]};}}
export function stopWorkSessionRunIfLoaded(runId:string):{cancelled:string[]}{try{return instance?.cancelRun(runId)??{cancelled:[]};}catch(error){console.warn("[work-session] run stop cleanup deferred",causeCode(error));return {cancelled:[]};}}
