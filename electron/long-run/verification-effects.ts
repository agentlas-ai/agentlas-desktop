import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { withAdapterEffectContext, type AdapterEffectAdmission, type AdapterEffectReport } from "../invocation/adapter-effect-context";
import { hasCallbackResultCoverage } from "../invocation/effect-boundary";
import { parseEffectMetadata } from "../invocation/effect-metadata";
import type { RunnerEvents, RunnerResult } from "../runtime/runner";
import { getDb } from "../store/db";
import { getLongRunAttemptGoalRevision } from "../store/long-runs";
import { recordRunEvent } from "../store/run-events";
import { captureGoalVerificationBoundary } from "./verification-boundary";

export interface VerificationSessionBinding {
  executionId: string;
  attemptId: string;
  goalId: string;
  goalRevision: number;
  /** The task whose sealed evidence is being judged, NOT this execution ID. */
  invocationRunId: string;
  chatId: string;
  boundaryDigest: string;
  signal: AbortSignal;
}
export interface VerificationSession {
  readonly executionId: string;
  readonly anchorId: string;
  runStage<T>(stage: "classification" | "judgment", action: () => Promise<T>): Promise<T>;
  assertSettledEmpty(): void;
  /** Revokes future dispatch; does not claim that pending runners have drained. */
  close(): void;
  /** Actual raw runners only. The caller retains this in its cleanup lifetime. */
  drain(): Promise<void>;
}
type Stage = { name: "classification" | "judgment"; open: boolean };
type NativeScope = AdapterEffectAdmission & { report: AdapterEffectReport | null };
type Dispatch = {
  id: string; kind: string; stage: Stage; settled: boolean;
  controller: AbortController; scopes: Map<string, NativeScope>;
};
const active = new AsyncLocalStorage<{ session: EffectSession; stage: Stage }>();

export class VerificationEffectsError extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); this.name = "VerificationEffectsError"; }
}

/** No serialized flag enables this lane: only a live Main session can enter it. */
export function hasActiveVerificationSession(): boolean { return active.getStore() !== undefined; }
export function markVerificationEffectFailure(reason: "timeout" | "cancelled" | "runner_failed" | "invalid_output"): void {
  active.getStore()?.session.fail(`verification_effects_${reason}`);
}

/** Observe the REAL runner, before the UI's bounded abort-grace race. Both
 * normal and recovery judgment dispatch use this identical boundary. */
export function runVerificationEffectDispatch(
  kind: string, signal: AbortSignal,
  start: (signal: AbortSignal, onTool: NonNullable<RunnerEvents["onTool"]>) => Promise<RunnerResult>,
): Promise<RunnerResult> {
  const scope = active.getStore();
  return scope ? scope.session.dispatch(scope.stage, kind, signal, start) : start(signal, () => {});
}

class EffectSession implements VerificationSession {
  readonly executionId: string;
  readonly anchorId: string;
  private closed = false;
  private stage: Stage | null = null;
  private readonly failures = new Set<string>();
  private readonly dispatches: Dispatch[] = [];
  private readonly rawRunners: Promise<unknown>[] = [];
  private readonly onAbort = () => this.fail("verification_effects_cancelled");

  constructor(private readonly binding: VerificationSessionBinding) {
    this.executionId = binding.executionId;
    const anchor = recordRunEvent({ runId: this.executionId, chatId: binding.chatId,
      kind: "verifier_execution_started", sourceEventId: `verifier-execution:${this.executionId}:started`,
      payload: { schemaVersion: "agentlas.verifier-execution.v1", attemptId: binding.attemptId,
        goalId: binding.goalId, goalRevision: binding.goalRevision,
        invocationRunId: binding.invocationRunId, boundaryDigest: binding.boundaryDigest } });
    this.anchorId = anchor.id;
    binding.signal.addEventListener("abort", this.onAbort, { once: true });
    if (binding.signal.aborted) this.onAbort();
  }

  private record(kind: string, payload: Record<string, unknown>): void {
    try {
      recordRunEvent({ runId: this.executionId, chatId: this.binding.chatId, kind,
        sourceEventId: `verifier-effect:${this.executionId}:${randomUUID()}`, payload });
    } catch {
      // Persisting the failure may itself fail; the in-memory guard still fails.
      this.failures.add("verification_effects_ledger_unavailable");
      for (const dispatch of this.dispatches) if (!dispatch.settled) dispatch.controller.abort(new VerificationEffectsError("verification_effects_ledger_unavailable"));
    }
  }

