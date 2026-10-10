/**
 * Agent Strategy v1 호스트 결선 (설계: output/agent-strategy-20261010/DESIGN.md §4.5–4.7, §5).
 *
 * 매 목표 패스마다: KPI 표본(에이전트가 표식으로 보고, 호스트가 검증·저장) → 상태 평가(shared/agent-strategy.ts)
 * → 상태 전이 때 트리거 발화 → 다음 One 패스 문맥에 "KPI 상태 + 필요한 재계획" 블록 주입.
 * 모델 호출을 추가하지 않는다 — 재계획은 다음 정상 패스에서 `<<agentlas-strategy-shift>>` 표식 한 줄로 낸다.
 * 호스트가 검증한 변경만 한 트랜잭션으로 적용한다(열린 전술 retire → 새 전략·전술 add, 전술 상한 12 안에서).
 *
 * 기억(Memory Sphere) 쓰기는 하지 않는다: 이 모듈은 목표 원장 곁 테이블(goal_kpi*, goal_plan_*)만 읽고 쓴다.
 * AGENTLAS_AGENT_STRATEGY=on|shadow|off — 기본 on. shadow 는 표본 저장·평가·영수증만(주입·적용 없음).
 */
import { createHash } from "node:crypto";
import {
  AGENT_STRATEGY_LIMITS,
  computeKpiMetrics,
  checkKpiSample,
  emptyKpiStateRow,
  resolveAgentStrategyMode,
  stepKpiState,
  trustedKpiSamples,
  triggerExpired,
  validateStrategyShift,
  withFiredTrigger,
  type AgentStrategyMode,
  type KpiMarker,
  type KpiMetrics,
  type KpiState,
  type KpiStateRow,
  type StrategyShiftContext,
  type StrategyShiftMarker,
} from "../../shared/agent-strategy";
import type { LiveGoalPlan } from "../../shared/goal-shape";
import type { MetricSample } from "../../shared/mission-pace";
import {
  goalPlanTacticPayload,
  insertGoalPlanNode,
  listGoalPlanDecisions,
  recordGoalPlanDecision,
  updateGoalPlanNode,
  readGoalPlan,
} from "../store/goal-plans";
import {
  countGoalKpiSamples,
  detachStaleKrKpis,
  getGoalKpi,
  insertKpiSample,
  listGoalKpis,
  listKpiSamples,
  listKpiStates,
  readKpiState,
  upsertGoalKpi,
  writeKpiState,
  type GoalKpi,
} from "../store/agent-strategy";
import { getDb } from "../store/db";
import { getLongRunByGoalId, longRunOwnerHold } from "../store/long-runs";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function agentStrategyMode(): AgentStrategyMode {
  return resolveAgentStrategyMode(process.env.AGENTLAS_AGENT_STRATEGY);
}

// ── KPI 동기화·표본 읽기 ─────────────────────────────────────────────────────

/** KR 마다 KPI 정의를 만든다(오너 숫자가 있는 KR 만 목표값을 가진다, R3). 사라진 KR 의 KPI 는 추적 전용으로 내린다. */
export function syncGoalKpis(plan: LiveGoalPlan): GoalKpi[] {
  const krs = plan.mission?.key_results ?? [];
  for (const kr of krs) {
    upsertGoalKpi({ goalId: plan.goalId, kpiId: kr.id, revision: plan.revision, name: kr.metric, unit: kr.unit,
      direction: kr.baseline !== null && kr.baseline > kr.target ? "down" : "up", krId: kr.id, target: kr.target,
      deadlineAt: kr.deadline_at, baseline: kr.baseline, sourceKind: "agent_observed", sourceRef: null });
  }
  detachStaleKrKpis(plan.goalId, krs.map((kr) => kr.id));
  return listGoalKpis(plan.goalId);
}

/** missionPace 에 넣는 호스트 표본(신뢰된 것만). 모드 off 면 빈 배열. */
export function krMetricSamples(goalId: string, krId: string): MetricSample[] {
  if (agentStrategyMode() === "off") return [];
  try {
    const kpi = getGoalKpi(goalId, krId);
    const samples = kpi ? listKpiSamples(goalId, krId, 200) : [];
    return trustedKpiSamples(samples).map((s) => ({ value: s.value, observedAt: s.observedAt }));
  } catch { return []; }
}

