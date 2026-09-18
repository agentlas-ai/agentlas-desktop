import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { recordRunEvent, redactRunEventSensitiveText } from "../store/run-events";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunAttemptGoalRevision } from "../store/long-runs";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { parseEffectMetadata } from "../invocation/effect-metadata";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { captureGoalVerificationBoundary } from "./verification-boundary";
import { mainMcpExecutionCompletion, mcpEffectArgumentsDigest, mcpEffectOutputDigest, type MainMcpEffectReceipt } from "../mcp-tools/effect-receipts";
import type { PreparedMcpBinding } from "../mcp-tools/prepared-transport";

const SCHEMA = "agentlas.main-execution-proof.v1";
const KIND = "runtime_execution_observed";
const MAX_PROOFS = 4096;
const MAX_SELECTED_PROOFS = 3;
const MAX_PACKET_BYTES = 4096;
interface Row { id: string; run_id: string; chat_id: string | null; seq: number; kind: string; payload_json: string }
interface Owner { id: string; run_id: string; goal_id: string; root_chat_id: string }
export interface CurrentExecutionProof {
  ref: string; contract: "time" | "native-browser"; toolName: string; toolId: string;
  argumentsDigest: string; resultDigest: string; startRef: string; resultRef: string;
  boundaryRef: string; mainResultPreview: string; attests: "operation-completed-not-domain-success";
  selection: "recent-subset-not-exhaustive";
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const data = (row: Row): Record<string, any> => JSON.parse(row.payload_json);
function rows(runId: string): Row[] {
  // The existing boundary reader also reconciles the full invocation. Never
  // silently take a tail and mistake a truncated history for complete proof.
  const events = getDb().prepare("SELECT id,run_id,chat_id,seq,kind,payload_json FROM run_events WHERE run_id=? ORDER BY seq LIMIT 32769").all(runId) as Row[];
  if (events.length > 32768) throw new Error("execution_proof_history_overflow");
  return events;
}
function owner(runId: string): (Owner & {revision: number}) | null {
  const attempts = getDb().prepare(`SELECT a.id,a.run_id,r.goal_id,r.root_chat_id FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id=a.worker_id JOIN long_runs r ON r.id=a.run_id
    WHERE a.invocation_run_id=? AND w.role='controller' AND r.surface IN ('one','work')`)
    .all(runId) as Owner[];
  if (attempts.length !== 1) return null;
  const attempt = attempts[0], revision = getLongRunAttemptGoalRevision(attempt.run_id, attempt.id);
  const goal = getChatGoalRevision(attempt.goal_id);
  return goal && revision === goal.revision && goal.chatId === attempt.root_chat_id ? { ...attempt, revision } : null;
}
function scopePair(events: Row[], scopeId: string, chatId: string) {
  const starts = events.filter(row => row.kind === "runtime_adapter_effect_started" && data(row).scopeId === scopeId);
  const ends = events.filter(row => row.kind === "runtime_adapter_effect_completed" && data(row).scopeId === scopeId);
  if (starts.length !== 1 || ends.length !== 1) return null;
  const [start, end] = [starts[0], ends[0]];
  const parse = (row: Row) => { const {runtimeEvidence: _evidence, ...metadata} = data(row); return parseEffectMetadata(row.kind, metadata, row.run_id) as Record<string, any> | null; };
  const admission = parse(start), completed = parse(end);
  if (!admission || !completed || start.chat_id !== chatId || end.chat_id !== chatId || start.seq >= end.seq
    || admission.scopeId !== scopeId || admission.adapterKind !== "antigravity" || admission.rootBound !== true
    || admission.chatId !== chatId || admission.purpose !== undefined) return null;
  const {report, ...repeated} = completed;
  if (JSON.stringify(admission) !== JSON.stringify(repeated) || report?.complete !== true || report.terminal !== "SUCCESS"
    || report.protocol !== "agy-stream-json-main-receipts.v2" || report.reasons.length !== 0) return null;
  return {start, end, report};
}
function toolPair(events: Row[], operationId: string, chatId: string) {
  const matched = events.filter(row => row.kind === "mcp_tool-use" && data(row).toolId === operationId);
  if (matched.length !== 2) return null;
  const [start, result] = matched, first = data(start), last = data(result);
  if (start.chat_id !== chatId || result.chat_id !== chatId || start.seq >= result.seq
    || typeof first.toolResultPreview === "string" || first.toolIsError === true || first.toolFailureCode
    || typeof last.toolResultPreview !== "string" || last.toolIsError !== false || last.toolFailureCode
    || typeof first.toolName !== "string" || first.toolName !== last.toolName
    || typeof first.toolArgs !== "string" || first.toolArgs !== last.toolArgs) return null;
  return {start, result, first, last};
}

/** Only the real AGY adapter calls this after native drain/complete and BEFORE
 * invocation termination. Opaque Main receipt+prepared binding are mandatory;
 * an arbitrary receipt-shaped object has no entry in Main's private WeakMap. */
export function recordMainExecutionProofs(input: {
  scopeId: string; bindings: readonly PreparedMcpBinding[]; signal?: AbortSignal;
  claims: readonly {operationId: string; outputDigest: string | null; receipt: MainMcpEffectReceipt}[];
}): void {
  try {
    if (input.signal?.aborted || input.claims.length > MAX_PROOFS) return;
    const match = /^(.*):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(input.scopeId);
    if (!match) return;
    const runId = match[1];
    getDb().transaction(() => {
      const bound = owner(runId), events = rows(runId);
      if (!bound || events.some(row => row.kind === "runtime_effect_boundary" || /^invoke_(?:completed|failed|threw|cancelled|interrupted)$/.test(row.kind))) return;
      const scope = scopePair(events, input.scopeId, bound.root_chat_id);
      if (!scope || input.signal?.aborted) return;
      const claimedIds = new Set<string>(), operations = new Set<string>();
      for (const claim of input.claims) {
        const proof = mainMcpExecutionCompletion(claim.receipt, input.bindings);
        if (!proof || !claim.outputDigest || !proof.outputDigests.includes(claim.outputDigest)
          || claimedIds.has(proof.receiptId) || operations.has(claim.operationId)) return;
        claimedIds.add(proof.receiptId); operations.add(claim.operationId);
      }
      for (const claim of input.claims) {
        const proof = mainMcpExecutionCompletion(claim.receipt, input.bindings)!;
        if (!claim.operationId.startsWith(`${input.scopeId}:agy-tool:call_mcp_tool:`)
          || scope.report.operationIds.filter((id: string) => id === claim.operationId).length !== 1
          || scope.report.settledFailureIds?.includes(claim.operationId)) continue;
        const tools = toolPair(events, claim.operationId, bound.root_chat_id);
        if (!tools || tools.start.seq <= scope.start.seq || tools.result.seq >= scope.end.seq
          || tools.first.toolName !== `mcp__${proof.server}__${proof.tool}`
          || mcpEffectArgumentsDigest(JSON.parse(tools.first.toolArgs)) !== proof.argumentsDigest
          || mcpEffectOutputDigest(tools.last.toolResultPreview) !== claim.outputDigest) continue;
        // Numeric durable positions avoid granting generic redaction exemptions
        // to UUID-prefixed provider IDs. Exact identities are read from Main rows.
        if (getDb().prepare("SELECT 1 FROM run_events WHERE kind=? AND json_extract(payload_json,'$.receiptId')=? LIMIT 1").get(KIND, proof.receiptId)) continue;
        const preview = redactRunEventSensitiveText(proof.resultPreview).slice(0, 512);
        recordRunEvent({runId,chatId:bound.root_chat_id,kind:KIND,sourceEventId:`main-execution:${proof.receiptId}`,evidencePhase:"executed",
          payload:{schemaVersion:SCHEMA,receiptId:proof.receiptId,contract:proof.contract,tool:proof.tool,
            argumentsDigest:proof.argumentsDigest,resultDigest:proof.resultDigest,outputDigest:claim.outputDigest,
            scopeStartSeq:scope.start.seq,scopeEndSeq:scope.end.seq,toolStartSeq:tools.start.seq,toolResultSeq:tools.result.seq,
            toolResultDigest:digest(tools.last.toolResultPreview),toolResultPreview:preview,previewDigest:digest(preview)}});
      }
    })();
  } catch { /* Missing/unrecordable proof cannot become successful evidence. */ }
}

/** Read-only, current-Goal projection. This proves bounded operation completion,
 * NOT correctness of a page, requested deliverable, or business outcome. */
export function collectCurrentExecutionProofs(input: {
  goalId: string; goalRevision: number; invocationRunId: string; boundaryDigest: string;
}): CurrentExecutionProof[] {
  try {
    return getDb().transaction(() => {
      const capture = captureGoalVerificationBoundary(input.goalId, input.invocationRunId);
      if (capture.digest !== input.boundaryDigest || capture.goalRevision !== input.goalRevision) return [];
      const bound = owner(input.invocationRunId);
      if (!bound || bound.goal_id !== input.goalId || bound.revision !== input.goalRevision) return [];
      const effect = readInvocationEffectBoundary({invocationRunId:input.invocationRunId,expectedChatId:bound.root_chat_id});
      if (!effect.terminal || effect.effects !== "settled" || !effect.receiptEventId) return [];
      const events = rows(input.invocationRunId), terminal = events.find(row => row.id === effect.terminalEventId);
      const seal = events.find(row => row.id === effect.receiptEventId);
      if (!terminal || !seal || terminal.kind !== "invoke_completed") return [];
      // Settlement is checked for the ENTIRE invocation above. These latest
      // observations are a bounded, explicitly non-exhaustive judge packet,
      // not a claim that a handful of tool calls completed the user's work.
      const proofRows = events.filter(row => row.kind === KIND).reverse().slice(0, MAX_SELECTED_PROOFS);
      const seen = new Set<string>(), operations = new Set<string>(), results: CurrentExecutionProof[] = [];
      for (const row of proofRows) {
        const p = data(row), correlation = decodeRuntimeEvidence(p.runtimeEvidence)?.correlation;
        const keys = ["schemaVersion","receiptId","contract","tool","argumentsDigest","resultDigest","outputDigest","scopeStartSeq","scopeEndSeq","toolStartSeq","toolResultSeq","toolResultDigest","toolResultPreview","previewDigest","runtimeEvidence"];
        if (Object.keys(p).length !== keys.length || Object.keys(p).some(key => !keys.includes(key))
          || p.schemaVersion !== SCHEMA || !["time","native-browser"].includes(p.contract)
          || typeof p.tool !== "string" || !/^[a-z_]{1,80}$/.test(p.tool)
          || typeof p.receiptId !== "string" || !/^[a-f0-9-]{36}$/.test(p.receiptId)
          || [p.argumentsDigest,p.resultDigest,p.outputDigest,p.toolResultDigest,p.previewDigest].some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
          || [p.scopeStartSeq,p.scopeEndSeq,p.toolStartSeq,p.toolResultSeq].some(value => !Number.isSafeInteger(value) || value < 0)
          || typeof p.toolResultPreview !== "string" || p.toolResultPreview.length > 512 || digest(p.toolResultPreview) !== p.previewDigest
          || correlation?.invocationRunId !== input.invocationRunId || correlation.goalId !== input.goalId
          || correlation.goalRevision !== input.goalRevision || correlation.attemptId !== bound.id || correlation.longRunId !== bound.run_id
          || row.chat_id !== bound.root_chat_id || row.seq >= terminal.seq || seen.has(p.receiptId)) return [];
        seen.add(p.receiptId);
        if (p.contract === "time" ? !["get_current_time","convert_time"].includes(p.tool) : !p.tool.startsWith("browser_")) return [];
        const start = events.find(event => event.seq === p.scopeStartSeq), end = events.find(event => event.seq === p.scopeEndSeq);
        const toolStart = events.find(event => event.seq === p.toolStartSeq), toolResult = events.find(event => event.seq === p.toolResultSeq);
        if (!start || !end || !toolStart || !toolResult) return [];
        const scopeId = data(start).scopeId, operationId = data(toolStart).toolId;
        if (typeof scopeId !== "string" || typeof operationId !== "string" || operations.has(operationId)
          || !operationId.startsWith(`${scopeId}:agy-tool:call_mcp_tool:`)) return [];
        operations.add(operationId);
        const scope = scopePair(events, scopeId, bound.root_chat_id), tools = toolPair(events, operationId, bound.root_chat_id);
        if (!scope || !tools || scope.start.id !== start.id || scope.end.id !== end.id
          || tools.start.id !== toolStart.id || tools.result.id !== toolResult.id
          || !(start.seq < toolStart.seq && toolStart.seq < toolResult.seq && toolResult.seq < end.seq && end.seq < row.seq)
          || !tools.first.toolName.endsWith(`__${p.tool}`)
          || mcpEffectArgumentsDigest(JSON.parse(tools.first.toolArgs)) !== p.argumentsDigest
          || mcpEffectOutputDigest(tools.last.toolResultPreview) !== p.outputDigest || digest(tools.last.toolResultPreview) !== p.toolResultDigest
          || scope.report.operationIds.filter((id: string) => id === operationId).length !== 1
          || scope.report.settledFailureIds?.includes(operationId)) return [];
        const boundary = data(seal);
        if (!boundary.operations?.some((op: any) => op.toolId === operationId && op.startObserved === true && op.resultObserved === true && op.outcome === "succeeded")
          || !boundary.adapterScopes?.some((item: any) => item.scopeId === scopeId && item.rootBound === true && item.chatId === bound.root_chat_id)) return [];
        // Reject one Main completion reused across invocations, even if a second
        // row happens to carry otherwise plausible local identities.
        const uses = getDb().prepare("SELECT id FROM run_events WHERE kind=? AND json_extract(payload_json,'$.receiptId')=? LIMIT 2").all(KIND,p.receiptId) as {id:string}[];
        if (uses.length !== 1 || uses[0].id !== row.id) return [];
        const projected: CurrentExecutionProof = {ref:`execution-proof:${row.id}`,contract:p.contract,toolName:tools.first.toolName,toolId:operationId,
          argumentsDigest:p.argumentsDigest,resultDigest:p.resultDigest,startRef:`event:${toolStart.id}`,resultRef:`event:${toolResult.id}`,
          boundaryRef:`event:${seal.id}`,mainResultPreview:p.toolResultPreview,attests:"operation-completed-not-domain-success",selection:"recent-subset-not-exhaustive"};
        if (Buffer.byteLength(JSON.stringify([...results, projected]), "utf8") <= MAX_PACKET_BYTES) results.push(projected);
      }
      return results;
    })();
  } catch { return []; }
}
