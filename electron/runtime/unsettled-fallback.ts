// B-lite: when a turn ended without its receipt AND the same-session continuation ended the same way, the request may go to the
// role pool's next candidate, but only on proof that nothing acted: the effect boundary shows no tool event and a complete
// ledger, the owner did not fix the runtime, the pool has another candidate and no serving settlement is open. Every missing
// fact keeps today's ending (the earlier-attempt resend). Pure; the caller supplies the facts.
import { typedCodeChain } from "../../shared/turn-settlement";

/** Runtimes whose runner reads proof of an unsettled turn (codex-turn-proof.ts). The others report no proof and never move. */
export const UNSETTLED_PROOF_RUNTIMES: ReadonlySet<string> = new Set(["codex"]);

const NEVER_MOVE_CODES: ReadonlySet<string> = new Set(["serving_reconciliation_required", "automation_no_progress_loop"]);

export interface UnsettledMoveFacts {
  runtimeKind: string;
  /** effectBoundary.provesNoOutsideEffect(): a covered adapter, a complete ledger, no tool event of any kind. */
  boundaryProvesNoEffect: boolean;
  /** Tool events counted by the dispatches of this invocation (the notification stream; it is the stream that broke). */
  toolEvents: number;
  /** What the runner's proof read found for the turn: its status, and the action items codex's own record holds. Unread = no move. */
  proofStatus?: string;
  actionItems?: number;
  /** The owner (or an automation, a Science run, a Goal checkpoint) fixed the runtime. */
  runtimeFixed: boolean;
  /** The role pool holds an untried candidate. */
  candidateAvailable: boolean;
  aborted: boolean;
  /** The error or failure that ended the turn, for its machine-code chain. */
  endedWith: unknown;
}

export function unsettledMoveAllowed(facts: UnsettledMoveFacts): boolean {
  if (facts.aborted || facts.runtimeFixed || !facts.candidateAvailable) return false;
  if (!UNSETTLED_PROOF_RUNTIMES.has(facts.runtimeKind)) return false;
  if (!facts.boundaryProvesNoEffect || facts.toolEvents !== 0) return false;
  // The stream that counted zero is the stream that broke: only codex's own record of the turn can say nothing ran.
  if (!facts.proofStatus || facts.proofStatus === "indeterminate" || facts.actionItems !== 0) return false;
  return !typedCodeChain(facts.endedWith).some((code) => NEVER_MOVE_CODES.has(code));
}
