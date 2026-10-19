import { createHash, randomUUID } from "node:crypto";
import type { InvocationSteerRecoveryOutcome, McpInvocationRequest } from "../../shared/types";
import type { InvocationExecutionContext } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { getDb } from "./db";

/** Private queue metadata, never a public invocation/renderer authority DTO. */
export interface QueuedTeamReportCustody {
  schemaVersion: "agentlas.queued-team-report-custody.v1";
  ownerScope: string; serviceIdentity: string; chatId: string;
  dispatchId: string | null; childRunId: string | null; parentRunId: string | null;
  requestDigest: string;
}
export function queuedTeamReportDigest(request: McpInvocationRequest): string {
  return createHash("sha256").update(canonicalQueuedSteerRequest(request)).digest("hex");
}
function reportCustodyJson(value: QueuedTeamReportCustody): string {
  const keys=["schemaVersion","ownerScope","serviceIdentity","chatId","dispatchId","childRunId","parentRunId","requestDigest"];
  if (!value || Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key))
    || value.schemaVersion!=="agentlas.queued-team-report-custody.v1"
    || ![value.ownerScope,value.serviceIdentity,value.requestDigest].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v))
    || ![value.chatId,value.dispatchId,value.childRunId,value.parentRunId].every(v=>v===null || typeof v==="string"&&!!v&&Buffer.byteLength(v)<=512&&!/[\u0000-\u001f]/.test(v))
    || !value.chatId || Boolean(value.dispatchId)!==Boolean(value.childRunId)) throw new Error("invocation_report_custody_invalid");
  return JSON.stringify(Object.fromEntries(keys.map(key=>[key,value[key as keyof QueuedTeamReportCustody]])));
}
export interface DurableQueuedSteer {
  /** Raw presence distinguishes unknown legacy from corrupt/conflicting custody. */
  oneTeamReportCustodyJson?: string;
  oneTeamReportCustody?: QueuedTeamReportCustody;
  id: string;
  chatId: string;
  originalRunId: string;
  promptText: string;
  promptHash: string;
  request: McpInvocationRequest;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: InvocationExecutionContext;
  queuedAt: string;
  drainedRunId?: string;
  status: "queued" | "draining" | "started" | "cancelled" | "failed";
  recoveryState: DurableQueuedSteerRecoveryState;
  recoveryReason?: DurableQueuedSteerRecoveryReason;
  /** Why a cancelled/failed row ended (the same column as recoveryReason, read only on a terminal row). */
  terminalCause?: DurableQueuedSteerTerminalCause;
}

/** A held steer is never dispatched automatically after a restart. */
export type DurableQueuedSteerRecoveryState = "ready" | "held";

/** Content-free, allowlisted reasons safe to expose to a UI/receipt. */
export type DurableQueuedSteerRecoveryReason =
  | "original-run-start-uncertain"
  | "original-run-effect-boundary-unconfirmed"
  | "drained-run-start-uncertain"
  | "drained-run-receipt-missing"
  | "draining-run-id-missing"
  | "one-team-report-owner-unbound";
const RECOVERY_REASONS: readonly DurableQueuedSteerRecoveryReason[] = [
  "original-run-start-uncertain",
  "original-run-effect-boundary-unconfirmed",
  "drained-run-start-uncertain",
  "drained-run-receipt-missing",
  "draining-run-id-missing",
  "one-team-report-owner-unbound",
];

/**




 */
export type DurableQueuedSteerTerminalCause =
  /** The owner pulled it back from the queue strip (unsteer). */
  | "owner-withdrawn"
  /** A host report whose content went stale before it ran (unsteerQueuedById). */
  | "host-report-superseded"
  /** The run it waited behind was stopped; the stop withdraws what was queued behind it. */
  | "run-stopped"
  /** The chat's Goal was paused or deleted. */
  | "goal-stopped"
  /** A held host-written direction whose original run ended without a receipt, closed at restart recovery. */
  | "held-system-retired"
  /** A held owner direction handed back to the owner's composer (returnHeldOwnerSteer). */
  | "held-returned-to-owner"
  /** A waiting Goal refused the system turn and parked the relay (deferred_system_relays); its next turn carries it. */
  | "parked-for-waiting-goal"
  /** The start kept hitting a locked store through the whole bounded retry. */
  | "drain-store-busy-exhausted"
  /** The start was refused with a typed code (logged with the cause). */
  | "drain-start-refused"
  /** The start threw without a typed code. */
  | "drain-start-error"
  /** The stored row could not be decoded. */
  | "row-undecodable"
  /** A JavaScript caller that named no cause (TypeScript callers must). */
  | "unattributed";
