import { currentHistoryRuntimeFence, withCurrentHistoryProvider } from "../one/history-runtime-fences";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRuntimeUsageCollector, type ObservedTokenUsage } from "../../shared/observed-usage";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure } from "./runner";
import { runnerResultRefusedBeforeDispatch, runtimeFailureIsClosedHttpRefusal, unsettledTurnError,
  RUNTIME_TURN_UNSETTLED_CODE, RUNTIME_SILENT_TIMEOUT_CODE, RUNTIME_PROTOCOL_UNRECOGNIZED_CODE } from "./runner";
import { beginInvocationUsageAttempt } from "./invocation-usage";
import { withModelCallScope, type ModelCallRole } from "./model-call-ledger";


type RunnerSettlementObserver = (provider: PromiseLike<unknown>) => void;
const settlementObservers = new AsyncLocalStorage<RunnerSettlementObserver>();
/** Main callers can keep actual provider work visible after a UI cancellation
 * boundary detaches. This scope changes neither runner results nor cancellation. */
export function withRunnerSettlementObserver<T>(observer: RunnerSettlementObserver, action: () => T): T {
  return settlementObservers.run(observer, action);
}
function observeRunnerSettlement<T>(provider: Promise<T>): Promise<T> {
  settlementObservers.getStore()?.(provider);
  return provider;
}

/*
 * A provider's own typed refusal (quota/billing, sign-in, an unsupported request, unavailable or at capacity, a policy
 * refusal), reported as a marker with or without dispatch, is that failure: callers keep its kind and providerCode (a
 * judgment walks to its next candidate, system-agents/judgment.ts; the no-tools lane's own refusals such as
 * codex_no_tools_frame_unknown are "refused"). Only an unknown terminal stays unsettled: no typed cause, the unsettled
 * code itself, a silent timeout, an unrecognized stream, a bare exit; it keeps the result as its cause. A refusal that
 * follows observed tool activity in a run that had tools also stays unsettled: the tools may have acted before it.
 * Production 2026-10-15..16: 2,849 judgment calls reported runtime_turn_unsettled while the runner had returned
 * codex_no_tools_frame_unknown (audit A7 M1).
 */
const TYPED_PROVIDER_FAILURE_KINDS: ReadonlySet<RunnerFailure["kind"]> = new Set(["quota", "rate_limit", "auth", "unsupported", "unavailable", "refused"]);
const UNKNOWN_TERMINAL_CODES: ReadonlySet<string> = new Set([RUNTIME_TURN_UNSETTLED_CODE, RUNTIME_SILENT_TIMEOUT_CODE, RUNTIME_PROTOCOL_UNRECOGNIZED_CODE]);
function typedProviderFailure(failure: RunnerFailure | undefined, toolActivity: boolean, request: RunnerRequest): boolean {
  if (!failure || failure.source !== "marker" || UNKNOWN_TERMINAL_CODES.has(failure.providerCode ?? "")) return false;
  const toolless = request.untrustedNoTools === true || request.judgmentOnly === true;
  return TYPED_PROVIDER_FAILURE_KINDS.has(failure.kind) && (!toolActivity || toolless);
}

/** The same rule for a host that calls a runner without this wrapper (alive-organisms/light-wake.ts). */
export function runnerFailureKeepsOwnCode(failure: RunnerFailure | undefined, toolActivity: boolean, request: RunnerRequest): boolean {
  return typedProviderFailure(failure, toolActivity, request);
}

const usageOnError = new WeakMap<object, ReturnType<typeof createRuntimeUsageCollector>>();
const nativeReceipts = new WeakMap<object, Map<string, ReturnType<typeof createRuntimeUsageCollector>>>();
const returnedResultsOnError = new WeakMap<object, RunnerResult>();

/** Diagnostic facts never authorize another provider attempt. */
export function observedRunnerReturnedResult(error: unknown): Readonly<RunnerResult> | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? returnedResultsOnError.get(error) : undefined;
}

/** Keep observed facts when a controller wraps a typed failure; do not synthesize usage. */
export function copyObservedRunnerEvidence(source: object, target: object): void {
  const usage = usageOnError.get(source);
  const receipts = nativeReceipts.get(source);
  const result = returnedResultsOnError.get(source);
  if (usage) usageOnError.set(target, usage);
  if (receipts) nativeReceipts.set(target, receipts);
  if (result) returnedResultsOnError.set(target, result);
}

/** Known per-attempt facts remain inspectable even when the whole call is unmeasured. */
export function observedRunnerUsageEvidence(value: unknown): Array<{ attemptId: string; usage: ObservedTokenUsage | null }> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return [];
  return [...(nativeReceipts.get(value) ?? [])].map(([attemptId, receipt]) => ({ attemptId, usage: receipt.total() ?? null }));
}

/** Preserve error identity and late terminal accounting; an exception is never a zero-cost receipt. */
export function observedRunnerUsage(error: unknown): ObservedTokenUsage | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? usageOnError.get(error)?.total(returnedResultsOnError.get(error)?.observedUsage) : undefined;
}

