import type { RunnerFailure } from "../runtime/runner";
import type { RuntimeStatus } from "../../shared/types";
import { isTransientExternalFailure } from "../../shared/transient-provider-failure";
import { parseRetryHint } from "../runtime/runtime-cooldown";

/**
 * A Build turn whose runtime failed on a cause outside the app that time clears, with no other runtime to take it (a pinned model,
 * an empty or exhausted pool), waits and is asked again on the same runtime. Before, it ended "Build failed" and the owner had to
 * start again by hand. Pauses grow and then stay at the last step; a limit the provider says lifts at a stated time is waited for
 * until then, an hour at a time. Waiting ends when the owner stops the Build or after six hours in all (a usage window): a Build
 * started from the phone has no stop there and holds the phone's one Build slot, so it must not show "running" for ever.
 */
export const BUILD_TRANSIENT_WAIT_STEPS_MS: readonly number[] = [20_000, 60_000, 5 * 60_000, 15 * 60_000];
const BUILD_LIMIT_WAIT_MAX_MS = 60 * 60_000;
export const BUILD_TRANSIENT_WAIT_TOTAL_MS = 6 * 60 * 60_000;

/** The pause before the same runtime is asked again, or null when time does not clear this failure (a sign-in, a refusal, a bad request). */
export function buildTransientWaitMs(failure: Pick<RunnerFailure, "kind" | "providerCode" | "source"> & { retryAfterHint?: string | null } | undefined,
  waits: number, now = Date.now(), budgetLeftMs = BUILD_TRANSIENT_WAIT_TOTAL_MS): number | null {
  if (!failure) return null;
  const limited = failure.kind === "rate_limit" || failure.kind === "quota";
  // A limit read out of an error's wording (source "exit", runnerFailureFromError) is a guess, as for the runtime cooldown: the Build
  // is not held for hours on a guess.
  if (limited && failure.source === "exit") return null;
  if (!limited && !isTransientExternalFailure(failure)) return null;
  const step = BUILD_TRANSIENT_WAIT_STEPS_MS[Math.min(waits, BUILD_TRANSIENT_WAIT_STEPS_MS.length - 1)];
  // ISO ("resetsAt") or a sentence ("Resets in 25m", agy): the shared reader. It reads a reset already passed as nothing.
  const hint = failure.retryAfterHint ?? "";
  const resetAt = limited ? parseRetryHint(hint || undefined, now) : null;
  const resetPassed = limited && resetAt === null && Number.isFinite(Date.parse(hint));
  // A quota that names no reset (out of credits, a plan limit) does not lift by waiting: the owner tops up or picks another model.
  // One whose stated reset has just passed is asked again after the step.
  if (failure.kind === "quota" && resetAt === null && !resetPassed) return null;
  // A reset later than the waiting left would only be slept on and then given up: the failure returns now.
  if (resetAt !== null && resetAt - now > budgetLeftMs) return null;
  const hinted = resetAt === null ? NaN : resetAt - now;
  return Number.isFinite(hinted) && hinted > step ? Math.min(hinted, BUILD_LIMIT_WAIT_MAX_MS) : step;
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The runtimes of the owner's worker pool, in the owner's order, taken one after another until one finishes the Build turn.
 * A runtime failure and a turn that wrote no files both move on to the next one; the pool itself is the bound, so there is
 * no separate retry count. Nothing here picks a model: a pinned runtime, a failure that must not be replayed and an empty
 * pool all end the ladder at the first attempt, the same as before.
 */
export interface BuildRuntimeAttemptFailure {
  runtime: RuntimeStatus;
  /** Machine facts of the failure; a turn that wrote nothing carries `code` only. */
  failure?: Pick<RunnerFailure, "kind" | "providerCode" | "source">;
  code: string;
}

export interface BuildRuntimeAttempt<T> {
  outcome: T;
  /** The runner's own failure, kept as the typed value the pool filters read. */
  failure?: RunnerFailure;
  /** A turn that ended without a failure but produced nothing usable (no files): code, no typed failure. */
  unusableCode?: string;
}

export interface BuildRuntimeLadderResult<T> {
  outcome: T;
  runtime: RuntimeStatus;
  failure?: RunnerFailure;
  unusableCode?: string;
  /** Every earlier attempt that moved on, in order. */
  skipped: BuildRuntimeAttemptFailure[];
}

export async function runBuildTurnOnRuntimeLadder<T>(input: {
  initial: RuntimeStatus;
  signal: AbortSignal;
  /** True when the owner chose this model: it is never replaced by another one. */
  pinned: boolean;
  attempt: (runtime: RuntimeStatus, skipped: readonly BuildRuntimeAttemptFailure[]) => Promise<BuildRuntimeAttempt<T>>;
  /** Next runtime after `failed`, or null. `failure` is absent for a turn that merely wrote nothing. */
  next: (failed: RuntimeStatus, failure: RunnerFailure | undefined, tried: readonly RuntimeStatus[]) => Promise<RuntimeStatus | null>;
  onSwitch?: (from: RuntimeStatus, to: RuntimeStatus, skipped: readonly BuildRuntimeAttemptFailure[]) => void;
  /** Called before the same runtime is asked again after a transient failure (buildTransientWaitMs). */
  onWait?: (runtime: RuntimeStatus, failure: RunnerFailure, waitMs: number, waits: number) => void;
  /** Test seam. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<BuildRuntimeLadderResult<T>> {
  const skipped: BuildRuntimeAttemptFailure[] = [];
  const tried: RuntimeStatus[] = [];
  let runtime = input.initial;
  let waits = 0;
  let waited = 0;
  for (;;) {
    input.signal.throwIfAborted();
    tried.push(runtime);
    const attempt = await input.attempt(runtime, skipped);
    input.signal.throwIfAborted();
    if (!attempt.failure && !attempt.unusableCode) return { outcome: attempt.outcome, runtime, skipped };
    const done: BuildRuntimeLadderResult<T> = { outcome: attempt.outcome, runtime, skipped,
      ...(attempt.failure ? { failure: attempt.failure } : {}), ...(attempt.unusableCode ? { unusableCode: attempt.unusableCode } : {}) };
    const following = input.pinned ? null : await input.next(runtime, attempt.failure, tried);
    if (!following) {
      const waitMs = buildTransientWaitMs(attempt.failure, waits, Date.now(), BUILD_TRANSIENT_WAIT_TOTAL_MS - waited);
      const pause = waitMs === null ? 0 : Math.min(waitMs, BUILD_TRANSIENT_WAIT_TOTAL_MS - waited);
      if (waitMs === null || !attempt.failure || pause <= 0) return done;
      input.onWait?.(runtime, attempt.failure, pause, waits + 1);
      await (input.wait ?? waitUnlessAborted)(pause, input.signal);
      input.signal.throwIfAborted();
      waits += 1;
      waited += pause;
      continue;
    }
    waits = 0;
    skipped.push({ runtime, ...(attempt.failure ? { failure: attempt.failure } : {}),
      code: attempt.failure ? (attempt.failure.providerCode ?? attempt.failure.kind) : (attempt.unusableCode ?? "unusable") });
    input.onSwitch?.(runtime, following, skipped);
    runtime = following;
  }
}

/** The fallback must be able to take over what the first runtime was given. */
export function buildFallbackAdmits(candidate: RuntimeStatus, constraints: {
  /** Kinds the resolved MCP attachment was built for; null = the Build has no attached MCP server. */
  attachmentKinds: ReadonlySet<string> | null;
  /** The contract reader is wired into the prompt; a runtime that cannot receive it would get a catalog without its sections. */
  requiresContractReader: boolean;
  contractReaderSupported: (runtime: RuntimeStatus) => boolean;
}): boolean {
  if (constraints.attachmentKinds && !constraints.attachmentKinds.has(candidate.kind)) return false;
  if (constraints.requiresContractReader && !constraints.contractReaderSupported(candidate)) return false;
  return true;
}

/** One factual line: which runtimes were tried and why each stopped. */
export function describeBuildRuntimeAttempts(attempts: readonly BuildRuntimeAttemptFailure[], last: BuildRuntimeAttemptFailure): string {
  return [...attempts, last]
    .map((item) => `${item.runtime.kind}${item.runtime.model ? `/${item.runtime.model}` : ""} (${item.code})`)
    .join(" → ");
}
