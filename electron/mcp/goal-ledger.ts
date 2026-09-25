import { ownsHostGoalLoop } from "../long-run/host-goal-surface";
import type { LongRunUsageInput } from "../long-run/budget";
// Compatibility bridge from the existing Goal-mode loop to Desktop-owned
// long-running work. Agentlas OS and its Python ledger are intentionally not
// part of this path: One, Work, and Science must remain inspectable and
// pausable from the Desktop store alone.
import { createHash } from "node:crypto";
import { normalizeProgressText } from "../../shared/progress-key";
import {
  ensureGoalLongRun,
  getLongRunByGoalId,
  listLongRunTasks,
  longRunContinueDecision,
  recordLongRunCycle,
  recordLongRunUsage,
  requestLongRunVerification,
  transitionLongRun,
  tryCompleteVerifiedLongRun,
} from "../store/long-runs";
import { getChatGoalRevision } from "../store/chat-goals";
import { goalScopeCriterion } from "../../shared/goal-scope";
import type { GoalPlanView } from "../../shared/goal-shape";
import { goalPlanView } from "../long-run/goal-shaping";

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
  lifecycle?: "finite" | "ongoing";
  goalRevision?: number;
  objective: string;
  acceptanceCriteria: string[];
  status: "active" | "blocked" | "completed" | "cancelled";
  runId: string;
  runStatus: string;
  pauseReason: string | null;
  /** 막힌 이유 — 저장소에는 있는데 화면까지 오지 않던 값이다(실측 2026-09-08). */
  blockedReason: string | null;
  version: number;
  executionLocation: "desktop-local" | "web-hosted";
  /** 골 구조 판단 결과(모양·현재 전술) — 읽기 모델. 판단 전이면 없음(2026-09-24 오너 최우선). */
  plan?: GoalPlanView | null;
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
  "budget_cost_unavailable",
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
    const revision = getChatGoalRevision(goalId);
    return {
      goalId: run.goalId,
      ...(revision ? { goalRevision: revision.revision, lifecycle: revision.lifecycle } : {}),
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      status: snapshotStatus(run.status),
      runId: run.id,
      runStatus: run.status,
      pauseReason: run.pauseReason,
      // ★막힌 이유를 함께 싣는다 — 저장소에는 있는데 화면까지 못 오던 값이다.
      blockedReason: run.blockedReason ?? null,
      version: run.version,
      executionLocation: run.executionLocation,
      plan: goalPlanView(goalId),
    };
  } catch {
    return null;
  }
}

/**
 * An explicit goal's contract: the requested outcome and the permission boundary — nothing else.
 *
 * ★Owner 2026-09-25: "기준 5개 하드코딩 이런 거 없어야지." This used to append three fixed templates to every
 * goal (tests/type checks/builds, app-UI launch QA, "every criterion needs evidence"), whatever the task — a
 * text-file goal could never pass the build criterion. What "done" means now comes from the AI's own
 * decomposition (goal-shaping: tactics with done_when, key results) and the verifier rolls the outcome up from
 * those leaves (shared/goal-rollup.ts). The evidence standard is enforced by code (pinned proof contracts and
 * admissible host refs), not by a criterion sentence. The scope criterion stays: it is the permission and
 * working-folder boundary the host audits (safety invariant, not task semantics).
 */