/** 화면용: KR 별 현재값과 상태. 값이 없으면 null. */
export function krStrategyView(goalId: string): Map<string, { current: number | null; state: KpiState | null }> {
  const out = new Map<string, { current: number | null; state: KpiState | null }>();
  if (agentStrategyMode() === "off") return out;
  try {
    const states = new Map(listKpiStates(goalId).map((row) => [row.kpiId, row.state]));
    for (const kpi of listGoalKpis(goalId)) {
      if (!kpi.krId) continue;
      const last = trustedKpiSamples(listKpiSamples(goalId, kpi.kpiId, 5)).at(-1);
      out.set(kpi.krId, { current: last ? last.value : null, state: states.get(kpi.kpiId) ?? null });
    }
  } catch { /* 화면 읽기 실패는 KR 줄만 비운다 */ }
  return out;
}

// ── 평가·트리거 ──────────────────────────────────────────────────────────────

function ownerHeld(goalId: string): boolean {
  const run = getLongRunByGoalId(goalId);
  if (!run) return false;
  return run.status === "pausing" || (run.status === "paused" && (run.pauseReason === "user" || run.pauseReason === "budget")) || longRunOwnerHold(run.id);
}

function windowHoursOf(plan: LiveGoalPlan): number {
  const windows = plan.strategies.filter((s) => s.status === "active").map((s) => s.observation_window_hours).filter((h) => Number.isFinite(h) && h > 0);
  return windows.length ? Math.min(...windows) : AGENT_STRATEGY_LIMITS.defaultWindowHours;
}

function budgetCounts(goalId: string, nowMs: number): { firedLast24h: number; appliedShiftsLast7d: number } {
  const fired = listGoalPlanDecisions(goalId, { kind: "kpi_state", limit: 100 })
    .filter((row) => row.payload.fired === true && nowMs - Date.parse(row.createdAt) < DAY_MS).length;
  const applied = listGoalPlanDecisions(goalId, { kind: "strategy_shift", limit: 100 })
    .filter((row) => row.payload.result === "applied" && row.payload.decision === "pivot" && nowMs - Date.parse(row.createdAt) < 7 * DAY_MS).length;
  return { firedLast24h: fired, appliedShiftsLast7d: applied };
}

function metricsOf(kpi: GoalKpi, plan: LiveGoalPlan, nowMs: number, prevState: KpiState | null): { metrics: KpiMetrics; samples: ReturnType<typeof listKpiSamples> } {
  const samples = listKpiSamples(plan.goalId, kpi.kpiId, 200);
  const metrics = computeKpiMetrics(samples, { target: kpi.target, baseline: kpi.baseline, deadlineAt: kpi.deadlineAt, direction: kpi.direction,
    minSamples: kpi.minSamples, cadenceHours: kpi.cadenceHours }, { nowMs, windowHours: windowHoursOf(plan), prevState });
  return { metrics, samples };
}

const jsonNumber = (value: number | null): number | null => value === null || !Number.isFinite(value) ? null : value;

function metricsReceipt(metrics: KpiMetrics): Record<string, unknown> {
  return { current: metrics.current, vLong: metrics.vLong, vShort: metrics.vShort, vPrev: metrics.vPrev, requiredPerDay: metrics.requiredPerDay,
    daysLeft: metrics.daysLeft, rho: metrics.rho, requiredOverObserved: jsonNumber(metrics.requiredOverObserved),
    unreachable: metrics.requiredOverObserved === Infinity, infeasible: metrics.infeasible, samples: metrics.samples };
}

export interface KpiEvaluation { kpiId: string; state: KpiState; transitioned: boolean; fired: "strategy_shift" | "target_infeasible" | null; blockedBy: string | null }

/**
 * 목표의 모든 KPI 를 평가해 상태·트리거를 갱신한다. 같은 표본 집합으로 여러 번 불러도 같은 결과(멱등).
 * shadow 모드는 상태·영수증은 남기되 트리거(주입 대상)는 만들지 않는다.
 */
