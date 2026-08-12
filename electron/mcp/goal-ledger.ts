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

export interface GoalLedgerSnapshot {
  goalId: string;
  objective: string;
  acceptanceCriteria: string[];
  status: "active" | "blocked" | "completed" | "cancelled";
}

const DECISION_SCHEMA = "agentlas.goal-ledger-decision.v1";
const GOAL_SCHEMA = "agentlas.goal-ledger.v1";

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

function parseSnapshot(value: unknown): GoalLedgerSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== GOAL_SCHEMA
    || typeof row.goalId !== "string"
    || typeof row.objective !== "string"
    || !["active", "blocked", "completed", "cancelled"].includes(String(row.status ?? ""))
  ) return null;
  return {
    goalId: row.goalId,
    objective: row.objective.trim(),
    acceptanceCriteria: Array.isArray(row.acceptanceCriteria)
      ? row.acceptanceCriteria.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
      : [],
    status: row.status as GoalLedgerSnapshot["status"],
  };
}

/** Read the durable contract without changing it. */
export async function getGoalLedgerGoal(
  goalId: string,
  projectDir?: string | null,
): Promise<GoalLedgerSnapshot | null> {
  return parseSnapshot(await ledgerCall<unknown>(["get", goalId], projectDir));
}

/**
 * Deterministic first-pass acceptance contract. The runtime must make these
 * more concrete in its visible kickoff, but even a disconnected Goal ledger
 * starts with target-surface, regression, and evidence requirements instead
 * of a vague "do your best" objective.
 */
export function deriveGoalAcceptanceCriteria(
  objective: string,
  locale: "ko" | "en",
): string[] {
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

/*
 * ── task 층 ────────────────────────────────────────────────────────────────
 * 원장 CLI는 8개 하위명령을 노출한다:
 *   create · get · tasks · add-task · complete-task · record-cycle ·
 *   should-continue · complete
 * 이 브리지는 오랫동안 5개만 감쌌고, 빠진 셋이 전부 task 층이었다. 결과는
 * 조용한 구조적 고장이었다(실측): create가 심는 `task:bootstrap`을 닫는 코드가
 * 없어 openTaskCount가 영원히 1 → 판정 사유 `no_open_tasks` 도달 불가 →
 * automation-scheduler의 verifiedComplete 영원히 거짓 → **어떤 goal도
 * completed로 끝날 수 없었다.** 남은 종료는 사용자 취소와 blocked뿐이었다.
 *
 * 원장 쪽은 멀쩡했다. 아무도 그 문을 두드리지 않았을 뿐이다.
 */

export interface GoalLedgerTask {
  taskId: string;
  summary: string;
  state: string;
  evidenceRef: string | null;
  blockedReason: string | null;
}

function parseTasks(value: unknown): GoalLedgerTask[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // 원장 goal 스키마 태그. 리터럴로 두는 것은 이 task 층이 goal 스냅샷 파서와
  // 독립적으로 커밋될 수 있어야 하기 때문이다(같은 파일을 다른 세션이 편집 중).
  if (row.schemaVersion !== "agentlas.goal-ledger.v1" || !Array.isArray(row.openTasks)) return null;
  return row.openTasks
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.taskId === "string" && typeof item.summary === "string")
    .map((item) => ({
      taskId: String(item.taskId),
      summary: String(item.summary),
      state: typeof item.state === "string" ? item.state : "todo",
      evidenceRef: typeof item.evidenceRef === "string" ? item.evidenceRef : null,
      blockedReason: typeof item.blockedReason === "string" ? item.blockedReason : null,
    }));
}

/** 미완 task 목록. 원장에 닿지 못하면 null(빈 배열과 구분된다). */
export async function listGoalLedgerTasks(
  goalId: string,
  projectDir?: string | null,
): Promise<GoalLedgerTask[] | null> {
  return parseTasks(await ledgerCall<unknown>(["tasks", goalId], projectDir));
}

/** task 하나를 근거와 함께 done으로 닫는다. */
export async function completeGoalLedgerTask(input: {
  goalId: string;
  taskId: string;
  evidence?: string | null;
  projectDir?: string | null;
}): Promise<boolean> {
  const args = ["complete-task", input.goalId, "--task-id", input.taskId];
  if (input.evidence) args.push("--evidence", input.evidence.slice(0, 240));
  const result = await ledgerCall<{ state?: string }>(args, input.projectDir);
  return result?.state === "done";
}

/**
 * 모델이 goal 전체 완료를 선언했을 때 미완 task를 전부 닫고 닫은 개수를 돌려준다.
 *
 * 이것은 완료 판정이 아니라 **회계**다. 호출자는 이 뒤에 판정을 다시 읽어
 * (`no_open_tasks`) 기존 신호 일치 규칙으로 goal을 닫을지 정한다. 여기서 바로
 * goal을 completed로 만들면 모델의 한마디가 곧 완료가 되어, 지금 고치려는
 * 결함의 정반대 결함(조기 완료)을 새로 만든다.
 *
 * 원장에 못 닿으면 0을 돌려주고 아무것도 바꾸지 않는다 — 기존 동작 그대로다.
 */
export async function closeOpenGoalLedgerTasks(input: {
  goalId: string;
  evidence?: string | null;
  projectDir?: string | null;
}): Promise<number> {
  const open = await listGoalLedgerTasks(input.goalId, input.projectDir);
  if (!open || open.length === 0) return 0;
  let closed = 0;
  for (const task of open) {
    const ok = await completeGoalLedgerTask({
      goalId: input.goalId,
      taskId: task.taskId,
      evidence: input.evidence ?? null,
      projectDir: input.projectDir,
    });
    if (ok) closed += 1;
  }
  return closed;
}
