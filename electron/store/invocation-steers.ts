import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import type { InvocationExecutionContext } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { getDb } from "./db";

export interface DurableQueuedSteer {
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
  | "draining-run-id-missing";

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
  return {
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

export function persistQueuedSteer(input: {
  /** Main-owned idempotency key for a preflight direction, never a renderer run id. */
  id?: string;
  chatId: string;
  originalRunId: string;
  request: McpInvocationRequest;
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
  const workspaceJson = input.workspaceBinding ? JSON.stringify(input.workspaceBinding) : null;
  const executionJson = input.executionContext ? JSON.stringify(input.executionContext) : null;
  const old = getDb().prepare("SELECT * FROM invocation_steers WHERE id = ?").get(id) as Row | undefined;
  if (old) {
    if (old.chat_id !== input.chatId || old.original_run_id !== input.originalRunId
      || old.prompt_text !== promptText || old.prompt_hash !== promptHash
      || old.request_json !== requestJson || old.workspace_binding_json !== workspaceJson
      || old.execution_context_json !== executionJson) throw new Error("invocation_steer_identity_conflict");
    if (old.status !== "queued" && old.status !== "draining") throw new Error("invocation_steer_already_consumed");
    return decode(old);
  }
  getDb().prepare(
    `INSERT INTO invocation_steers
       (id, chat_id, original_run_id, prompt_text, prompt_hash, request_json,
        workspace_binding_json, execution_context_json, status, recovery_state,
        queued_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'ready', ?, ?)`,
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
  );
  return { id, chatId: input.chatId, originalRunId: input.originalRunId, promptText, promptHash,
    request: input.request, ...(input.workspaceBinding ? { workspaceBinding: input.workspaceBinding } : {}),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}), queuedAt,
    recoveryState: "ready", status: "queued" };
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

export function listRecoverableQueuedSteers(): DurableQueuedSteer[] {
  const rows = getDb().prepare(
    `SELECT * FROM invocation_steers WHERE status IN ('queued','draining') ORDER BY queued_at, id`,
  ).all() as Row[];
  const out: DurableQueuedSteer[] = [];
  for (const row of rows) {
    try { out.push(decode(row)); } catch {
      getDb().prepare("UPDATE invocation_steers SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
    }
  }
  return out;
}

export function beginQueuedSteerDrain(id: string, drainedRunId: string): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers SET status = 'draining', drained_run_id = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'ready'`,
  ).run(drainedRunId, new Date().toISOString(), id).changes === 1;
}

export function settleQueuedSteer(id: string, status: "started" | "cancelled" | "failed"): boolean {
  return getDb().prepare(
    "UPDATE invocation_steers SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'ready'",
  ).run(status, new Date().toISOString(), id).changes === 1;
}

export function cancelQueuedSteersForChat(chatId: string): void {
  getDb().prepare(
    "UPDATE invocation_steers SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status = 'queued'",
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

/** Explicit recovery route hook; callers must make the replay decision first. */
export function releaseQueuedSteerRecoveryHold(id: string): boolean {
  return getDb().prepare(
    `UPDATE invocation_steers
        SET recovery_state = 'ready', recovery_reason = NULL, status = 'queued',
            drained_run_id = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued','draining') AND recovery_state = 'held'`,
  ).run(new Date().toISOString(), id).changes === 1;
}
