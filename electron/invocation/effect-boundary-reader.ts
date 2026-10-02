import { receiptSettlesAttempts } from "../long-run/attempt-effect-receipt";
import { isPredispatchApprovalRefusal } from "../../shared/tool-failure";
import { verifyScienceSchemaRejection, type ScienceSchemaRejectionSettlement } from "./science-schema-rejection";
import type { ScienceNativeFailureObservation } from "./science-native-failure";
import { isEffectStatusOnlyTool, isSettledPreparationScope } from "./effect-boundary";
import type { RuntimeEffectBoundaryReceipt } from "./effect-boundary";
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { parseEffectMetadata, MAIN_TOOL_PREDISPATCH_PROTOCOL, isMainToolPreDispatchRejectionReport, isMainLinkedAdapterScope, hasClosedScopedEffects, type MainHostControlObservation } from "./effect-metadata";
import { failedCallLeftNoOutsideEffect } from "./no-effect-failure";

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
  /** Failed calls settled because their recorded name and arguments prove no outside effect (audit only). */
  noEffectFailureIds?: string[];
  /** Ledger ref of the read-only observation whose done/not_done verdict settled a quiesced boundary. */
  settledByObservation?: string;
}
interface EventRow { id: string; seq: number; kind: string; chat_id: string | null; agent_id?: string | null; node_id?: string | null; payload_json: string }
const terminalKinds = new Set(["invoke_completed", "invoke_waiting", "invoke_failed", "invoke_threw", "invoke_cancelled", "invoke_interrupted"]);
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
    const rows = getDb().prepare("SELECT id, seq, kind, chat_id, agent_id, node_id, payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC")
      .all(input.invocationRunId) as EventRow[];
    const start = rows.find((row) => row.kind === "invoke_started");
    if (!start || start.chat_id !== input.expectedChatId || (input.expectedSource !== undefined && payload(start).invocationSource !== input.expectedSource)) {
      throw new Error("runtime_effect_boundary_run_binding_mismatch");
    }
    if (rows.some((row) => row.chat_id !== null && row.chat_id !== input.expectedChatId)) throw new Error("runtime_effect_boundary_event_binding_mismatch");
    const terminal = [...rows].reverse().find((row) => terminalKinds.has(row.kind));
    let runtimeQuiesced = terminal?.kind === "invoke_completed"
      || (terminal?.kind === "invoke_waiting" && payload(terminal).runtimeQuiesced === true);
    const effectRow = [...rows].reverse().find(row => row.kind === "runtime_effect_boundary");
    const boundary = effectRow ? payload(effectRow) : null;
    const attemptRows = getDb().prepare("SELECT id, run_id, state, side_effect_state FROM long_run_worker_attempts WHERE invocation_run_id = ? ORDER BY id")
      .all(input.invocationRunId) as Array<{ id: string; run_id: string; state: string; side_effect_state: string }>;
    // The digest below hashes `attempts`; keep its shape exactly as before (no run_id).
    const attempts = attemptRows.map(({ id, state, side_effect_state }) => ({ id, state, side_effect_state }));
    const pending = new Set<string>();
    let exactBoundary: Record<string, unknown> | null = null;
    try {
      if (boundary) { const { runtimeEvidence: _evidence, ...metadata } = boundary; exactBoundary = parseEffectMetadata("runtime_effect_boundary", metadata, input.invocationRunId); }
    } catch { pending.add("runtime-effect-metadata-invalid"); }
    const controls = (exactBoundary?.hostControls ?? []) as MainHostControlObservation[];
    const controlById = new Map(controls.map(control => [control.controlId, control]));
    const projectedControls = new Set<string>();
    if (controlById.size !== controls.length) pending.add("runtime-effect-host-control-reused");
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
    if (terminal && !runtimeQuiesced) pending.add(`event:${terminal.id}:effects-unconfirmed`);
    for (const attempt of attempts) if (attempt.state === "running" || attempt.state === "uncertain" || attempt.side_effect_state === "uncertain") pending.add(`attempt:${attempt.id}`);
    if (!effectRow || !boundary || boundary.schemaVersion !== "agentlas.runtime-effect-boundary.v1"
      || boundary.terminalEventId !== terminal?.id || boundary.terminalSeq !== terminal?.seq
      || boundary.coverage !== "complete" || boundary.ledgerComplete !== true || boundary.effects !== "settled"
      || !Array.isArray(boundary.pendingEffectRefs) || boundary.pendingEffectRefs.length !== 0) pending.add("runtime-effect-boundary-unconfirmed");
    if (Array.isArray(boundary?.pendingEffectRefs)) for (const ref of boundary.pendingEffectRefs) if (typeof ref === "string") pending.add(ref);
    let toolEventCount = 0;
    const tools = new Map<string, { row: EventRow; started: boolean; result: boolean; outcome: "pending" | "succeeded" | "failed" | "unknown" }>();
    // Every recorded row per tool id: runtimes reuse item ids inside one invocation (measured 2026-09-27, codex
    // a5916446: item_289 was a failed python write and also a later read), so no single row speaks for the id.
    const rowsByTool = new Map<string, Array<Record<string, unknown>>>();
    // A start row after that id's result row is a new call reusing the id (codex numbers items per provider turn;
    // a5916446 had two provider turns, so item_13 was a failed tool search and later a successful page load). Its
    // different result is not a conflict about one call. Outcomes still collapse per id exactly as the tracker does.
    const lastRowWasResult = new Map<string, boolean>(); const reusedId = new Set<string>();
    const artifactRefs = new Set<string>(); const sourceRefs = new Set<string>();
    for (const row of rows) {
      const data = payload(row);
      const evidence = decodeRuntimeEvidence(data.runtimeEvidence);
      if (evidence?.correlation.artifactVersionRef) artifactRefs.add(evidence.correlation.artifactVersionRef);
      if (Array.isArray(data.toolSourceUrls)) for (const ref of data.toolSourceUrls) if (typeof ref === "string" && /^https?:\/\//.test(ref)) sourceRefs.add(ref);
      if (row.kind === "mcp_tool-use" && data.toolHostControl !== undefined) {
        try {
          const control = parseEffectMetadata("runtime_host_control_observed", data.toolHostControl, input.invocationRunId) as unknown as MainHostControlObservation;
          const audit = rows.find(candidate => candidate.id === control.auditEventId);
          if (projectedControls.has(control.controlId) || JSON.stringify(controlById.get(control.controlId)) !== JSON.stringify(control)
            || !audit || audit.kind !== control.auditKind || audit.seq >= row.seq || !terminal || row.seq >= terminal.seq
            || !effectRow || row.seq >= effectRow.seq) throw new Error("binding");
          const { runtimeEvidence: _evidence, ...auditPayload } = payload(audit);
          const auditDigest = createHash("sha256").update(JSON.stringify(auditPayload)).digest("hex");
          const projectionDigest = createHash("sha256").update(JSON.stringify([data.toolName ?? null, data.toolId ?? null, data.toolArgs ?? null, data.toolResultPreview ?? null, data.toolIsError ?? null, data.toolOrigin ?? null, data.role ?? null, data.phase ?? null, data.tier ?? null, row.agent_id ?? null, row.node_id ?? null])).digest("hex");
          if (control.auditPayloadSha256 !== auditDigest || control.storedProjectionSha256 !== projectionDigest) throw new Error("projection");
          projectedControls.add(control.controlId);
          continue;
        } catch { pending.add("runtime-effect-host-control-witness-invalid"); }
      }
      if (row.kind !== "mcp_tool-use" || typeof data.toolName !== "string" || isEffectStatusOnlyTool({name:data.toolName,id:data.toolId,args:data.toolArgs,isError:data.toolIsError})) continue;
      toolEventCount++;
      if (effectRow && row.seq > effectRow.seq) pending.add(`event:${row.id}:after-effect-boundary`);
      if (terminal && row.seq > terminal.seq) pending.add(`event:${row.id}:after-terminal`);
      const toolId = typeof data.toolId === "string" && data.toolId ? data.toolId : `event:${row.id}`;
      const previous = tools.get(toolId);
      rowsByTool.set(toolId, [...(rowsByTool.get(toolId) ?? []), data]);
      const hasResult = typeof data.toolResultPreview === "string";
      // recordMcpInvocationEvent preserves toolIsError as a boolean but redacts
      // and truncates previews. Only a result's typed flag attests its outcome;
      // ACTIVE events may also carry isError=false without having a result.
      const outcome = hasResult ? (data.toolIsError === true ? "failed"
        : data.toolIsError === false && !data.toolFailureCode ? "succeeded" : "unknown") : "pending";
      if (!hasResult && lastRowWasResult.get(toolId)) reusedId.add(toolId);
      if (hasResult && previous?.result && previous.outcome !== outcome && !reusedId.has(toolId)) pending.add(`tool:${toolId}:outcome-conflict`);
      if (hasResult) reusedId.delete(toolId);
      lastRowWasResult.set(toolId, hasResult);
      tools.set(toolId, { row, started: !hasResult || previous?.started === true, result: hasResult || previous?.result === true,
        outcome: previous?.outcome === "failed" || previous?.outcome === "unknown" ? previous.outcome : hasResult ? outcome : previous?.outcome ?? "pending" });
    }
    if (projectedControls.size !== controls.length) pending.add("runtime-effect-host-control-snapshot-incomplete");
    // The observer never upgrades previews into receipts. The service's complete
    // operation snapshot, produced after runner settlement, is mandatory.
    if (boundary?.observedToolEventCount !== toolEventCount) pending.add("runtime-effect-event-count-mismatch");
    for (const [id, tool] of tools) if (!tool.started || !tool.result || tool.outcome !== (settledFailures.has(id) ? "failed" : "succeeded")) pending.add(`tool:${id}:outcome-pending`);
    // Require the durable closed snapshot, not merely its old truncated summary flags.
    const operations = exactBoundary?.operations as RuntimeEffectBoundaryReceipt["operations"] | undefined;
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
      if (report?.protocol === MAIN_TOOL_PREDISPATCH_PROTOCOL) {
        const operationRows = rowsByTool.get(report.operationIds[0]) ?? [];
        if (!isMainToolPreDispatchRejectionReport(report) || operationRows.length !== 2
          || typeof operationRows[0].toolResultPreview === "string"
          || typeof operationRows[1].toolResultPreview !== "string" || operationRows[1].toolIsError !== true) {
          pending.add(`adapter:${scope.scopeId}:predispatch-proof-unconfirmed`);
        }
      }
      if ((!scope.rootBound && !isMainLinkedAdapterScope(scope, input.invocationRunId, input.expectedChatId, scopes ?? []) && !isSettledPreparationScope(scope, input.expectedChatId)) || scope.chatId !== input.expectedChatId || report?.complete !== true
        || JSON.stringify(startScope) !== JSON.stringify(admission) || JSON.stringify(completedScope) !== JSON.stringify(scope)
        || report.operationIds.some(id => !tools.has(id))) pending.add(`adapter:${scope.scopeId}:durable-receipt-mismatch`);
      if (!scope.rootBound && isSettledPreparationScope(scope, input.expectedChatId)
        && !(scopes ?? []).some(root => root.adapterKind === scope.adapterKind && root.rootBound
          && root.chatId === input.expectedChatId && root.report?.complete === true
          && root.report.protocol !== MAIN_TOOL_PREDISPATCH_PROTOCOL)) pending.add(`adapter:${scope.scopeId}:root-execution-unconfirmed`);
      if (scope.parentScopeId && report?.operationIds.some(id => !id.startsWith(`${scope.scopeId}:tool:`))) pending.add("runtime-effect-child-operation-unbound");
      for (const id of report?.operationIds ?? []) {
        if (reportedOperationIds.has(id)) pending.add("runtime-effect-adapter-operation-reused");
        reportedOperationIds.add(id);
      }
      if (scope.parentScopeId && scope.parentScopeId !== `${input.invocationRunId}:root`) {
        const parentStart = rows.find(row => row.kind === "runtime_adapter_effect_started" && payload(row).scopeId === scope.parentScopeId);
        const parentEnd = rows.find(row => row.kind === "runtime_adapter_effect_completed" && payload(row).scopeId === scope.parentScopeId);
        const ownStart = rows.find(row => row.kind === "runtime_adapter_effect_started" && payload(row).scopeId === scope.scopeId);
        const ownEnd = rows.find(row => row.kind === "runtime_adapter_effect_completed" && payload(row).scopeId === scope.scopeId);
        if (!parentStart || !parentEnd || !ownStart || !ownEnd || parentStart.seq >= ownStart.seq || parentEnd.seq <= ownEnd.seq) pending.add(`adapter:${scope.scopeId}:parent-lifetime-mismatch`);
      }
    }
    for (const kind of (exactBoundary?.adapterKinds ?? []) as string[]) if (["antigravity", "acp"].includes(kind)
      && !(scopes ?? []).some(scope => scope.adapterKind === kind && scope.rootBound
        && scope.chatId === input.expectedChatId && scope.report?.complete === true
        && scope.report.protocol !== MAIN_TOOL_PREDISPATCH_PROTOCOL)) pending.add("runtime-effect-adapter-receipt-missing");
    if (((exactBoundary?.adapterKinds ?? []) as string[]).some(kind => ["antigravity", "acp"].includes(kind))) {
      for (const id of tools.keys()) if (!reportedOperationIds.has(id)) pending.add("runtime-effect-adapter-operation-missing");
    }
    if (terminal?.kind === "invoke_failed" && exactBoundary?.runtimeQuiesced === true && boundary?.effects === "settled"
      && hasClosedScopedEffects(scopes ?? [], operations ?? [], input.invocationRunId, input.expectedChatId)
      && [...pending].every(ref => ref === `event:${terminal.id}:effects-unconfirmed`)) {
      runtimeQuiesced = true;
      pending.delete(`event:${terminal.id}:effects-unconfirmed`);
    }
    const pendingEffectRefs = [...pending].sort();
    // Failed-but-resolved tool calls: started, result observed, typed failure, and in the closed snapshot.
    // A typed failure whose result was observed has finished; host-loop runtimes (serving) may record the call and its
    // result as one event with no separate start (routed R2, run d3ff01c6), which is still a finished call.
    const failedIds = new Set([...tools].filter(([id, tool]) => tool.result && tool.outcome === "failed"
      && !settledFailures.has(id)).map(([id]) => id));
    const snapshotOnlyFailed = Boolean(operations && operations.length === tools.size
      && new Set(operations.map(operation => operation.toolId)).size === tools.size
      && operations.every(operation => operation.toolId && tools.has(operation.toolId)
        && (operation.startObserved || (operation.outcome === "failed" && failedIds.has(operation.toolId)))
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
    const quiesced = runtimeQuiesced && failedIds.size > 0 && pendingEffectRefs.every(explainedByFailure);
    // A failed call that provably could not change anything outside (read-only browser profile, read-only
    // shell command, network query tool — judged from its recorded name and arguments, never its result text)
    // is a settled effect. Measured 2026-09-27: failed `wc -l`, a failed Threads page load and failed
    // context.verify calls each held a whole One goal episode "uncertain" (no-effect-failure.ts).
    // Failed clicks, typing, page JavaScript and unknown tools stay open: that is the truly ambiguous case.
    // Judge every failed/unknown result row recorded under the id (a reused id may also hold successful calls,
    // whose own result is their receipt).
    const noEffectFailedIds = runtimeQuiesced ? [...failedIds].filter((id) => {
      const failedResults = (rowsByTool.get(id) ?? []).filter((data) => typeof data.toolResultPreview === "string"
        && !(data.toolIsError === false && !data.toolFailureCode));
      return failedResults.length > 0 && failedResults.every((data) => failedCallLeftNoOutsideEffect({ toolName: data.toolName, toolArgs: data.toolArgs })
        || (data.toolIsError === true && isPredispatchApprovalRefusal({ failureCode: data.toolFailureCode, result: data.toolResultPreview })));
    }) : [];
    const explainedByNoEffectFailure = (ref: string): boolean => (ref === "runtime-effect-boundary-unconfirmed" && boundaryOnlyFailed)
      || (ref === "runtime-effect-operation-snapshot-incomplete" && snapshotOnlyFailed)
      || noEffectFailedIds.some(id => ref === `tool:${id}:outcome-pending` || (ref.startsWith("operation:") && ref.endsWith(`:${id}:failed`)));
    let openEffectRefs = noEffectFailedIds.length ? pendingEffectRefs.filter((ref) => !explainedByNoEffectFailure(ref)) : pendingEffectRefs;
    // The rest of a quiesced boundary (nothing running; only failed calls such as a click whose element was gone)
    // is settled once the goal's read-only observation looked at the live page and recorded done / not_done for
    // exactly this invocation (effect-observation.ts settle_boundary). Owner direction 2026-09-27: an uncertain
    // effect is reconciled by looking, never by asking a person; the look's verdict is the effect's resolution.
    let settledByObservation: string | null = null;
    if (openEffectRefs.length && quiesced) {
      const runIds = [...new Set(attemptRows.map((row) => row.run_id))];
      for (const runId of runIds) {
        const row = getDb().prepare(`SELECT seq, json_extract(payload_json, '$.verdict') AS verdict,
          json_extract(payload_json, '$.externalOutcomeProof') AS proof FROM long_run_events
          WHERE run_id = ? AND kind = 'run.effect_observation' AND json_extract(payload_json, '$.action') = 'settle_boundary'
            AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.targetIds') WHERE value = ?)
          ORDER BY seq DESC LIMIT 1`).get(runId, `invocation:${input.invocationRunId}`) as { seq: number; verdict: string | null; proof: string | null } | undefined;
        if (row && (row.verdict === "done" || (row.verdict === "not_done"
          && row.proof === "host_receipt_closed_ledger"
          && receiptSettlesAttempts([{ id: `invocation:${input.invocationRunId}`, invocationRunId: input.invocationRunId }])))) { settledByObservation = `long-run:${runId}:event:${row.seq}`; break; }
      }
      if (settledByObservation) openEffectRefs = [];
    }
    const result: InvocationEffectBoundary = { invocationRunId: input.invocationRunId, terminalEventId: terminal?.id ?? null, receiptEventId: effectRow?.id ?? null, snapshotDigest: null,
      terminal: Boolean(terminal), effects: openEffectRefs.length ? "uncertain" : "settled",
      ...(openEffectRefs.length && quiesced ? { quiesced: true } : {}),
      artifactRefs: [...artifactRefs].sort(), sourceRefs: [...sourceRefs].sort(), pendingEffectRefs: openEffectRefs,
      ...(noEffectFailedIds.length ? { noEffectFailureIds: [...noEffectFailedIds].sort() } : {}),
      ...(settledByObservation ? { settledByObservation } : {}) };
    if (terminal) {
      const digest = createHash("sha256").update(JSON.stringify({ input, terminal, effectRow, attempts,
        tools: [...tools].map(([id, tool]) => ({ id, ...tool })), result })).digest("hex");
      result.snapshotDigest = digest;
    }
    return result;
  })();
}
