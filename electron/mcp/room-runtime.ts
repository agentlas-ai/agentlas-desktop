import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { RunnerFailure } from "../runtime/runner";
import { pinnedRuntimeUnavailableReason } from "../runtime/selection";

/**
 * Owner decision 2026-10-16 ("방에서 고른 모델을 팀원에게도 적용"): the model chip of a One room applies to the
 * room's teammates too — Taskforce workers (direct, nested, escalated retry), firm delegated turns and swarm workers —
 * not only to the orchestrator. Production measured the opposite: the room pinned agentlas-light and every worker
 * still ran the global worker pool (codex gpt-6-luna), so the owner's Light-vs-GPT comparison was invalid.
 *
 * Precedence for a teammate: (a) the member's own explicit model (agent/division/firm override, unchanged), then
 * (b) this room pin, then (c) the global worker pool (a room without a pin is unchanged). The pin is the run's
 * controller runtime (`active`), which already carries the room's model, effort and long-context choice and already
 * follows the controller's own recorded fallback, so teammates never run a different model than the chip shows.
 * Host selection only: no model-facing text.
 */
export interface RoomPinSource {
  req: { oneMode?: boolean; runtimeSelection?: RuntimeSelection | null; agentAppMode?: boolean };
  runtimePinHonored?: boolean;
  active: RuntimeStatus;
  workforceSelectionReceipt?: unknown;
  benchmarkMode?: boolean;
}

export function roomPinnedTeammateRuntime(p: RoomPinSource): RuntimeStatus | null {
  if (p.req.oneMode !== true || p.runtimePinHonored !== true || !p.req.runtimeSelection) return null;
  // Prepared Workforce rosters, Agent Apps and benchmarks already pin their own exact runtime.
  if (p.req.agentAppMode || p.workforceSelectionReceipt || p.benchmarkMode) return null;
  return p.active;
}

/** Typed refusal when the room's pinned runtime cannot take a teammate dispatch now. null = dispatch. */
export function roomRuntimeTeammateRefusal(runtime: RuntimeStatus): RunnerFailure | null {
  const reason = pinnedRuntimeUnavailableReason(runtime);
  if (!reason) return null;
  return {
    kind: "unavailable",
    runtime: runtime.kind,
    source: "marker",
    providerCode: "room_runtime_unavailable_for_teammate",
    message: `room_runtime_unavailable_for_teammate:${reason}:${runtime.model ?? runtime.kind}`,
  };
}
