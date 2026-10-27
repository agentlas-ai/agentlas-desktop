import { getDb } from "../store/db";

/**
 * Durable placement facts of an invocation run, written by mcp/client.ts and read by the send queue
 * (pending-chat-sends.ts) to decide whether a queued owner message reached the runtime's conversation.
 *
 * - RUNTIME_TURN_PLACED_EVENT, once per run: the first protocol fact that the turn reached the runtime (the native turn
 *   ACK, model output of this turn, or a terminal the runner reports accepted/completed). Never a dispatch alone.
 * - RUNTIME_TURN_ATTEMPT_EVENT, once per runner attempt: `delivery` "not-dispatched" when the attempt provably sent
 *   nothing (the runner was never entered, or it raised/returned the typed pre-dispatch refusal, runner.ts
 *   RuntimeTurnDelivery), otherwise "dispatched" (sent, acceptance unknown unless a placed event exists).
 *
 * No prose is read. Electron-free: the daemon host writes and reads the same rows.
 */
export const RUNTIME_TURN_PLACED_EVENT = "runtime_turn_placed";
export const RUNTIME_TURN_ATTEMPT_EVENT = "runtime_turn_attempt";

/** "placed": proven in the conversation. "not-dispatched": every attempt provably sent nothing. "unconfirmed": neither. */
export type RunTurnPlacement = "placed" | "not-dispatched" | "unconfirmed";

export function readRunTurnPlacement(runId: string): RunTurnPlacement {
  if (!runId) return "unconfirmed";
  const rows = getDb().prepare(`SELECT kind, payload_json FROM run_events WHERE run_id = ? AND kind IN (?, ?) ORDER BY seq ASC`)
    .all(runId, RUNTIME_TURN_PLACED_EVENT, RUNTIME_TURN_ATTEMPT_EVENT) as Array<{ kind: string; payload_json: string | null }>;
  if (rows.some((row) => row.kind === RUNTIME_TURN_PLACED_EVENT)) return "placed";
  const attempts = rows.filter((row) => row.kind === RUNTIME_TURN_ATTEMPT_EVENT).map((row) => {
    try { return (JSON.parse(row.payload_json ?? "{}") as { delivery?: unknown }).delivery; } catch { return undefined; }
  });
  // No attempt row at all is not proof of non-delivery: a team, swarm or firm path may have sent the turn without
  // passing the direct runner (its own placement is unknown here), so only "every attempt refused" counts.
  return attempts.length > 0 && attempts.every((delivery) => delivery === "not-dispatched") ? "not-dispatched" : "unconfirmed";
}

/**
 * Whether a model may have read this run's prompt: a placed fact, or any attempt not recorded as refused before dispatch.
 * A run with no recorded attempt (a team or swarm path, a runner that records none) is not "read" by this ledger; the
 * caller's own typed proof that the terminal failure sent nothing decides there (service.ts turnProvedNotDispatched).
 */
export function runTurnMayHaveBeenRead(runId: string): boolean {
  if (!runId) return true;
  const rows = getDb().prepare(`SELECT kind, payload_json FROM run_events WHERE run_id = ? AND kind IN (?, ?) ORDER BY seq ASC`)
    .all(runId, RUNTIME_TURN_PLACED_EVENT, RUNTIME_TURN_ATTEMPT_EVENT) as Array<{ kind: string; payload_json: string | null }>;
  return rows.some((row) => {
    if (row.kind === RUNTIME_TURN_PLACED_EVENT) return true;
    try { return (JSON.parse(row.payload_json ?? "{}") as { delivery?: unknown }).delivery !== "not-dispatched"; } catch { return true; }
  });
}