const TERMINAL_CAUSES: readonly DurableQueuedSteerTerminalCause[] = [
  "owner-withdrawn", "host-report-superseded", "run-stopped", "goal-stopped", "held-system-retired",
  "held-returned-to-owner", "parked-for-waiting-goal", "drain-store-busy-exhausted", "drain-start-refused",
  "drain-start-error", "row-undecodable", "unattributed",
];
function terminalCause(cause: unknown): DurableQueuedSteerTerminalCause {
  return TERMINAL_CAUSES.includes(cause as DurableQueuedSteerTerminalCause) ? cause as DurableQueuedSteerTerminalCause : "unattributed";
}

type Row = {
  id: string;
  chat_id: string;
  original_run_id: string;
  prompt_text: string;
  prompt_hash: string;
  request_json: string;
  workspace_binding_json: string | null;
  execution_context_json: string | null;
  queued_at: string;
  drained_run_id: string | null;
  status: DurableQueuedSteer["status"];
  one_team_report_custody_json?: string | null;
  recovery_state?: DurableQueuedSteerRecoveryState;
  /** A hold reason on a held row, a terminal cause on a cancelled/failed one. */
  recovery_reason?: string | null;
};

function decode(row: Row): DurableQueuedSteer {
  const recoveryState = row.recovery_state ?? "ready";
  if (recoveryState !== "ready" && recoveryState !== "held") {
    throw new Error("invocation_steer_invalid_recovery_state");
  }
  const storedReason = (row.recovery_reason ?? undefined) as string | undefined;
  const terminal = row.status === "cancelled" || row.status === "failed";
  // A terminal row's column holds its terminal cause (or the hold reason it ended with, for rows written before causes).
  const recoveryReason = storedReason && RECOVERY_REASONS.includes(storedReason as DurableQueuedSteerRecoveryReason)
    ? storedReason as DurableQueuedSteerRecoveryReason : undefined;
  const endedBy = terminal && storedReason && TERMINAL_CAUSES.includes(storedReason as DurableQueuedSteerTerminalCause)
    ? storedReason as DurableQueuedSteerTerminalCause : undefined;
  if (storedReason && !recoveryReason && !endedBy) {
    throw new Error("invocation_steer_invalid_recovery_reason");
  }
  const request = JSON.parse(row.request_json) as McpInvocationRequest;
  const workspaceBinding = row.workspace_binding_json
    ? JSON.parse(row.workspace_binding_json) as InvocationWorkspaceBinding
    : undefined;
  const executionContext = row.execution_context_json
    ? JSON.parse(row.execution_context_json) as InvocationExecutionContext
    : undefined;
  let reportCustody: QueuedTeamReportCustody | undefined;
  if (row.one_team_report_custody_json!==null && row.one_team_report_custody_json!==undefined) {try {const raw=JSON.parse(row.one_team_report_custody_json);reportCustodyJson(raw);reportCustody=raw;} catch { /* Invalid presence is held by the original host; never fallback to legacy. */ }}
  return {
    ...(row.one_team_report_custody_json!==null && row.one_team_report_custody_json!==undefined ? {oneTeamReportCustodyJson:row.one_team_report_custody_json} : {}),
    ...(reportCustody ? {oneTeamReportCustody:reportCustody} : {}),
    id: row.id,
    chatId: row.chat_id,
    originalRunId: row.original_run_id,
    promptText: row.prompt_text,
    promptHash: row.prompt_hash,
    request,
    ...(workspaceBinding ? { workspaceBinding } : {}),
    ...(executionContext ? { executionContext } : {}),
    queuedAt: row.queued_at,
    ...(row.drained_run_id ? { drainedRunId: row.drained_run_id } : {}),
    status: row.status,
    recoveryState,
    ...(recoveryReason ? { recoveryReason } : {}),
    ...(endedBy ? { terminalCause: endedBy } : {}),
  };
}

/** Receipt lookup includes consumed/held rows: a lost ACK never grants a second dispatch. */
export function getDurableQueuedSteer(id: string): DurableQueuedSteer | null {
  const row = getDb().prepare("SELECT * FROM invocation_steers WHERE id = ?").get(id) as Row | undefined;
  return row ? decode(row) : null;
}

