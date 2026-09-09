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
import { goalScopeCriterion } from "../../shared/goal-scope";

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
  /** 막힌 이유 — 저장소에는 있는데 화면까지 오지 않던 값이다(실측 2026-09-08). */
  blockedReason: string | null;
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
      // ★막힌 이유를 함께 싣는다 — 저장소에는 있는데 화면까지 못 오던 값이다.
      blockedReason: run.blockedReason ?? null,
      version: run.version,
      executionLocation: run.executionLocation,
    };
  } catch {
    return null;
  }
}

export function deriveGoalAcceptanceCriteria(objective: string, locale: "ko" | "en", permission?: "read" | "write" | "full"): string[] {
  const normalized = objective.replace(/\s+/g, " ").trim().slice(0, 500);
  const requestedOutcome = locale === "ko"
    ? `요청 결과가 실제 대상 표면에서 확인 가능하게 완성되어야 합니다: ${normalized}`
    : `The requested outcome must be complete and observable on the real target surface: ${normalized}`;
  /*
   * 판정자가 확인할 수 없는 기준은 영원히 통과하지 못하는 기준이다.
   * 2026-09-08 실측: "명시된 범위·금지사항을 보존" 을 물었더니 판정자가
   * "대조할 제약 목록이 없어 구체적으로 검증 불가"라고 답했다. 사용자가 제약을
   * 말하지 않으면 그 목록은 존재하지 않으므로 그 기준은 절대 만족될 수 없다.
   * 그래서 호스트가 실제로 영수증에 싣는 것(작업 폴더·권한)으로 바꾼다.
   */
  return locale === "ko"
    ? [
        requestedOutcome,
        goalScopeCriterion({ permission, originalRequest: objective, locale: "ko" }),
        "변경한 경로의 관련 테스트·타입 검사·빌드가 통과하고 기존 핵심 흐름에 회귀가 없어야 합니다.",
        "사용자가 앱이나 상호작용 UI의 생성·변경·전달 또는 실제 화면 QA를 요청한 경우에만 실제 앱을 실행하고"
        + " 브라우저·시뮬레이터·네이티브 런타임에서 핵심 사용자 흐름을 조작해야 합니다. 실행·화면·조작·결과의"
        + " 도구 기록이나 캡처를 남깁니다. 소스·빌드·정적 분석·단위/위젯 테스트·모델의 보고만으로는 충족되지 않습니다."
        + " 실패를 고치고 다시 검증합니다. 도구만 사용하는 런타임 관찰 요청에는 앱 실행·화면 QA를 요구하지 않으며,"
        + " 요청한 작업은 호스트 도구 영수증으로 증명합니다. 다른 산출물은 전달할 실제 형식에서 확인합니다."
        + " 환경이나 접근 권한이 없으면 미충족이며 기존 권한 안에서만 실행합니다.",
        "각 성공 기준에는 재현 가능한 증거가 있어야 하며, 도구 위임 관찰 요청에는 성공한 호스트 도구 영수증과"
        + " 위임을 요청한 경우 host-owned 실행 영수증이 필요합니다. 작업자·모델 보고만으로는 완료하지 않습니다.",
      ]
    : [
        requestedOutcome,
        goalScopeCriterion({ permission, originalRequest: objective, locale: "en" }),
        "Relevant tests, type checks, and builds for changed paths must pass without regressing the core flow.",
        "Only when the request asks to create, change, deliver, or perform actual screen QA of an app or interactive UI, launch the actual"
        + " app and exercise core user flows in a browser, simulator, or native runtime. Preserve tool evidence or captures of launch,"
        + " rendered screens, interactions, and outcomes. Source, build, static analysis, unit/widget tests, or a completion report alone"
        + " do not pass. Fix failures and repeat. A tool-only runtime or observation request does not require app launch or screen QA; its"
        + " requested operation must instead be proved by host receipts. For other outputs inspect the delivered format. Missing runtime/access"
        + " remains unmet; use only existing permissions.",
        "Every acceptance criterion needs reproducible evidence; for a delegated tool-only observation request, a successful host tool receipt"
        + " and a host-owned delegation execution receipt when delegation was requested are required. Worker or model prose alone is not evidence.",
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
