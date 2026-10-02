import { AsyncLocalStorage } from "node:async_hooks";
import { createRuntimeUsageCollector, type ObservedTokenUsage } from "../../shared/observed-usage";

interface InvocationUsageScope {
  collector: ReturnType<typeof createRuntimeUsageCollector>;
  attempts: number;
  closed: boolean;
  snapshot?: ObservedTokenUsage;
  onFirstAttemptStarted?: () => void;
  startFailed: boolean;
  startError?: unknown;
}

const scopes = new AsyncLocalStorage<InvocationUsageScope>();
const copy = (usage: ObservedTokenUsage | undefined): ObservedTokenUsage | undefined => usage && { ...usage };

/** Register exactly one actual outer runner call, before provider dispatch. */
export function beginInvocationUsageAttempt(): { complete(usage: ObservedTokenUsage | null | undefined): void } {
  const scope = scopes.getStore();
  if (!scope) return { complete() {} };
  if (scope.closed) throw new Error("Invocation usage scope has already settled");
  if (scope.startFailed) throw scope.startError;
  const id = String(++scope.attempts);
  scope.collector.start(id);
  if (scope.attempts === 1) {
    try { scope.onFirstAttemptStarted?.(); }
    catch (error) { scope.startFailed = true; scope.startError = error; throw error; }
  }
  let completed = false;
  return {
    complete(usage): void {
      if (completed || scope.closed) return;
      completed = true;
      scope.collector.recordTerminal(usage, id);
    },
  };
}

/** Outer runner-call scopes only, including pre-dispatch failures; never a provider or billing count. */
export function currentInvocationRunnerScopeCount(): number {
  return scopes.getStore()?.attempts ?? 0;
}

/** Missing, pending, or absent attempts never become an invented zero. */
export function currentInvocationObservedUsage(): ObservedTokenUsage | undefined {
  const scope = scopes.getStore();
  return scope ? copy(scope.closed ? scope.snapshot : scope.collector.total()) : undefined;
}

/** Each invocation owns an isolated total; nested invocations do not double-count their parent. */
export async function withInvocationUsage<T extends object>(
  call: () => Promise<T>,
  onFirstAttemptStarted?: () => void,
): Promise<T & { observedUsage?: ObservedTokenUsage }> {
  const scope: InvocationUsageScope = {
    collector: createRuntimeUsageCollector(), attempts: 0, closed: false,
    startFailed: false, onFirstAttemptStarted,
  };
  return scopes.run(scope, async () => {
    try {
      const result = await call();
      scope.snapshot = scope.collector.total();
      scope.closed = true;
      const { observedUsage: _previousUsage, ...rest } = result as T & { observedUsage?: ObservedTokenUsage };
      return { ...rest, ...(scope.snapshot ? { observedUsage: copy(scope.snapshot) } : {}) } as T & { observedUsage?: ObservedTokenUsage };
    } finally {
      if (!scope.closed) scope.snapshot = scope.collector.total();
      scope.closed = true;
    }
  });
}

/** Standalone controllers open one scope; child controllers reuse their live parent's scope. */
export async function withInvocationUsageIfAbsent<T>(call: (ownsScope: boolean) => Promise<T>): Promise<T> {
  const current = scopes.getStore();
  if (current) {
    if (current.closed) throw new Error("Invocation usage scope has already settled");
    if (current.startFailed) throw current.startError;
    return call(false);
  }
  const result = await withInvocationUsage(async () => ({ value: await call(true) }));
  return result.value;
}
