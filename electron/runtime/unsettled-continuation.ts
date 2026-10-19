// One same-session continuation for a turn that ended without its terminal event. Runtime-agnostic by construction: it
// reads only typed facts (RuntimeTurnUnsettledError, ownerControlTerminal, the typed failure code, a session id, the
// turn's RuntimeTurnDelivery) and names
// no CLI, tool or cause. See the comment at its single call site, mcp/client.ts invokeCurrentRuntime.
import { RuntimeTurnUnsettledError, RUNTIME_TURN_UNSETTLED_CODE, type RunnerResult, type RuntimeTurnDelivery } from "./runner";
import { decideTurnSettlement } from "../../shared/turn-settlement";
import type { AgentContextUnsettledTurn } from "./agent-context";

/** Host-authored (purpose "run-recovery", compacted on replay); names no tool, runtime or cause. */
export const UNSETTLED_CONTINUATION_PROMPT = "previous turn: no completion signal. Check history, finish what remains, repeat nothing done.";

/**





 */
export function unsettledContinuationCarriesRequest(delivery: RuntimeTurnDelivery | undefined): boolean {
  // The one settlement decision (shared/turn-settlement.ts) owns this rule; a resumable unsettled turn continues in its
  // session and re-sends its request unless that session acknowledged it.
  if (delivery === "not-dispatched") return true;
  const decision = decideTurnSettlement({ outcome: "unsettled", delivery, unattended: false, attempt: 0, resumeBudget: 1, resumable: true });
  return decision.action === "continue-same-session" && decision.resendOriginal;
}

/**
 * The continuation turn's prompt: the fixed line, then (unsettledContinuationCarriesRequest) the turn's own request,
 * which the model answers only when its history has no reply to it.
 */
export function unsettledContinuationPrompt(turnRequest: string | undefined, delivery?: RuntimeTurnDelivery): string {
  const request = unsettledContinuationCarriesRequest(delivery) ? turnRequest?.trim() : "";
  return request
    ? `${UNSETTLED_CONTINUATION_PROMPT}\nthat turn's request (reply to it now if history has no reply to it):\n${request}`
    : UNSETTLED_CONTINUATION_PROMPT;
}

export type UnsettledOutcome = { ok: true; result: RunnerResult } | { ok: false; error: unknown };

export interface UnsettledContinuationPort<Req> {
  /** One dispatch; the caller keeps its own custody, accounting and authority exactly as for any other attempt. */
  dispatch(request: Req, hostAuthored?: string, continuationHandle?: string): Promise<RunnerResult>;
  /** The continuation request: the same request with the host's own prompt and the resumed session id. `delivery` is
   * what the first dispatch observed (RuntimeTurnDelivery); unset when the runner could not tell. */
  continuationRequest(request: Req, sessionId: string | undefined, delivery: RuntimeTurnDelivery | undefined): Req;
  /** False for host judgments, Alive decisions and fresh recovery episodes. */
  eligible: boolean;
  /** Owner stop / abort. */
  aborted(): boolean;
  /** A closed HTTP refusal or a locally rejected dispatch of the LAST dispatch: no model work happened. */
  noModelWork(): boolean;
  /** What the LAST dispatch's journal turn left behind (null when it was not a journal turn). */
  leftBehind(): AgentContextUnsettledTurn | null;
  record(phase: "dispatched" | "settled" | "unsettled" | "not_resumable", delivery?: RuntimeTurnDelivery): void;
}

export async function invokeWithUnsettledContinuation<Req>(port: UnsettledContinuationPort<Req>, request: Req,
  hostAuthored?: string): Promise<RunnerResult> {
  const run = async (r: Req, purpose?: string, handle?: string): Promise<UnsettledOutcome> => {
    try { return { ok: true, result: await port.dispatch(r, purpose, handle) }; } catch (error) { return { ok: false, error }; }
  };
  const surface = (o: UnsettledOutcome): RunnerResult => { if (!o.ok) throw o.error; return o.result; };
  const unsettled = (o: UnsettledOutcome): boolean => {
    if (!port.eligible || port.aborted()) return false;
    if (!o.ok) return o.error instanceof RuntimeTurnUnsettledError;
    // A typed pre-dispatch refusal (RuntimeTurnDelivery "not-dispatched") is that failure: nothing to continue.
    if (o.result.ownerControlTerminal === "completed" || o.result.turnDelivery === "not-dispatched" || port.noModelWork()) return false;
    return !o.result.failure || o.result.failure.providerCode === RUNTIME_TURN_UNSETTLED_CODE;
  };
  const first = await run(request, hostAuthored);
  if (!unsettled(first)) return surface(first);
  const left = port.leftBehind();
  const thrown = !first.ok && first.error instanceof RuntimeTurnUnsettledError ? first.error : null;
  const handle = (first.ok ? first.result.sessionId : undefined) ?? thrown?.sessionId ?? left?.handle ?? undefined;
  // A typed protocol fact from the first dispatch, never prose: did the session acknowledge that turn?
  const delivery = thrown?.turnDelivery ?? (first.ok ? first.result.turnDelivery : undefined);
  // The one settlement decision: one same-session continuation when the conversation can be resumed, else surface.
  const decision = decideTurnSettlement({ outcome: "unsettled", delivery, unattended: false, attempt: 0, resumeBudget: 1,
    resumable: Boolean(left ? left.resumable || handle : handle) });
  if (decision.action !== "continue-same-session") {
    left?.retire();
    port.record("not_resumable");
    return surface(first);
  }
  port.record("dispatched", delivery);
  const next = await run(port.continuationRequest(request, handle, delivery), "run-recovery", handle);
  // A definite refusal (owner stop, budget, custody) is that failure, not the first turn's unknown.
  if (!next.ok && !unsettled(next)) throw next.error;
  if (next.ok && !unsettled(next)) {
    port.record("settled");
    const earlier = first.ok ? first.result.text.trim() : "";
    return earlier && !next.result.failure
      ? { ...next.result, text: [earlier, next.result.text].filter((part) => part && part.trim()).join("\n\n") }
      : next.result;
  }
  port.leftBehind()?.retire();
  left?.retire();
  port.record("unsettled");
  return surface(first);
}