/** Object key order is transport detail; array order and every request value remain part of identity. */
export function canonicalQueuedSteerRequest(request: McpInvocationRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
    return value;
  };
  return JSON.stringify(canonical({ ...request, runId: undefined }));
}

export function persistQueuedSteer(input: {
  /** Main-owned idempotency key for a preflight direction, never a renderer run id. */
  id?: string;
  chatId: string;
  originalRunId: string;
  request: McpInvocationRequest;
  oneTeamReportCustody?: QueuedTeamReportCustody;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: InvocationExecutionContext;
}): DurableQueuedSteer {
  const id = input.id ?? randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    throw new Error("invocation_steer_invalid_id");
  }
  const queuedAt = new Date().toISOString();
  const promptText = input.request.userPrompt;
  const promptHash = createHash("sha256").update(promptText, "utf8").digest("hex");
  const requestJson = JSON.stringify(input.request);
  const custodyJson=input.oneTeamReportCustody ? reportCustodyJson(input.oneTeamReportCustody) : null;
  if (custodyJson && (input.request.oneTeamReportTurn!==true || input.oneTeamReportCustody!.chatId!==input.chatId
    || input.oneTeamReportCustody!.requestDigest!==queuedTeamReportDigest(input.request))) throw new Error("invocation_report_custody_invalid");
  const workspaceJson = input.workspaceBinding ? JSON.stringify(input.workspaceBinding) : null;
  const executionJson = input.executionContext ? JSON.stringify(input.executionContext) : null;
  const old = getDb().prepare("SELECT * FROM invocation_steers WHERE id = ?").get(id) as Row | undefined;
  if (old) {
    if (old.chat_id !== input.chatId || old.original_run_id !== input.originalRunId
      || old.prompt_text !== promptText || old.prompt_hash !== promptHash
      || old.request_json !== requestJson || old.workspace_binding_json !== workspaceJson
      || old.execution_context_json !== executionJson || (old.one_team_report_custody_json ?? null)!==custodyJson) throw new Error("invocation_steer_identity_conflict");
    if (old.status !== "queued" && old.status !== "draining") throw new Error("invocation_steer_already_consumed");
    return decode(old);
  }
  getDb().prepare(
    `INSERT INTO invocation_steers
       (id, chat_id, original_run_id, prompt_text, prompt_hash, request_json,
        workspace_binding_json, execution_context_json, status, recovery_state,
        queued_at, updated_at, one_team_report_custody_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'ready', ?, ?, ?)`,
  ).run(
    id,
    input.chatId,
    input.originalRunId,
    promptText,
    promptHash,
    requestJson,
    workspaceJson,
    executionJson,
    queuedAt,
    queuedAt,
    custodyJson,
  );
  return { id, chatId: input.chatId, originalRunId: input.originalRunId, promptText, promptHash,
    request: input.request, ...(input.workspaceBinding ? { workspaceBinding: input.workspaceBinding } : {}),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}), queuedAt,
    recoveryState: "ready", status: "queued", ...(custodyJson ? {oneTeamReportCustodyJson:custodyJson,oneTeamReportCustody:input.oneTeamReportCustody} : {}) };
}

/** Exact receipt check for a claimed preflight handoff after IPC loss. */
export function durableQueuedSteerMatches(input: {
  id: string; chatId: string; originalRunId: string; request: McpInvocationRequest;
}): boolean {
  const row = getDb().prepare(
    "SELECT chat_id, original_run_id, prompt_text, prompt_hash, request_json, " +
      "workspace_binding_json, execution_context_json FROM invocation_steers WHERE id = ?",
  ).get(input.id) as Pick<Row, "chat_id" | "original_run_id" | "prompt_text" | "prompt_hash" |
    "request_json" | "workspace_binding_json" | "execution_context_json"> | undefined;
  return Boolean(row && row.chat_id === input.chatId
    && row.original_run_id === input.originalRunId
    && row.prompt_text === input.request.userPrompt
    && row.prompt_hash === createHash("sha256").update(input.request.userPrompt, "utf8").digest("hex")
    && row.request_json === JSON.stringify(input.request)
    && row.workspace_binding_json === null && row.execution_context_json === null);
}

