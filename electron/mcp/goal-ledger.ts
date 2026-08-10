// Desktop bridge to the shared persistent-goal ledger (Python:
// agentlas_cloud/workforce/goal_ledger.py, stored in
// ~/.agentlas/networking/workforce-goals.sqlite3).
//
// The ledger is the host-owned half of the persistent-goal loop: the model
// marker (<<stormbreaker-continue>>) says "I want to keep going"; the ledger
// says "the goal is not achieved yet". The continuation decision is the OR of
// both — the loop no longer dies just because the model forgot the marker.
//
// Deliberately account-free: unlike workforce goal-bind/goal-turn, the ledger
// must work signed-out, so no accountContext() round trip is made here.
//
// Every call is fail-soft (null on any failure): a machine without the
// Hephaestus runtime keeps exactly the old marker-only behavior instead of
// breaking the send path.
import { createHash } from "node:crypto";
import path from "node:path";

export interface GoalLedgerDecision {
  /** True exactly when: goal active AND open tasks remain AND budgets have headroom. */
  continue: boolean;
  /** Machine reason marker (e.g. open_tasks_remain, no_open_tasks, goal_blocked,
   *  budget_wallclock_exhausted, budget_cycles_exhausted, budget_cost_exhausted). */
  reason: string;
  status: string | null;
  openTaskCount: number;
  cycleCount: number;
  objective: string | null;
  blockedReason: string | null;
}

const DECISION_SCHEMA = "agentlas.goal-ledger-decision.v1";

/**
 * Reasons that must stop the loop even when the model marker asks to continue:
 * explicit end, human-call block (no-progress stall), and every budget
 * exhaustion. Shared by the live chat loop and the background scheduler so the
 * two surfaces cannot drift.
 */
export const GOAL_HARD_STOP_REASONS: ReadonlySet<string> = new Set([
  "goal_blocked",
  "goal_terminal",
  "budget_wallclock_exhausted",
  "budget_cycles_exhausted",
  "budget_cost_exhausted",
]);

function parseDecision(value: unknown): GoalLedgerDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== DECISION_SCHEMA || typeof row.continue !== "boolean") return null;
  return {
    continue: row.continue,
    reason: typeof row.reason === "string" ? row.reason : "unknown",
    status: typeof row.status === "string" ? row.status : null,
    openTaskCount: Number.isFinite(Number(row.openTaskCount)) ? Number(row.openTaskCount) : 0,
    cycleCount: Number.isFinite(Number(row.cycleCount)) ? Number(row.cycleCount) : 0,
    objective: typeof row.objective === "string" ? row.objective : null,
    blockedReason: typeof row.blockedReason === "string" ? row.blockedReason : null,
  };
}

async function ledgerCall<T>(args: string[], projectDir?: string | null): Promise<T | null> {
  try {
    // Lazy import: the engine module touches Electron app paths, and this
    // module's pure helpers (progress keys, hard-stop reasons) must stay
    // loadable from plain-node contract gates.
    const { runHephaestus } = await import("../hephaestus/engine");
    const result = await runHephaestus<T>("agentlas_cloud", ["workforce", "goal-ledger", ...args], {
      ...(projectDir ? { cwd: path.resolve(projectDir) } : {}),
      timeoutMs: 20_000,
    });
    if (!result.ok || !result.json) return null;
    return result.json;
  } catch {
    return null;
  }
}

/**
 * Idempotent goal upsert. On a fresh goal a bootstrap task is seeded by the
 * ledger so the continue decision never dead-ends before the first cycle.
 */
export async function ensureGoalLedgerGoal(input: {
  goalId: string;
  objective: string;
  projectDir?: string | null;
  acceptanceCriteria?: string[];
  wallclockDeadline?: string;
  maxCycles?: number;
  maxCostUsd?: number;
  stallWindow?: number;
}): Promise<boolean> {
  const args = ["create", input.goalId, "--objective", input.objective.slice(0, 2_000)];
  for (const criterion of input.acceptanceCriteria ?? []) args.push("--criteria", criterion);
  if (input.projectDir) args.push("--project", path.resolve(input.projectDir));
  if (input.wallclockDeadline) args.push("--deadline", input.wallclockDeadline);
  if (input.maxCycles != null) args.push("--max-cycles", String(input.maxCycles));
  if (input.maxCostUsd != null) args.push("--max-cost", String(input.maxCostUsd));
  if (input.stallWindow != null) args.push("--stall-window", String(input.stallWindow));
  const result = await ledgerCall<{ goalId?: string; status?: string }>(args, input.projectDir);
  return result?.status === "active";
}

/** Pure read of the host-owned continue decision. */
export async function goalLedgerShouldContinue(
  goalId: string,
  projectDir?: string | null,
): Promise<GoalLedgerDecision | null> {
  return parseDecision(await ledgerCall<unknown>(["should-continue", goalId], projectDir));
}

/**
 * Account one loop cycle (progress + stall detection + budgets) and return the
 * fresh continue decision in the same spawn. Identical consecutive progress
 * keys are "no progress"; a stall streak blocks the goal and calls a human.
 */
export async function recordGoalLedgerCycle(input: {
  goalId: string;
  progressKey?: string | null;
  outcome?: string | null;
  projectDir?: string | null;
}): Promise<GoalLedgerDecision | null> {
  const args = ["record-cycle", input.goalId];
  if (input.progressKey) args.push("--progress-key", input.progressKey);
  if (input.outcome) args.push("--outcome", input.outcome.slice(0, 240));
  return parseDecision(await ledgerCall<unknown>(args, input.projectDir));
}

/** Explicit goal terminal — completed / cancelled (or human-call blocked). */
export async function completeGoalLedgerGoal(input: {
  goalId: string;
  status: "completed" | "cancelled" | "blocked";
  reason?: string;
  projectDir?: string | null;
}): Promise<boolean> {
  const args = ["complete", input.goalId, "--terminal-status", input.status];
  if (input.reason) args.push("--reason", input.reason.slice(0, 240));
  const result = await ledgerCall<{ status?: string }>(args, input.projectDir);
  return result?.status === input.status;
}

/**
 * Progress fingerprint for one cycle: the digest of the visible result text.
 * Two cycles that end with byte-identical output made no progress — the exact
 * `progress_key` contract from networking/goal_loop.py.
 */
export function goalProgressKeyForText(text: string): string {
  return `sha256:${createHash("sha256").update((text ?? "").trim()).digest("hex").slice(0, 40)}`;
}
