import path from "node:path";
import { isWorkAttachmentInput } from "../invocation/work-attachments";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { FILE_OBSERVATION_MAX_BYTES, observeWorkspaceFile, type FileObservation, type FileObservationAction } from "../../shared/file-observation";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getProject } from "../store/projects";
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
const nativeSchemaVersion = "agentlas.native-file-proof.v1";
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
function declaredWorkspace(chatId: string): string | null {
  const explicit = getChatWorkingFolder(chatId);
  if (explicit) return explicit;
  const projectId = getChat(chatId)?.projectId;
  return projectId ? getProject(projectId)?.folderPath ?? null : null;
}
function boundOwner(goalId: string, attemptId: string, runId: string, chatId: string) {
  const run = getLongRunByGoalId(goalId), goal = getChatGoalRevision(goalId);
  if (!run || !goal || run.rootChatId !== chatId || goal.chatId !== chatId || !["running", "verifying"].includes(run.status)) return null;
  const attempt = getDb().prepare(`SELECT a.id,w.workspace_binding_json,w.permission_profile FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id=a.worker_id WHERE a.id=? AND a.run_id=? AND a.invocation_run_id=? AND w.role='controller'`)
    .get(attemptId, run.id, runId) as {id:string;workspace_binding_json:string;permission_profile:string}|undefined;
  if (!attempt || getLongRunAttemptGoalRevision(run.id, attempt.id) !== goal.revision) return null;
  const cwd = JSON.parse(attempt.workspace_binding_json).cwd;
  // Same folder order the executor froze for the controller: saved chat folder, then the chat's Project
  // folder. Reading only the chat folder meant a Project Work Goal could never record a file proof, so
  // every file criterion came back inconclusive ("allowlist has no host refs") even for a byte-exact
  // file (isolated live run 2026-09-24: 0 runtime_file_observed rows, verification_inconclusive_retry:N).
  const declared = declaredWorkspace(chatId);
  if (!cwd || !declared) return null;
  const root = fs.realpathSync(cwd);
  if (root !== fs.realpathSync(declared)) return null;
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

function nativeActionAllowed(kind: string, toolName: string, action: FileObservationAction): boolean {
  if (!["read", "write", "edit"].includes(action)) return false;
  return kind === "claude-code"
    ? ({ Read: "read", Write: "write", Edit: "edit" } as Record<string, string>)[toolName] === action
    : kind === "codex" && toolName === "apply_patch" && (action === "write" || action === "edit");
}

function nativeRuntimeBound(attemptId: string, runId: string, runtimeKind: string): boolean {
  const row = getDb().prepare(`SELECT runtime_selection_json FROM long_run_worker_attempts
    WHERE id=? AND invocation_run_id=?`).get(attemptId, runId) as {runtime_selection_json:string}|undefined;
  if (!row) return false;
  const selection = JSON.parse(row.runtime_selection_json);
  const binding = selection.desktopRuntimeBinding;
  if (selection.kind !== runtimeKind || binding?.kind !== runtimeKind || typeof binding.source !== "string" || !binding.source) return false;
  const receipts = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND kind='runtime_selection'
    AND json_extract(payload_json,'$.runtimeRole')='orchestrator'`).all(runId) as {payload_json:string}[];
  return receipts.length > 0 && receipts.every((receipt) => {
    const payload = JSON.parse(receipt.payload_json);
    return payload.runtimeKind === runtimeKind && payload.runtimeSource === binding.source;
  });
}

/** Only the native CLI adapters call this, at an actual structured tool start.
 * Candidates are authorized before observation. Neither stdout paths, generic
 * MCP results, completion-only events nor model-provided hashes are admitted. */
export function beginNativeFileProof(input: {
  runtimeKind: "claude-code" | "codex"; chatId?: string; cwd?: string; permission?: string;
  toolId: string; toolName: string; filePath: string; action: FileObservationAction; expectedText?: string;
}) {
  const scope = contexts.getStore();
  if (!scope || scope.signal.aborted || input.chatId !== scope.chatId || !input.toolId || input.toolId.length > 700
    || !nativeActionAllowed(input.runtimeKind, input.toolName, input.action)
    || !input.filePath || input.filePath.length > 700 || input.filePath.includes("\0")) return null;
  try {
    const owner = scope.readOwner();
    if (!owner?.attemptId) return null;
    const bound = boundOwner(owner.goalId, owner.attemptId, scope.runId, scope.chatId);
    if (!bound || !input.cwd || fs.realpathSync(input.cwd) !== bound.root || input.permission !== bound.permission
      || (input.action !== "read" && !["write", "full"].includes(bound.permission))
      || !nativeRuntimeBound(owner.attemptId, scope.runId, input.runtimeKind)) return null;
    const target = path.resolve(bound.root, input.filePath);
    const relativePath = path.relative(bound.root, target);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]+/).some(part => part === "..")) return null;
    // Refuse symlinks and non-directory parents even when the output does not
    // exist yet. A failed observation of an existing file is never "new file".
    let component = bound.root;
    const parts = relativePath.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      component = path.join(component, parts[index]);
      try {
        const stat = fs.lstatSync(component);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        break;
      }
    }
    if (isWorkAttachmentInput(scope.runId, scope.chatId, bound.root, target)) return null;
    const before = observeWorkspaceFile(bound.root, relativePath, input.action);
    if (!before && (fs.existsSync(target) || input.action !== "write")) return null;
    if (input.expectedText !== undefined && (typeof input.expectedText !== "string"
      || Buffer.byteLength(input.expectedText, "utf8") > FILE_OBSERVATION_MAX_BYTES)) return null;
    if (input.runtimeKind === "claude-code" && input.action === "write" && input.expectedText === undefined) return null;
    const startRows = getDb().prepare(`SELECT id,seq,payload_json FROM run_events WHERE run_id=? AND chat_id=?
      AND kind='mcp_tool-use' AND json_extract(payload_json,'$.toolId')=? ORDER BY seq`)
      .all(scope.runId, scope.chatId, input.toolId) as Event[];
    if (startRows.length !== 1) return null;
    const start = JSON.parse(startRows[0].payload_json);
    if (start.toolName !== input.toolName || typeof start.toolResultPreview === "string" || start.toolIsError === true) return null;
    let completed = false;
    return { complete() {
      if (completed) return;
      completed = true;
      try {
        if (scope.signal.aborted) return;
        const current = boundOwner(owner.goalId, owner.attemptId!, scope.runId, scope.chatId);
        if (!current || current.root !== bound.root || current.goalRevision !== bound.goalRevision || current.permission !== bound.permission
          || !nativeRuntimeBound(owner.attemptId!, scope.runId, input.runtimeKind)
          || isWorkAttachmentInput(scope.runId, scope.chatId, bound.root, target)) return;
        const receipts = toolReceipts(scope.runId, scope.chatId, input.toolId, input.toolName);
        if (!receipts || receipts[0].id !== startRows[0].id
          || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_cancelled','invoke_interrupted') LIMIT 1").get(scope.runId)) return;
        const observation = observeWorkspaceFile(bound.root, relativePath, input.action, input.expectedText);
        if (!observation || (input.action === "read" && observation.sha256 !== before?.sha256)
          || (input.action !== "read" && input.expectedText === undefined && observation.sha256 === before?.sha256)) return;
        const pathKey = createHash("sha256").update(relativePath).digest("hex");
        recordRunEvent({ runId: scope.runId, chatId: scope.chatId, kind: "runtime_file_observed",
          sourceEventId: `native-file:${receipts[1].id}:${pathKey}`,
          payload: { schemaVersion: nativeSchemaVersion, ...observation, runtimeKind: input.runtimeKind,
            goalId: owner.goalId, goalRevision: bound.goalRevision, attemptId: owner.attemptId,
            toolId: input.toolId, toolName: input.toolName, startEventId: receipts[0].id, resultEventId: receipts[1].id,
            beforeSha256: before?.sha256 ?? null } });
      } catch { /* Observation failure must not interrupt the user's file work. */ }
    } };
  } catch { return null; }
}

/** Resident CLI transports can outlive an invocation. Capture the new Main
 * scope at runner entry instead of inheriting the old child's event context. */
export function bindNativeFileProofObserver() {
  const scope = contexts.getStore();
  return (input: Parameters<typeof beginNativeFileProof>[0]) => scope
    ? contexts.run(scope, () => beginNativeFileProof(input))
    : null;
}

export interface CurrentFileProof { ref: string; relativePath: string; action: FileObservationAction; sha256: string; bytes: number }
/** Revalidate exact builtin/native producer receipts and current scoped bytes. It
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
    const builtin = data.schemaVersion === schemaVersion && actionForTool[data.builtinName] === data.action;
    const native = data.schemaVersion === nativeSchemaVersion && nativeActionAllowed(data.runtimeKind, data.toolName, data.action);
    if ((!builtin && !native) || data.goalId !== input.goalId || data.goalRevision !== input.goalRevision
      || typeof data.attemptId !== "string") continue;
    const correlation = decodeRuntimeEvidence(data.runtimeEvidence)?.correlation;
    if (correlation?.invocationRunId !== input.invocationRunId || correlation.goalId !== input.goalId
      || correlation.goalRevision !== input.goalRevision || correlation.attemptId !== data.attemptId) continue;
    const bound = boundOwner(input.goalId,data.attemptId,input.invocationRunId,goal.chatId);
    if (!bound || data.root !== bound.root || (data.action !== "read" && !["write","full"].includes(bound.permission))) continue;
    if (native && !nativeRuntimeBound(data.attemptId, input.invocationRunId, data.runtimeKind)) continue;
    const tools = toolReceipts(input.invocationRunId,goal.chatId,data.toolId,data.toolName);
    if (!tools || tools[0].id !== data.startEventId || tools[1].id !== data.resultEventId || tools[1].seq >= row.seq) continue;
    const current = observeWorkspaceFile(bound.root,data.relativePath,data.action);
    if (!current || current.sha256 !== data.sha256 || current.bytes !== data.bytes) continue;
    proofs.push({ref:`file-proof:${row.id}`,relativePath:current.relativePath,action:current.action,sha256:current.sha256,bytes:current.bytes});
  } catch { /* Malformed, moved or missing files cannot become proof. */ }
  return proofs;
}
