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
};

function decode(row: Row): DurableQueuedSteer {
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
  };
}

export function persistQueuedSteer(input: {
  chatId: string;
  originalRunId: string;
  request: McpInvocationRequest;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: InvocationExecutionContext;
}): DurableQueuedSteer {
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  const promptText = input.request.userPrompt;
  const promptHash = createHash("sha256").update(promptText, "utf8").digest("hex");
  getDb().prepare(
    `INSERT INTO invocation_steers
       (id, chat_id, original_run_id, prompt_text, prompt_hash, request_json,
        workspace_binding_json, execution_context_json, status, queued_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    id,
    input.chatId,
    input.originalRunId,
    promptText,
    promptHash,
    JSON.stringify(input.request),
    input.workspaceBinding ? JSON.stringify(input.workspaceBinding) : null,
    input.executionContext ? JSON.stringify(input.executionContext) : null,
    queuedAt,
    queuedAt,
  );
  return { id, chatId: input.chatId, originalRunId: input.originalRunId, promptText, promptHash,
    request: input.request, ...(input.workspaceBinding ? { workspaceBinding: input.workspaceBinding } : {}),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}), queuedAt };
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
     WHERE id = ? AND status IN ('queued','draining')`,
  ).run(drainedRunId, new Date().toISOString(), id).changes === 1;
}

export function settleQueuedSteer(id: string, status: "started" | "cancelled" | "failed"): void {
  getDb().prepare("UPDATE invocation_steers SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
}

export function cancelQueuedSteersForChat(chatId: string): void {
  getDb().prepare(
    "UPDATE invocation_steers SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status = 'queued'",
  ).run(new Date().toISOString(), chatId);
}
