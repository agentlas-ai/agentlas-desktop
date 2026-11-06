import type { RunnerFailure } from "../runtime/runner";
import type { RuntimeStatus } from "../../shared/types";

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
}): Promise<BuildRuntimeLadderResult<T>> {
  const skipped: BuildRuntimeAttemptFailure[] = [];
  const tried: RuntimeStatus[] = [];
  let runtime = input.initial;
  for (;;) {
    input.signal.throwIfAborted();
    tried.push(runtime);
    const attempt = await input.attempt(runtime, skipped);
    input.signal.throwIfAborted();
    if (!attempt.failure && !attempt.unusableCode) return { outcome: attempt.outcome, runtime, skipped };
    const done: BuildRuntimeLadderResult<T> = { outcome: attempt.outcome, runtime, skipped,
      ...(attempt.failure ? { failure: attempt.failure } : {}), ...(attempt.unusableCode ? { unusableCode: attempt.unusableCode } : {}) };
    if (input.pinned) return done;
    const following = await input.next(runtime, attempt.failure, tried);
    if (!following) return done;
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
