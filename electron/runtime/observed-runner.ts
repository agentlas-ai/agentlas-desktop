import { createRuntimeUsageCollector, type ObservedTokenUsage } from "../../shared/observed-usage";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult, RunnerFailure } from "./runner";
import { beginInvocationUsageAttempt } from "./invocation-usage";

const usageOnError = new WeakMap<object, ReturnType<typeof createRuntimeUsageCollector>>();
const nativeReceipts = new WeakMap<object, Map<string, ReturnType<typeof createRuntimeUsageCollector>>>();

/** Known per-attempt facts remain inspectable even when the whole call is unmeasured. */
export function observedRunnerUsageEvidence(value: unknown): Array<{ attemptId: string; usage: ObservedTokenUsage | null }> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return [];
  return [...(nativeReceipts.get(value) ?? [])].map(([attemptId, receipt]) => ({ attemptId, usage: receipt.total() ?? null }));
}

/** Preserve error identity and late terminal accounting; an exception is never a zero-cost receipt. */
export function observedRunnerUsage(error: unknown): ObservedTokenUsage | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? usageOnError.get(error)?.total() : undefined;
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
  try {
    const result = await runner(request, {
      ...events,
      onRuntimeAttemptStarted: (id) => {
        usage.start(id);
        if (!receipts.has(id)) {
          const receipt = createRuntimeUsageCollector();
          receipt.start(id);
          receipts.set(id, receipt);
        }
        events.onRuntimeAttemptStarted?.(id);
      },
      onTerminalObservedUsage: (receipt, id) => {
        usage.recordTerminal(receipt, id);
        if (id !== undefined) receipts.get(id)?.recordTerminal(receipt, id);
        events.onTerminalObservedUsage?.(receipt, id);
      },
    });
    const { observedUsage: returnedUsage, ...rest } = result;
    const observedUsage = usage.total(returnedUsage);
    invocationAttempt.complete(observedUsage);
    const measuredResult = { ...rest, ...(observedUsage ? { observedUsage } : {}) };
    nativeReceipts.set(measuredResult, receipts);
    return measuredResult;
  } catch (error) {
    invocationAttempt.complete(usage.total());
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      usageOnError.set(error, usage);
      nativeReceipts.set(error, receipts);
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