export function evaluateGoalKpis(plan: LiveGoalPlan, nowMs: number = Date.now()): KpiEvaluation[] {
  const mode = agentStrategyMode();
  if (mode === "off") return [];
  const nowIso = new Date(nowMs).toISOString();
  const out: KpiEvaluation[] = [];
  const kpis = syncGoalKpis(plan);
  const held = ownerHeld(plan.goalId);
  const activeStrategies = plan.strategies.filter((s) => s.status === "active" && !s.ownerPaused)
    .map((s) => ({ activatedAt: s.activatedAt, observationWindowHours: s.observation_window_hours }));
  for (const kpi of kpis) {
    let prev = readKpiState(plan.goalId, kpi.kpiId) ?? emptyKpiStateRow(nowIso);
    if (triggerExpired(prev, nowMs)) {
      // 응답 못 받은 트리거는 hold 로 종결한다(영수증에 남긴다) — 다음 발화는 쿨다운이 정한다.
      recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "strategy_shift", createdAt: nowIso,
        payload: { triggerId: prev.triggerId, kpi: kpi.kpiId, decision: "hold", result: "closed_expired" } });
      prev = { ...prev, triggerId: null, triggerCreatedAt: null };
    }
    const { metrics } = metricsOf(kpi, plan, nowMs, prev.state === "no_data" ? null : prev.state);
    const counts = budgetCounts(plan.goalId, nowMs);
    const step = stepKpiState(prev, metrics, { nowMs, windowHours: windowHoursOf(plan), ownerPaused: held, activeStrategies, ...counts });
    let next: KpiStateRow = step.next;
    let fired: KpiEvaluation["fired"] = null;
    if (step.fire) {
      const triggerId = `kt_${createHash("sha1").update(`${plan.goalId}|${kpi.kpiId}|${next.state}|${nowIso}`).digest("hex").slice(0, 12)}`;
      if (mode === "on") { next = withFiredTrigger(next, step.fire.kind, triggerId, nowIso); fired = step.fire.kind; }
      else next = { ...next, lastFiredAt: nowIso, lastFiredState: step.fire.kind === "target_infeasible" ? "target_infeasible" : next.state };
      recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "kpi_state", createdAt: nowIso,
        payload: { kpi: kpi.kpiId, from: step.from, to: next.state, fired: mode === "on", shadowWouldFire: mode === "shadow" ? step.fire.kind : null,
          kind: step.fire.kind, triggerId: mode === "on" ? triggerId : null, metrics: metricsReceipt(metrics),
          expected: plan.strategies.filter((s) => s.status === "active").map((s) => ({ id: s.id, expectedDelta: (s as { expected_delta?: string }).expected_delta ?? null })) } });
    } else if (step.transitioned) {
      recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "kpi_state", createdAt: nowIso,
        payload: { kpi: kpi.kpiId, from: step.from, to: next.state, fired: false, blockedBy: step.blockedBy, metrics: metricsReceipt(metrics) } });
    }
    if (JSON.stringify(next) !== JSON.stringify(readKpiState(plan.goalId, kpi.kpiId))) writeKpiState(plan.goalId, kpi.kpiId, next);
    out.push({ kpiId: kpi.kpiId, state: next.state, transitioned: step.transitioned, fired, blockedBy: step.blockedBy });
  }
  return out;
}

// ── 표본 표식 적용 ───────────────────────────────────────────────────────────

export interface KpiMarkerOutcome { kpi: string; result: string }

