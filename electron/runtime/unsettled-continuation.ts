// One same-session continuation for a turn that ended without its terminal event. Runtime-agnostic by construction: it
// reads only typed facts (RuntimeTurnUnsettledError, ownerControlTerminal, the typed failure code, a session id, the
// turn's RuntimeTurnDelivery) and names
// no CLI, tool or cause. See the comment at its single call site, mcp/client.ts invokeCurrentRuntime.
import { RuntimeTurnUnsettledError, RUNTIME_TURN_UNSETTLED_CODE, type RunnerFailure, type RunnerResult, type RuntimeTurnDelivery } from "./runner";
import { decideTurnSettlement } from "../../shared/turn-settlement";
import { isTransientExternalFailure, TRANSIENT_CONTINUATION_DELAY_MS } from "../../shared/transient-provider-failure";
import type { AgentContextUnsettledTurn } from "./agent-context";
import { isContextOverflowFailure } from "./session-generation";

/** Host-authored (purpose "run-recovery", compacted on replay); names no tool, runtime or cause. */
export const UNSETTLED_CONTINUATION_PROMPT = "previous turn: no completion signal. Check history, finish what remains, repeat nothing done.";

/**
 * Whether the continuation carries the interrupted turn's own request (and its images). The session holds that request
 * only when it acknowledged the turn ("accepted", a protocol receipt): then the original contract stands, the request is
 * not re-sent and the model finishes from its history. Without that receipt ("not-accepted", or a runner that cannot
 * tell) the request may never have reached the resumed conversation: the fixed line alone then made the model report
 * "nothing remains" for a question it never saw (owner 2026-10-16, every follow-up of one Work chat), so it rides along.
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
  /** Whether the LAST dispatch ran a tool (any tool event). Absent: unknown, so a context-overflow retry is not made. */
  toolRan?(): boolean;
  /** `proof`: the status the runner's proof read found for the turn that ended without a receipt (diagnostics only). */
  record(phase: "dispatched" | "settled" | "unsettled" | "not_resumable" | "context_overflow_rotated" | "moved", delivery?: RuntimeTurnDelivery,
    cause?: "provider_transient", proof?: string): void;
  /**
   * Waits `ms` before a continuation that follows a transient cause outside the app (shared/transient-provider-failure.ts),
   * telling the owner why. Resolves early on the owner's stop. Absent: the continuation goes at once.
   */
  wait?(ms: number): Promise<void>;
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
    // A transient cause outside the app after dispatch (the provider at capacity, a lost stream, a stalled stream the host
    // ended) leaves the turn's work in its session exactly as a missing receipt does: it continues there once. Every other
    // typed failure (quota, sign-in, refusal, an unsupported request) is that failure and never a continuation.
    return !o.result.failure || o.result.failure.providerCode === RUNTIME_TURN_UNSETTLED_CODE || isTransientExternalFailure(o.result.failure);
  };
  /** The typed failure of an outcome, whether the runner returned it or threw it as the cause of an unsettled turn. */
  const failureOf = (o: UnsettledOutcome): RunnerFailure | undefined => {
    if (o.ok) return o.result.failure;
    const cause = (o.error as { cause?: unknown } | null)?.cause;
    const failure = cause && typeof cause === "object" && "failure" in cause ? (cause as { failure?: unknown }).failure : cause;
    return failure && typeof failure === "object" ? failure as RunnerFailure : undefined;
  };
  /** The first dispatch ended on a transient cause outside the app: returned as a typed failure, or the cause of the thrown unsettled turn. */
  const transient = (o: UnsettledOutcome): boolean => {
    const failure = failureOf(o);
    return Boolean(failure && isTransientExternalFailure(failure));
  };
  /** The status of the proof read behind an outcome (the runner returned or threw it), when the runner made one. */
  const proofOf = (o: UnsettledOutcome): string | undefined => {
    const value = o.ok ? o.result.turnProof : (o.error as { proof?: unknown } | null)?.proof;
    return typeof value === "string" ? value : undefined;
  };
  /** The action items codex's record shows for an outcome (a thrown unsettled turn or a returned result); undefined = not read. */
  const actionsOf = (o: UnsettledOutcome): number | undefined => {
    const value = o.ok ? o.result.turnActionItems : (o.error as { actionItems?: unknown } | null)?.actionItems;
    return typeof value === "number" ? value : undefined;
  };
  /**
   * What surfaces when both dispatches ended unsettled carries the actions of BOTH (the larger count), and "not read" if either
   * dispatch's record was not read: the continuation turn may have acted quietly, and the first dispatch's proof says nothing of it.
   */
  const surfaceBoth = (a: UnsettledOutcome, b: UnsettledOutcome): RunnerResult => {
    const x = actionsOf(a), y = actionsOf(b);
    const combined = x === undefined || y === undefined ? undefined : Math.max(x, y);
    if (!a.ok) {
      const error = a.error as { actionItems?: number } | null;
      if (error && typeof error === "object") { if (combined === undefined) delete error.actionItems; else error.actionItems = combined; }
      throw a.error;
    }
    if (combined === x) return a.result; // nothing to add: the very outcome that surfaced before
    const { turnActionItems: _drop, ...rest } = a.result;
    return combined === undefined ? rest : { ...rest, turnActionItems: combined };
  };
  let first = await run(request, hostAuthored);
  /*
   * A turn that ended on the model's own context-window failure (shared typed codes, session-generation.ts): the conversation's native
   * session is retired (decideGeneration symptom "context_overflow": the next session is seeded from the journal within continuity.ts's
   * budget) and the turn runs once more in it. With no tool run, that is the SAME turn; after a tool ran the journal already holds its
   * calls as ledger lines, so only the existing continuation line goes (nothing is repeated beyond the continuation contract). One
   * retry, structurally; its outcome then takes the ordinary path below (a retry that ends unsettled still gets the same-session
   * continuation, a second overflow keeps the existing capacity line). No marker is stored.
   */
  if (port.eligible && !port.aborted() && isContextOverflowFailure(failureOf(first)) && port.toolRan) {
    const left = port.leftBehind();
    if (left) {
      const toolRan = port.toolRan();
      // A request sent again (nothing ran) is shown once in replay; after a tool ran the failed turn stays whole: it is what the continuation line refers to.
      left.retire("context_overflow", toolRan ? undefined : { requestResent: true });
      port.record("context_overflow_rotated", first.ok ? first.result.turnDelivery : undefined);
      first = toolRan
        ? await run(port.continuationRequest(request, undefined, "accepted"), "run-recovery")
        : await run(request, hostAuthored); // the owner's request keeps its own authorship; only the continuation line is host-authored
      if (isContextOverflowFailure(failureOf(first))) port.leftBehind()?.retire("context_overflow");
    }
  }
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
    port.record("not_resumable", delivery, undefined, proofOf(first));
    return surface(first);
  }
  const waitFirst = transient(first);
  port.record("dispatched", delivery, waitFirst ? "provider_transient" : undefined, proofOf(first));
  if (waitFirst && port.wait) {
    await port.wait(TRANSIENT_CONTINUATION_DELAY_MS);
    // The owner stopped the turn while it waited: that stop is the outcome, nothing more is sent.
    if (port.aborted()) return surface(first);
  }
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
  port.record("unsettled", delivery, undefined, proofOf(next) ?? proofOf(first));
  return surfaceBoth(first, next);
}
