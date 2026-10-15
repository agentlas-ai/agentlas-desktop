import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
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
  recovery_reason?: DurableQueuedSteerRecoveryReason | null;
};

function decode(row: Row): DurableQueuedSteer {
  const recoveryState = row.recovery_state ?? "ready";
  if (recoveryState !== "ready" && recoveryState !== "held") {
    throw new Error("invocation_steer_invalid_recovery_state");
  }
  const recoveryReason = row.recovery_reason ?? undefined;
  if (recoveryReason && ![
    "original-run-start-uncertain",
    "original-run-effect-boundary-unconfirmed",
    "drained-run-start-uncertain",
    "drained-run-receipt-missing",
    "draining-run-id-missing",
    "one-team-report-owner-unbound",
  ].includes(recoveryReason)) {
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
      getDb().prepare("UPDATE invocation_steers SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
    }
  }
  return out;
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
export function queuedSteerState(id: string): { status: DurableQueuedSteer["status"]; drainedRunId: string | null } | null {
  const row = getDb().prepare("SELECT status, drained_run_id FROM invocation_steers WHERE id = ?").get(id) as
    { status: DurableQueuedSteer["status"]; drained_run_id: string | null } | undefined;
  return row ? { status: row.status, drainedRunId: row.drained_run_id } : null;
}

export function settleQueuedSteer(id: string, status: "started" | "cancelled" | "failed"): boolean {
  return getDb().prepare(
    // A trusted terminal withdrawal must win even when recovery is held.
    // Delivery/failure still requires the existing ready-state decision.
    "UPDATE invocation_steers SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','draining')"
      + (status === "cancelled" ? "" : " AND recovery_state = 'ready'"),
  ).run(status, new Date().toISOString(), id).changes === 1;
}

export function cancelQueuedSteersForChat(chatId: string, preserveTeamReports = false): void {
  getDb().prepare(
    "UPDATE invocation_steers SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status = 'queued'"
      + (preserveTeamReports ? " AND CASE WHEN json_valid(request_json) THEN COALESCE(json_type(request_json,'$.oneTeamReportTurn'),'')<>'true' ELSE 1 END" : ""),
  ).run(new Date().toISOString(), chatId);
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

/** Close a held host-written direction that can no longer be delivered (its original run ended without a receipt). */
export function retireHeldQueuedSteer(id: string): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'held'`,
  ).run(new Date().toISOString(), id).changes === 1;
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
