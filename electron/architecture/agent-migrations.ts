/**
 * 에이전트 아키텍처 마이그레이션 — 이 제품의 상시 층.
 *
 * 업데이트(데스크탑·플러그인·Agentlas OS)는 새 아키텍처를 가져온다. 그런데 새 배선은
 * 대개 "앞으로 만들어질 것"에만 적용되고, **이미 등록된 에이전트는 옛 상태 그대로 남는다.**
 * 그래서 오래 쓴 에이전트일수록 새 기능이 비어 있는 역설이 생긴다 — 실측: 913회 실행한
 * 에이전트가 경험 칩 0, 로컬로 가져온 팀원 3명이 기억 59건을 갖고도 경험 후보 0.
 *
 * 이 층의 계약:
 *
 *  1. **단계는 추가만 한다.** 이미 배포돼 지나간 단계의 뜻을 바꾸지 않는다. 고칠 것이 있으면
 *     새 id 로 단계를 하나 더 만든다(원장이 옛 단계를 이미 닫아 놨기 때문에, 뜻을 바꾸면
 *     그 수정은 기존 사용자에게 영원히 도달하지 않는다).
 *
 *  2. **원장은 (에이전트 × 단계)다.** 앱 버전이 아니라. 그래서 새 단계는 언제 설치됐든,
 *     누구 소유든, 등록된 **모든** 에이전트에게 정확히 한 번씩 돈다. 새로 설치되는
 *     에이전트도 다음 스윕에서 같은 단계를 받는다.
 *
 *  3. **조용한 0을 남기지 않는다.** 아무것도 안 바꾼 단계도 `noop` 으로 적고, 실패는
 *     `failed` 로 사유와 함께 적는다. 원장을 보면 "이 사용자에게 무엇이 적용됐는가"를
 *     추측 없이 답할 수 있다.
 *
 *  4. **한 에이전트의 실패가 나머지를 막지 않는다.** 라이브러리 하나가 손상돼도 스윕은
 *     끝까지 간다.
 */
import { getDb } from "../store/db";
import { ARCHITECTURE_VERSION } from "./manifest";
import {
  currentExperienceBaseHash,
  promoteWaitingExperienceCandidates,
  reconcileExistingCuratedMemoryCandidates,
} from "../experience/store";
import { backfillExperienceFromRunHistory } from "../experience/backfill";
import { hasDurableRunStartReceipt } from "../store/run-events";

export interface AgentMigrationOutcome {
  outcome: "applied" | "noop" | "failed";
  changed: number;
  detail?: string;
}

export interface AgentMigrationStep {
  /** 원장 키. 한 번 배포하면 절대 바꾸지 않는다. */
  id: string;
  /** 사람이 읽는 설명 — 원장 화면과 로그에 그대로 나간다. */
  description: string;
  run(agentId: string): AgentMigrationOutcome;
}

/**
 * 이 에이전트가 실제로 돈 실행 중 시작 영수증이 있는 것 하나. 없으면 승급 근거가 없다.
 *
 * ★시작 영수증 행은 **이 에이전트 이름으로 남지 않는다.** 실행이 시작되는 시점에는 아직 누가
 * 맡을지 정해지지 않아 `agent_id` 가 NULL 이고(스웜·편성 실행), 에이전트 이름은 그 뒤의
 * 도구·완료 이벤트부터 붙는다. 그래서 "이 에이전트의 시작 이벤트"를 찾으면 항상 0건이다 —
 * 실측: 913개 이벤트를 남긴 에이전트의 실행 6건이 전부 영수증을 갖고 있는데도 0으로 보였다.
 * 실행 id 는 이 에이전트의 이벤트에서 얻고, 영수증 판정은 그 실행 전체에 묻는다.
 */
function durableRunIdFor(agentId: string): string | null {
  const rows = getDb().prepare(
    `SELECT run_id AS runId, MAX(ts) AS at
       FROM run_events
      WHERE agent_id = ? AND run_id IS NOT NULL
      GROUP BY run_id
      ORDER BY at DESC
      LIMIT 24`,
  ).all(agentId) as Array<{ runId: string }>;
  for (const row of rows) {
    if (row.runId && hasDurableRunStartReceipt(row.runId)) return row.runId;
  }
  return null;
}

