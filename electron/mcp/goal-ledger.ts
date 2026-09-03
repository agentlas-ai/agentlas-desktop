// Compatibility bridge from the existing Goal-mode loop to Desktop-owned
// long-running work. Agentlas OS and its Python ledger are intentionally not
// part of this path: One, Work, and Science must remain inspectable and
// pausable from the Desktop store alone.
import { createHash } from "node:crypto";
import {
  ensureGoalLongRun,
  getLongRunByGoalId,
  listLongRunTasks,
  longRunContinueDecision,
  recordLongRunCycle,
  requestLongRunVerification,
  transitionLongRun,
  tryCompleteVerifiedLongRun,
} from "../store/long-runs";

export interface GoalLedgerDecision {
  continue: boolean;
  reason: string;
  status: string | null;
  openTaskCount: number;
  cycleCount: number;
  objective: string | null;
  blockedReason: string | null;
}

export interface GoalLedgerSnapshot {
  goalId: string;
  objective: string;
  acceptanceCriteria: string[];
  status: "active" | "blocked" | "completed" | "cancelled";
  runId: string;
  runStatus: string;
  pauseReason: string | null;
  version: number;
  executionLocation: "desktop-local" | "web-hosted";
}

export interface GoalLedgerTask {
  taskId: string;
  summary: string;
  state: string;
  evidenceRef: string | null;
  blockedReason: string | null;
}

export const GOAL_HARD_STOP_REASONS: ReadonlySet<string> = new Set([
  "goal_blocked",
  "goal_terminal",
  "goal_paused",
  "budget_wallclock_exhausted",
  "budget_cycles_exhausted",
  "budget_cost_exhausted",
]);

function snapshotStatus(status: string): GoalLedgerSnapshot["status"] {
  if (status === "blocked" || status === "failed") return "blocked";
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "cancelling") return "cancelled";
  return "active";
}

function decisionForGoal(goalId: string): GoalLedgerDecision | null {
  const decision = longRunContinueDecision(goalId);
  if (!decision) return null;
  return {
    continue: decision.continue,
    // The existing Goal loop uses no_open_tasks as its evidence-gated close
    // handshake. A completed long run has already passed that gate.
    reason: decision.status === "completed" ? "no_open_tasks" : decision.reason,
    status: decision.status,
    openTaskCount: decision.openTaskCount,
    cycleCount: decision.cycleCount,
    objective: decision.objective,
    blockedReason: decision.blockedReason,
  };
}

export async function getGoalLedgerGoal(
  goalId: string,
  _projectDir?: string | null,
): Promise<GoalLedgerSnapshot | null> {
  try {
    const run = getLongRunByGoalId(goalId);
    if (!run) return null;
    return {
      goalId: run.goalId,
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      status: snapshotStatus(run.status),
      runId: run.id,
      runStatus: run.status,
      pauseReason: run.pauseReason,
      version: run.version,
      executionLocation: run.executionLocation,
    };
  } catch {
    return null;
  }
}

export function deriveGoalAcceptanceCriteria(objective: string, locale: "ko" | "en"): string[] {
  const normalized = objective.replace(/\s+/g, " ").trim().slice(0, 500);
  const requestedOutcome = locale === "ko"
    ? `요청 결과가 실제 대상 표면에서 확인 가능하게 완성되어야 합니다: ${normalized}`
    : `The requested outcome must be complete and observable on the real target surface: ${normalized}`;
  return locale === "ko"
    ? [
        requestedOutcome,
        "명시된 범위·금지사항·기존 사용자 데이터를 보존하고, steering은 실행 경로만 조정해야 합니다.",
        "변경한 경로의 관련 테스트·타입 검사·빌드가 통과하고 기존 핵심 흐름에 회귀가 없어야 합니다.",
        "완료 주장은 소스가 아니라 실제 앱·런타임·산출물 중 해당되는 최종 표면에서 검증되어야 합니다.",
        "각 성공 기준에는 재현 가능한 증거가 있어야 하며, 확인하지 못한 항목은 완료로 처리하지 않습니다.",
      ]
    : [
        requestedOutcome,
        "Preserve stated scope, exclusions, and existing user data; steering may adjust execution but must not redefine the goal.",
        "Relevant tests, type checks, and builds for changed paths must pass without regressing the core flow.",
        "Completion must be verified on the applicable final app, runtime, or artifact surface rather than inferred from source alone.",
        "Every acceptance criterion needs reproducible evidence; unverified items must not be reported as complete.",
      ];
}

export function ensureGoalLedgerGoal(input: {
  goalId: string;
  objective: string;
  projectDir?: string | null;
  acceptanceCriteria?: string[];
  wallclockDeadline?: string;
  maxCycles?: number;
  maxCostUsd?: number;
  stallWindow?: number;
}): boolean {
  try {
    const run = ensureGoalLongRun({
      goalId: input.goalId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      projectDir: input.projectDir,
      wallclockDeadline: input.wallclockDeadline,
      maxCycles: input.maxCycles,
      maxCostUsd: input.maxCostUsd,
      stallWindow: input.stallWindow,
    });
    return !["blocked", "completed", "failed", "cancelled"].includes(run.status);
  } catch {
    return false;
  }
}

