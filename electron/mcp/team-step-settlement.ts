/*
 * One team step that did not complete (a room teammate, a nested team's worker, a firm node, a swarm worker, the room's
 * synthesis) never discards the owner turn (owner rule 2026-10-13: no output-cap termination; production 1.3.49 run
 * 5d37e4cc, 2026-10-16: four teammates finished, the fifth hit codex `max_output_tokens` after acceptance, the whole
 * owner turn failed after 3h10m and the finished work never reached the owner).
 *
 * The decision is the shared one (docs 31 W1, shared/turn-settlement.ts decideTurnSettlement), fed from typed facts only
 * (RunnerResult.turnDelivery, the typed RunnerFailure, the session id, the RuntimeTurnUnsettledError identity; never
 * prose); a typed output-limit cut proves the model ran, so it enters as an acknowledged unsettled turn:
 *  - an unsettled turn with a resumable session continues ONCE in that session (the host's fixed continuation line; the
 *    step's request rides along only when the session never acknowledged it);
 *  - throttling that did no work retries the same request after the provider's wait, within the shared bound;
 *  - anything else surfaces unchanged ("recover" is the room's own runtime-pool recovery above this layer): the caller
 *    marks the step FAILED with its typed cause (teamStepFailureNote) and the room still synthesizes over the rest.
 * Pure apart from observed-runner's returned-result lookup; no Electron.
 */
import {
  RuntimeTurnUnsettledError, RUNTIME_TURN_UNSETTLED_CODE, runnerRefusedBeforeDispatch,
  type RunnerFailure, type RunnerRequest, type RunnerResult, type RuntimeTurnDelivery,
} from "../runtime/runner";
import { observedRunnerReturnedResult } from "../runtime/observed-runner";
import { unsettledContinuationPrompt } from "../runtime/unsettled-continuation";
import { carryRunnerTurnContext, replaceRunnerUserPrompt } from "../runtime/runner-turn-context-binding";
import { decideTurnSettlement, RATE_LIMIT_MAX_RETRIES, type TurnFailureKind } from "../../shared/turn-settlement";

/** The fields of the shared TurnSettlementInput this layer can supply. */
export interface TeamStepSettlementInput {
  /** "unsettled": dispatched, no terminal receipt (a typed output-limit cut is reported as unsettled + "accepted"). */
  outcome: "failed" | "unsettled" | "cancelled";
  delivery?: RuntimeTurnDelivery;
  kind?: string;
  providerCode?: string;
  /** A session id resumes the same conversation. */
  resumable: boolean;
  /** Continuations or resends this step may still use. */
  resumeBudget: number;
  /** Same-request retries already spent. */
  attempt: number;
}

export type TeamStepSettlementDecision =
  | { action: "continue-same-session"; resendOriginal: boolean }
  | { action: "retry"; delayMs: number }
  | { action: "surface" };

/**
 * Typed cut by the output-token cap: a provider-owned machine code naming an output limit (local_output_limit_exceeded,
 * the Responses/Claude reason max_output_tokens, …). Code shape only, never prose.
 */
export function isOutputLimitCode(code: string | null | undefined): boolean {
  return typeof code === "string" && /(?:^|_)(?:output_limit|max_output_tokens)(?:_|$)/.test(code);
}

const TURN_FAILURE_KINDS: ReadonlySet<string> = new Set<TurnFailureKind>(
  ["quota", "rate_limit", "auth", "refused", "empty", "exit", "timeout", "unavailable", "unsupported"]);

/**
 * The shared decision for an unattended team step. "fresh-session" (an idempotent resend) runs the step again as it was;
 * "recover" (another candidate) is the room's pool recovery above this layer, so here it surfaces.
 */
export function decideTeamStepSettlement(input: TeamStepSettlementInput): TeamStepSettlementDecision {
  const decision = decideTurnSettlement({
    outcome: input.outcome,
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.kind && TURN_FAILURE_KINDS.has(input.kind) ? { kind: input.kind as TurnFailureKind } : {}),
    ...(input.providerCode ? { providerCode: input.providerCode } : {}),
    unattended: true,
    attempt: input.attempt,
    resumeBudget: input.resumeBudget,
    resumable: input.resumable,
    fallbackAvailable: false,
  });
  if (decision.action === "continue-same-session") return { action: "continue-same-session", resendOriginal: decision.resendOriginal };
  if (decision.action === "retry") return { action: "retry", delayMs: decision.delayMs };
  if (decision.action === "fresh-session") return { action: "retry", delayMs: 0 };
  return { action: "surface" };
}

/** What one dispatch outcome proves, read from typed fields only. */
export interface TeamStepFacts {
  settled: boolean;
  aborted: boolean;
  unsettled: boolean;
  delivery: RuntimeTurnDelivery | null;
  sessionId: string | null;
  failure: { kind: string; providerCode: string | null } | null;
  /** The error's own machine code when it carries one (task_force_runtime_failure, worker_capabilities_*, …). */
  errorCode: string | null;
  /** The text the runner returned with this outcome (a cut reply's partial text). */
  text: string;
}

