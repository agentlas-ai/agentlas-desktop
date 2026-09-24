/**
 * 지속 정책의 Main 쪽 손 — 원장에서 과거 결정을 읽고, 호스트 사실로 원인을 고르고, 결정을 남긴다.
 * 결정 자체는 shared/persistence-policy.ts 의 순수 함수 하나가 한다(여기서 수를 고르지 않는다).
 *
 * 원인은 기계 표식으로만 고른다: 판정 reasonCode, 호스트가 센 도구 호출(run_events), 러너가 남긴
 * runtimeFailureKind. 모델 산문은 읽지 않는다.
 */
import type { Automation, RuntimeSelection } from "../shared/types";
import { getDb } from "./store/db";
import { listPersistenceDecisionEvents, recordPersistenceDecisionEvent } from "./store/run-events";
import { automationRunToolCounts, recentAutomationRunFacts } from "./automation-progress-facts";
import {
  decidePersistenceMove,
  persistenceAttemptOf,
  persistenceDecisionPayload,
  type FailureCause,
  type PersistenceDecision,
  type PersistenceDecisionPayload,
} from "../shared/persistence-policy";

/** 결정 이력을 보는 창 — 마지막 진전(바깥을 바꾸고 수용된 실행) 이후, 최대 7일. */
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface AutomationRunSettlementFacts {
  /** 커널/러너가 예외 없이 끝까지 돌았는가(판정 전). 실패·중지·감시견 정지는 false. */
  completed: boolean;
  outcome: string | null;
  reasonCode: string | null;
  /** 호스트가 센, 바깥을 바꿀 수 있었던 도구 호출 수. */
  actionCalls: number;
}

/**
 * 자기 보류(progress.self_hold) — 호스트 사실만으로 판정한다(판정 문장이 아니라).
 *  - 실행은 끝까지 돌았다(실패가 아니다),
 *  - 바깥을 바꾼 호출이 0이다,
 *  - 목표 충족이 확인되지 않았다: 판정이 미충족으로 봤거나(rejected = partial/error 판정), 판정기에 닿지
 *    못했다(unjudged). 판정이 목표 충족(accepted)·할 일 없음(skipped→accepted)·사람 필요(needs_input)·외부
 *    제약(blocked)으로 본 것은 목표 충족이거나 이유 타입이 있으므로 보류가 아니다.
 *    unjudged 를 넣는 이유(설치본 실측 2026-09-23 15:00Z 이후 f7a61706 20회): 스스로 고른 무변경 보류 중 7회가
 *    판정 시간 초과로 unjudged, 3회가 accepted 로 끝났고 rejected 는 0회였다 — 판정 결과에만 기대면 보류를
 *    한 번도 못 잡는다. 판정 불가는 "목표를 채웠다"의 증거가 아니다,
 *  - 도구 없이 했다는 주장은 따로 센다(claimed_without_tools).
 */
export function automationRunSettlementCause(facts: AutomationRunSettlementFacts): FailureCause | null {
  if (facts.reasonCode === "claimed_without_tools") return { kind: "claimed_without_tools" };
  if (!facts.completed) return null;
  if (facts.actionCalls > 0) return null;
  if (facts.outcome === "rejected" && facts.reasonCode === "controller_judged") return { kind: "self_hold" };
  if (facts.outcome === "unjudged") return { kind: "self_hold" };
  return null;
}

/** 마지막 진전 시각 — 바깥을 바꾸고(acting ≥ 1) 수용된 가장 최근 실행. 그 이후의 결정만 이력이다. */
function lastProgressAt(automationId: string): string | null {
  try {
    const facts = recentAutomationRunFacts(automationId, 24).reverse();
    const progressed = facts.find((fact) => fact.outcome === "accepted" && fact.actionCalls > 0);
    return progressed?.ranAt ?? null;
  } catch {
    return null;
  }
}

export function automationPersistenceHistory(automationId: string, nowMs = Date.now()): PersistenceDecisionPayload[] {
  const floor = new Date(nowMs - HISTORY_WINDOW_MS).toISOString();
  const progress = lastProgressAt(automationId);
  const since = progress && progress > floor ? progress : floor;
  return listPersistenceDecisionEvents({ automationId, sinceIso: since, limit: 100 }).map((row) => row.payload);
}

