/**
 * The Goal lifecycle port, host side (PLAN S7-4): the common ledger (Work and One) answers the port's questions with the store
 * functions it already has, and `goalLifecyclePortFor` names which port answers for any run. A caller that holds a run asks THAT
 * port; it does not look at the run's surface.
 */
import {
  evaluateLongRunSegment, longRunContinueDecision, resumeLongRunByUser, transitionLongRun, tryCompleteVerifiedLongRun,
  type LongRunRecord,
} from "../store/long-runs";
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { ownsHostGoalLoop } from "./host-goal-surface";
import { startupResumeDecision } from "./startup-reconciler";
import {
  domainGoalLifecyclePort,
  type GoalAdmission, type GoalBudgetVerdict, type GoalLifecyclePort, type GoalLifecycleStatus, type GoalParkCause,
} from "./goal-lifecycle-registry";

const PARK_CAUSE: Record<string, GoalParkCause> = {
  user: "owner", app_closed: "host_boundary", crash_recovery: "host_boundary", approval_required: "approval", budget: "budget",
};
const WAITING = new Set(["waiting_tool", "waiting_user", "waiting_worker", "verifying"]);

export const hostGoalLifecyclePort: GoalLifecyclePort = {
  kind: "host",

  status(run, nowMs = Date.now()): GoalLifecycleStatus | null {
    const segment = run.budget.segment ?? null;
    const terminal = LONG_RUN_TERMINAL_STATUSES.has(run.status);
    const parked = run.status === "paused";
    const parkCause = parked ? PARK_CAUSE[run.pauseReason ?? ""] ?? "other" : null;
    return {
      kind: "host",
      phase: terminal ? "terminal" : parked ? "parked" : WAITING.has(run.status) ? "waiting" : "active",
      parkCause,
      budget: segment,
      nextDeadlineAt: segment && segment.status === "active" && !segment.hostWait && !terminal ? segment.deadlineAt : null,
      resumesAtRestart: startupResumeDecision({ status: run.status, pauseReason: run.pauseReason, cycleCount: run.cycleCount,
        costUsedUsd: run.costUsedUsd, costAccounting: run.costAccounting,
        budget: { maxCycles: run.budget.maxCycles ?? null, maxCostUsd: run.budget.maxCostUsd ?? null, wallclockDeadline: run.budget.wallclockDeadline ?? null },
        now: nowMs }).resume,
    };
  },

  /** The host decides; the attempt itself is written by startLongRunWorkerAttempt when the invocation starts. */
  admit(run): GoalAdmission {
    const decision = longRunContinueDecision(run.goalId);
    if (!decision) return { admitted: false, cause: "not_active" };
    if (decision.continue) return { admitted: true, registered: false };
    return { admitted: false, cause: decision.reason === "segment_budget_exhausted" ? "budget"
      : decision.reason === "goal_paused" ? "owner_stopped" : "not_active" };
  },

  evaluateBudget(run, nowMs = Date.now()): GoalBudgetVerdict {
    const result = evaluateLongRunSegment(run.id, { nowMs });
    return { exhausted: result.exhausted !== null, reason: result.exhausted, parked: result.parked
      || (result.run?.status === "paused" && result.run.pauseReason === "budget") };
  },

  park(run, request) {
    try {
      transitionLongRun({ runId: run.id, to: "paused", actorKind: request.cause === "owner" ? "user" : "host",
        reason: request.cause === "owner" ? "user" : "app_closed", actorId: request.reason.slice(0, 120) });
      return { parked: true };
    } catch (error) {
      return { parked: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },

  resume(run, request) {
    try {
      if (request.actor === "owner") {
        if (!request.appInstanceId) return { resumed: false, reason: "app_instance_required" };
        resumeLongRunByUser(run.id, request.appInstanceId, run.version);
        return { resumed: true };
      }
      // The restart rule is the common one: a run the host itself parked, within its budget.
      const decision = startupResumeDecision({ status: run.status, pauseReason: run.pauseReason, cycleCount: run.cycleCount,
        costUsedUsd: run.costUsedUsd, costAccounting: run.costAccounting,
        budget: { maxCycles: run.budget.maxCycles ?? null, maxCostUsd: run.budget.maxCostUsd ?? null, wallclockDeadline: run.budget.wallclockDeadline ?? null } });
      if (!decision.resume) return { resumed: false, reason: decision.reason };
      transitionLongRun({ runId: run.id, to: "queued", actorKind: "host", reason: request.reason.slice(0, 120),
        ...(request.appInstanceId ? { appInstanceId: request.appInstanceId } : {}), expectedVersion: run.version });
      return { resumed: true };
    } catch (error) {
      return { resumed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },

  complete(run) {
    try { return tryCompleteVerifiedLongRun(run.id) ? { completed: true } : { completed: false, reason: "criteria_unverified" }; }
    catch (error) { return { completed: false, reason: error instanceof Error ? error.message : String(error) }; }
  },
};

/** The port that answers for this run: the common ledger for Work and One, the registered domain port otherwise (null = none installed). */
export function goalLifecyclePortFor(run: Pick<LongRunRecord, "surface">): GoalLifecyclePort | null {
  return ownsHostGoalLoop(run.surface) ? hostGoalLifecyclePort : domainGoalLifecyclePort(run.surface);
}

/** The common controller's budget step: ask whichever port answers for the run. A run with no port is left alone. */
export function evaluateGoalBudget(run: LongRunRecord, nowMs = Date.now()): GoalBudgetVerdict | null {
  return goalLifecyclePortFor(run)?.evaluateBudget(run, nowMs) ?? null;
}