type Outcome = { ok: true; result: RunnerResult } | { ok: false; error: unknown };

const CODE_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
function field(value: unknown, name: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return (value as Record<string, unknown>)[name]; } catch { return undefined; }
}
function typedCode(value: unknown): string | null {
  return typeof value === "string" && value.length <= 96 && CODE_RE.test(value) ? value : null;
}
function deliveryOf(value: unknown): RuntimeTurnDelivery | null {
  return value === "accepted" || value === "not-accepted" || value === "not-dispatched" ? value : null;
}
function sessionOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 256 ? value : null;
}
function failureOf(value: unknown): TeamStepFacts["failure"] {
  const kind = field(value, "kind");
  return typeof kind === "string" && kind ? { kind, providerCode: typedCode(field(value, "providerCode")) } : null;
}
/** The RunnerResult a thrown error carries: observed-runner's returned result, else a result-shaped standard `cause`. */
function returnedResultOf(error: unknown): RunnerResult | null {
  const observed = observedRunnerReturnedResult(error);
  if (observed) return observed as RunnerResult;
  const cause = field(error, "cause");
  return cause && typeof field(cause, "text") === "string" ? cause as RunnerResult : null;
}

export function readTeamStepFacts(outcome: Outcome, aborted: boolean): TeamStepFacts {
  if (outcome.ok) {
    const result = outcome.result;
    const failure = failureOf(result.failure);
    return {
      settled: !result.failure, aborted, unsettled: failure?.providerCode === RUNTIME_TURN_UNSETTLED_CODE,
      delivery: deliveryOf(result.turnDelivery), sessionId: sessionOf(result.sessionId), failure, errorCode: null,
      text: typeof result.text === "string" ? result.text : "",
    };
  }
  const error = outcome.error;
  const returned = returnedResultOf(error);
  const failure = failureOf(returned?.failure) ?? failureOf(field(error, "failure"));
  const errorCode = typedCode(field(error, "code"));
  const unsettled = error instanceof RuntimeTurnUnsettledError || errorCode === RUNTIME_TURN_UNSETTLED_CODE
    || failure?.providerCode === RUNTIME_TURN_UNSETTLED_CODE;
  return {
    settled: false, aborted, unsettled,
    delivery: runnerRefusedBeforeDispatch(error) ? "not-dispatched"
      : deliveryOf(field(error, "turnDelivery")) ?? deliveryOf(returned?.turnDelivery),
    sessionId: sessionOf(field(error, "sessionId")) ?? sessionOf(returned?.sessionId),
    failure, errorCode, text: typeof returned?.text === "string" ? returned.text : "",
  };
}

/** The decision input for one outcome. A typed output-limit cut proves the model ran: an accepted, unsettled turn. */
export function teamStepSettlementInput(facts: TeamStepFacts, used: { continued: boolean; retries: number }): TeamStepSettlementInput {
  const outputLimit = isOutputLimitCode(facts.failure?.providerCode);
  return {
    outcome: facts.aborted ? "cancelled" : facts.unsettled || outputLimit ? "unsettled" : "failed",
    ...(outputLimit ? { delivery: "accepted" as const } : facts.delivery ? { delivery: facts.delivery } : {}),
    ...(facts.failure ? { kind: facts.failure.kind } : {}),
    ...(facts.failure?.providerCode ? { providerCode: facts.failure.providerCode } : {}),
    resumable: Boolean(facts.sessionId),
    resumeBudget: used.continued ? 0 : 1,
    attempt: used.retries,
  };
}

/** The typed cause of a step the room marks FAILED. Machine values only; the owner copy is written by the host. */
export interface TeamStepFailureNote {
  settlement: "unsettled" | "failed" | "not-dispatched";
  kind: string | null;
  code: string | null;
  delivery: RuntimeTurnDelivery | null;
  continued: boolean;
  retried: boolean;
}

interface Trail { facts: TeamStepFacts; continued: boolean; retried: boolean }
const trails = new WeakMap<object, Trail>();
function mark<T>(value: T, trail: Trail): T {
  if (value && (typeof value === "object" || typeof value === "function")) trails.set(value as object, trail);
  return value;
}

function noteFrom(facts: TeamStepFacts, continued: boolean, retried: boolean): TeamStepFailureNote {
  const code = facts.failure?.providerCode ?? (facts.unsettled ? RUNTIME_TURN_UNSETTLED_CODE : facts.errorCode);
  return {
    settlement: facts.delivery === "not-dispatched" ? "not-dispatched" : facts.unsettled ? "unsettled" : "failed",
    kind: facts.failure?.kind ?? null,
    code: code ?? null,
    delivery: facts.delivery,
    continued,
    retried,
  };
}

/**
 * The typed cause of a failed step, from the value a step surfaced (an error, possibly wrapped through its standard
 * `cause`, or a returned result with a typed failure). The first dispatch's facts and the policy's own trail win.
 */
