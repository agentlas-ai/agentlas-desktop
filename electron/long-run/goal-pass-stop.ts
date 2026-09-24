/**
 * 목표 턴이 실패로 멈춘 사유를 원장에 적고, 다시 이어갈 시각을 예약한다 (P0-3, G1·G2·G3).
 *
 * 실측(코드, 2026-09-24): mcp/client.ts 가 `goalPassStop` 을 세우지만 읽는 곳이 0곳이었고 `goal_pass_failed`
 * 이벤트를 소비하는 곳도 0곳이었다(5a47fcf1 이후). 한도·거절로 멈추면 알림만 남고 리셋 시각은 원장에도
 * 깨어남에도 닿지 않았다 — 목표는 사람이 다시 말을 걸 때까지 서 있었다.
 *
 * 규칙(지속 정책 shared/persistence-policy.ts 가 고른다):
 *  - 한도 → 리셋+15초(최소 30초)에 다시(Science 규칙과 같다). 힌트가 없으면 30분→2시간→6시간 탐침. pause 가 아니다.
 *  - 인증 → 다른 런타임으로(러너가 이미 인증 실패 런타임을 쿨다운에 올려 둔다 — 재개 턴이 다른 연결 모델로 간다).
 *    넘어갈 런타임이 하나도 없을 때만 자격증명을 한 번 묻고, 그동안에도 긴 휴식 뒤 다시 본다.
 *  - 거절·미지원 → 재계획(같은 요청은 같은 거절을 받는다). 재개 턴이 대화에서 거절 사실을 본다.
 *  - 일시 오류 소진 → 백오프 재시도 / 런타임 전환. 효과 확인 필요 → 읽기 전용 관찰.
 *
 * 쓰기 경로는 새로 만들지 않는다: running → blocked 뒤 기존 scheduleBlockedGoalRetry(막힌 목표 스윕의 예약)를
 * 그대로 쓴다. 시각이 되면 스윕이 원래 사유로 되돌려 관찰/재개를 한다(blocked-goal-sweep.ts).
 */
import { appendChatMessage } from "../store/chats";
import {
  appendLongRunEvent,
  getLongRun,
  getLongRunByGoalId,
  nextBlockedGoalRetrySlot,
  scheduleBlockedGoalRetry,
  transitionLongRun,
} from "../store/long-runs";
import { listPersistenceDecisionEvents, recordPersistenceDecisionEvent } from "../store/run-events";
import { desktopAppInstanceId } from "./app-runtime-coordinator";
import { currentUiLocale } from "../ui-locale";
import {
  decidePersistenceMove,
  jitteredDelayMs,
  persistenceAttemptOf,
  persistenceDecisionPayload,
  type FailureCause,
  type PersistenceDecision,
} from "../../shared/persistence-policy";
import type { PassFailureVerdict } from "./pass-failure-verdict";
import type { RunnerFailureKind } from "../runtime/runner";

export const GOAL_PASS_STOPPED_EVENT_KIND = "run.goal_pass_stopped" as const;

/** mcp/client.ts 가 루프를 멈출 때 세우는 호스트 사실(타입만, 산문 없음). */
export interface GoalPassStop {
  goalId: string;
  reason: PassFailureVerdict["reason"];
  action: PassFailureVerdict["action"];
  failureKind: RunnerFailureKind;
  runtime: string;
  /** 런타임 고지문의 리셋 힌트 원문(있으면). */
  retryAfterHint?: string;
  /** 힌트를 호스트가 해석한 리셋 시각(ISO). 못 읽었으면 없음. */
  retryAfterAt?: string;
}

/** 멈춘 사유 → 지속 정책의 원인 어휘. 러너가 쓴 타입과 판정 사유만 본다. */
export function goalPassStopCause(stop: Pick<GoalPassStop, "reason" | "failureKind" | "retryAfterAt">): FailureCause {
  if (stop.reason === "effect_verification_required") return { kind: "effect_uncertain" };
  if (stop.failureKind === "quota" || stop.reason === "usage_limited") {
    return { kind: "quota", retryAfterAt: stop.retryAfterAt ?? null };
  }
  if (stop.failureKind === "auth" || stop.reason === "unauthorized") return { kind: "auth" };
  // 같은 요청은 같은 거절을 받는다 — 요청(계획)을 바꿔야 한다. 대안 도구가 없으므로 사다리 첫 칸은 replan.
  if (stop.failureKind === "refused" || stop.failureKind === "unsupported"
    || stop.reason === "refused" || stop.reason === "unsupported"
    || stop.reason === "context_capacity" || stop.reason === "context_measurement") return { kind: "tool_refused" };
  if (["timeout", "unavailable", "empty", "exit"].includes(stop.failureKind)) return { kind: "runtime_unavailable" };
  return { kind: "unknown" };
}