/**
 * 등록된 에이전트에 적용할 단계들.
 *
 * ★새 아키텍처를 만들 때마다 여기에 단계를 하나 추가하는 것이 이 제품의 규칙이다. 새 배선을
 * "앞으로의 실행"에만 붙이고 끝내면, 이미 등록된 에이전트에게는 영원히 도달하지 않는다.
 */
export const AGENT_MIGRATION_STEPS: AgentMigrationStep[] = [
  {
    id: "experience-base-hash-2026-08",
    description: "패키지가 없는 에이전트도 안정된 경험 기준을 갖게 하고, 기준이 없어 버려졌던 기억을 다시 수집한다",
    run(agentId) {
      // 기준을 못 구하는 에이전트는 건드리지 않는다 — 추측한 기준으로 경험을 묶으면
      // 나중에 진짜 기준이 생겼을 때 전부 무효가 된다.
      if (!currentExperienceBaseHash(agentId)) {
        return { outcome: "noop", changed: 0, detail: "base-unavailable" };
      }
      const result = reconcileExistingCuratedMemoryCandidates(2_000, { agentId });
      return {
        outcome: result.candidateCreated > 0 ? "applied" : "noop",
        changed: result.candidateCreated,
        detail: `scanned=${result.scanned} blocked=${result.blocked} skipped=${result.skipped}`,
      };
    },
  },
  {
    id: "experience-from-run-history-2026-08",
    description: "하드 훅이 붙기 전에 지나간 실행 이력을 경험으로 되돌린다",
    run(agentId) {
      const result = backfillExperienceFromRunHistory({ agentId });
      return {
        outcome: result.memoriesCreated > 0 ? "applied" : "noop",
        changed: result.memoriesCreated,
        detail: `intake=${result.intakeAttempted} existing=${result.skippedExisting}`,
      };
    },
  },
  {
    id: "experience-auto-promote-2026-08",
    description: "실행 영수증이 있는 후보를 칩으로 승급한다(사용자가 승급 방법을 몰라도 쌓이게)",
    run(agentId) {
      const runId = durableRunIdFor(agentId);
      if (!runId) return { outcome: "noop", changed: 0, detail: "no-durable-run-receipt" };
      const result = promoteWaitingExperienceCandidates({ agentId, runId, limit: 200 });
      return {
        outcome: result.promoted > 0 ? "applied" : "noop",
        changed: result.promoted,
        detail: `eligible=${result.eligible}`,
      };
    },
  },
];

export interface AgentMigrationSweepResult {
  agentsScanned: number;
  stepsRun: number;
  applied: number;
  noop: number;
  failed: number;
  changed: number;
  /** 단계별 변경 건수 — 로그 한 줄로 "이번 업데이트가 무엇을 했는가"가 보이게. */
  byStep: Record<string, number>;
}

/** 이 에이전트가 마지막으로 무언가를 남긴 시각 — 이력이 늘었는지 판단하는 값싼 기준. */
function lastActivityAt(agentId: string): string | null {
  const row = getDb().prepare(
    `SELECT MAX(at) AS at FROM (
       SELECT MAX(ts) AS at FROM run_events WHERE agent_id = ?
       UNION ALL
       SELECT MAX(created_at) AS at FROM memory_entries WHERE agent_id = ?
     )`,
  ).get(agentId, agentId) as { at?: string | null } | undefined;
  return row?.at ?? null;
}

/**
 * 이 에이전트에게 아직 적용하지 않은 단계들.
 *
 * ★`noop` 은 종결이 아니다. 오늘 설치돼 이력이 없는 에이전트는 모든 단계가 `noop` 으로
 * 닫히는데, 그 뒤 100번을 돌아도 단계가 다시 오지 않으면 그 에이전트는 영원히 빈 채로 남는다
 * — 지금 고치고 있는 병과 정확히 같은 모양이다. 그래서 `noop`/`failed` 는 그 뒤로 이력이
 * 늘었을 때만 다시 돈다(값싼 MAX(ts) 비교 한 번). `applied` 는 다시 돌지 않는다.
 */
