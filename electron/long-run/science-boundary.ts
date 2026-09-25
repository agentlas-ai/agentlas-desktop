import { createHash } from "node:crypto";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { getDb } from "../store/db";

export interface ScienceRuntimeBoundaryInput {
  projectId: string; conversationId: string; turnId: string; invocationRunId: string;
  /** Resolved from the canonical Science conversation binding by Main. Never renderer-authored. */
  expectedRuntimeChatId: string;
}
export interface ScienceRuntimeBoundary {
  schema: "agentlas.science-runtime-boundary.v1";
  invocationRunId: string; checkpointId: string | null; terminal: boolean;
  effects: "settled" | "uncertain"; artifactRefs: string[]; sourceRefs: string[]; pendingEffectRefs: string[];
}
/** Read-only observer. Main validates canonical Science identity; Science owns
 * steering and successor dispatch. The anchor is a real invocation receipt. */
export async function reconcileScienceBoundary(input: ScienceRuntimeBoundaryInput,
  options: { hostLost?: (invocationRunId: string) => boolean } = {}): Promise<ScienceRuntimeBoundary> {
  for (const value of Object.values(input)) if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("science_runtime_boundary_identity_invalid");
  let boundary;
  try { boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId,
    expectedChatId: input.expectedRuntimeChatId, expectedSource: "science" }); }
  catch (error) { throw new Error(error instanceof Error ? error.message.replace("runtime_effect_boundary_", "science_runtime_boundary_") : "science_runtime_boundary_unavailable"); }
  // A run whose host died mid-turn has no terminal ledger row, so the reader calls it non-terminal forever, while the
  // receipt ledger already projects it as interrupted and Science settled the turn that way. Science's forward-only
  // recovery accepts only a terminal boundary, so a killed turn could never recover on its own (live QA 2026-09-24:
  // 43 minutes on science.alive.host-boundary-unsettled until a person pressed Continue). When no live owner exists,
  // the run is terminal and its effects stay uncertain: nothing is inferred to be safe, only a forward successor opens.
  if (!boundary.terminal && options.hostLost?.(input.invocationRunId) === true) {
    return { schema: "agentlas.science-runtime-boundary.v1", invocationRunId: input.invocationRunId, checkpointId: null,
      terminal: true, effects: "uncertain", artifactRefs: boundary.artifactRefs, sourceRefs: boundary.sourceRefs,
      pendingEffectRefs: [...new Set([...boundary.pendingEffectRefs, `invocation:${input.invocationRunId}:host-lost`])].sort() };
  }
  const digest = boundary.snapshotDigest ? createHash("sha256").update(JSON.stringify({ input, snapshotDigest: boundary.snapshotDigest })).digest("hex") : null;
  return { schema: "agentlas.science-runtime-boundary.v1", invocationRunId: input.invocationRunId,
    checkpointId: digest ? `invocation-boundary:${boundary.terminalEventId}:${digest}` : null,
    terminal: boundary.terminal, effects: boundary.effects, artifactRefs: boundary.artifactRefs,
    sourceRefs: boundary.sourceRefs, pendingEffectRefs: boundary.pendingEffectRefs };
}

/**
 * Older Science invocations did not persist `invocationSource` in invoke_started.
 * That omission cannot make an execution settled, but the exact terminal ledger
 * and effect snapshot can still prove that its effects are *uncertain*. This
 * read-only compatibility observer is used only to record a future-only basis.
 */
export async function inspectLegacyForwardRecoveryBoundary(input: ScienceRuntimeBoundaryInput): Promise<ScienceRuntimeBoundary> {
  for (const value of Object.values(input)) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) {
      throw new Error("science_runtime_boundary_identity_invalid");
    }
  }
  const boundary = getDb().transaction(() => {
    const rows = getDb().prepare(`SELECT seq,kind,chat_id,payload_json FROM run_events
      WHERE run_id=? AND kind IN ('invoke_started','invoke_completed','invoke_failed','invoke_threw',
        'invoke_cancelled','invoke_interrupted','runtime_effect_boundary') ORDER BY seq`)
      .all(input.invocationRunId) as Array<{ seq: number; kind: string; chat_id: string | null; payload_json: string }>;
    const starts = rows.filter((row) => row.kind === "invoke_started");
    const terminals = rows.filter((row) => row.kind.startsWith("invoke_") && row.kind !== "invoke_started");
    const effects = rows.filter((row) => row.kind === "runtime_effect_boundary");
    if (starts.length !== 1 || terminals.length !== 1 || effects.length !== 1
      || starts[0].chat_id !== input.expectedRuntimeChatId
      || terminals[0].kind !== "invoke_completed" || terminals[0].chat_id !== input.expectedRuntimeChatId
      || effects[0].chat_id !== input.expectedRuntimeChatId
      || !(starts[0].seq < terminals[0].seq && terminals[0].seq < effects[0].seq)) {
      throw new Error("science_runtime_boundary_legacy_provenance_invalid");
    }
    let started: unknown;
    try { started = JSON.parse(starts[0].payload_json); }
    catch { throw new Error("science_runtime_boundary_legacy_provenance_invalid"); }
    if (!started || typeof started !== "object" || Array.isArray(started)
      || ((started as Record<string, unknown>).invocationSource !== undefined
        && (started as Record<string, unknown>).invocationSource !== null)) {
      throw new Error("science_runtime_boundary_legacy_provenance_invalid");
    }
    const observed = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId,
      expectedChatId: input.expectedRuntimeChatId });
    if (!observed.terminal || observed.terminalEventId === null || observed.receiptEventId === null
      || observed.snapshotDigest === null || observed.effects !== "uncertain"
      || observed.pendingEffectRefs.length === 0) {
      throw new Error("science_runtime_boundary_legacy_not_uncertain");
    }
    return observed;
  })();
  return { schema: "agentlas.science-runtime-boundary.v1", invocationRunId: input.invocationRunId,
    checkpointId: null, terminal: true, effects: "uncertain", artifactRefs: boundary.artifactRefs,
    sourceRefs: boundary.sourceRefs, pendingEffectRefs: boundary.pendingEffectRefs };
}