/** 이 목표 대화의 지난 24시간 지속 결정(목표 층이 내린 것만). */
function goalDecisionHistory(chatId: string, nowMs: number) {
  const since = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  return listPersistenceDecisionEvents({ chatId, sinceIso: since, limit: 50 })
    .map((row) => row.payload)
    .filter((payload) => payload.surface === "goal" && payload.ownerLayer === "goal_ledger");
}

export interface ParkGoalResult {
  status: "scheduled" | "escalated" | "skipped";
  detail: string;
  decision?: PersistenceDecision;
  nextAt?: string;
}

/**
 * 턴 정지 → 원장. 목표 행이 running 일 때만 움직인다(사람이 멈췄거나 다른 주인이 이미 다음 단계를 잡았으면
 * 건드리지 않는다). 반환값은 영수증의 요약이다.
 */
export function parkGoalAfterPassStop(input: {
  stop: GoalPassStop;
  invocationRunId: string;
  chatId: string;
  /** 실패한 런타임을 뺀, 지금 넘어갈 수 있는 연결 런타임 수. */
  switchableRuntimes: number;
  nowMs?: number;
  random?: () => number;
}): ParkGoalResult {
  const nowMs = input.nowMs ?? Date.now();
  const run = getLongRunByGoalId(input.stop.goalId);
  if (!run || run.surface === "science") return { status: "skipped", detail: "goal_run_missing" };
  if (run.status !== "running") return { status: "skipped", detail: `goal_run_${run.status}` };
  const cause = goalPassStopCause(input.stop);
  const history = goalDecisionHistory(input.chatId, nowMs).map(persistenceAttemptOf);
  const deadline = run.budget.wallclockDeadline ?? null;
  const decision = decidePersistenceMove({
    cause,
    history,
    budget: { deadlineAt: deadline },
    goal: { status: "active", switchableRuntimes: input.switchableRuntimes },
    nowMs,
    ...(input.random ? { random: input.random } : {}),
  });
  recordPersistenceDecisionEvent({
    runId: input.invocationRunId,
    chatId: input.chatId,
    payload: persistenceDecisionPayload(decision, { surface: "goal", sourceRunId: input.invocationRunId, ownerLayer: "goal_ledger" }),
  });
  const move = decision.move;
  if (move.kind === "cancel_with_reason") {
    // 예산 소진은 기존 스윕의 취소 규칙이 기록과 함께 닫는다(여기서 새 취소 경로를 만들지 않는다).
    const blocked = transitionLongRun({ runId: run.id, to: "blocked", actorKind: "host", reason: "budget_wallclock_exhausted" });
    appendStop(blocked.id, input, decision, null);
    return { status: "skipped", detail: move.reason, decision };
  }
  const blockedReason = `goal_pass_${input.stop.reason}`;
  const nextAtMs = move.kind === "retry_backoff"
    ? Date.parse(move.at)
    : move.kind === "escalate_boundary"
      // 경계를 묻는 동안에도 목표를 버리지 않는다 — 긴 휴식 뒤 스스로 다시 본다(로그인이 되면 그때 이어진다).
      ? nowMs + jitteredDelayMs(6 * 60 * 60_000, input.random)
      // 런타임 전환·재계획·관찰은 곧바로 — 30초 지터(같은 정각 충돌 방지).
      : nowMs + jitteredDelayMs(30_000, input.random);
  const nextAt = new Date(nextAtMs).toISOString();
  const blockedRun = transitionLongRun({ runId: run.id, to: "blocked", actorKind: "host", reason: blockedReason });
  appendStop(blockedRun.id, input, decision, nextAt);
  const blocked = getLongRun(blockedRun.id) ?? blockedRun;
  const slot = nextBlockedGoalRetrySlot(blocked.id, nowMs);
  scheduleBlockedGoalRetry({
    runId: blocked.id,
    expectedVersion: blocked.version,
    kind: move.kind === "observe" || cause.kind === "effect_uncertain" ? "observe" : "resume",
    fromReason: blockedReason,
    retryIndex: slot.retryIndex,
    nextAt,
    detail: `persistence:${move.kind}:${cause.kind}`,
    trigger: "goal-pass-stop",
    effectUncertain: cause.kind === "effect_uncertain",
    appInstanceId: desktopAppInstanceId(),
  });
  notifyOnce(input, blocked.id, decision, nextAtMs, nowMs);
  return { status: move.kind === "escalate_boundary" ? "escalated" : "scheduled", detail: move.kind, decision, nextAt };
}