export function listRecoverableQueuedSteers(chatId?: string): DurableQueuedSteer[] {
  const rows = getDb().prepare(
    "SELECT * FROM invocation_steers WHERE status IN ('queued','draining') " +
    (chatId !== undefined ? "AND chat_id = ? " : "") + "ORDER BY rowid",
  ).all(...(chatId !== undefined ? [chatId] : [])) as Row[];
  const out: DurableQueuedSteer[] = [];
  for (const row of rows) {
    try { out.push(decode(row)); } catch {
      getDb().transaction(() => {
        getDb().prepare("UPDATE invocation_steers SET status = 'failed', recovery_reason = ?, updated_at = ? WHERE id = ?")
          .run("row-undecodable" satisfies DurableQueuedSteerTerminalCause, new Date().toISOString(), row.id);
        revertTeamReportLedger(row, "row-undecodable");
      })();
    }
  }
  // After a restart an owner turn waits ahead of host-written (system) turns, as in the live queue (service.ts
  // enqueueSteer); each kind keeps its rowid order.
  return [...out.filter((row) => row.request?.promptOrigin !== "system"), ...out.filter((row) => row.request?.promptOrigin === "system")];
}

/**
 * A direction the owner wrote is waiting behind this chat's run. Host-written turns (a teammate finished, a Goal
 * check) carry promptOrigin "system" and do not count.
 */
export function hasQueuedOwnerSteer(chatId: string): boolean {
  const rows = getDb().prepare(
    "SELECT request_json FROM invocation_steers WHERE chat_id = ? AND status = 'queued' AND recovery_state = 'ready'",
  ).all(chatId) as Array<{ request_json: string }>;
  return rows.some((row) => {
    try { return (JSON.parse(row.request_json) as { promptOrigin?: unknown })?.promptOrigin !== "system"; } catch { return false; }
  });
}

/** The current original host guard runs inside the same canonical queue CAS. */
export function beginQueuedSteerDrain(id: string, drainedRunId: string, reportGuard?: (row: DurableQueuedSteer) => boolean): boolean {
  const db=getDb();return db.transaction(()=>{
    const raw=db.prepare("SELECT * FROM invocation_steers WHERE id=? AND status IN ('queued','draining') AND recovery_state='ready'").get(id) as Row|undefined;
    if(!raw)return false;const row=decode(raw);
    if(row.drainedRunId && row.drainedRunId!==drainedRunId)return false;
    if(row.request.oneTeamReportTurn===true && (!reportGuard || !reportGuard(row))){holdQueuedSteerForRecovery(id,"one-team-report-owner-unbound");return false;}
    return db.prepare(`UPDATE invocation_steers SET status='draining',drained_run_id=?,updated_at=?
      WHERE id=? AND status IN ('queued','draining') AND recovery_state='ready'`).run(drainedRunId,new Date().toISOString(),id).changes===1;
  })();
}
/** Seal unknown legacy only after actual host proof; known custody never changes. */
export function bindQueuedTeamReportCustody(id:string,custody:QueuedTeamReportCustody):boolean {
  const db=getDb();return db.transaction(()=>{
    const row=getDurableQueuedSteer(id);if(!row || row.request.oneTeamReportTurn!==true || row.oneTeamReportCustodyJson!==undefined
      || row.chatId!==custody.chatId || queuedTeamReportDigest(row.request)!==custody.requestDigest)return false;
    return db.prepare("UPDATE invocation_steers SET one_team_report_custody_json=?,updated_at=? WHERE id=? AND one_team_report_custody_json IS NULL AND status IN ('queued','draining')")
      .run(reportCustodyJson(custody),new Date().toISOString(),id).changes===1;
  })();
}

/** Where a queued direction stands: still waiting, delivered into a run ("started"), withdrawn or failed. */
export function queuedSteerState(id: string): { status: DurableQueuedSteer["status"]; drainedRunId: string | null; recoveryReason: string | null } | null {
  const row = getDb().prepare("SELECT status, drained_run_id, recovery_reason FROM invocation_steers WHERE id = ?").get(id) as
    { status: DurableQueuedSteer["status"]; drained_run_id: string | null; recovery_reason: string | null } | undefined;
  return row ? { status: row.status, drainedRunId: row.drained_run_id, recoveryReason: row.recovery_reason } : null;
}

/** The columns the teammate-report ledger revert reads, taken before the settling UPDATE overwrites recovery_reason. */
type ReportLedgerRow = Pick<Row, "id" | "queued_at" | "request_json" | "one_team_report_custody_json" | "recovery_reason">;
const REPORT_LEDGER_COLUMNS = "id, queued_at, request_json, one_team_report_custody_json, recovery_reason";
/** Causes that are the owner withdrawing the queued work (a stop, a Goal pause or delete): the report is not carried again. */
const OWNER_STOP_CAUSES: ReadonlySet<DurableQueuedSteerTerminalCause> = new Set(["run-stopped", "goal-stopped", "owner-withdrawn"]);
/**
 * Causes that are not a lost report: the waiting Goal parked it (its next turn carries it), a newer report of the same
 * session replaced it (that path writes the ledger itself), or an owner text handed back (never a report).
 */
