import path from "node:path";
import { isWorkAttachmentInput } from "../invocation/work-attachments";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { observeWorkspaceFile, type FileObservation, type FileObservationAction } from "../../shared/file-observation";
import { getDb } from "../store/db";
import { getChatWorkingFolder } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunAttemptGoalRevision } from "../store/long-runs";
import { recordRunEvent } from "../store/run-events";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

interface Scope {
  runId: string; chatId: string; agentId: string | null; signal: AbortSignal;
  readOwner: () => { goalId: string; attemptId: string | null } | null;
}
const contexts = new AsyncLocalStorage<Scope>();
export function withBuiltinFileProofContext<T>(scope: Scope, action: () => T): T { return contexts.run(scope, action); }
const schemaVersion = "agentlas.builtin-file-proof.v1";
const actionForTool: Record<string, FileObservationAction> = { read_file: "read", write_file: "write", edit_file: "edit" };
interface Event { id: string; seq: number; kind: string; payload_json: string }
function toolReceipts(runId: string, chatId: string, toolId: string, toolName: string) {
  const rows = getDb().prepare("SELECT id,seq,kind,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='mcp_tool-use' AND json_extract(payload_json,'$.toolId')=? ORDER BY seq")
    .all(runId, chatId, toolId) as Event[];
  if (rows.length !== 2) return null;
  const [start, result] = rows.map(row => JSON.parse(row.payload_json));
  return start.toolName === toolName && result.toolName === toolName && typeof start.toolResultPreview !== "string"
    && typeof result.toolResultPreview === "string" && result.toolIsError === false ? rows : null;
}
function boundOwner(goalId: string, attemptId: string, runId: string, chatId: string) {
  const run = getLongRunByGoalId(goalId), goal = getChatGoalRevision(goalId);
  if (!run || !goal || run.rootChatId !== chatId || goal.chatId !== chatId || !["running", "verifying"].includes(run.status)) return null;
  const attempt = getDb().prepare(`SELECT a.id,w.workspace_binding_json,w.permission_profile FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id=a.worker_id WHERE a.id=? AND a.run_id=? AND a.invocation_run_id=? AND w.role='controller'`)
    .get(attemptId, run.id, runId) as {id:string;workspace_binding_json:string;permission_profile:string}|undefined;
  if (!attempt || getLongRunAttemptGoalRevision(run.id, attempt.id) !== goal.revision) return null;
  const cwd = JSON.parse(attempt.workspace_binding_json).cwd;
  if (!cwd || !getChatWorkingFolder(chatId)) return null;
  const root = fs.realpathSync(cwd);
  if (root !== fs.realpathSync(getChatWorkingFolder(chatId)!)) return null;
  return { root, goalRevision: goal.revision, permission: attempt.permission_profile };
}

/** Called exclusively inside the resolved builtin branch, after approval and
 * before executing it. Ordinary MCP/CLI output cannot enter this producer. */
