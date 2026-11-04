/**
 * Invocation runs the host decided are NOT their chat's Goal episode (service.ts goal_dispatch_ordinary_turn: the owner's
 * message to a paused, blocked or waiting Goal, a turn whose resume could not apply, a background-service turn). The common
 * runner boundary (durable-retry.ts) binds a provider call to the chat's Goal by chat alone, so it refused exactly these turns
 * because the Goal was not running: the owner's phone message to a stopped Goal's room failed before any runtime ran
 * (Thread Marketing room). Process-local and bounded: the decision and the runner live in the same process.
 */
const ORDINARY_TURN_TTL_MS = 6 * 60 * 60_000;
const MAX_ORDINARY_TURNS = 512;
const ordinary = new Map<string, number>();

export function markOrdinaryGoalTurn(runId: string, now = Date.now()): void {
  if (!runId) return;
  for (const [id, at] of ordinary) if (now - at > ORDINARY_TURN_TTL_MS) ordinary.delete(id);
  ordinary.set(runId, now);
  while (ordinary.size > MAX_ORDINARY_TURNS) ordinary.delete(ordinary.keys().next().value!);
}

export function isOrdinaryGoalTurn(runId: string | null | undefined, now = Date.now()): boolean {
  if (!runId) return false;
  const at = ordinary.get(runId);
  return at !== undefined && now - at <= ORDINARY_TURN_TTL_MS;
}

/** The run settled: its decision is no longer needed. */
export function clearOrdinaryGoalTurn(runId: string): void {
  ordinary.delete(runId);
}