export function deriveGoalAcceptanceCriteria(objective: string, locale: "ko" | "en", permission?: "read" | "write" | "full"): string[] {
  const normalized = objective.replace(/\s+/g, " ").trim();
  const requestedOutcome = locale === "ko"
    ? `요청 결과가 실제 대상 표면에서 확인 가능하게 완성되어야 합니다: ${normalized}`
    : `The requested outcome must be complete and observable on the real target surface: ${normalized}`;
  return [requestedOutcome, goalScopeCriterion({ permission, originalRequest: objective, locale })];
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
    lastFailure = null;
    return !["blocked", "completed", "failed", "cancelled"].includes(run.status);
  } catch (error) {
    /*
     * ★목표가 조용히 안 만들어지고 있었다 (오너 실사용 2026-09-08:
     *   "워크에서 goal 설정했는데 안 닫힌다. 진행도 안 된다").
     *
     *   여기 `catch { return false }` 가 **이유를 통째로 버렸다.** 그 false 를
     *   부르는 쪽도 안 보거나(ipc.ts) 안 쓰고, 화면은 `.catch(() => null)` 로 또 버렸다.
     *   삼킴이 세 겹이라, 앱 로그 3MB 안에 "goal" 이라는 글자가 **0줄**이었다.
     *   실패조차 남지 않으면 무엇이 잘못됐는지 아무도 알 수 없다.
     *
     *   판정(boolean)은 그대로 둔다 — service.ts 가 그 값으로 분기한다.
     *   대신 **이유를 남기고 물어볼 수 있게** 한다.
     */
    lastFailure = {
      goalId: input.goalId,
      reason: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    console.error("[goal] could not create or update the goal contract:", lastFailure.goalId, lastFailure.reason);
    return false;
  }
}

/** 마지막으로 목표 계약을 못 만든 이유. 화면이 사람에게 옮겨 적을 수 있도록 남긴다. */
let lastFailure: { goalId: string; reason: string; at: string } | null = null;
export function lastGoalLedgerFailure(): { goalId: string; reason: string; at: string } | null {
  return lastFailure;
}

export async function goalLedgerShouldContinue(
  goalId: string,
  _projectDir?: string | null,
): Promise<GoalLedgerDecision | null> {
  try { return decisionForGoal(goalId); } catch { return null; }
}

export async function recordGoalLedgerCycle(input: {
  goalId: string;
  usage?: LongRunUsageInput;
  progressKey?: string | null;
  /** Legacy finite path only; ignored when host receipts own progress. */
  progressText?: string;
  /** Only the direct One invocation path may request host evidence projection. */
  progressAuthority?: "one-host-receipts";
  outcome?: string | null;
  projectDir?: string | null;
}): Promise<GoalLedgerDecision | null> {
  try {
    const run = getLongRunByGoalId(input.goalId);
    const ongoingOne = input.progressAuthority === "one-host-receipts"
      && ownsHostGoalLoop(run?.surface) && getChatGoalRevision(input.goalId)?.lifecycle === "ongoing";
    if (ongoingOne) {
      // This executes inside an unfinished invocation, possibly once per
      // model pass. The current episode has no settled verification receipt
      // yet. Charge usage now, but count progress exactly once in the verifier
      // after its checkpoint is durable.
      if (input.usage) recordLongRunUsage(input.goalId, input.usage);
      return decisionForGoal(input.goalId);
    }
    const result = recordLongRunCycle({
      goalId: input.goalId,
      progressKey: input.progressKey ?? (input.progressText === undefined ? null : goalProgressKeyForText(input.progressText)),
      outcome: input.outcome,
      usage: input.usage,
    });
    return result ? decisionForGoal(input.goalId) : null;
  } catch (error) {
    if (input.usage) throw error;
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

/**
 * 진전 판별용 지문 — 원문 해시가 아니라 **뜻이 같으면 같은 키**.
 *
 * 실측(페르소나 루프 2026-09-14): 자동 목표 연속 실행이 "Computer Use 도구가 6번째 확인에도 연결되지 않습니다 … 변화 없음"을
 * 7번째·8번째·…·20번째로 숫자만 바꿔 20턴 넘게 반복했다(15초 간격). 정체 판별(stall_window=3)이 원문 sha256 이라 숫자 하나로
 * 매번 '새 진전'이 되었고, 순환 상한(maxCycles)은 null 이라 멈출 것이 없었다. 숫자·기억 이벤트 블록·공백·문장부호를 걷어낸 뒤 해시한다.
 */
export function goalProgressKeyForText(text: string): string {
  // 정규화는 자동화 도구 반복 감지(automation-progress-guard)와 한 벌이다.
  const normalized = normalizeProgressText(text);
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 40)}`;
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
