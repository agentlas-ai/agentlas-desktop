// The loop of B-lite, separate from mcp/client.ts so it runs with two fake runners (scripts gate). The caller supplies typed
// facts and the switch; this decides nothing about prompts. One move per untried candidate (the caller's `candidate` never
// offers a runtime twice), each one only behind unsettledMoveAllowed.
import { unsettledMoveAllowed, type UnsettledMoveFacts } from "./unsettled-fallback";

export type MoveOutcome<Res> = { ok: true; result: Res } | { ok: false; error: unknown };

export interface UnsettledMovePort<Req, Res> {
  /** One dispatch with its own same-session continuation (it may throw). */
  dispatch(request: Req): Promise<Res>;
  /** The error or failure that ended the turn unsettled (null: it did not), with what the runner's proof read found. */
  inspect(outcome: MoveOutcome<Res>): { endedWith: unknown | null; proofStatus?: string; actionItems?: number };
  /** The facts that do not depend on this outcome. */
  facts(): Pick<UnsettledMoveFacts, "runtimeKind" | "boundaryProvesNoEffect" | "toolEvents" | "runtimeFixed" | "aborted">;
  /** The next untried pool candidate, or null. `commit` switches to it and returns the request to dispatch there. */
  candidate(endedWith: unknown): { commit(proofStatus: string | undefined): Req } | null;
}

export async function dispatchWithUnsettledMove<Req, Res>(port: UnsettledMovePort<Req, Res>, request: Req): Promise<Res> {
  let next = request;
  for (;;) {
    let outcome: MoveOutcome<Res>;
    try { outcome = { ok: true, result: await port.dispatch(next) }; } catch (error) { outcome = { ok: false, error }; }
    const ended = port.inspect(outcome);
    const stay = (): Res => { if (!outcome.ok) throw outcome.error; return outcome.result; };
    if (ended.endedWith === null) return stay();
    const facts: UnsettledMoveFacts = { ...port.facts(), proofStatus: ended.proofStatus, actionItems: ended.actionItems, endedWith: ended.endedWith, candidateAvailable: true };
    if (!unsettledMoveAllowed(facts)) return stay();
    const candidate = port.candidate(ended.endedWith);
    if (!candidate) return stay();
    next = candidate.commit(ended.proofStatus);
  }
}