function pendingStepsFor(agentId: string): AgentMigrationStep[] {
  const rows = getDb().prepare(
    "SELECT step_id AS stepId, outcome, applied_at AS appliedAt FROM agent_architecture_migrations WHERE agent_id = ?",
  ).all(agentId) as Array<{ stepId: string; outcome: string; appliedAt: string }>;
  if (rows.length === 0) return AGENT_MIGRATION_STEPS;
  const byStep = new Map(rows.map((row) => [row.stepId, row]));
  let activity: string | null | undefined;
  return AGENT_MIGRATION_STEPS.filter((step) => {
    const seen = byStep.get(step.id);
    if (!seen) return true;
    if (seen.outcome === "applied") return false;
    if (activity === undefined) activity = lastActivityAt(agentId);
    return Boolean(activity && activity > seen.appliedAt);
  });
}

function recordOutcome(agentId: string, step: AgentMigrationStep, outcome: AgentMigrationOutcome): void {
  getDb().prepare(
    `INSERT INTO agent_architecture_migrations
       (agent_id, step_id, architecture_version, outcome, changed, detail, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, step_id) DO UPDATE SET
       architecture_version = excluded.architecture_version,
       outcome = excluded.outcome,
       changed = excluded.changed,
       detail = excluded.detail,
       applied_at = excluded.applied_at`,
  ).run(
    agentId,
    step.id,
    ARCHITECTURE_VERSION,
    outcome.outcome,
    Math.max(0, Math.trunc(outcome.changed || 0)),
    outcome.detail ? String(outcome.detail).slice(0, 300) : null,
    new Date().toISOString(),
  );
}

/**
 * 등록된 모든 에이전트를 현재 아키텍처로 올린다.
 *
 * 평상시엔 거의 no-op 이다(모든 에이전트가 모든 단계를 이미 받았으면 쿼리 한 번). 업데이트로
 * 단계가 하나 추가되면, 그 부팅에서 등록된 전원이 그 단계를 받는다.
 */
export function migrateRegisteredAgents(options: { agentId?: string } = {}): AgentMigrationSweepResult {
  const result: AgentMigrationSweepResult = {
    agentsScanned: 0, stepsRun: 0, applied: 0, noop: 0, failed: 0, changed: 0, byStep: {},
  };
  const agentIds = options.agentId
    ? [options.agentId]
    : (getDb().prepare("SELECT id FROM installed_agents").all() as Array<{ id: string }>).map((row) => row.id);

  for (const agentId of agentIds) {
    const pending = pendingStepsFor(agentId);
    if (pending.length === 0) continue;
    result.agentsScanned += 1;
    for (const step of pending) {
      result.stepsRun += 1;
      let outcome: AgentMigrationOutcome;
      try {
        outcome = step.run(agentId);
      } catch (err) {
        // 실패도 기록한다. 기록하지 않으면 매 부팅 같은 실패를 반복하면서 아무도 모른다.
        outcome = { outcome: "failed", changed: 0, detail: String((err as Error)?.message ?? err).slice(0, 200) };
      }
      try {
        recordOutcome(agentId, step, outcome);
      } catch {
        // 원장 기록 실패는 이 스윕을 멈출 이유가 아니다 — 다음 부팅에 다시 시도된다.
      }
      result[outcome.outcome] += 1;
      result.changed += outcome.changed;
      if (outcome.changed > 0) {
        result.byStep[step.id] = (result.byStep[step.id] ?? 0) + outcome.changed;
      }
    }
  }
  return result;
}

/** 진단용 — 이 에이전트가 어떤 단계를 언제 받았는가. */
export function agentMigrationLedger(agentId: string): Array<{
  stepId: string;
  outcome: string;
  changed: number;
  detail: string | null;
  appliedAt: string;
  architectureVersion: string;
}> {
  return getDb().prepare(
    `SELECT step_id AS stepId, outcome, changed, detail, applied_at AS appliedAt,
            architecture_version AS architectureVersion
       FROM agent_architecture_migrations
      WHERE agent_id = ?
      ORDER BY applied_at ASC`,
  ).all(agentId) as never;
}
