import { AsyncLocalStorage } from "node:async_hooks";
import { createRuntimeUsageCollector, type ObservedTokenUsage } from "../../shared/observed-usage";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure } from "./runner";
import { RuntimeTurnUnsettledError, runtimeFailureIsClosedHttpRefusal } from "./runner";
import { beginInvocationUsageAttempt } from "./invocation-usage";


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
): Promise<RunnerResult> {
  const usage = createRuntimeUsageCollector();
  const receipts = new Map<string, ReturnType<typeof createRuntimeUsageCollector>>();
  const invocationAttempt = beginInvocationUsageAttempt();
  let returnedResult: RunnerResult | undefined;
  let providerActivityObserved = false;
  try {
    const result = await observeRunnerSettlement(runner(request, {
      ...events,
      onPartial: (text) => {
        if (text.length > 0) providerActivityObserved = true;
        events.onPartial(text);
      },
      onTool: (...args) => {
        providerActivityObserved = true;
        events.onTool?.(...args);
      },
      onThinking: (...args) => {
        providerActivityObserved = true;
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
        providerActivityObserved = true;
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
    }));
    returnedResult = result;
    const { observedUsage: returnedUsage, ...rest } = result;
    const observedUsage = usage.total(returnedUsage);
    const measuredResult = { ...rest, ...(observedUsage ? { observedUsage } : {}) };
    request.signal?.throwIfAborted();
    // A closed HTTP refusal before any model/tool output is failure evidence,
    // never successful completion. Arbitrary quota/auth labels after dispatch
    // cannot authorize a fallback to another runtime.
    const httpRefusal = runtimeFailureIsClosedHttpRefusal(result.failure, {
      text: result.text, nativeActivity: providerActivityObserved,
      aborted: request.signal?.aborted === true, observedUsage: result.observedUsage,
    });
    if (result.ownerControlTerminal !== "completed" && !httpRefusal) {
      throw new RuntimeTurnUnsettledError("runtime", request.locale);
    }
    invocationAttempt.complete(observedUsage);
    nativeReceipts.set(measuredResult, receipts);
    return measuredResult;
  } catch (error) {
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
