/**
 * Agent Strategy 의 저장소 — 목표(goal_id) 아래에만 있는 KPI 정의·표본 시계열·상태 한 행.
 * 설계: output/agent-strategy-20261010/DESIGN.md §4.2. 공유 스토어 DDL 이라 lazy 가 아니라 스키마 사다리 v131 에서 만든다
 * (데몬은 lazy DDL 을 돌리지 않는다 — agent-context.ts 와 같은 이유). 기억(Memory Sphere) 쓰기 API 는 부르지 않는다.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { createAgentStrategySchema } from "./agent-strategy-schema";
import type { KpiSample, KpiState, KpiStateRow } from "../../shared/agent-strategy";

type Db = Database.Database;

export { createAgentStrategySchema };

export interface GoalKpi {
  goalId: string;
  kpiId: string;
  revision: number;
  name: string;
  unit: string;
  direction: "up" | "down";
  krId: string | null;
  target: number | null;
  deadlineAt: string | null;
  baseline: number | null;
  sourceKind: "agent_observed" | "collector";
  sourceRef: string | null;
  cadenceHours: number;
  minSamples: number;
  createdAt: string;
}

interface KpiRow { goal_id: string; kpi_id: string; revision: number; name: string; unit: string; direction: "up" | "down"; kr_id: string | null;
  target: number | null; deadline_at: string | null; baseline: number | null; source_kind: "agent_observed" | "collector"; source_ref: string | null;
  cadence_hours: number; min_samples: number; created_at: string }
const kpiOf = (row: KpiRow): GoalKpi => ({ goalId: row.goal_id, kpiId: row.kpi_id, revision: row.revision, name: row.name, unit: row.unit,
  direction: row.direction, krId: row.kr_id, target: row.target, deadlineAt: row.deadline_at, baseline: row.baseline, sourceKind: row.source_kind,
  sourceRef: row.source_ref, cadenceHours: row.cadence_hours, minSamples: row.min_samples, createdAt: row.created_at });

/** 정의를 만들거나(KR 동기화) 갱신한다. 이미 있는 추적 KPI 의 이름·단위는 덮지 않는다. */
export function upsertGoalKpi(input: Omit<GoalKpi, "createdAt" | "cadenceHours" | "minSamples"> & { cadenceHours?: number; minSamples?: number; createdAt?: string }, db: Db = getDb()): void {
  db.prepare(`INSERT INTO goal_kpis (goal_id,kpi_id,revision,name,unit,direction,kr_id,target,deadline_at,baseline,source_kind,source_ref,cadence_hours,min_samples,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(goal_id,kpi_id) DO UPDATE SET revision=excluded.revision, kr_id=excluded.kr_id, target=excluded.target,
      deadline_at=excluded.deadline_at, baseline=COALESCE(excluded.baseline, goal_kpis.baseline)`)
    .run(input.goalId, input.kpiId, input.revision, input.name, input.unit, input.direction, input.krId, input.target, input.deadlineAt, input.baseline,
      input.sourceKind, input.sourceRef, input.cadenceHours ?? 24, input.minSamples ?? 3, input.createdAt ?? new Date().toISOString());
}

export function listGoalKpis(goalId: string, db: Db = getDb()): GoalKpi[] {
  return (db.prepare("SELECT * FROM goal_kpis WHERE goal_id = ? ORDER BY created_at, kpi_id").all(goalId) as KpiRow[]).map(kpiOf);
}

export function getGoalKpi(goalId: string, kpiId: string, db: Db = getDb()): GoalKpi | null {
  const row = db.prepare("SELECT * FROM goal_kpis WHERE goal_id = ? AND kpi_id = ?").get(goalId, kpiId) as KpiRow | undefined;
  return row ? kpiOf(row) : null;
}