  fail(reason: string): void {
    if (!this.failures.has(reason)) {
      this.failures.add(reason);
      this.record("verifier_effect_failure", { reasonCode: reason });
    }
    for (const dispatch of this.dispatches) if (!dispatch.settled && !dispatch.controller.signal.aborted) {
      dispatch.controller.abort(new VerificationEffectsError(reason));
    }
  }

  private checkLive(): void {
    if (this.closed) this.fail("verification_effects_session_closed");
    if (this.binding.signal.aborted) this.fail("verification_effects_cancelled");
    if (this.failures.size) throw new VerificationEffectsError(this.failures.values().next().value!);
  }

  async runStage<T>(name: Stage["name"], action: () => Promise<T>): Promise<T> {
    this.checkLive();
    if (this.stage || active.getStore()) {
      this.fail("verification_effects_stage_reentry");
      this.checkLive();
    }
    const stage: Stage = { name, open: true };
    this.stage = stage;
    const startCount = this.dispatches.length;
    // Even an accidentally unwrapped nested adapter must never inherit the
    // task's sealed ledger. It is an uncovered verifier dispatch, not success.
    const untracked = () => this.fail("verification_effects_untracked_dispatch");
    try {
      const result = await active.run({ session: this, stage }, () => withAdapterEffectContext({
        runId: this.executionId, chatId: this.binding.chatId, rootAgentId: null,
        purpose: "preparation", begin: untracked, finish: untracked,
      }, action));
      if (this.dispatches.length === startCount) this.fail("verification_effects_dispatch_missing");
      this.assertSettledEmpty();
      this.record("verifier_effect_stage_completed", { stage: name, dispatchCount: this.dispatches.length - startCount });
      this.checkLive();
      return result;
    } catch (error) {
      this.fail("verification_effects_stage_failed");
      throw error;
    } finally {
      stage.open = false;
      this.stage = null;
    }
  }

  dispatch(stage: Stage, kind: string, signal: AbortSignal,
    start: (signal: AbortSignal, onTool: NonNullable<RunnerEvents["onTool"]>) => Promise<RunnerResult>,
  ): Promise<RunnerResult> {
    this.checkLive();
    if (!stage.open || this.stage !== stage) {
      this.fail("verification_effects_late_dispatch");
      this.checkLive();
    }
    if (!hasCallbackResultCoverage(kind) && kind !== "antigravity" && kind !== "acp") {
      this.fail("verification_effects_coverage_unknown");
      this.checkLive();
    }
    const dispatch: Dispatch = { id: randomUUID(), kind, stage, settled: false,
      controller: new AbortController(), scopes: new Map() };
    this.dispatches.push(dispatch);
    const onAbort = () => this.fail("verification_effects_aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const combined = AbortSignal.any([signal, this.binding.signal, dispatch.controller.signal]);
    this.record("verifier_effect_dispatch_started", { dispatchId: dispatch.id, stage: stage.name, adapterKind: kind });
    const callbackLive = () => {
      if (dispatch.settled || !stage.open || this.closed) this.fail("verification_effects_late_callback");
    };
    const onTool: NonNullable<RunnerEvents["onTool"]> = () => {
      callbackLive();
      // Any real callback is a violation, including successful read tools.
      // Latch before abort: adapters may swallow callback exceptions.
      this.fail("verification_effects_tool_observed");
    };
    const begin = (admission: AdapterEffectAdmission) => {
      callbackLive();
      try {
        const parsed = parseEffectMetadata("runtime_adapter_effect_started", admission, this.executionId) as unknown as AdapterEffectAdmission;
        if (!parsed || parsed.chatId !== this.binding.chatId || parsed.adapterKind !== kind
          || parsed.rootBound || parsed.purpose !== "preparation" || dispatch.scopes.has(parsed.scopeId)) throw new Error();
        dispatch.scopes.set(parsed.scopeId, { ...parsed, report: null });
        this.record("runtime_adapter_effect_started", { ...parsed });
      } catch { this.fail("verification_effects_scope_invalid"); }
    };
    const finish = (scopeId: string, report: AdapterEffectReport) => {
      callbackLive();
      try {
        const scope = dispatch.scopes.get(scopeId);
        if (!scope || scope.report) throw new Error();
        const parsed = parseEffectMetadata("runtime_adapter_effect_completed", { ...scope, report }, this.executionId) as unknown as NativeScope;
        scope.report = parsed.report;
        this.record("runtime_adapter_effect_completed", { ...parsed });
        if (!this.emptyReport(kind, parsed.report)) this.fail("verification_effects_native_not_empty_complete");
      } catch { this.fail("verification_effects_report_invalid"); }
    };
    // Register the observed raw promise synchronously; never register the
    // abort-grace Promise.race as evidence of drainage.
    const raw = Promise.resolve().then(() => {
      this.checkLive();
      if (combined.aborted) throw new VerificationEffectsError("verification_effects_aborted");
      return withAdapterEffectContext({ runId: this.executionId, chatId: this.binding.chatId,
        rootAgentId: null, purpose: "preparation", begin, finish }, () => start(combined, onTool));
    });
    const observed = raw.then(result => {
      dispatch.settled = true;
      if (!result || result.failure) this.fail("verification_effects_runner_failed");
      if (!hasCallbackResultCoverage(kind) && dispatch.scopes.size === 0) this.fail("verification_effects_native_report_missing");
      for (const scope of dispatch.scopes.values()) if (!this.emptyReport(kind, scope.report)) this.fail("verification_effects_native_not_empty_complete");
      this.record("verifier_effect_dispatch_settled", { dispatchId: dispatch.id, outcome: result?.failure ? "failed" : "returned", rawRunnerSettled: true });
      this.checkLive();
      return result;
    }, error => {
      dispatch.settled = true;
      this.fail("verification_effects_runner_failed");
      this.record("verifier_effect_dispatch_settled", { dispatchId: dispatch.id, outcome: "rejected", rawRunnerSettled: true });
      throw error;
    }).finally(() => signal.removeEventListener("abort", onAbort));
    this.rawRunners.push(observed);
    // Also observe it after the bounded caller has stopped awaiting it.
    void observed.catch(() => {});
    return observed;
  }

  private emptyReport(kind: string, report: AdapterEffectReport | null): boolean {
    const successfulTerminal = kind === "antigravity" ? report?.terminal === "SUCCESS"
      : kind === "acp" ? report?.terminal === "end_turn" : false;
    return report?.complete === true && successfulTerminal && report.operationIds.length === 0
      && (report.settledFailureIds?.length ?? 0) === 0 && report.reasons.length === 0;
  }

  assertSettledEmpty(): void {
    this.checkLive();
    if (!this.dispatches.length) this.fail("verification_effects_dispatch_missing");
    if (this.dispatches.some(dispatch => !dispatch.settled)) this.fail("verification_effects_runner_pending");
    try {
      const boundary = captureGoalVerificationBoundary(this.binding.goalId, this.binding.invocationRunId);
      if (boundary.digest !== this.binding.boundaryDigest || boundary.goalRevision !== this.binding.goalRevision) {
        this.fail("verification_effects_boundary_changed");
      }
    } catch { this.fail("verification_effects_boundary_changed"); }
    this.checkLive();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.dispatches.some(dispatch => !dispatch.settled)) this.fail("verification_effects_runner_pending");
    this.binding.signal.removeEventListener("abort", this.onAbort);
    this.record("verifier_execution_closed", { rawRunnersDrained: this.dispatches.every(dispatch => dispatch.settled),
      reasonCodes: [...this.failures], dispatchCount: this.dispatches.length });
  }