const REPORT_DELIVERED_CAUSES: ReadonlySet<DurableQueuedSteerTerminalCause> = new Set(["parked-for-waiting-goal", "host-report-superseded", "held-returned-to-owner"]);

/**







 */
function revertTeamReportLedger(row: ReportLedgerRow | undefined, cause: DurableQueuedSteerTerminalCause): void {
  if (!row || REPORT_DELIVERED_CAUSES.has(cause)) return;
  let report = false;
  try { report = (JSON.parse(row.request_json) as { oneTeamReportTurn?: unknown })?.oneTeamReportTurn === true; }
  catch { report = row.one_team_report_custody_json !== null && row.one_team_report_custody_json !== undefined; }
  if (!report) return;
  let custody: { dispatchId?: unknown; childRunId?: unknown } | null = null;
  try { custody = row.one_team_report_custody_json ? JSON.parse(row.one_team_report_custody_json) as { dispatchId?: unknown; childRunId?: unknown } : null; }
  catch { custody = null; }
  const ownerStopped = OWNER_STOP_CAUSES.has(cause);
  // A report turn the restart held after its run may have started is never sent twice; the ledger still says why.
  const mayHaveRun = cause === "held-system-retired" && /^drain(?:ed|ing)-/.test(row.recovery_reason ?? "");
  try {
    const { revertQueuedOneTeamReport } = require("../one/team-dispatch") as typeof import("../one/team-dispatch");
    revertQueuedOneTeamReport({
      steerId: row.id,
      dispatchId: typeof custody?.dispatchId === "string" ? custody.dispatchId : null,
      childRunId: typeof custody?.childRunId === "string" ? custody.childRunId : null,
      queuedAt: row.queued_at,
      cause,
      ownerStopped,
      retry: !ownerStopped && !mayHaveRun,
    });
  } catch (error) {
    console.warn(`[invocation] teammate report ledger not reverted steer=${row.id} cause=${cause} code=${
      String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 80)}`);
  }
}

/** Delivery ("started") keeps the row's column; every cancelled/failed transition writes its cause in the same UPDATE. */
export function settleQueuedSteer(id: string, status: "started"): boolean;
export function settleQueuedSteer(id: string, status: "cancelled" | "failed", cause: DurableQueuedSteerTerminalCause): boolean;
export function settleQueuedSteer(id: string, status: "started" | "cancelled" | "failed", cause?: DurableQueuedSteerTerminalCause): boolean {
  const now = new Date().toISOString();
  // A trusted terminal withdrawal must win even when recovery is held.
  // Delivery/failure still requires the existing ready-state decision.
  const ready = status === "cancelled" ? "" : " AND recovery_state = 'ready'";
  if (status === "started") {
    return getDb().prepare(
      "UPDATE invocation_steers SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','draining')" + ready,
    ).run(status, now, id).changes === 1;
  }
  const db = getDb();
  return db.transaction(() => {
    const before = db.prepare(`SELECT ${REPORT_LEDGER_COLUMNS} FROM invocation_steers WHERE id = ?`).get(id) as ReportLedgerRow | undefined;
    const settled = db.prepare(
      "UPDATE invocation_steers SET status = ?, recovery_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued','draining')" + ready,
    ).run(status, terminalCause(cause), now, id).changes === 1;
    if (settled) revertTeamReportLedger(before, terminalCause(cause));
    return settled;
  }).immediate();
}

export function cancelQueuedSteersForChat(chatId: string, preserveTeamReports: boolean, cause: DurableQueuedSteerTerminalCause): void {
  const preserve = preserveTeamReports ? " AND CASE WHEN json_valid(request_json) THEN COALESCE(json_type(request_json,'$.oneTeamReportTurn'),'')<>'true' ELSE 1 END" : "";
  const db = getDb();
  db.transaction(() => {
    const rows = db.prepare(`SELECT ${REPORT_LEDGER_COLUMNS} FROM invocation_steers WHERE chat_id = ? AND status = 'queued'${preserve} ORDER BY rowid`)
      .all(chatId) as ReportLedgerRow[];
    db.prepare(
      "UPDATE invocation_steers SET status = 'cancelled', recovery_reason = ?, updated_at = ? WHERE chat_id = ? AND status = 'queued'" + preserve,
    ).run(terminalCause(cause), new Date().toISOString(), chatId);
    for (const row of rows) revertTeamReportLedger(row, terminalCause(cause));
  }).immediate();
}