export function teamStepFailureNote(value: unknown): TeamStepFailureNote | null {
  let current: unknown = value;
  let first: TeamStepFacts | null = null;
  for (let depth = 0; depth < 6 && current && (typeof current === "object" || typeof current === "function"); depth += 1) {
    const trail = trails.get(current as object);
    if (trail) return noteFrom(trail.facts, trail.continued, trail.retried);
    first ??= readTeamStepFacts(
      field(current, "text") !== undefined && field(current, "message") === undefined
        ? { ok: true, result: current as RunnerResult } : { ok: false, error: current }, false);
    current = field(current, "cause");
  }
  return first && !first.settled ? noteFrom(first, false, false) : null;
}

/**
 * The continuation turn, built exactly as the owner turn's (mcp/client.ts invokeCurrentRuntime continuationRequest): same
 * request and the resumed session id; the host's fixed line, with the step's own request (and images) only when the
 * session never acknowledged it.
 */
export function teamStepContinuationRequest(request: RunnerRequest, sessionId: string, resendOriginal: boolean): RunnerRequest {
  const next = replaceRunnerUserPrompt(request, unsettledContinuationPrompt(request.userPrompt, resendOriginal ? "not-accepted" : "accepted"),
    resendOriginal ? {} : { images: undefined });
  return carryRunnerTurnContext(next, { ...next, runtimeSessionId: sessionId });
}

export type TeamStepSettlementPhase = "continued" | "continuation_settled" | "continuation_failed" | "retried" | "surfaced";

export interface TeamStepSettlementPort {
  /** The step's request exactly as the host built it for this runtime. */
  request: RunnerRequest;
  /** One dispatch with the caller's runner, events, custody and accounting (runObservedRunner). */
  dispatch(request: RunnerRequest): Promise<RunnerResult>;
  /** False where a request object carries bound identity a copy would lose (Agent Apps' memory binding). */
  eligible: boolean;
  aborted(): boolean;
  record?(phase: TeamStepSettlementPhase, note: TeamStepFailureNote): void;
}

/**
 * Run one step under the bounded policy. Returns or throws exactly what the surfaced dispatch returned or threw, marked so
 * teamStepFailureNote reads the first dispatch's facts and what the policy tried.
 */
export async function runTeamStepWithSettlement(port: TeamStepSettlementPort): Promise<RunnerResult> {
  const run = async (request: RunnerRequest): Promise<Outcome> => {
    try { return { ok: true, result: await port.dispatch(request) }; } catch (error) { return { ok: false, error }; }
  };
  const surface = (outcome: Outcome, trail: Trail): RunnerResult => {
    if (!outcome.ok) throw mark(outcome.error, trail);
    return outcome.result.failure ? mark(outcome.result, trail) : outcome.result;
  };
  const record = (phase: TeamStepSettlementPhase, trail: Trail): void => {
    try { port.record?.(phase, noteFrom(trail.facts, trail.continued, trail.retried)); } catch { /* telemetry never decides */ }
  };
  let outcome = await run(port.request);
  let facts = readTeamStepFacts(outcome, port.aborted());
  const trail: Trail = { facts, continued: false, retried: false };
  let retries = 0;
  for (;;) {
    if (facts.settled || !port.eligible) return outcome.ok && facts.settled ? outcome.result : surface(outcome, trail);
    const decision = decideTeamStepSettlement(teamStepSettlementInput(facts, { continued: trail.continued, retries }));
    if (decision.action === "retry" && retries < RATE_LIMIT_MAX_RETRIES) {
      retries += 1;
      trail.retried = true;
      record("retried", trail);
      if (decision.delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, decision.delayMs).unref?.(); });
      if (port.aborted()) return surface(outcome, trail);
      outcome = await run(port.request);
      facts = readTeamStepFacts(outcome, port.aborted());
      trail.facts = facts;
      continue;
    }
    if (decision.action !== "continue-same-session" || !facts.sessionId) {
      record("surfaced", trail);
      return surface(outcome, trail);
    }
    trail.continued = true;
    record("continued", trail);
    const next = await run(teamStepContinuationRequest(port.request, facts.sessionId, decision.resendOriginal));
    const nextFacts = readTeamStepFacts(next, port.aborted());
    if (nextFacts.settled && next.ok) {
      record("continuation_settled", trail);
      // A schema-bound step's continuation is its whole typed answer; a prose step keeps what the cut turn already said.
      const earlier = port.request.outputSchema ? "" : facts.text.trim();
      return earlier && next.result.text.trim() ? { ...next.result, text: `${earlier}\n\n${next.result.text}` } : next.result;
    }
    record("continuation_failed", trail);
    // A definite failure of the continuation (owner stop, a typed refusal) is that failure; another unknown terminal
    // leaves the first turn's facts as the cause.
    return nextFacts.unsettled ? surface(outcome, trail) : surface(next, { ...trail, facts: nextFacts });
  }
}