/** 추가형 — 수정·삭제 없음. 같은 observed_at 은 거절(false). */
export function insertKpiSample(input: { goalId: string; kpiId: string; value: number; observedAt: string; evidence: string; runId: string | null;
  trust?: "agent_observed" | "collector"; recordedAt?: string }, db: Db = getDb()): { inserted: boolean; id: string } {
  const id = randomUUID();
  const result = db.prepare(`INSERT OR IGNORE INTO goal_kpi_samples (id,goal_id,kpi_id,value,observed_at,recorded_at,trust,evidence,run_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, input.goalId, input.kpiId, input.value, input.observedAt, input.recordedAt ?? new Date().toISOString(),
    input.trust ?? "agent_observed", input.evidence, input.runId);
  return { inserted: result.changes > 0, id };
}

/** 시간순(오래된 것부터) 표본. 최근 limit 개. */
export function listKpiSamples(goalId: string, kpiId: string, limit = 200, db: Db = getDb()): KpiSample[] {
  const rows = db.prepare(`SELECT id,value,observed_at,run_id,evidence FROM goal_kpi_samples WHERE goal_id = ? AND kpi_id = ?
    ORDER BY observed_at DESC LIMIT ?`).all(goalId, kpiId, Math.max(1, Math.min(1000, limit))) as Array<{ id: string; value: number; observed_at: string; run_id: string | null; evidence: string }>;
  return rows.reverse().map((row) => ({ id: row.id, value: row.value, observedAt: row.observed_at, runId: row.run_id, evidence: row.evidence }));
}

export function countGoalKpiSamples(goalId: string, db: Db = getDb()): number {
  return (db.prepare("SELECT COUNT(*) n FROM goal_kpi_samples WHERE goal_id = ?").get(goalId) as { n: number }).n;
}

interface StateRow { state: KpiState; since: string; pending_state: KpiState | null; pending_count: number; last_sample_id: string | null;
  last_fired_at: string | null; last_fired_state: string | null; trigger_id: string | null; trigger_created_at: string | null }

export function readKpiState(goalId: string, kpiId: string, db: Db = getDb()): KpiStateRow | null {
  const row = db.prepare("SELECT * FROM goal_kpi_state WHERE goal_id = ? AND kpi_id = ?").get(goalId, kpiId) as StateRow | undefined;
  return row ? { state: row.state, since: row.since, pendingState: row.pending_state, pendingCount: row.pending_count, lastSampleId: row.last_sample_id,
    lastFiredAt: row.last_fired_at, lastFiredState: row.last_fired_state, triggerId: row.trigger_id, triggerCreatedAt: row.trigger_created_at } : null;
}

export function writeKpiState(goalId: string, kpiId: string, row: KpiStateRow, db: Db = getDb()): void {
  db.prepare(`INSERT INTO goal_kpi_state (goal_id,kpi_id,state,since,pending_state,pending_count,last_sample_id,last_fired_at,last_fired_state,trigger_id,trigger_created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(goal_id,kpi_id) DO UPDATE SET state=excluded.state, since=excluded.since, pending_state=excluded.pending_state,
      pending_count=excluded.pending_count, last_sample_id=excluded.last_sample_id, last_fired_at=excluded.last_fired_at,
      last_fired_state=excluded.last_fired_state, trigger_id=excluded.trigger_id, trigger_created_at=excluded.trigger_created_at`)
    .run(goalId, kpiId, row.state, row.since, row.pendingState, row.pendingCount, row.lastSampleId, row.lastFiredAt, row.lastFiredState, row.triggerId, row.triggerCreatedAt);
}

export function listKpiStates(goalId: string, db: Db = getDb()): Array<{ kpiId: string } & KpiStateRow> {
  const rows = db.prepare("SELECT * FROM goal_kpi_state WHERE goal_id = ?").all(goalId) as Array<StateRow & { kpi_id: string }>;
  return rows.map((row) => ({ kpiId: row.kpi_id, state: row.state, since: row.since, pendingState: row.pending_state, pendingCount: row.pending_count,
    lastSampleId: row.last_sample_id, lastFiredAt: row.last_fired_at, lastFiredState: row.last_fired_state, triggerId: row.trigger_id, triggerCreatedAt: row.trigger_created_at }));
}

/** 목표 개정으로 KR 이 사라진 KPI 는 추적 전용으로 내린다(낡은 목표값으로 pace 를 계산하지 않는다). */
export function detachStaleKrKpis(goalId: string, liveKrIds: readonly string[], db: Db = getDb()): void {
  const marks = liveKrIds.map(() => "?").join(",");
  db.prepare(`UPDATE goal_kpis SET kr_id = NULL, target = NULL, deadline_at = NULL WHERE goal_id = ? AND kr_id IS NOT NULL${liveKrIds.length ? ` AND kr_id NOT IN (${marks})` : ""}`)
    .run(goalId, ...liveKrIds);
}
