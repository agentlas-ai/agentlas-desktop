import { createHash } from "node:crypto";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

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
export async function reconcileScienceBoundary(input: ScienceRuntimeBoundaryInput): Promise<ScienceRuntimeBoundary> {
  for (const value of Object.values(input)) if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("science_runtime_boundary_identity_invalid");
  let boundary;
  try { boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId,
    expectedChatId: input.expectedRuntimeChatId, expectedSource: "science" }); }
  catch (error) { throw new Error(error instanceof Error ? error.message.replace("runtime_effect_boundary_", "science_runtime_boundary_") : "science_runtime_boundary_unavailable"); }
  const digest = boundary.snapshotDigest ? createHash("sha256").update(JSON.stringify({ input, snapshotDigest: boundary.snapshotDigest })).digest("hex") : null;
  return { schema: "agentlas.science-runtime-boundary.v1", invocationRunId: input.invocationRunId,
    checkpointId: digest ? `invocation-boundary:${boundary.terminalEventId}:${digest}` : null,
    terminal: boundary.terminal, effects: boundary.effects, artifactRefs: boundary.artifactRefs,
    sourceRefs: boundary.sourceRefs, pendingEffectRefs: boundary.pendingEffectRefs };
}