/** 에이전트가 보고한 KPI 표본을 검증해 저장하고, 곧바로 상태를 갱신한다. 실패는 삼킨다(답을 막지 않는다). */
export function applyKpiMarkers(input: { goalId: string; markers: readonly KpiMarker[]; runId: string | null; nowMs?: number }): KpiMarkerOutcome[] {
  const mode = agentStrategyMode();
  if (mode === "off" || !input.markers.length) return [];
  const nowMs = input.nowMs ?? Date.now();
  const outcomes: KpiMarkerOutcome[] = [];
  try {
    const plan = readGoalPlan(input.goalId);
    if (!plan) return input.markers.map((m) => ({ kpi: m.kpi, result: "rejected:no_plan" }));
    syncGoalKpis(plan);
    for (const marker of input.markers) {
      let kpi = getGoalKpi(input.goalId, marker.kpi);
      if (!kpi) {
        if (!marker.define) { outcomes.push({ kpi: marker.kpi, result: "rejected:kpi_unknown" }); continue; }
        if (listGoalKpis(input.goalId).length >= AGENT_STRATEGY_LIMITS.maxTrackedKpis * 2) { outcomes.push({ kpi: marker.kpi, result: "rejected:kpi_cap" }); continue; }
        // 오너 숫자 없는 목표용: 목표값 없는 추적 KPI(R3 유지 — 목표값은 오너 숫자가 있을 때만).
        upsertGoalKpi({ goalId: input.goalId, kpiId: marker.kpi, revision: plan.revision, name: marker.define.name, unit: marker.define.unit,
          direction: marker.define.direction, krId: null, target: null, deadlineAt: null, baseline: null, sourceKind: "agent_observed", sourceRef: marker.source || null });
        kpi = getGoalKpi(input.goalId, marker.kpi);
        if (!kpi) { outcomes.push({ kpi: marker.kpi, result: "rejected:kpi_unknown" }); continue; }
      }
      const recent = listKpiSamples(input.goalId, kpi.kpiId, 60);
      const check = checkKpiSample(marker, { nowMs, target: kpi.target, baseline: kpi.baseline, recent });
      if (!check.ok) { outcomes.push({ kpi: marker.kpi, result: `rejected:${check.reason}` }); continue; }
      const stored = insertKpiSample({ goalId: input.goalId, kpiId: kpi.kpiId, value: check.value, observedAt: check.observedAt, evidence: check.evidence,
        runId: input.runId, recordedAt: new Date(nowMs).toISOString() });
      outcomes.push({ kpi: marker.kpi, result: stored.inserted ? (check.suspect ? "recorded_suspect" : "recorded") : "rejected:duplicate_observation" });
    }
    evaluateGoalKpis(plan, nowMs);
  } catch (error) {
    console.warn("[agent-strategy] kpi marker application failed:", error instanceof Error ? error.message : error);
  }
  return outcomes;
}

// ── 대기 트리거·검증 문맥 ────────────────────────────────────────────────────

export interface PendingStrategyTrigger { id: string; kpiId: string; kind: "strategy_shift" | "target_infeasible"; state: KpiState; createdAt: string }

export function pendingStrategyTrigger(goalId: string): PendingStrategyTrigger | null {
  try {
    const rows = listKpiStates(goalId).filter((row) => row.triggerId)
      .sort((a, b) => Date.parse(a.triggerCreatedAt ?? "") - Date.parse(b.triggerCreatedAt ?? ""));
    const row = rows[0];
    return row ? { id: row.triggerId!, kpiId: row.kpiId, kind: row.lastFiredState === "target_infeasible" ? "target_infeasible" : "strategy_shift",
      state: row.state, createdAt: row.triggerCreatedAt ?? "" } : null;
  } catch { return null; }
}

function strategyShiftContext(plan: LiveGoalPlan, nowMs: number): StrategyShiftContext {
  const trigger = pendingStrategyTrigger(plan.goalId);
  const open = plan.tactics.filter((t) => t.status === "active" || t.status === "proposed");
  const sampleIds = new Set<string>();
  if (trigger) for (const s of listKpiSamples(plan.goalId, trigger.kpiId, 60)) sampleIds.add(s.id);
  return { nowMs, trigger: trigger ? { id: trigger.id, kind: trigger.kind, kpiId: trigger.kpiId } : null, sampleIds,
    strategies: plan.strategies.map((s) => ({ id: s.id, status: s.status, activatedAt: s.activatedAt, observationWindowHours: s.observation_window_hours,
      openTactics: open.filter((t) => t.strategy_id === s.id).length })),
    krIds: new Set((plan.mission?.key_results ?? []).map((kr) => kr.id)), openTactics: open.length,
    appliedShiftsLast7d: budgetCounts(plan.goalId, nowMs).appliedShiftsLast7d };
}

// ── 전략 변경 적용 (원자) ────────────────────────────────────────────────────

function takeId(prefix: "t" | "s", plan: LiveGoalPlan, taken: Set<string>): string {
  let n = (prefix === "t" ? plan.tactics.length : plan.strategies.length) + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  taken.add(id);
  return id;
}

export interface StrategyShiftHooks { afterRetire?: () => void }

/**
 * 검증된 전략 변경을 계획에 적용한다. 호출자가 withCurrentGoalPlan 안에서 부른다(plan = 그 시점의 정확한 투영).
 * 구조 변경은 savepoint 한 덩어리 — 중간에 던지면 retire·add 가 모두 되돌려진다.
 * 반환: applied:<ids> | recorded:<decision> | rejected:<reason> | ignored:<mode>
 */
