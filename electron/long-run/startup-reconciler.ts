import { longRunMonetaryRefusal, type LongRunCostAccounting } from "./budget";
import { getLongRun, unsettledLongRunAttemptCount, type LongRunRecord } from "../store/long-runs";

/**
 * Whether a goal that the host paused may pick itself up again.
 *
 * Quitting the app pauses every running goal with `automaticResume: false`, and startup pauses again
 * for the same reason. Nothing ever undid either, so a goal meant to run for days ended permanently
 * the first time the person closed the window — the state said "paused", and no code path in the
 * product could take it out of that state on its own.
 *
 * Auto-resume cannot simply be switched on, though: an attempt that was mid-flight when the host
 * died has an unknown side effect, and repeating it could send the same message or write the same
 * file twice. So the rule is narrow and provable: resume only a goal that was *between* turns.
 *
 * That is not a corner case, it is the common one. A long goal spends almost all of its life
 * between turns, which is exactly when a person closes their laptop.
 */
export type StartupResumeDecision =
  | { resume: true }
  | { resume: false; reason: StartupResumeRefusal };

export type StartupResumeRefusal =
  /** The person paused it, or a blocker stopped it. Only a host pause is ours to undo. */
  | "not-a-host-pause"
  /** Something was mid-flight; its side effects are unknown, so a person decides. */
  | "attempt-unsettled"
  /** Cycles, wallclock, or cost are genuinely spent. An absent limit is not a spent one. */
  | "budget-spent"
  | "budget-cost-unavailable"
  /** Nothing left to do. */
  | "not-paused";

/** Pause reasons the host itself wrote. Anything else belongs to the person or to a blocker. */
const HOST_PAUSE_REASONS = new Set(["app_closed", "crash_recovery"]);

export function startupResumeDecision(input: {
  status: string;
  pauseReason: string | null;
  unsettledAttempts: number;
  cycleCount: number;
  costUsedUsd: number;
  costAccounting?: LongRunCostAccounting;
  budget: { maxCycles: number | null; maxCostUsd: number | null; wallclockDeadline: string | null };
  now?: number;
}): StartupResumeDecision {
  if (input.status !== "paused") return { resume: false, reason: "not-paused" };
  if (!input.pauseReason || !HOST_PAUSE_REASONS.has(input.pauseReason)) {
    return { resume: false, reason: "not-a-host-pause" };
  }
  if (input.unsettledAttempts > 0) return { resume: false, reason: "attempt-unsettled" };
  const now = input.now ?? Date.now();
  const cyclesSpent = input.budget.maxCycles != null && input.cycleCount >= input.budget.maxCycles;
  const deadlinePassed = input.budget.wallclockDeadline != null
    && Date.parse(input.budget.wallclockDeadline) <= now;
  const monetaryRefusal = longRunMonetaryRefusal(input);
  if (cyclesSpent || deadlinePassed || monetaryRefusal === "budget_cost_exhausted") return { resume: false, reason: "budget-spent" };
  if (monetaryRefusal) return { resume: false, reason: "budget-cost-unavailable" };
  return { resume: true };
}

export interface StartupReconcileEntry {
  runId: string;
  decision: StartupResumeDecision;
}

/**
 * Read the state of every run the host just paused and say, per run, whether it may continue.
 *
 * This only decides. Dispatch is the caller's, so a host that cannot dispatch right now still gets a
 * truthful list rather than a silent no-op.
 */
export function reconcileHostPausedLongRuns(runIds: readonly string[]): StartupReconcileEntry[] {
  const entries: StartupReconcileEntry[] = [];
  for (const runId of runIds) {
    let run: LongRunRecord | null = null;
    try { run = getLongRun(runId); } catch { run = null; }
    if (!run) {
      entries.push({ runId, decision: { resume: false, reason: "not-paused" } });
      continue;
    }
    const unsettledAttempts = unsettledLongRunAttemptCount(runId);
    entries.push({
      runId,
      decision: startupResumeDecision({
        status: run.status,
        pauseReason: run.pauseReason ?? null,
        unsettledAttempts,
        cycleCount: run.cycleCount,
        costUsedUsd: run.costUsedUsd,
        costAccounting: run.costAccounting,
        budget: {
          maxCycles: run.budget.maxCycles ?? null,
          maxCostUsd: run.budget.maxCostUsd ?? null,
          wallclockDeadline: run.budget.wallclockDeadline ?? null,
        },
      }),
    });
  }
  return entries;
}
