import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { TurnLineTurn, TurnLineWho } from "./agent-context-turn-line";

/** ESRCH is positive evidence of death; access denial and every unknown process error preserve the lease. */
function processIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as { code?: unknown })?.code === "ESRCH"; }
}

/** A shared-session waiter may release one dead holder's exact lease, never all leases of its host kind. */
export function releaseDeadSessionTurn(
  holder: { who: TurnLineWho; turn: TurnLineTurn },
  ports: {
    current(): { ownerId: string; ownerKind: string; pid: number };
    getOwner(chatId: string, runId: string): InvocationRunOwner | null;
    release(expected: InvocationRunOwner): boolean;
    processGone?(pid: number): boolean;
  },
): boolean {
  const { who, turn } = holder, current = ports.current();
  if (!Number.isSafeInteger(who.pid) || who.pid <= 0 || who.pid === current.pid || who.ownerId === current.ownerId || !turn.leaseId) return false;
  const gone = ports.processGone ?? processIsGone;
  if (!gone(who.pid)) return false;
  const owner = ports.getOwner(turn.chatId, turn.runId);
  if (!owner || owner.state === "released" || owner.ownerId !== who.ownerId || owner.ownerKind !== who.ownerKind || owner.leaseId !== turn.leaseId) return false;
  // Recheck immediately before the store's compare-and-swap; a reused PID or changed lease must stay owned.
  if (!gone(who.pid)) return false;
  return ports.release(owner);
}
