import path from "node:path";
import { getDb } from "../store/db";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { revalidateInvocationWorkspaceBinding, type InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { resolveMainOwnedReadPath, FsAccessDeniedError } from "./access";

const PREFIX = "invocation-artifact-workspace:";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
interface WorkspaceCustody {
  v: 1; chatId: string; runId: string; agentId: string; ownerScope: string; startedEventId: string;
  createdAt: string; expiresAt: string; binding: InvocationWorkspaceBinding;
}
function startFor(chatId: string, runId: string) {
  const rows = getDb().prepare("SELECT id,chat_id,agent_id,payload_json,ts AS created_at FROM run_events WHERE run_id=? AND kind='invoke_started'")
    .all(runId) as Array<{id:string;chat_id:string;agent_id:string|null;payload_json:string;created_at:string}>;
  if (rows.length !== 1 || rows[0].chat_id !== chatId || !rows[0].agent_id) throw new FsAccessDeniedError("Invocation workspace has no exact durable start.");
  return rows[0];
}
function assertCurrent(custody: WorkspaceCustody): string {
  if (custody.v !== 1 || !custody.chatId || !custody.runId || !custody.agentId || !custody.startedEventId
    || custody.ownerScope !== agentContextOwnerBinding().ownerScope || !custody.binding
    || !Number.isFinite(Date.parse(custody.expiresAt)) || Date.parse(custody.expiresAt) <= Date.now()
    || Date.parse(custody.expiresAt) !== Date.parse(custody.createdAt) + RETENTION_MS) throw new FsAccessDeniedError();
  const start = startFor(custody.chatId,custody.runId);
  const chat = getDb().prepare("SELECT agent_id,archived_at FROM chats WHERE id=?").get(custody.chatId) as {agent_id:string;archived_at:string|null}|undefined;
  if (!chat || chat.archived_at || chat.agent_id !== custody.agentId || start.id !== custody.startedEventId
    || start.agent_id !== custody.agentId || start.created_at !== custody.createdAt
    || JSON.parse(start.payload_json).invocationSource !== custody.binding.source) throw new FsAccessDeniedError();
  const root = revalidateInvocationWorkspaceBinding(custody.binding);
  if (!root || !path.isAbsolute(root)) throw new FsAccessDeniedError();
  return root;
}
/** Called only by the shared invocation host after its durable start, with the
 * exact immutable workspace it admitted. No provider result path grants roots. */
export function recordInvocationArtifactWorkspace(input: {chatId:string;runId:string;binding:InvocationWorkspaceBinding}): void {
  if (!input.binding.canonicalPath) return;
  const start = startFor(input.chatId,input.runId), startedAt = Date.parse(start.created_at);
  if (!Number.isFinite(startedAt)) throw new FsAccessDeniedError();
  const custody: WorkspaceCustody = {v:1,chatId:input.chatId,runId:input.runId,agentId:start.agent_id!,
    ownerScope:agentContextOwnerBinding().ownerScope,startedEventId:start.id,createdAt:start.created_at,
    expiresAt:new Date(startedAt + RETENTION_MS).toISOString(),binding:structuredClone(input.binding)};
  assertCurrent(custody);
  const key = PREFIX + input.runId, value = JSON.stringify(custody), db = getDb();
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key,value);
  if ((db.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}|undefined)?.value !== value) throw new FsAccessDeniedError("Invocation workspace custody changed.");
}
/** Exact-run fallback for the common artifact binder and retained reopen path.
 * Existing chat/generated roots remain the ordinary first path. */
export function resolveInvocationArtifactReadPath(file: string, input: {chatId:string;runId:string}): string {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(PREFIX + input.runId) as {value:string}|undefined;
  if (!row) throw new FsAccessDeniedError();
  let custody: WorkspaceCustody;
  try { custody = JSON.parse(row.value); } catch { throw new FsAccessDeniedError(); }
  if (!custody || custody.chatId !== input.chatId || custody.runId !== input.runId) throw new FsAccessDeniedError();
  return resolveMainOwnedReadPath(file,assertCurrent(custody));
}
