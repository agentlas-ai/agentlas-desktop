import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import type { RuntimePlanSnapshot } from "../../shared/runtime-plan";
import type { InvocationEffectBoundary } from "../invocation/effect-boundary-reader";

const DEFAULT_CYCLE_MS = 30 * 60_000;
const MIN_CYCLE_MS = 60_000;
const MAX_CYCLE_MS = 24 * 60 * 60_000;

/** A plan's time is descriptive until the same episode's checkpoint and live
 * Main effect receipt bind it to the current Goal. Invalid/stale data retains
 * the existing bounded observation cadence, never an earlier action grant. */
export function ongoingCycleWakeAt(input: {
  now: number; runId: string; goalRevision: number; invocationRunId: string;
  plan: RuntimePlanSnapshot | null; checkpoint: LongRunTaskCheckpoint | null;
  effectBoundary: Pick<InvocationEffectBoundary, "invocationRunId" | "effects" | "snapshotDigest" | "receiptEventId"> | null;
}): string {
  const fallback = new Date(input.now + DEFAULT_CYCLE_MS).toISOString();
  const { plan, checkpoint, effectBoundary: boundary } = input;
  const strategy = plan?.episodeStrategy;
  const wake = strategy?.nextWakeAt;
  const wakeMs = typeof wake === "string" ? Date.parse(wake) : NaN;
  if (!plan || plan.schemaVersion !== "agentlas.runtime-plan.v1" || plan.runId !== input.runId
    || plan.goalRevision !== input.goalRevision || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !strategy || strategy.schemaVersion !== "agentlas.ongoing-episode-strategy.v1"
    || strategy.goalRevision !== input.goalRevision || strategy.invocationRunId !== input.invocationRunId
    || strategy.state === "unknown" || strategy.nextAction !== "wait_observe"
    || !checkpoint || checkpoint.schemaVersion !== "agentlas.task-checkpoint.v2"
    || checkpoint.capsule.runId !== input.runId || checkpoint.capsule.plan?.revision !== plan.revision
    || checkpoint.goalRevision !== input.goalRevision || checkpoint.invocationRunId !== input.invocationRunId
    || checkpoint.disposition !== "cycle_completed" || checkpoint.sideEffects.state !== "settled"
    || checkpoint.sideEffects.boundary?.invocationRunId !== input.invocationRunId
    || !boundary || boundary.invocationRunId !== input.invocationRunId || boundary.effects !== "settled"
    || !boundary.snapshotDigest || !boundary.receiptEventId
    || strategy.effectBoundaryDigest !== boundary.snapshotDigest
    || strategy.effectReceiptEventId !== boundary.receiptEventId
    || checkpoint.sideEffects.boundary.snapshotDigest !== boundary.snapshotDigest
    || checkpoint.sideEffects.boundary.receiptEventId !== boundary.receiptEventId
    || !Number.isFinite(wakeMs) || wakeMs < input.now + MIN_CYCLE_MS
    || wakeMs > input.now + MAX_CYCLE_MS || wake !== new Date(wakeMs).toISOString()) return fallback;
  return wake;
}
