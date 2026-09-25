import { verifyScienceSchemaRejection, type ScienceSchemaRejectionSettlement } from "./science-schema-rejection";
import type { ScienceNativeFailureObservation } from "./science-native-failure";
import { isEffectStatusOnlyTool, isSettledPreparationScope } from "./effect-boundary";
import type { RuntimeEffectBoundaryReceipt } from "./effect-boundary";
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { parseEffectMetadata } from "./effect-metadata";

export interface InvocationEffectBoundaryInput {
  invocationRunId: string; expectedChatId: string; expectedSource?: string;
}
export interface InvocationEffectBoundary {
  invocationRunId: string; terminalEventId: string | null; receiptEventId: string | null; snapshotDigest: string | null;
  terminal: boolean; effects: "settled" | "uncertain";
  /**
   * Verification-only projection. True when the completed invocation is fully covered and ended, and
   * its only open effect refs are tool calls whose typed failed result was observed (for example a
   * probe command exiting 1). Nothing is still running, so the current state can be judged; it is
   * NOT replay/continuation authority, which still requires `effects === "settled"`.
   */
  quiesced?: boolean;
  artifactRefs: string[]; sourceRefs: string[]; pendingEffectRefs: string[];
}
interface EventRow { id: string; seq: number; kind: string; chat_id: string | null; payload_json: string }
const terminalKinds = new Set(["invoke_completed", "invoke_failed", "invoke_threw", "invoke_cancelled", "invoke_interrupted"]);
function payload(row: EventRow): Record<string, unknown> {
  const value: unknown = JSON.parse(row.payload_json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime_effect_boundary_event_invalid");
  return value as Record<string, unknown>;
}
/** Read-only reconciliation. Science owns steering and the only successor writer.
 * The anchor names an actual terminal ledger event plus exact effect snapshot,
 * never a fabricated task checkpoint or a model completion claim. */
export function readInvocationEffectBoundary(input: InvocationEffectBoundaryInput): InvocationEffectBoundary {
  for (const value of Object.values(input).filter(value => value !== undefined)) if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("runtime_effect_boundary_identity_invalid");
  return getDb().transaction(() => {
    const rows = getDb().prepare("SELECT id, seq, kind, chat_id, payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC")
      .all(input.invocationRunId) as EventRow[];
    const start = rows.find((row) => row.kind === "invoke_started");
    if (!start || start.chat_id !== input.expectedChatId || (input.expectedSource !== undefined && payload(start).invocationSource !== input.expectedSource)) {
      throw new Error("runtime_effect_boundary_run_binding_mismatch");
    }
    if (rows.some((row) => row.chat_id !== null && row.chat_id !== input.expectedChatId)) throw new Error("runtime_effect_boundary_event_binding_mismatch");
    const terminal = [...rows].reverse().find((row) => terminalKinds.has(row.kind));
    const effectRow = [...rows].reverse().find(row => row.kind === "runtime_effect_boundary");
    const boundary = effectRow ? payload(effectRow) : null;
    const attempts = getDb().prepare("SELECT id, state, side_effect_state FROM long_run_worker_attempts WHERE invocation_run_id = ? ORDER BY id")
      .all(input.invocationRunId) as Array<{ id: string; state: string; side_effect_state: string }>;
    const pending = new Set<string>();
    let exactBoundary: Record<string, unknown> | null = null;
    try {
      if (boundary) { const { runtimeEvidence: _evidence, ...metadata } = boundary; exactBoundary = parseEffectMetadata("runtime_effect_boundary", metadata, input.invocationRunId); }
    } catch { pending.add("runtime-effect-metadata-invalid"); }
    const scopeProofs = exactBoundary?.adapterScopes as Array<{ rootBound: boolean; chatId: string | null; report: { complete: boolean; settledFailureIds?: string[] } | null }> | undefined;
    const settledFailures = new Set((scopeProofs ?? []).filter(scope => scope.rootBound && scope.chatId === input.expectedChatId && scope.report?.complete)
      .flatMap(scope => scope.report?.settledFailureIds ?? []));
    // New snapshots must carry their own verified rejection and native witnesses.
    // Never search for new proof to upgrade an old uncertain boundary.
    const schemaProofs = (exactBoundary?.scienceSchemaRejections ?? []) as ScienceSchemaRejectionSettlement[];
    const proofRows = rows.filter(row => row.kind === "runtime_science_schema_rejection_verified");
    if (schemaProofs.length !== proofRows.length) pending.add("science-schema-rejection-snapshot-mismatch");
    for (const proof of schemaProofs) {
      try {
        const toolId = proof.binding.providerToolId;
        if (proof.binding.chatId !== input.expectedChatId || schemaProofs.filter(p => p.attemptId === proof.attemptId || p.binding.providerToolId === toolId).length !== 1) throw new Error("binding");
        const exact = (row: EventRow) => {
          const { runtimeEvidence: _evidence, ...metadata } = payload(row);
          return parseEffectMetadata(row.kind, metadata, input.invocationRunId)!;
        };
        const verified = proofRows.filter(row => exact(row).attemptId === proof.attemptId);
        const correlations = rows.filter(row => row.kind === "runtime_science_tool_correlation" && exact(row).providerToolId === toolId);
        const observations = rows.filter(row => row.kind === "runtime_science_native_failure_observed"
          && (exact(row).observation as ScienceNativeFailureObservation).binding.providerToolId === toolId);
        if (verified.length !== 1 || correlations.length !== 1 || observations.length !== 1 || !terminal || !effectRow
          || observations[0].seq <= correlations[0].seq || observations[0].seq >= terminal.seq
          || verified[0].seq <= terminal.seq || verified[0].seq >= effectRow.seq
          || JSON.stringify(exact(verified[0])) !== JSON.stringify(proof)
          || JSON.stringify(exact(correlations[0])) !== JSON.stringify(proof.binding)) throw new Error("witness");
        const observation = exact(observations[0]);
        if (observation.conflictingObservation !== false
          || JSON.stringify(verifyScienceSchemaRejection(observation.observation as ScienceNativeFailureObservation)) !== JSON.stringify(proof)) throw new Error("receipt");
        settledFailures.add(toolId);
      } catch { pending.add("science-schema-rejection-proof-unconfirmed"); }
    }
    if (!terminal) pending.add(`invocation:${input.invocationRunId}:terminal-pending`);
    if (terminal && terminal.kind !== "invoke_completed") pending.add(`event:${terminal.id}:effects-unconfirmed`);
    for (const attempt of attempts) if (attempt.state === "running" || attempt.state === "uncertain" || attempt.side_effect_state === "uncertain") pending.add(`attempt:${attempt.id}`);
    if (!effectRow || !boundary || boundary.schemaVersion !== "agentlas.runtime-effect-boundary.v1"
      || boundary.terminalEventId !== terminal?.id || boundary.terminalSeq !== terminal?.seq
      || boundary.coverage !== "complete" || boundary.ledgerComplete !== true || boundary.effects !== "settled"
      || !Array.isArray(boundary.pendingEffectRefs) || boundary.pendingEffectRefs.length !== 0) pending.add("runtime-effect-boundary-unconfirmed");
    if (Array.isArray(boundary?.pendingEffectRefs)) for (const ref of boundary.pendingEffectRefs) if (typeof ref === "string") pending.add(ref);
    let toolEventCount = 0;
    const tools = new Map<string, { row: EventRow; started: boolean; result: boolean; outcome: "pending" | "succeeded" | "failed" | "unknown" }>();
    const artifactRefs = new Set<string>(); const sourceRefs = new Set<string>();
    for (const row of rows) {
      const data = payload(row);
      const evidence = decodeRuntimeEvidence(data.runtimeEvidence);
      if (evidence?.correlation.artifactVersionRef) artifactRefs.add(evidence.correlation.artifactVersionRef);
      if (Array.isArray(data.toolSourceUrls)) for (const ref of data.toolSourceUrls) if (typeof ref === "string" && /^https?:\/\//.test(ref)) sourceRefs.add(ref);
      if (row.kind !== "mcp_tool-use" || typeof data.toolName !== "string" || isEffectStatusOnlyTool({name:data.toolName,id:data.toolId,args:data.toolArgs,isError:data.toolIsError})) continue;
      toolEventCount++;
      if (effectRow && row.seq > effectRow.seq) pending.add(`event:${row.id}:after-effect-boundary`);
      if (terminal && row.seq > terminal.seq) pending.add(`event:${row.id}:after-terminal`);
      const toolId = typeof data.toolId === "string" && data.toolId ? data.toolId : `event:${row.id}`;
      const previous = tools.get(toolId);
      const hasResult = typeof data.toolResultPreview === "string";
      // recordMcpInvocationEvent preserves toolIsError as a boolean but redacts
      // and truncates previews. Only a result's typed flag attests its outcome;
      // ACTIVE events may also carry isError=false without having a result.
      const outcome = hasResult ? (data.toolIsError === true ? "failed"
        : data.toolIsError === false && !data.toolFailureCode ? "succeeded" : "unknown") : "pending";
      if (hasResult && previous?.result && previous.outcome !== outcome) pending.add(`tool:${toolId}:outcome-conflict`);
      tools.set(toolId, { row, started: !hasResult || previous?.started === true, result: hasResult || previous?.result === true,
        outcome: previous?.outcome === "failed" || previous?.outcome === "unknown" ? previous.outcome : hasResult ? outcome : previous?.outcome ?? "pending" });
    }
    // The observer never upgrades previews into receipts. The service's complete
    // operation snapshot, produced after runner settlement, is mandatory.
    if (boundary?.observedToolEventCount !== toolEventCount) pending.add("runtime-effect-event-count-mismatch");
    for (const [id, tool] of tools) if (!tool.started || !tool.result || tool.outcome !== (settledFailures.has(id) ? "failed" : "succeeded")) pending.add(`tool:${id}:outcome-pending`);
    // Require the durable closed snapshot, not merely its old truncated summary flags.
    const operations = exactBoundary?.operations as Array<{ toolId: string | null; startObserved: boolean; resultObserved: boolean; outcome: string }> | undefined;
    if (!operations || operations.length !== tools.size || new Set(operations.map(operation => operation.toolId)).size !== tools.size || operations.some(operation => !operation.toolId || !tools.has(operation.toolId)
      || !operation.startObserved || !operation.resultObserved || operation.outcome !== tools.get(operation.toolId)?.outcome
      || operation.outcome !== (settledFailures.has(operation.toolId) ? "failed" : "succeeded"))) pending.add("runtime-effect-operation-snapshot-incomplete");
    const scopes = exactBoundary?.adapterScopes as RuntimeEffectBoundaryReceipt["adapterScopes"];
    const completedScopes = new Map<string, Record<string, unknown>>();
    const startedScopes = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (row.kind !== "runtime_adapter_effect_started" && row.kind !== "runtime_adapter_effect_completed") continue;
      try {
        const { runtimeEvidence: _evidence, ...metadata } = payload(row);
        const value = parseEffectMetadata(row.kind, metadata, input.invocationRunId)!;
        if (effectRow && row.seq > effectRow.seq) pending.add(`adapter:${String(value.scopeId)}:after-effect-boundary`);
        const target = row.kind === "runtime_adapter_effect_started" ? startedScopes : completedScopes;
        if (target.has(String(value.scopeId))) pending.add("runtime-effect-adapter-duplicate");
        target.set(String(value.scopeId), value);
      } catch { pending.add("runtime-effect-adapter-metadata-invalid"); }
    }
    if ((scopes?.length ?? 0) !== startedScopes.size || (scopes?.length ?? 0) !== completedScopes.size) pending.add("runtime-effect-adapter-snapshot-incomplete");
    const scopeIds = new Set<string>(), reportedOperationIds = new Set<string>();
    for (const scope of scopes ?? []) {
      if (scopeIds.has(scope.scopeId)) pending.add("runtime-effect-adapter-scope-reused");
      scopeIds.add(scope.scopeId);
      const startScope = startedScopes.get(scope.scopeId), completedScope = completedScopes.get(scope.scopeId);
      const { report, ...admission } = scope;
      if ((!scope.rootBound && !isSettledPreparationScope(scope, input.expectedChatId)) || scope.chatId !== input.expectedChatId || report?.complete !== true
        || JSON.stringify(startScope) !== JSON.stringify(admission) || JSON.stringify(completedScope) !== JSON.stringify(scope)
        || report.operationIds.some(id => !tools.has(id))) pending.add(`adapter:${scope.scopeId}:durable-receipt-mismatch`);
      if (!scope.rootBound && isSettledPreparationScope(scope, input.expectedChatId)
        && !(scopes ?? []).some(root => root.adapterKind === scope.adapterKind && root.rootBound
          && root.chatId === input.expectedChatId && root.report?.complete === true)) pending.add(`adapter:${scope.scopeId}:root-execution-unconfirmed`);
      for (const id of report?.operationIds ?? []) {
        if (reportedOperationIds.has(id)) pending.add("runtime-effect-adapter-operation-reused");
        reportedOperationIds.add(id);
      }
    }
    for (const kind of (exactBoundary?.adapterKinds ?? []) as string[]) if (["antigravity", "acp"].includes(kind)
      && !(scopes ?? []).some(scope => scope.adapterKind === kind && scope.rootBound
        && scope.chatId === input.expectedChatId && scope.report?.complete === true)) pending.add("runtime-effect-adapter-receipt-missing");
    if (((exactBoundary?.adapterKinds ?? []) as string[]).some(kind => ["antigravity", "acp"].includes(kind))) {
      for (const id of tools.keys()) if (!reportedOperationIds.has(id)) pending.add("runtime-effect-adapter-operation-missing");
    }
    const pendingEffectRefs = [...pending].sort();
    // Failed-but-resolved tool calls: started, result observed, typed failure, and in the closed snapshot.
    const failedIds = new Set([...tools].filter(([id, tool]) => tool.started && tool.result && tool.outcome === "failed"
      && !settledFailures.has(id)).map(([id]) => id));
    const snapshotOnlyFailed = Boolean(operations && operations.length === tools.size
      && new Set(operations.map(operation => operation.toolId)).size === tools.size
      && operations.every(operation => operation.toolId && tools.has(operation.toolId) && operation.startObserved
        && operation.resultObserved && operation.outcome === tools.get(operation.toolId)?.outcome
        && (operation.outcome === "succeeded" || (operation.outcome === "failed" && (failedIds.has(operation.toolId) || settledFailures.has(operation.toolId))))));
    const boundaryOnlyFailed = Boolean(effectRow && boundary && boundary.schemaVersion === "agentlas.runtime-effect-boundary.v1"
      && boundary.terminalEventId === terminal?.id && boundary.terminalSeq === terminal?.seq
      && boundary.coverage === "complete" && boundary.ledgerComplete === true && Array.isArray(boundary.pendingEffectRefs)
      && (boundary.pendingEffectRefs as unknown[]).every(ref => typeof ref === "string"
        && [...failedIds].some(id => ref.startsWith("operation:") && ref.endsWith(`:${id}:failed`))));
    const explainedByFailure = (ref: string): boolean => (ref === "runtime-effect-boundary-unconfirmed" && boundaryOnlyFailed)
      || (ref === "runtime-effect-operation-snapshot-incomplete" && snapshotOnlyFailed)
      || [...failedIds].some(id => ref === `tool:${id}:outcome-pending` || (ref.startsWith("operation:") && ref.endsWith(`:${id}:failed`)));
    const quiesced = terminal?.kind === "invoke_completed" && failedIds.size > 0 && pendingEffectRefs.every(explainedByFailure);
    const result: InvocationEffectBoundary = { invocationRunId: input.invocationRunId, terminalEventId: terminal?.id ?? null, receiptEventId: effectRow?.id ?? null, snapshotDigest: null,
      terminal: Boolean(terminal), effects: pendingEffectRefs.length ? "uncertain" : "settled",
      ...(pendingEffectRefs.length && quiesced ? { quiesced: true } : {}),
      artifactRefs: [...artifactRefs].sort(), sourceRefs: [...sourceRefs].sort(), pendingEffectRefs };
    if (terminal) {
      const digest = createHash("sha256").update(JSON.stringify({ input, terminal, effectRow, attempts,
        tools: [...tools].map(([id, tool]) => ({ id, ...tool })), result })).digest("hex");
      result.snapshotDigest = digest;
    }
    return result;
  })();
}