export function applyStrategyShift(plan: LiveGoalPlan, shift: StrategyShiftMarker, runId: string | null, nowMs: number, hooks: StrategyShiftHooks = {}): string {
  const mode = agentStrategyMode();
  if (mode !== "on") return `ignored:${mode}`;
  const at = new Date(nowMs).toISOString();
  const ctx = strategyShiftContext(plan, nowMs);
  const kpiId = ctx.trigger?.kpiId ?? null;
  const record = (payload: Record<string, unknown>) => recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq,
    kind: "strategy_shift", createdAt: at, payload: { triggerId: shift.trigger_id, kpi: kpiId, decision: shift.decision, runId, ...payload } });
  const clearTrigger = () => {
    if (!kpiId) return;
    const row = readKpiState(plan.goalId, kpiId);
    if (row) writeKpiState(plan.goalId, kpiId, { ...row, triggerId: null, triggerCreatedAt: null });
  };
  const checked = validateStrategyShift(shift, ctx);
  if (!checked.ok) {
    record({ result: `rejected:${checked.reason}` });
    // 같은 트리거 재제출은 2회까지 — 넘으면 hold 로 종결한다.
    const rejected = listGoalPlanDecisions(plan.goalId, { kind: "strategy_shift", limit: 100 })
      .filter((row) => row.payload.triggerId === shift.trigger_id && typeof row.payload.result === "string" && String(row.payload.result).startsWith("rejected:")).length;
    if (ctx.trigger && ctx.trigger.id === shift.trigger_id && rejected > AGENT_STRATEGY_LIMITS.maxResubmits) {
      record({ decision: "hold", result: "closed_after_rejections" });
      clearTrigger();
    }
    return `rejected:${checked.reason}`;
  }
  const metrics = (() => {
    try {
      const kpi = kpiId ? getGoalKpi(plan.goalId, kpiId) : null;
      return kpi ? metricsOf(kpi, plan, nowMs, readKpiState(plan.goalId, kpiId!)?.state ?? null).metrics : null;
    } catch { return null; }
  })();
  const evidence = { sampleIds: shift.evidence_refs, ...(metrics ? metricsReceipt(metrics) : {}) };
  if (shift.decision !== "pivot") {
    record({ result: "recorded", evidence, reason: shift.reason_ko, diagnosis: shift.diagnosis });
    clearTrigger();
    return `recorded:${shift.decision}`;
  }
  const db = getDb();
  const taken = new Set([...plan.tactics.map((t) => t.id), ...plan.strategies.map((s) => s.id)]);
  const maxOrd = Math.max(0, ...plan.tactics.map((t) => t.ord)) + 1;
  const maxStrategyOrd = Math.max(-1, ...plan.strategies.map((s) => s.priority)) + 1;
  const priorApplied = listGoalPlanDecisions(plan.goalId, { kind: "strategy_shift", limit: 200 }).filter((row) => row.payload.result === "applied").length;
  try {
    const result = db.transaction(() => {
      const retiredIds: string[] = [];
      for (const item of shift.retire) {
        updateGoalPlanNode(plan, item.id, { status: "retired", payload: { retiredAt: at, retireEvidence: item.evidence, retiredBy: "strategy_shift", retiredByTrigger: shift.trigger_id } });
        for (const tactic of plan.tactics.filter((t) => t.strategy_id === item.id && (t.status === "active" || t.status === "proposed"))) {
          updateGoalPlanNode(plan, tactic.id, { status: "retired", payload: { retiredBy: "strategy_shift" } });
        }
        retiredIds.push(item.id);
      }
      hooks.afterRetire?.();
      const addedIds: string[] = [];
      const order = checked.iceScores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score || a.index - b.index);
      let tacticSeq = 0;
      order.forEach(({ score, index }, rank) => {
        const add = shift.add[index]!;
        const id = takeId("s", plan, taken);
        const krIds = ctx.krIds;
        insertGoalPlanNode(plan, { nodeId: id, kind: "strategy", parentId: plan.mission ? "mission" : null, status: "active", ord: maxStrategyOrd + rank,
          payload: { id, hypothesis: add.hypothesis, serves_krs: add.serves_krs.filter((ref) => krIds.has(ref)), kpi: add.kpi, actions_per_day: null,
            timebox_hours: add.timebox_hours, observation_window_hours: add.observation_window_hours, priority: maxStrategyOrd + rank, activatedAt: at,
            expected_delta: add.expected_delta, kill_if: add.kill_if, ice: add.ice, ice_score: score, born_from_trigger: shift.trigger_id } });
        for (const draft of add.tactics) {
          const tid = takeId("t", plan, taken);
          insertGoalPlanNode(plan, { nodeId: tid, kind: "tactic", parentId: id, status: "active", ord: maxOrd + tacticSeq,
            payload: goalPlanTacticPayload({ id: tid, strategy_id: id, description: draft.description, done_when: draft.done_when, kind: draft.kind }) });
          tacticSeq += 1;
        }
        addedIds.push(id);
      });
      return { retiredIds, addedIds };
    })();
    record({ result: "applied", evidence, retired: result.retiredIds, added: result.addedIds, reason: shift.reason_ko, diagnosis: shift.diagnosis,
      strategyRevision: priorApplied + 1 });
    clearTrigger();
    return `applied:${[...result.retiredIds.map((id) => `-${id}`), ...result.addedIds].join(",")}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 60) : "apply_failed";
    record({ result: `rejected:apply_failed`, error: reason });
    return "rejected:apply_failed";
  }
}

// ── 턴 문맥 블록 ─────────────────────────────────────────────────────────────

const fmt = (value: number | null, digits = 2): string => value === null || !Number.isFinite(value) ? "n/a" : String(Math.round(value * 10 ** digits) / 10 ** digits);

/** KR 마다 "먼저 현재 값을 재라" 지시와 표식 안내(트리일 때 항상, 한두 줄). 모드 on/shadow 에서만. */
export function kpiMeasurementLines(plan: LiveGoalPlan, nowMs: number): string[] {
  if (agentStrategyMode() === "off" || plan.shape !== "mission_tree") return [];
  const lines: string[] = [];
  try {
    const kpis = listGoalKpis(plan.goalId);
    const missing: string[] = [];
    const stale: string[] = [];
    for (const kr of plan.mission?.key_results ?? []) {
      const kpi = kpis.find((k) => k.kpiId === kr.id);
      const last = kpi ? trustedKpiSamples(listKpiSamples(plan.goalId, kr.id, 5)).at(-1) : undefined;
      if (!last) missing.push(kr.id);
      else if (nowMs - Date.parse(last.observedAt) > 2 * (kpi?.cadenceHours ?? 24) * HOUR_MS) stale.push(kr.id);
    }
    if (missing.length) lines.push(`KPI measurement needed (infrastructure state, not a strategy failure): read the current value of ${missing.join(", ")} from the real source now and report it with a kpi marker.`);
    if (stale.length) lines.push(`KPI measurement is stale for ${stale.join(", ")}: measure again this pass if you can read the real value.`);
    lines.push('KPI sample marker (one line, evidence required; the host stores it): <<agentlas-kpi>>{"kpi":"<kr id>","value":30,"observed_at":"<ISO time you read it>","source":"<where>","evidence":"what the screen/tool showed"}. To track a metric the owner gave no number for: add "name":"...","unit":"...","direction":"up" with a new lowercase kpi id (no target is invented).');
  } catch { /* 문맥 보조 줄은 실패해도 본 문맥을 막지 않는다 */ }
  return lines;
}

/** 대기 중인 트리거가 있으면 "KPI 상태 + 필요한 재계획" 블록(약 600토큰)을, 없으면 null. on 모드만. */
export function buildKpiShiftContext(plan: LiveGoalPlan, nowMs: number, locale: "ko" | "en" = "en"): string | null {
  if (agentStrategyMode() !== "on" || plan.shape !== "mission_tree") return null;
  const trigger = pendingStrategyTrigger(plan.goalId);
  if (!trigger) return null;
  try {
    const kpi = getGoalKpi(plan.goalId, trigger.kpiId);
    if (!kpi) return null;
    const row = readKpiState(plan.goalId, trigger.kpiId);
    const { metrics, samples } = metricsOf(kpi, plan, nowMs, row?.state ?? null);
    const recent = trustedKpiSamples(samples).slice(-6);
    const lines: string[] = [];
    lines.push(`## KPI state — re-plan required (agentlas.strategy-shift.v1 · trigger ${trigger.id})`);
    lines.push(`Trigger: KPI "${kpi.name}" is now ${trigger.state}${trigger.kind === "target_infeasible" ? " and the target is out of reach at the observed pace" : ""}. Decide in THIS pass; it costs no extra call.`);
    lines.push(`- ${kpi.name}: current ${fmt(metrics.current)}${kpi.unit ? ` ${kpi.unit}` : ""}`
      + (kpi.target !== null ? ` / target ${fmt(kpi.target)}` : " (tracked, no owner target)")
      + (metrics.daysLeft !== null ? ` · ${fmt(metrics.daysLeft, 1)} days left` : "")
      + ` · required ${fmt(metrics.requiredPerDay)}/day · observed ${fmt(metrics.vLong)}/day (long window), ${fmt(metrics.vShort)}/day (short)`
      + (metrics.requiredOverObserved === Infinity ? " · required/observed: unreachable" : metrics.requiredOverObserved !== null ? ` · required/observed ×${fmt(metrics.requiredOverObserved, 1)}` : ""));
    lines.push(`Recent samples (cite these ids in evidence_refs): ${recent.map((s) => `${s.id} · ${s.observedAt.slice(0, 16)} · ${s.value}`).join(" | ")}`);
    const active = plan.strategies.filter((s) => s.status === "active").map((s) => {
      const ageH = Math.max(0, Math.round((nowMs - Date.parse(s.activatedAt)) / HOUR_MS));
      const extra = s as { expected_delta?: string; kill_if?: string };
      return `${s.id} (${ageH}h of ${s.observation_window_hours}h window): ${s.hypothesis}${extra.expected_delta ? ` · expects ${extra.expected_delta}` : ""}${extra.kill_if ? ` · kill if ${extra.kill_if}` : ""}`;
    });
    if (active.length) lines.push(`Active strategies: ${active.join(" | ")}`);
    const past = listGoalPlanDecisions(plan.goalId, { kind: "strategy_shift", limit: 30 }).filter((r) => r.payload.result === "applied").slice(0, 3)
      .map((r) => `${r.createdAt.slice(0, 10)} ${String(r.payload.reason ?? "").slice(0, 80)}`);
    if (past.length) lines.push(`Earlier strategy shifts: ${past.join(" | ")}`);
    if (trigger.kind === "target_infeasible") {
      lines.push("Do NOT replace strategies for this trigger. Tell the owner once, in your reply, three numbers — current value, required per day, observed per day — and ask whether to adjust the goal. Then emit decision escalate_owner:");
      lines.push('<<agentlas-strategy-shift>>{"schema":"agentlas.strategy-shift.v1","trigger_id":"' + trigger.id + '","diagnosis":"<=300 chars, cite sample ids","decision":"escalate_owner","evidence_refs":["<sample id>"],"retire":[],"add":[],"reason_ko":"one sentence for the owner"}');
    } else {
      lines.push("Emit exactly one marker line (the host validates it; a rejected one is returned with a reason, max 2 resubmits):");
      lines.push('<<agentlas-strategy-shift>>{"schema":"agentlas.strategy-shift.v1","trigger_id":"' + trigger.id + '","diagnosis":"<=300 chars, cite sample ids","decision":"hold|pivot|double_down|escalate_owner","evidence_refs":["<sample id>"],"retire":[{"id":"s1","evidence":"..."}],"add":[{"hypothesis":"...","serves_krs":["<kr id>"],"kpi":"...","expected_delta":"+3/day within 72h","kill_if":"no slope gain after 2 windows","ice":{"impact":6,"confidence":4,"ease":7},"timebox_hours":72,"observation_window_hours":72,"tactics":[{"description":"...","done_when":"..."}]}],"reason_ko":"one sentence for the owner"}');
      lines.push("Rules: only pivot changes the plan (retire + add ≤ 2 in total; retire only strategies past their observation window; every new strategy cites a key result and states expected_delta and kill_if; its tactics replace the retired ones inside the 12-tactic cap). hold needs a diagnosis; non-hold decisions need evidence_refs. Keep strategies that still work; retire the oldest or weakest-evidence one first.");
    }
    lines.push(`reason_ko is shown to the owner: write it in ${locale === "ko" ? "Korean" : "English"}.`);
    return lines.join("\n");
  } catch (error) {
    console.warn("[agent-strategy] context block failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** 실측/계약용: 한 목표의 표본 수. */
export function goalKpiSampleCount(goalId: string): number {
  try { return countGoalKpiSamples(goalId); } catch { return 0; }
}
