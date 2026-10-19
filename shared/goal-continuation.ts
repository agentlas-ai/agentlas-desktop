/**






 */
export const ALIVE_CONTINUABLE_PAUSE_REASONS: ReadonlySet<string> = new Set(["agent_paused", "runtime_unavailable", "app_closed", "crash_recovery"]);

export function goalContinuationAdmissible(status: string, pauseReason: string | null | undefined): boolean {
  return status === "blocked" || (status === "paused" && ALIVE_CONTINUABLE_PAUSE_REASONS.has(pauseReason ?? ""));
}