export function beginBuiltinFileProof(input: {chatId?:string;agentId?:string;cwd?:string;permission?:string;toolId?:string;toolName:string;builtinName:string}) {
  const scope = contexts.getStore(), action = actionForTool[input.builtinName];
  if (!scope || scope.signal.aborted || !action || input.chatId !== scope.chatId || !scope.agentId || input.agentId !== scope.agentId
    || !input.toolId || input.toolId.length > 700 || input.toolName.length > 700) return null;
  try {
    const owner = scope.readOwner();
    if (!owner?.attemptId) return null;
    const bound = boundOwner(owner.goalId, owner.attemptId, scope.runId, scope.chatId);
    if (!bound || !input.cwd || fs.realpathSync(input.cwd) !== bound.root || input.permission !== bound.permission
      || (action !== "read" && !["write", "full"].includes(bound.permission))) return null;
    let completed = false;
    return { complete(observation: FileObservation) {
      if (completed) return; completed = true;
      if (scope.signal.aborted || observation.action !== action || observation.root !== bound.root) return;
      const current = boundOwner(owner.goalId, owner.attemptId!, scope.runId, scope.chatId);
      if (!current || current.root !== bound.root || current.goalRevision !== bound.goalRevision) return;
      try { if (isWorkAttachmentInput(scope.runId, scope.chatId, bound.root, path.resolve(bound.root, observation.relativePath))) return; }
      catch { return; } // A replaced Main input is uncertain, never a new output proof.
      const rows = toolReceipts(scope.runId, scope.chatId, input.toolId!, input.toolName);
      if (!rows || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_cancelled','invoke_interrupted') LIMIT 1").get(scope.runId)) return;
      recordRunEvent({runId:scope.runId,chatId:scope.chatId,kind:"runtime_file_observed",sourceEventId:`builtin-file:${rows[1].id}`,
        payload:{schemaVersion,...observation,goalId:owner.goalId,goalRevision:bound.goalRevision,attemptId:owner.attemptId,
          toolId:input.toolId,toolName:input.toolName,builtinName:input.builtinName,startEventId:rows[0].id,resultEventId:rows[1].id}});
    } };
  } catch { return null; }
}

export interface CurrentFileProof { ref: string; relativePath: string; action: FileObservationAction; sha256: string; bytes: number }
/** Revalidate exact canonical producer receipts and current scoped bytes. It
 * never opens a path mentioned by a model, generic tool JSON, or other run. */
export function currentBuiltinFileProofs(input: {goalId:string;invocationRunId:string;goalRevision:number}): CurrentFileProof[] {
  const goal = getChatGoalRevision(input.goalId);
  if (!goal || goal.revision !== input.goalRevision) return [];
  const effect = readInvocationEffectBoundary({invocationRunId:input.invocationRunId,expectedChatId:goal.chatId});
  if (!effect.terminal || effect.effects !== "settled") return [];
  const terminal = getDb().prepare("SELECT seq FROM run_events WHERE id=? AND run_id=?").get(effect.terminalEventId,input.invocationRunId) as {seq:number}|undefined;
  if (!terminal) return [];
  const rows = getDb().prepare("SELECT id,seq,kind,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='runtime_file_observed' ORDER BY seq DESC LIMIT 65")
    .all(input.invocationRunId,goal.chatId) as Event[];
  if (rows.length > 64) return [];
  // Keep synchronous verifier IO bounded across the whole evidence packet.
  let totalBytes = 0;
  for (const row of rows) {
    try {
      const size = JSON.parse(row.payload_json).bytes;
      if (!Number.isSafeInteger(size) || size < 0) return [];
      totalBytes += size;
    } catch { return []; }
  }
  if (totalBytes > 64 * 1024 * 1024) return [];
  const proofs: CurrentFileProof[] = [];
  for (const row of rows) try {
    const data = JSON.parse(row.payload_json);
    if (row.seq >= terminal.seq) continue;
    if (data.schemaVersion !== schemaVersion || data.goalId !== input.goalId || data.goalRevision !== input.goalRevision
      || actionForTool[data.builtinName] !== data.action || typeof data.attemptId !== "string") continue;
    const correlation = decodeRuntimeEvidence(data.runtimeEvidence)?.correlation;
    if (correlation?.invocationRunId !== input.invocationRunId || correlation.goalId !== input.goalId
      || correlation.goalRevision !== input.goalRevision || correlation.attemptId !== data.attemptId) continue;
    const bound = boundOwner(input.goalId,data.attemptId,input.invocationRunId,goal.chatId);
    if (!bound || data.root !== bound.root || (data.action !== "read" && !["write","full"].includes(bound.permission))) continue;
    const tools = toolReceipts(input.invocationRunId,goal.chatId,data.toolId,data.toolName);
    if (!tools || tools[0].id !== data.startEventId || tools[1].id !== data.resultEventId || tools[1].seq >= row.seq) continue;
    const current = observeWorkspaceFile(bound.root,data.relativePath,data.action);
    if (!current || current.sha256 !== data.sha256 || current.bytes !== data.bytes) continue;
    proofs.push({ref:`file-proof:${row.id}`,relativePath:current.relativePath,action:current.action,sha256:current.sha256,bytes:current.bytes});
  } catch { /* Malformed, moved or missing files cannot become proof. */ }
  return proofs;
}
