import type { Runner, RunnerResult } from "./runner";

/**
 * The one place a harness bug cannot turn into a process storm.
 *
 * Owner rule (2026-09-14): give the AI room to run long jobs on its own, and stop only what burns the
 * machine. The shape that burns it is a loop that keeps launching a runtime that keeps failing — two
 * exhausted providers handing a request back and forth (gemini <-> another fallback), tens of
 * thousands of launches a minute. Each loop has its own caps (fallback attempts per run, pass
 * retries, loop budgets), but a cap in one loop says nothing about a bug in the next one.
 *
 * So every model runner is wrapped here, at the point every product path goes through (pickRunner).
 * The breaker counts FAILED invocations per runtime in a sliding minute. Past the threshold it stops
 * launching that runtime: each call waits a fixed interval and returns a typed refusal without
 * spawning anything. A caller that loops on the refusal is throttled to a few calls a minute instead
 * of spinning; a caller that falls back finds the other runtime tripped too and exhausts its
 * candidates. Successes are never counted, so a busy healthy swarm is untouched, and the breaker
 * closes by itself once the minute has no storm in it.
 */
export const INVOCATION_BREAKER_WINDOW_MS = 60_000;
export const INVOCATION_BREAKER_FAILURE_THRESHOLD = 12;
export const INVOCATION_BREAKER_REFUSAL_DELAY_MS = 2_000;

export interface InvocationBreakerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: InvocationBreakerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class InvocationBreaker {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly clock: InvocationBreakerClock = realClock) {}

  private recent(key: string): number[] {
    const cutoff = this.clock.now() - INVOCATION_BREAKER_WINDOW_MS;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  isOpen(key: string): boolean {
    return this.recent(key).length >= INVOCATION_BREAKER_FAILURE_THRESHOLD;
  }

  noteFailure(key: string): void {
    const kept = this.recent(key);
    kept.push(this.clock.now());
    // Only the threshold matters; never let one storm grow the list without bound.
    this.failures.set(key, kept.slice(-INVOCATION_BREAKER_FAILURE_THRESHOLD * 2));
  }

  wrap(runner: Runner, key: string, runtimeLabel: string): Runner {
    return async (req, events) => {
      if (this.isOpen(key)) {
        await this.clock.sleep(INVOCATION_BREAKER_REFUSAL_DELAY_MS);
        return {
          text: "",
          failure: {
            kind: "refused",
            source: "marker",
            runtime: runtimeLabel,
            providerCode: "runtime_invocation_storm",
            message: req.locale === "ko"
              ? `${runtimeLabel} 실행이 1분 안에 ${INVOCATION_BREAKER_FAILURE_THRESHOLD}번 넘게 실패해 잠시 실행을 멈췄습니다. 반복 실행이 기계를 태우지 않게 하려는 것으로, 1분 뒤 저절로 풀립니다.`
              : `${runtimeLabel} failed more than ${INVOCATION_BREAKER_FAILURE_THRESHOLD} times within a minute, so launching it is paused. This keeps a repeating loop from burning the machine; it clears by itself after a minute.`,
          },
        } satisfies RunnerResult;
      }
      let result: RunnerResult;
      try {
        result = await runner(req, events);
      } catch (error) {
        // A runner that throws is a failed launch too; a loop that retries on throw storms the same way.
        if (!req.signal?.aborted) this.noteFailure(key);
        throw error;
      }
      if (result.failure && !req.signal?.aborted) this.noteFailure(key);
      return result;
    };
  }
}

export const invocationBreaker = new InvocationBreaker();

/** Failures are counted per executable account, not per model: a storm is a launch pattern, not a model choice. */
export function invocationBreakerKey(runtime: { kind: string; backend?: string | null; source?: string | null; acpAgentId?: string | null }): string {
  return JSON.stringify([runtime.kind, runtime.backend ?? null, runtime.source ?? null, runtime.acpAgentId ?? null]);
}
