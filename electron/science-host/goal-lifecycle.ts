/*
 * Science's side of the Goal lifecycle port (PLAN S7-4).
 *
 * Science keeps its research loop and the ONE transaction that registers an attempt and updates the execution budget together
 * (inside its own database), so that state is not moved here. What moves is the control: the common Goal engine holds the budget
 * clock and decides, after a restart, which parked loops are resumed. This file is the seam:
 *
 *   - `sdkHost`      the member the Science package reads from the host contract (`execution.goalLifecycle`): it hands its budget
 *                    deadline to the common clock instead of arming a timer of its own, and leaves restart resumes to the host.
 *   - `domainPort`   the common GoalLifecyclePort over a Science row of `long_runs`, answered by Science's own functions
 *                    (src/goal-lifecycle-port.ts in the package) through the row's loop binding.
 *   - `driveRestartResumes`  after the package's startup recovery, resume each loop it handed over and write the outcome into the
 *                    common ledger (before this the outcome was visible only inside Science).
 *
 * Restart behaviour is unchanged (decision D3): a loop the restart parked is resumed by the app itself, no owner step.
 */
import { scienceLongRunId } from "agentlas-science/dist/contracts/science-long-run";
import { scienceGoalLifecyclePort } from "agentlas-science";
import { appendLongRunEvent, getLongRun, getLongRunDomainBinding, type LongRunRecord } from "../store/long-runs";
import { createSegmentDeadlineClock, type SegmentDeadlineClock } from "../long-run/segment-deadline-clock";
import {
  registerDomainGoalLifecyclePort,
  type GoalAdmission, type GoalBudgetVerdict, type GoalLifecyclePort, type GoalLifecycleStatus, type GoalParkCause,
} from "../long-run/goal-lifecycle-registry";
import type { SegmentBudgetExhaustReason, SegmentBudgetState } from "../../shared/segment-budget";

/** Structural copy of the package's port (src/goal-lifecycle-port.ts), so this file compiles against an older package too. */
export interface ScienceGoalLifecycleSdkPort {
  status(scope: { projectId: string; loopSessionId: string }): {
    phase: "active" | "waiting" | "parked" | "terminal"; parkCause: GoalParkCause | null; budget: SegmentBudgetState | null;
    nextDeadlineAt: string | null; resumesAtRestart: boolean } | null;
  admit(scope: { projectId: string; loopSessionId: string }, attempt: { invocationRunId: string }, nowMs?: number):
    { admitted: true; registered: boolean } | { admitted: false; cause: "budget" | "conflict" | "not_found" };
  evaluateBudget(scope: { projectId: string; loopSessionId: string }, nowMs?: number): { exhausted: boolean; reason: SegmentBudgetExhaustReason | null; parked: boolean };
  enforceBudgetDeadline(scope: { projectId: string; conversationId: string; epoch?: number }, nowMs?: number): { exhausted: boolean; reason: SegmentBudgetExhaustReason | null };
  park(scope: { projectId: string; loopSessionId: string }, request: { requestId?: string; reason: string }): { parked: boolean; reason?: string };
  resume(scope: { projectId: string; loopSessionId: string }, request: { reason: string; expectedLoopVersion?: number }): { resumed: true } | { resumed: false; reason: string };
  complete(scope: { projectId: string; loopSessionId: string }, request: { requestId?: string; reason: string }): { completed: boolean; reason?: string };
}

export interface ScienceDeferredLoopResumeInput {
  projectId: string; conversationId: string; loopSessionId: string; expectedLoopVersion: number; reason: string;
}

export interface ScienceGoalLifecycleInstallInput {
  hostKind: "main" | "daemon";
  /** Throws when this host may not act now (admission closed, lease lost). Every clock fire and every resume passes it first. */
  fence: { assertExecution(): void };
  sdkPort?: () => ScienceGoalLifecycleSdkPort;
  clock?: SegmentDeadlineClock;
  recordLedger?: (runId: string, kind: string, payload: Record<string, unknown>) => void;
  resolveRun?: (loopSessionId: string) => LongRunRecord | null;
  onError?: (what: string, error: unknown) => void;
}

export interface ScienceGoalLifecycleHandle {
  /** Goes in `execution.goalLifecycle` of the Science host contract; undefined on a host that does not drive the loop's clocks. */
  readonly sdkHost: {
    readonly version: 1;
    readonly drives: readonly ("budget-deadlines" | "restart-resume")[];
    armBudgetDeadline(input: { projectId: string; conversationId: string; epoch: number; deadlineAt: string }): void;
    clearBudgetDeadline(projectId: string): void;
  } | undefined;
  readonly domainPort: GoalLifecyclePort;
  readonly clock: SegmentDeadlineClock;
  /** Names the domain port to the common controllers. Called once the Science host contract is accepted, so a refused install leaves nothing registered. */
  register(): void;
  driveRestartResumes(deferred: readonly ScienceDeferredLoopResumeInput[]): Array<{ loopSessionId: string; outcome: "resumed" | "left-paused"; reason?: string }>;
  /** Clears every clock and unregisters the port. Safe to call more than once. */
  stop(): void;
}

const errorCode = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9_.:-]{0,118}$/i.test(raw) ? raw : "science_goal_lifecycle_failed";
};