/** 가장 최근 실행이 남긴 결정 — 다음 실행이 소비한다. 그보다 뒤에 실행이 있었으면 이미 소비된 것이다. */
export function latestAutomationPersistenceDecision(automationId: string): PersistenceDecisionPayload | null {
  try {
    const latestRun = getDb().prepare(
      "SELECT id FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1",
    ).get(automationId) as { id: string } | undefined;
    if (!latestRun) return null;
    const decisions = listPersistenceDecisionEvents({ automationId, limit: 5 });
    const latest = decisions.at(-1)?.payload ?? null;
    if (!latest || latest.surface !== "automation" || latest.ownerLayer !== "scheduler") return null;
    return latest.sourceRunId === latestRun.id ? latest : null;
  } catch {
    return null;
  }
}

export interface RecordAutomationPersistenceInput {
  automation: Pick<Automation, "id" | "enabled">;
  /** run_history 의 id(= 실행 run id). */
  runId: string;
  cause: FailureCause;
  /** 실패한 런타임을 뺀, 지금 넘어갈 수 있는 풀 구성원 수. */
  switchableRuntimes: number;
  nowMs?: number;
  random?: () => number;
}

export function decideAndRecordAutomationPersistence(input: RecordAutomationPersistenceInput): PersistenceDecision {
  const nowMs = input.nowMs ?? Date.now();
  const history = automationPersistenceHistory(input.automation.id, nowMs).map(persistenceAttemptOf);
  const decision = decidePersistenceMove({
    cause: input.cause,
    history,
    goal: { status: input.automation.enabled ? "active" : "cancelled", switchableRuntimes: input.switchableRuntimes },
    nowMs,
    ...(input.random ? { random: input.random } : {}),
  });
  recordPersistenceDecisionEvent({
    runId: input.runId,
    automationId: input.automation.id,
    payload: persistenceDecisionPayload(decision, { surface: "automation", sourceRunId: input.runId, ownerLayer: "scheduler" }),
  });
  return decision;
}

/** 이 실행에서 바깥을 바꿀 수 있었던 호출 수(호스트 영수증). 못 읽으면 null — 0으로 지어내지 않는다. */
export function automationRunActionCalls(runId: string): number | null {
  try {
    return automationRunToolCounts(runId).actionCalls;
  } catch {
    return null;
  }
}

/**
 * 실패한 실행의 런타임 원인 — 러너가 남긴 타입 표식(runtimeFailureKind)만 본다.
 * 한도·인증·가용성처럼 "런타임을 바꾸면 나아지는" 원인만 돌려준다. 그 밖은 null.
 */
export function automationRuntimeFailureCause(runId: string): FailureCause | null {
  try {
    const rows = getDb().prepare(
      `SELECT payload_json FROM run_events WHERE run_id = ? AND payload_json LIKE '%runtimeFailureKind%'
        ORDER BY seq DESC LIMIT 20`,
    ).all(runId) as Array<{ payload_json: string | null }>;
    for (const row of rows) {
      let payload: Record<string, unknown> | null = null;
      try { payload = row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : null; } catch { payload = null; }
      const kind = typeof payload?.runtimeFailureKind === "string" ? payload.runtimeFailureKind : null;
      if (!kind) continue;
      if (kind === "quota") {
        const at = typeof payload?.runtimeFailureRetryAfterAt === "string" ? payload.runtimeFailureRetryAfterAt : null;
        return { kind: "quota", retryAfterAt: at };
      }
      if (kind === "auth") return { kind: "auth" };
      if (["timeout", "unavailable", "empty", "exit"].includes(kind)) return { kind: "runtime_unavailable" };
    }
  } catch {
    /* 원장을 못 읽으면 원인을 지어내지 않는다 */
  }
  return null;
}

/** 두 선택이 같은 공급자 좌석인가(모델까지). 복구 런타임을 고를 때 실패한 좌석을 빼는 데만 쓴다. */
export function sameRuntimeSeat(left: Pick<RuntimeSelection, "kind" | "backend" | "source">, right: Pick<RuntimeSelection, "kind" | "backend" | "source">): boolean {
  return left.kind === right.kind && (left.backend ?? null) === (right.backend ?? null)
    && (left.source ?? null) === (right.source ?? null);
}
