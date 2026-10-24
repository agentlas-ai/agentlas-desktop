/**
 * When the host can continue a Goal now: the one rule the Alive/AGI `goal.continue` path applies
 * (electron/long-run/blocked-goal-sweep.ts continueGoalForAlive) and the AGI classifier offers
 * (electron/agi/blocker.ts). A blocked Goal goes through the blocked-goal sweep; a paused Goal only for a host
 * pause. Anything else (waiting_tool on a registered wait, running, an owner pause, a budget stop) is deferred
 * by the host, so offering "start a work turn" there only produced refusals the AGI model then filed as defects
 * (agi.turn.deferred_repeated_with_eligible_tactics 2026-10-05 16:11 UTC, agi.eligibility.assignment_mismatch 22:08).
 */
export const ALIVE_CONTINUABLE_PAUSE_REASONS: ReadonlySet<string> = new Set(["agent_paused", "runtime_unavailable", "app_closed", "crash_recovery"]);

export function goalContinuationAdmissible(status: string, pauseReason: string | null | undefined): boolean {
  return status === "blocked" || (status === "paused" && ALIVE_CONTINUABLE_PAUSE_REASONS.has(pauseReason ?? ""));
}