/** Collect native attempts inside one runner call without adding its returned pair twice. */
export async function runObservedRunner(
  runner: Runner,
  request: RunnerRequest,
  events: RunnerEvents,
  nativeRuntimeKind?:string,
): Promise<RunnerResult> {
  const usage = createRuntimeUsageCollector();
  const receipts = new Map<string, ReturnType<typeof createRuntimeUsageCollector>>();
  const invocationAttempt = beginInvocationUsageAttempt();
  let returnedResult: RunnerResult | undefined;
  let providerActivityObserved = false;
  let toolActivityObserved = false;
  try {
    currentHistoryRuntimeFence()?.assertRuntimeCoverage(nativeRuntimeKind??"unknown");
    const result = await observeRunnerSettlement(withCurrentHistoryProvider(async()=>{const nativeResult=await runner(request, {
      ...events,
      onPartial: (text) => {
        if (text.length > 0) providerActivityObserved = true;
        currentHistoryRuntimeFence()?.assertCurrent();
        events.onPartial(text);
      },
      onTool: (...args) => {
        providerActivityObserved = true;
        toolActivityObserved = true;
        currentHistoryRuntimeFence()?.assertCurrent();
        events.onTool?.(...args);
      },
      onThinking: (...args) => {
        providerActivityObserved = true;
        if(args[0]!=="end"||args[2])currentHistoryRuntimeFence()?.assertCurrent();
        events.onThinking?.(...args);
      },
      onUsage: (tokens) => {
        providerActivityObserved = true;
        events.onUsage?.(tokens);
      },
      onNativeTurnController: (controller) => {
        if (controller) providerActivityObserved = true;
        events.onNativeTurnController?.(controller);
      },
      onRuntimeAttemptStarted: (id) => {
        // Attempt admission starts accounting. Only measured model/tool output
        // above can invalidate a process-proven closed HTTP rejection.
        usage.start(id);
        if (!receipts.has(id)) {
          const receipt = createRuntimeUsageCollector();
          receipt.start(id);
          receipts.set(id, receipt);
        }
        events.onRuntimeAttemptStarted?.(id);
      },
      onTerminalObservedUsage: (receipt, id) => {
        providerActivityObserved = true;
        usage.recordTerminal(receipt, id);
        if (id !== undefined) receipts.get(id)?.recordTerminal(receipt, id);
        events.onTerminalObservedUsage?.(receipt, id);
      },
    });returnedResult=nativeResult;return nativeResult;}));
    returnedResult = result;
    currentHistoryRuntimeFence()?.assertCurrent();
    const { observedUsage: returnedUsage, ...rest } = result;
    const observedUsage = usage.total(returnedUsage);
    const measuredResult = { ...rest, ...(observedUsage ? { observedUsage } : {}) };
    request.signal?.throwIfAborted();
    // A closed HTTP refusal before any model/tool output is failure evidence,
    // never successful completion. Quota/auth labels after dispatch are not that
    // proof: they pass below only as the runner's typed failure (typedProviderFailure),
    // and each caller's own replay rule decides what happens next.
    const httpRefusal = runtimeFailureIsClosedHttpRefusal(result.failure, {
      text: result.text, nativeActivity: providerActivityObserved,
      aborted: request.signal?.aborted === true, observedUsage: result.observedUsage,
    });
    // A failure the runner proved pre-dispatch (RuntimeTurnDelivery "not-dispatched") keeps its provider code: it is
    // never an unknown dispatch.
    if (result.ownerControlTerminal !== "completed" && !httpRefusal && !runnerResultRefusedBeforeDispatch(result)
      && !typedProviderFailure(result.failure, toolActivityObserved, request)) {
      // Unknown effect, but never anonymous: the runtime kind, the returned result (typed failure, session) as the cause
      // and the delivery the runner observed survive (audit A7 M1 dropped all three and named the runtime "runtime").
      throw unsettledTurnError({ runtimeKind: nativeRuntimeKind ?? result.failure?.runtime ?? "runtime", locale: request.locale,
        cause: result, turnDelivery: result.turnDelivery });
    }
    invocationAttempt.complete(observedUsage);
    nativeReceipts.set(measuredResult, receipts);
    return measuredResult;
  } catch (error) {
    returnedResult??=observedRunnerReturnedResult(error);
    invocationAttempt.complete(usage.total(returnedResult?.observedUsage));
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      usageOnError.set(error, usage);
      nativeReceipts.set(error, receipts);
      if (returnedResult) returnedResultsOnError.set(error, returnedResult);
    }
    throw error;
  }
}

/** Typed failure propagation across controller catches; prose carries no replay authority. */
export class ObservedRunnerFailureError extends Error {
  readonly code: string;
  readonly #failure: Readonly<RunnerFailure>;
  get failure(): Readonly<RunnerFailure> { return this.#failure; }
  static providerFailure(error: unknown): Readonly<RunnerFailure> | undefined {
    return error instanceof ObservedRunnerFailureError && #failure in error ? error.#failure : undefined;
  }
  constructor(failure: RunnerFailure) {
    super(failure.message);
    this.#failure = Object.freeze({ ...failure });
    this.name = "ObservedRunnerFailureError";
    this.code = failure.providerCode ?? "runtime_failure";
  }
}

/** Native host result boundary: preserve genuine returned usage/diagnostics on denial, never deliver the result. No additional attempt/admission. */
export function assertCurrentHistoryRunnerResult<T extends RunnerResult>(result:T):T{try{currentHistoryRuntimeFence()?.assertCurrent();return result;}catch(error){if(error!==null&&(typeof error==="object"||typeof error==="function")){returnedResultsOnError.set(error,result);const usage=createRuntimeUsageCollector();usageOnError.set(error,usage);}throw error;}}

/** Same as runObservedRunner, naming the call's role for the model-call ledger (curator, router, repair ...). */
export function runObservedRunnerAs(
  role: ModelCallRole,
  phase: string,
  runner: Runner,
  request: RunnerRequest,
  events: RunnerEvents,
  nativeRuntimeKind?: string,
): Promise<RunnerResult> {
  return withModelCallScope({ role, phase }, () => runObservedRunner(runner, request, events, nativeRuntimeKind));
}