  async drain(): Promise<void> {
    // Freeze registration first so a snapshot cannot miss a new child.
    this.close();
    await Promise.allSettled(this.rawRunners);
  }
}

export function createVerificationSession(input: VerificationSessionBinding): VerificationSession {
  const binding = { ...input };
  if (!/^[a-f0-9-]{36}$/i.test(binding.executionId) || binding.executionId === binding.invocationRunId
    || binding.signal.aborted || active.getStore()) throw new VerificationEffectsError("verification_effects_binding_invalid");
  const db = getDb();
  const attempt = db.prepare(`SELECT a.run_id, a.invocation_run_id, a.state, w.role, r.goal_id, r.root_chat_id
    FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id=a.worker_id JOIN long_runs r ON r.id=a.run_id WHERE a.id=?`)
    .get(binding.attemptId) as { run_id: string; invocation_run_id: string | null; state: string; role: string; goal_id: string; root_chat_id: string | null } | undefined;
  if (!attempt || attempt.role !== "verifier" || attempt.state !== "running" || attempt.invocation_run_id !== binding.executionId
    || attempt.goal_id !== binding.goalId || attempt.root_chat_id !== binding.chatId
    || getLongRunAttemptGoalRevision(attempt.run_id, binding.attemptId) !== binding.goalRevision
    || db.prepare("SELECT 1 FROM run_events WHERE run_id=? LIMIT 1").get(binding.executionId)) {
    throw new VerificationEffectsError("verification_effects_attempt_unbound");
  }
  const boundary = captureGoalVerificationBoundary(binding.goalId, binding.invocationRunId);
  if (boundary.digest !== binding.boundaryDigest || boundary.goalRevision !== binding.goalRevision) {
    throw new VerificationEffectsError("verification_effects_boundary_changed");
  }
  return new EffectSession(binding);
}