/**
 * A start that a locked store refused before anything was dispatched, after its drain claim had recorded the planned
 * run (invoke_started, then the undispatched failure): that run id is spent. Put the row back in the queue with no run
 * id so the retry starts a new run; only the exact draining claim is reopened.
 */
export function requeueUndispatchedQueuedSteer(id: string, spentRunId: string): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers SET status = 'queued', drained_run_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'draining' AND drained_run_id = ? AND recovery_state = 'ready'`,
  ).run(new Date().toISOString(), id, spentRunId).changes === 1;
}

/**
 * Mark a queued/draining direction as requiring an explicit user/trusted-route
 * decision. This is the restart boundary: no provider call is made here and a
 * held row cannot pass the normal drain CAS until it is explicitly released.
 */
export function holdQueuedSteerForRecovery(
  id: string,
  reason: DurableQueuedSteerRecoveryReason,
): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers
        SET recovery_state = 'held', recovery_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'ready'`,
  ).run(reason, new Date().toISOString(), id).changes === 1;
}

/**
 * Close a held direction that is not going to be dispatched: a host-written one whose original run ended without a
 * receipt ("held-system-retired"), or an owner-written one handed back to the owner ("held-returned-to-owner").
 */
export function retireHeldQueuedSteer(id: string, cause: "held-system-retired" | "held-returned-to-owner"): boolean {
  const db = getDb();
  return db.transaction(() => {
    const before = db.prepare(`SELECT ${REPORT_LEDGER_COLUMNS} FROM invocation_steers WHERE id = ?`).get(id) as ReportLedgerRow | undefined;
    const retired = db.prepare(
      `UPDATE invocation_steers SET status = 'cancelled', recovery_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'held'`,
    ).run(terminalCause(cause), new Date().toISOString(), id).changes === 1;
    if (retired) revertTeamReportLedger(before, terminalCause(cause));
    return retired;
  }).immediate();
}

/** What handing a held direction back to its owner did. `promptText` is present for "returned" / "already-returned". */
export type HeldOwnerSteerReturn = InvocationSteerRecoveryOutcome;

/**






 */
export function returnHeldOwnerSteer(id: string, expectedChatId?: string): HeldOwnerSteerReturn {
  const db = getDb();
  return db.transaction((): HeldOwnerSteerReturn => {
    const raw = db.prepare("SELECT * FROM invocation_steers WHERE id = ?").get(id) as Row | undefined;
    if (!raw) return { status: "refused", code: "steer_recovery_not_found" };
    if (expectedChatId !== undefined && raw.chat_id !== expectedChatId) return { status: "refused", code: "steer_recovery_chat_mismatch" };
    let request: Partial<McpInvocationRequest> | null = null;
    try { request = JSON.parse(raw.request_json) as Partial<McpInvocationRequest>; } catch { request = null; }
    if (!request || request.promptOrigin === "system" || request.oneTeamReportTurn === true || request.agentAppMode === true) {
      return { status: "refused", code: "steer_recovery_not_owner_text" };
    }
    if (raw.status === "cancelled" && raw.recovery_reason === "held-returned-to-owner") {
      return { status: "already-returned", chatId: raw.chat_id, promptText: raw.prompt_text };
    }
    if (!retireHeldQueuedSteer(id, "held-returned-to-owner")) return { status: "refused", code: "steer_recovery_not_held" };
    return { status: "returned", chatId: raw.chat_id, promptText: raw.prompt_text };
  }).immediate();
}

/** Explicit recovery route hook; callers must make the replay decision first. */
export function releaseQueuedSteerRecoveryHold(id: string, expectedReason?: DurableQueuedSteerRecoveryReason): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers
        SET recovery_state = 'ready', recovery_reason = NULL, status = 'queued',
            drained_run_id = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'held'
        ${expectedReason ? "AND recovery_reason = ? AND status = 'queued' AND drained_run_id IS NULL" : ""}`,
  ).run(new Date().toISOString(), id, ...(expectedReason ? [expectedReason] : [])).changes === 1;
}