export function installScienceGoalLifecycle(input: ScienceGoalLifecycleInstallInput): ScienceGoalLifecycleHandle {
  const sdk = input.sdkPort ?? (() => scienceGoalLifecyclePort() as unknown as ScienceGoalLifecycleSdkPort);
  const clock = input.clock ?? createSegmentDeadlineClock({ onError: (key, error) => (input.onError ?? defaultOnError)(`clock ${key}`, error) });
  const ledger = input.recordLedger ?? ((runId, kind, payload) => { appendLongRunEvent({ runId, kind, actorKind: "host", payload }); });
  const resolveRun = input.resolveRun ?? ((loopSessionId) => getLongRun(scienceLongRunId(loopSessionId)));
  let stopped = false;

  const scopeOf = (run: LongRunRecord) => {
    const binding = getLongRunDomainBinding(run.id);
    return binding && binding.domain === "science" && binding.objectType === "loop_session"
      ? { projectId: binding.externalProjectId, loopSessionId: binding.objectId } : null;
  };

  const domainPort: GoalLifecyclePort = {
    kind: "domain",
    status(run): GoalLifecycleStatus | null {
      const scope = scopeOf(run);
      const status = scope ? sdk().status(scope) : null;
      return status ? { kind: "domain", phase: status.phase, parkCause: status.parkCause, budget: status.budget,
        nextDeadlineAt: status.nextDeadlineAt, resumesAtRestart: status.resumesAtRestart } : null;
    },
    admit(run, attempt, nowMs): GoalAdmission {
      const scope = scopeOf(run);
      if (!scope) return { admitted: false, cause: "not_active" };
      input.fence.assertExecution();
      const result = sdk().admit(scope, attempt, nowMs);
      return result.admitted ? result : { admitted: false, cause: result.cause === "not_found" ? "not_active" : result.cause };
    },
    evaluateBudget(run, nowMs): GoalBudgetVerdict {
      const scope = scopeOf(run);
      if (!scope) return { exhausted: false, reason: null, parked: false };
      input.fence.assertExecution();
      return sdk().evaluateBudget(scope, nowMs);
    },
    park(run, request) {
      const scope = scopeOf(run);
      if (!scope) return { parked: false, reason: "science_loop_binding_missing" };
      input.fence.assertExecution();
      return sdk().park(scope, { reason: request.reason, ...(request.requestId ? { requestId: request.requestId } : {}) });
    },
    resume(run, request) {
      // An owner's Continue clears the owner's own Stop and is authenticated by Science's command channel; the port only resumes
      // without a person (restart, due retry), which never clears a Stop.
      if (request.actor === "owner") return { resumed: false, reason: "science_owner_resume_is_its_own_command" };
      const scope = scopeOf(run);
      if (!scope) return { resumed: false, reason: "science_loop_binding_missing" };
      input.fence.assertExecution();
      return sdk().resume(scope, { reason: request.reason, ...(request.expectedLoopVersion !== undefined ? { expectedLoopVersion: request.expectedLoopVersion } : {}) });
    },
    complete(run, request) {
      const scope = scopeOf(run);
      if (!scope) return { completed: false, reason: "science_loop_binding_missing" };
      input.fence.assertExecution();
      return sdk().complete(scope, request);
    },
  };

  let unregister: (() => void) | null = null;
  const drives = input.hostKind === "daemon";
  const sdkHost: ScienceGoalLifecycleHandle["sdkHost"] = drives ? {
    version: 1 as const,
    drives: ["budget-deadlines", "restart-resume"] as const,
    armBudgetDeadline: ({ projectId, conversationId, epoch, deadlineAt }) => {
      if (stopped) return;
      input.fence.assertExecution();
      const at = Date.parse(deadlineAt);
      if (!Number.isFinite(at) || !Number.isSafeInteger(epoch)) throw new Error("science_budget_deadline_invalid");
      clock.arm(`science-budget:${projectId}`, at, () => {
        if (stopped) return;
        input.fence.assertExecution();
        sdk().enforceBudgetDeadline({ projectId, conversationId, epoch });
      });
    },
    clearBudgetDeadline: (projectId) => { clock.clear(`science-budget:${projectId}`); },
  } : undefined;

  function defaultOnError(what: string, error: unknown): void {
    console.warn(`[science-goal-lifecycle] ${what} failed: ${errorCode(error)}`);
  }

  return {
    sdkHost, domainPort, clock,
    register() { if (!unregister && !stopped) unregister = registerDomainGoalLifecyclePort("science", domainPort); },
    driveRestartResumes(deferred) {
      const results: Array<{ loopSessionId: string; outcome: "resumed" | "left-paused"; reason?: string }> = [];
      for (const item of deferred) {
        let result: { loopSessionId: string; outcome: "resumed" | "left-paused"; reason?: string };
        try {
          if (stopped) throw new Error("science_goal_lifecycle_stopped");
          input.fence.assertExecution();
          const resumed = sdk().resume({ projectId: item.projectId, loopSessionId: item.loopSessionId },
            { reason: item.reason, expectedLoopVersion: item.expectedLoopVersion });
          result = resumed.resumed ? { loopSessionId: item.loopSessionId, outcome: "resumed" }
            : { loopSessionId: item.loopSessionId, outcome: "left-paused", reason: resumed.reason };
        } catch (error) {
          result = { loopSessionId: item.loopSessionId, outcome: "left-paused", reason: errorCode(error) };
        }
        results.push(result);
        // The outcome goes into the common ledger beside the loop's own (best effort: a missing mirror row loses only this note).
        try {
          const run = resolveRun(item.loopSessionId);
          if (run) ledger(run.id, "run.domain_restart_resume", { surface: "science", loopSessionId: item.loopSessionId,
            outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}), source: "goal-lifecycle-port" });
        } catch (error) { (input.onError ?? defaultOnError)("restart ledger note", error); }
      }
      return results;
    },
    stop() {
      stopped = true;
      clock.clearAll();
      unregister?.();
      unregister = null;
    },
  };
}