export async function goalLedgerShouldContinue(
  goalId: string,
  _projectDir?: string | null,
): Promise<GoalLedgerDecision | null> {
  try { return decisionForGoal(goalId); } catch { return null; }
}

export async function recordGoalLedgerCycle(input: {
  goalId: string;
  progressKey?: string | null;
  outcome?: string | null;
  projectDir?: string | null;
}): Promise<GoalLedgerDecision | null> {
  try {
    const result = recordLongRunCycle({
      goalId: input.goalId,
      progressKey: input.progressKey,
      outcome: input.outcome,
    });
    return result ? decisionForGoal(input.goalId) : null;
  } catch {
    return null;
  }
}

function cancelRun(goalId: string, reason: string): boolean {
  let run = getLongRunByGoalId(goalId);
  if (!run) return false;
  if (run.status === "cancelled") return true;
  if (run.status === "completed" || run.status === "failed") return false;
  if (run.status === "draft" || run.status === "paused" || run.status === "blocked") {
    transitionLongRun({ runId: run.id, to: "cancelled", reason, actorKind: "user" });
    return true;
  }
  if (run.status !== "cancelling") {
    run = transitionLongRun({ runId: run.id, to: "cancelling", reason, actorKind: "user" });
  }
  transitionLongRun({ runId: run.id, to: "cancelled", reason, actorKind: "host" });
  return true;
}

export async function completeGoalLedgerGoal(input: {
  goalId: string;
  status: "completed" | "cancelled" | "blocked";
  reason?: string;
  projectDir?: string | null;
}): Promise<boolean> {
  try {
    const run = getLongRunByGoalId(input.goalId);
    if (!run) return false;
    if (input.status === "cancelled") return cancelRun(input.goalId, input.reason ?? "cancelled");
    if (input.status === "blocked") {
      if (run.status === "blocked") return true;
      transitionLongRun({ runId: run.id, to: "blocked", reason: input.reason ?? "blocked", actorKind: "host" });
      return true;
    }
    if (run.status === "completed") return true;
    return tryCompleteVerifiedLongRun(run.id);
  } catch {
    return false;
  }
}

export function goalProgressKeyForText(text: string): string {
  return `sha256:${createHash("sha256").update((text ?? "").trim()).digest("hex").slice(0, 40)}`;
}

export async function listGoalLedgerTasks(
  goalId: string,
  _projectDir?: string | null,
): Promise<GoalLedgerTask[] | null> {
  try {
    const run = getLongRunByGoalId(goalId);
    if (!run) return null;
    return listLongRunTasks(run.id, true).map((task) => ({
      taskId: task.id,
      summary: task.title,
      state: task.state,
      evidenceRef: task.evidenceRef,
      blockedReason: task.blockedReason,
    }));
  } catch {
    return null;
  }
}

/** A completion claim requests verification; it never completes a task. */
export async function completeGoalLedgerTask(input: {
  goalId: string;
  taskId: string;
  evidence?: string | null;
  projectDir?: string | null;
}): Promise<boolean> {
  try {
    const run = getLongRunByGoalId(input.goalId);
    if (!run || !listLongRunTasks(run.id, true).some((task) => task.id === input.taskId)) return false;
    requestLongRunVerification(input.goalId, input.evidence);
    return false;
  } catch {
    return false;
  }
}

/** Compatibility name: record the claim and move to verification, closing zero tasks. */
export async function closeOpenGoalLedgerTasks(input: {
  goalId: string;
  evidence?: string | null;
  projectDir?: string | null;
  outcomeText?: string | null;
  invocationRunId?: string | null;
  /** InvocationService sets this while its terminal receipt is not durable yet. */
  deferVerificationUntilTerminal?: boolean;
}): Promise<number> {
  try {
    const before = await listGoalLedgerTasks(input.goalId, input.projectDir);
    if (input.deferVerificationUntilTerminal) {
      requestLongRunVerification(input.goalId, input.evidence);
      return 0;
    }
    const { verifyGoalCompletionClaim } = await import("../long-run/verifier");
    await verifyGoalCompletionClaim({
      goalId: input.goalId,
      outcomeText: input.outcomeText?.trim() || input.evidence?.trim() || "Completion claimed without result text.",
      evidence: input.evidence,
      invocationRunId: input.invocationRunId,
      projectDir: input.projectDir,
    });
    const after = await listGoalLedgerTasks(input.goalId, input.projectDir);
    return Math.max(0, (before?.length ?? 0) - (after?.length ?? 0));
  } catch {
    return 0;
  }
}