function appendStop(runId: string, input: { stop: GoalPassStop; invocationRunId: string }, decision: PersistenceDecision, nextAt: string | null): void {
  appendLongRunEvent({
    runId,
    kind: GOAL_PASS_STOPPED_EVENT_KIND,
    actorKind: "host",
    payload: {
      invocationRunId: input.invocationRunId,
      reason: input.stop.reason,
      action: input.stop.action,
      failureKind: input.stop.failureKind,
      runtime: input.stop.runtime,
      retryAfterAt: input.stop.retryAfterAt ?? null,
      retryAfterHint: input.stop.retryAfterHint?.slice(0, 200) ?? null,
      cause: decision.cause.kind,
      move: decision.move.kind,
      nextAt,
    },
  });
}

function notifyOnce(input: { chatId: string; stop: GoalPassStop }, longRunId: string, decision: PersistenceDecision, nextAtMs: number, nowMs: number): void {
  const ko = currentUiLocale() === "ko";
  const minutes = Math.max(1, Math.round((nextAtMs - nowMs) / 60_000));
  const move = decision.move;
  let text: string;
  if (move.kind === "escalate_boundary") {
    text = ko
      ? "이 목표를 이어갈 모델이 모두 로그인이 필요한 상태예요. 연결된 모델 하나에 다시 로그인해 주시면 이어갑니다. 그동안에도 앱이 주기적으로 다시 확인합니다."
      : "Every model that could continue this goal needs a sign-in. Sign in to one connected model and it will continue; the app keeps checking on its own meanwhile.";
  } else if (decision.cause.kind === "quota") {
    text = ko
      ? `사용 한도에 걸려 잠시 멈췄어요. 한도가 풀리는 시각에 맞춰 약 ${minutes}분 뒤 앱이 스스로 이어갑니다.`
      : `Paused on a usage limit. The app continues on its own when the limit resets, in about ${minutes} min.`;
  } else if (move.kind === "replan") {
    text = ko
      ? "모델이 이 요청을 그대로는 받지 않았어요. 곧 방법을 바꿔 다시 이어갑니다."
      : "The model would not take this request as it was. The app will change the approach and continue shortly.";
  } else if (move.kind === "switch_runtime") {
    text = ko
      ? "이 모델로는 지금 이어갈 수 없어서 곧 다른 연결 모델로 이어갑니다."
      : "This model cannot continue right now, so another connected model will pick the goal up shortly.";
  } else {
    text = ko
      ? `잠시 멈췄어요. 약 ${minutes}분 뒤 앱이 스스로 다시 이어갑니다.`
      : `Paused for now. The app continues on its own in about ${minutes} min.`;
  }
  try {
    appendChatMessage(input.chatId, "assistant", text, { hostNotice: { purpose: "goal-continuation", runId: longRunId } });
  } catch (error) {
    console.warn("[goal-pass-stop] chat notice failed:", error);
  }
}

/**
 * Service entry: count the connected orchestrator pool minus the failed runtime (cooldowns and signed-out
 * seats are already excluded by the pool), then park. Never throws — a ledger failure must not turn a
 * settled turn into an error; the goal then stays where the turn left it, exactly as before this path.
 */
export async function parkGoalAfterPassStopWithPool(input: {
  stop: GoalPassStop;
  invocationRunId: string;
  chatId: string;
}): Promise<ParkGoalResult> {
  try {
    const [{ detectRuntimes }, { rolePriorityRuntimes }] = await Promise.all([
      import("../runtime/detect"),
      import("../runtime/selection"),
    ]);
    const pool = rolePriorityRuntimes(await detectRuntimes(), "orchestrator");
    const switchableRuntimes = pool.filter((runtime) => runtime.kind !== input.stop.runtime).length;
    return parkGoalAfterPassStop({ ...input, switchableRuntimes });
  } catch (error) {
    console.warn("[goal-pass-stop] could not park the goal:", error);
    return { status: "skipped", detail: "park_failed" };
  }
}
