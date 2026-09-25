/**
 * 골 구조 판단 → 계획 → 실행 연결(One·Work 공통, ownsHostGoalLoop).
 * docs/2026-09-24-PLAN-persistent-autonomy-foundation.md "골 구조 판단" S-4.
 *
 * 1) 목표가 만들어지거나 목적이 개정되면(= 그 개정에 모양 판단이 없으면) **그 턴을 시작하기 전에** 가장 강한 계획 모델이
 *    도구 없이 한 번 모양을 정한다(판정 풀, 풀 안 폴백). 호스트는 shared/goal-shape.ts 로 결정적으로 검증한다.
 *    판단이 실패하면 목표를 막지 않는다 — 단일 전술 폴백으로 저장하고 다음 턴 시작에 다시 판단한다.
 * 2) 턴 문맥에는 활성 전술만(R9) 넣고, 표식으로 전술 완료·막힘·계획 연산을 받는다(산문 파싱 없음).
 * 3) 막힘은 지속 정책(shared/persistence-policy.ts)이 다음 수를 고른다. 단일 전술이 두 번 막히면 모양을 다시 판단한다(ADaPT 승격).
 * 4) 트리는 review_every_hours 마다 전략 리뷰 절을 넣는다. 속도는 shared/mission-pace.ts, 센서는 P-a 스텁("no_sensor" = 인프라 상태).
 */
import {
  callConnectedModelDetailed,
  configuredOrchestratorJudgmentPolicy,
  type JudgmentRuntimeAttempt,
  type JudgmentRuntimeReceipt,
} from "../system-agents/judgment";
import {
  GOAL_SHAPE_LIMITS,
  NATURE_SHAPE,
  checkPlanOp,
  extractGoalPlanMarkers,
  fallbackGoalShape,
  parseGoalShapeDraft,
  selectActiveTactics,
  validateGoalShape,
  type GoalShapePlan,
  type LiveGoalPlan,
  type LiveTactic,
  type PlanOp,
  type TacticMarker,
  type GoalPlanView,
} from "../../shared/goal-shape";
import { missionPace, type MissionPace } from "../../shared/mission-pace";
import type { RuntimeSelection } from "../../shared/types";
import { decidePersistenceMove, isPersistenceBoundaryKind, type FailureCause, type PersistenceAttempt } from "../../shared/persistence-policy";
import {
  goalPlanTacticPayload,
  insertGoalPlanNode,
  listGoalPlanDecisions,
  readGoalPlan,
  recordGoalPlanDecision,
  saveGoalPlan,
  updateGoalPlanNode,
} from "../store/goal-plans";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId } from "../store/long-runs";
import { ownsHostGoalLoop } from "./host-goal-surface";

export const GOAL_SHAPE_TIMEOUT_MS = 60_000;
/** 폴백 뒤 재판단 상한 — 넘으면 6시간에 한 번만 다시 묻는다(매 턴 60초 지연 방지). */
export const GOAL_SHAPE_FALLBACK_RETRIES = 3;
const FALLBACK_RETRY_COOLDOWN_MS = 6 * 60 * 60_000;
/** 단일 전술이 이만큼 막히면 모양을 다시 판단한다(ADaPT: 실패한 곳에서만 더 쪼갠다). */
export const SINGLE_TACTIC_PROMOTION_FAILURES = 2;

export type GoalShapeModelCall = (opts: Parameters<typeof callConnectedModelDetailed>[0]) =>
  Promise<{ text: string | null; runtimeReceipt?: JudgmentRuntimeReceipt; attempts?: JudgmentRuntimeAttempt[]; failure?: { kind?: string; message?: string } }>;

export function goalShapeSystemPrompt(): string {
  return [
    "You are the planning lead for an autonomous agent. BEFORE any work starts, decide the SHAPE of the plan for the owner's goal.",
    "The domain can be anything: software, money, marketing, a game, a reminder, research. Never assume a domain.",
    "",
    "Step 1 — classify the problem (Cynefin):",
    "- clear: what to do is obvious; one run of work finishes it and completion is directly checkable.",
    "- complicated: the steps can be worked out in advance by analysis, but it takes several ordered steps or runs.",
    "- complex: the outcome (a number or state, often with a deadline) is fixed, but which approach works can only be learned by trying; several approaches should be run as experiments and kept or dropped by results.",
    "- chaotic: something is broken or urgent right now; act first to stabilise.",
    "Step 2 — choose the SIMPLEST shape that can work (decompose only as needed; when in doubt pick the simpler shape):",
    "- single_tactic for clear and chaotic problems: exactly one tactic.",
    "- tactic_list for complicated problems: as many ordered tactics as the work needs.",
    "- mission_tree for complex problems: mission -> strategies (as many parallel hypotheses as are worth running now) -> tactics.",
    "- The tactics' done_when conditions ARE the goal's completion checklist: the goal is achieved exactly when every tactic's done_when (and every key result) is met — nothing more, nothing missing (WBS 100% rule). Write each done_when as something a checker can observe (a file, a page, a command result, a number); a claim that cannot be observed must be restated as something observable.",
    "",
    "Rules:",
    "- Every tactic has an id (t1, t2, ...), a concrete description, and done_when: an observable post-condition that proves it is finished. kind is one_off, or recurring for a repeated action (e.g. a daily post).",
    "- A tactic must change something. 'Look into it' alone is not a tactic.",
    "- mission_tree needs mission.objective (the owner's intent and end state), mission.diagnosis (one sentence naming the biggest obstacle — the crux), strategies, and tactics where EVERY tactic has strategy_id of an existing strategy — including measurement or tracking tactics (attach them to the strategy they inform). A tactic without a strategy is dropped.",
    "- Strategy: id (s1, s2, ...), hypothesis (the guiding policy: why this approach should move the key results), serves_krs (metric names of the key results it serves), kpi (a leading indicator), budget {actions_per_day} only if a sensible daily volume follows from the required pace, timebox_hours (minimum observation before judging it), observation_window_hours.",
    "- key_results: ONLY numeric targets the owner actually wrote (target must equal a number in the owner's text, e.g. '1만' = 10000, '백만' = 1000000, '$10k' = 10000). Never invent targets. If the owner wrote no numeric target, key_results is []. A yes/no end state (e.g. 'capture the capital') belongs in mission.objective, not in key_results. deadline as an ISO 8601 calendar duration from now (e.g. P30D for '1달'/'one month') or null; a limit in non-calendar units (game turns, rounds, levels) stays in mission.objective. baseline only if the owner stated it.",
    "- boundaries: ONLY (a) owner rules, source 'owner' with quote = an exact substring of the owner's text, or (b) explicit platform/legal rules, source 'platform_rule' with rule_ref naming the rule, no numbers. Do NOT invent caps, quotas or safety limits — self-made limits are not boundaries.",
    "- review_every_hours (mission_tree only): how often to review strategies against the key-result pace (1-168; 24 is typical).",
    "- At most 6 strategies and 12 tactics. Tactics should each fit in one work session.",
    "- rationale: one or two sentences explaining the classification and shape.",
    "",
    "Answer with ONE JSON object and nothing else:",
    '{"shape":"single_tactic|tactic_list|mission_tree","problem_nature":"clear|complicated|complex|chaotic","rationale":"...",',
    '"mission":{"objective":"...","diagnosis":"...","key_results":[{"metric":"...","target":0,"unit":"...","deadline":"P30D","baseline":null}],"boundaries":[{"text":"...","source":"owner","quote":"..."}]},',
    '"strategies":[{"id":"s1","hypothesis":"...","serves_krs":["..."],"kpi":"...","budget":{"actions_per_day":null},"timebox_hours":72,"observation_window_hours":72}],',
    '"tactics":[{"id":"t1","strategy_id":"s1","description":"...","done_when":"...","kind":"one_off"}],"review_every_hours":24}',
    "Omit mission and strategies (or use null/[]) unless the shape is mission_tree; tactics then have strategy_id null.",
  ].join("\n");
}

export interface GoalShapeJudgment {
  ok: boolean;
  plan: GoalShapePlan | null;
  notes: string[];
  reason: string | null;
  rawText: string | null;
  runtimeReceipt: JudgmentRuntimeReceipt | null;
  attempts: JudgmentRuntimeAttempt[];
  elapsedMs: number;
}

/** 모양 판단 한 번(도구 없음, 판정 풀). 실패해도 throw 하지 않는다. */
export async function judgeGoalShape(input: {
  objective: string;
  ownerText: string;
  createdAt: string;
  priorFacts?: Record<string, unknown> | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  callModel?: GoalShapeModelCall;
  /** 계약·실측용: 풀 정책을 주입(없으면 설정된 오케스트레이터 풀). */
  selectionPolicy?: ReturnType<typeof configuredOrchestratorJudgmentPolicy>;
  /**
   * The runtime this Goal's turn is about to use. With no configured orchestrator judgment pool the plan is
   * decided on it (no tools) instead of falling back to a single generic tactic: goal completion now rolls up
   * from this decomposition (shared/goal-rollup.ts), so an unshaped Goal would never get its own checklist.
   */
  runtimeSelection?: RuntimeSelection;
}): Promise<GoalShapeJudgment> {
  const started = Date.now();
  const fail = (reason: string, extra: Partial<GoalShapeJudgment> = {}): GoalShapeJudgment => ({
    ok: false, plan: null, notes: [], reason, rawText: null, runtimeReceipt: null, attempts: [], elapsedMs: Date.now() - started, ...extra,
  });
  const policy = input.selectionPolicy === undefined ? configuredOrchestratorJudgmentPolicy() : input.selectionPolicy;
  if (!policy && !input.callModel && !input.runtimeSelection) return fail("goal_shape_judgment_pool_unconfigured");
  const payload = JSON.stringify({
    now: input.createdAt,
    goal_objective: input.objective,
    owner_text: input.ownerText,
    ...(input.priorFacts ? { previous_attempt: input.priorFacts,
      instruction: "The previous plan shape failed in practice. Decompose further only where it failed; a larger shape is allowed." } : {}),
  });
  let detailed: Awaited<ReturnType<GoalShapeModelCall>>;
  try {
    detailed = await (input.callModel ?? callConnectedModelDetailed)({
      systemPrompt: goalShapeSystemPrompt(),
      input: payload,
      timeoutMs: input.timeoutMs ?? GOAL_SHAPE_TIMEOUT_MS,
      signal: input.signal,
      ...(policy ? { selectionPolicy: policy } : input.runtimeSelection ? { runtimeSelection: input.runtimeSelection } : {}),
      requireNoTools: true,
      accept: (text: string) => validateGoalShape(parseGoalShapeDraft(text), input.ownerText, input.createdAt).ok,
    });
  } catch {
    return fail("goal_shape_runtime_failed");
  }
  const attempts = detailed.attempts ?? [];
  const receipt = detailed.runtimeReceipt ?? null;
  if (!detailed.text) return fail(detailed.failure?.message ? `goal_shape_unavailable:${String(detailed.failure.message).slice(0, 80)}` : "goal_shape_unavailable",
    { attempts, runtimeReceipt: receipt });
  const validated = validateGoalShape(parseGoalShapeDraft(detailed.text), input.ownerText, input.createdAt);
  if (!validated.ok) return fail(`goal_shape_invalid:${validated.reason}`, { rawText: detailed.text.slice(0, 4000), attempts, runtimeReceipt: receipt });
  return { ok: true, plan: validated.plan, notes: validated.notes, reason: null, rawText: detailed.text.slice(0, 8000),
    runtimeReceipt: receipt, attempts, elapsedMs: Date.now() - started };
}

/** 목표 원문(오너가 쓴 것) — KR 숫자·경계 인용의 대조 대상. */
export function goalOwnerText(goalId: string, objective: string): { revision: number; ownerText: string } {
  const revision = getChatGoalRevision(goalId);
  if (!revision) return { revision: 1, ownerText: objective };
  const texts = [revision.originalRequest.text, revision.sourceMessage.text, revision.objective];
  return { revision: revision.revision, ownerText: [...new Set(texts.filter((t) => typeof t === "string" && t.trim()))].join("\n") };
}

function judgmentReceipt(judgment: GoalShapeJudgment, trigger: string): Record<string, unknown> {
  return {
    schemaVersion: "agentlas.goal-shape-decision.v1",
    trigger,
    ok: judgment.ok,
    reason: judgment.reason,
    notes: judgment.notes,
    elapsedMs: judgment.elapsedMs,
    natureShapeMatch: judgment.plan ? NATURE_SHAPE[judgment.plan.problem_nature] === judgment.plan.shape : null,
    runtime: judgment.runtimeReceipt ? { ...judgment.runtimeReceipt.selection, route: judgment.runtimeReceipt.route } : null,
    attempts: judgment.attempts.map((attempt) => ({ outcome: attempt.outcome, elapsedMs: attempt.elapsedMs,
      kind: attempt.runtimeReceipt.selection.kind, model: attempt.runtimeReceipt.selection.model ?? null })),
  };
}

function tacticFacts(plan: LiveGoalPlan): Record<string, unknown> {
  return { previous_shape: plan.shape, tactics: plan.tactics.map((t) => ({ id: t.id, description: t.description, status: t.status,
    failures: t.failures, last_cause: t.guidance?.cause ?? null })) };
}

/**
 * 이 턴을 시작하기 전에 모양을 보장한다. One·Work 목표만(Science 는 자기 소유자가 있다).
 * 반환: 지금 쓸 계획(판단 실패면 폴백 계획), 또는 대상이 아니면 null.
 */
export async function ensureGoalShapeBeforeTurn(input: {
  goalId: string;
  objective: string;
  signal?: AbortSignal;
  nowMs?: number;
  callModel?: GoalShapeModelCall;
  selectionPolicy?: ReturnType<typeof configuredOrchestratorJudgmentPolicy>;
  runtimeSelection?: RuntimeSelection;
  onJudging?: () => void;
}): Promise<LiveGoalPlan | null> {
  const run = getLongRunByGoalId(input.goalId);
  if (!run || !ownsHostGoalLoop(run.surface)) return null;
  const nowMs = input.nowMs ?? Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const { revision, ownerText } = goalOwnerText(input.goalId, input.objective);
  const existing = readGoalPlan(input.goalId, revision);
  let trigger: string | null = null;
  let priorFacts: Record<string, unknown> | null = null;
  if (!existing) {
    trigger = revision > 1 ? "goal_revised" : "goal_created";
  } else if (existing.fallback) {
    const failedRetries = listGoalPlanDecisions(input.goalId, { revision, planSeq: existing.planSeq, kind: "reshape_requested", limit: 50 })
      .filter((row) => row.payload.reason === "shape_retry_failed");
    const lastRetry = failedRetries[0] ? Date.parse(failedRetries[0].createdAt) : Date.parse(existing.createdAt);
    if (failedRetries.length < GOAL_SHAPE_FALLBACK_RETRIES || nowMs - lastRetry >= FALLBACK_RETRY_COOLDOWN_MS) {
      trigger = "fallback_retry";
    }
  } else {
    const promotion = listGoalPlanDecisions(input.goalId, { revision, planSeq: existing.planSeq, kind: "reshape_requested", limit: 5 })
      .find((row) => row.payload.reason === "single_tactic_failed_twice");
    if (promotion) { trigger = "promotion_after_failures"; priorFacts = tacticFacts(existing); }
  }
  if (!trigger) return existing;
  input.onJudging?.();
  const judgment = await judgeGoalShape({ objective: input.objective, ownerText, createdAt, priorFacts, signal: input.signal,
    callModel: input.callModel, selectionPolicy: input.selectionPolicy, runtimeSelection: input.runtimeSelection });
  if (judgment.ok && judgment.plan) {
    return saveGoalPlan({ goalId: input.goalId, revision, plan: judgment.plan, fallback: false,
      receipt: { ...judgmentReceipt(judgment, trigger), ownerText: ownerText.slice(0, 2000), rawText: judgment.rawText }, createdAt });
  }
  if (!existing) {
    // 목표를 막지 않는다: 단일 전술로 시작하고 다음 턴에 다시 판단한다.
    return saveGoalPlan({ goalId: input.goalId, revision, plan: fallbackGoalShape(input.objective), fallback: true,
      receipt: judgmentReceipt(judgment, trigger), createdAt });
  }
  recordGoalPlanDecision({ goalId: input.goalId, revision, planSeq: existing.planSeq, kind: "reshape_requested", createdAt,
    payload: { reason: "shape_retry_failed", trigger, judgment: judgmentReceipt(judgment, trigger) } });
  return existing;
}

// ── 턴 문맥 ──────────────────────────────────────────────────────────────────

function utcDay(iso: string): string { return iso.slice(0, 10); }

function dispatchesToday(plan: LiveGoalPlan, nowMs: number): Record<string, number> {
  const today = utcDay(new Date(nowMs).toISOString());
  const counts: Record<string, number> = {};
  for (const row of listGoalPlanDecisions(plan.goalId, { revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_dispatch", limit: 500 })) {
    if (utcDay(row.createdAt) !== today) continue;
    for (const id of Array.isArray(row.payload.strategyIds) ? row.payload.strategyIds as string[] : []) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export function missionPaces(plan: LiveGoalPlan, nowMs: number): Array<{ krId: string; metric: string; target: number; unit: string; targetText: string; pace: MissionPace }> {
  return (plan.mission?.key_results ?? []).map((kr) => ({ krId: kr.id, metric: kr.metric, target: kr.target, unit: kr.unit, targetText: kr.target_text,
    // 센서는 P-a 스텁 — 호스트가 잰 표본이 아직 없다. 추측하지 않는다.
    pace: missionPace({ target: kr.target, baseline: kr.baseline, startAt: plan.createdAt, deadlineAt: kr.deadline_at, nowMs, samples: [] }) }));
}

function reviewDue(plan: LiveGoalPlan, nowMs: number): boolean {
  if (plan.shape !== "mission_tree" || !plan.review_every_hours) return false;
  const last = listGoalPlanDecisions(plan.goalId, { revision: plan.revision, planSeq: plan.planSeq, kind: "strategy_review", limit: 1 })[0];
  const since = Date.parse(last?.createdAt ?? plan.createdAt);
  return nowMs - since >= plan.review_every_hours * 3_600_000;
}

function guidanceLine(tactic: LiveTactic): string | null {
  const g = tactic.guidance;
  if (!g) return null;
  switch (g.move) {
    case "replan": return `This tactic was blocked (${g.cause}). Try a clearly different approach, or split it with a replace_tactic plan-op.`;
    case "observe": return `This tactic was blocked (${g.cause}). First inspect the current state read-only; do not repeat an external action whose effect is unknown.`;
    case "retry_backoff": return `This tactic was blocked (${g.cause}); retry it${g.at ? ` after ${g.at}` : ""}. Work on another open tactic meanwhile if there is one.`;
    case "escalate_boundary": return `This tactic waits on the owner for a ${g.boundary ?? "boundary"} decision. Ask that one question once, then continue other tactics.`;
    case "switch_tool": return `This tactic was blocked (${g.cause}); use an alternative installed tool with the same capability.`;
    default: return `This tactic was blocked (${g.cause}); the host chose ${g.move}.`;
  }
}

/**
 * 계획을 턴 문맥 한 절로(R9: 활성 전술만). 선택한 전술의 발송 영수증과, 트리면 리뷰 영수증을 남긴다.
 */
export function buildGoalPlanTurnContext(plan: LiveGoalPlan, input: { nowMs?: number; runId?: string | null; record?: boolean } = {}): string {
  const nowMs = input.nowMs ?? Date.now();
  const tactics = selectActiveTactics(plan, { nowMs, dispatchesToday: dispatchesToday(plan, nowMs) });
  const strategyOf = (id: string | null) => plan.strategies.find((s) => s.id === id) ?? null;
  const lines: string[] = ["## Goal plan (host-owned shape decision · agentlas.goal-shape.v1)"];
  lines.push(`Shape: ${plan.shape} (problem: ${plan.problem_nature}${plan.fallback ? "; provisional — the planner was unavailable" : ""}). ${plan.rationale}`);
  const paces = missionPaces(plan, nowMs);
  if (plan.shape === "mission_tree" && plan.mission) {
    lines.push(`Mission (owner intent, immutable): ${plan.mission.objective}`);
    lines.push(`Diagnosis: ${plan.mission.diagnosis}`);
    for (const { metric, target, unit, targetText, pace } of paces) {
      lines.push(`- KR ${metric}: ${target}${unit ? ` ${unit}` : ""} (owner: "${targetText}")`
        + (pace.daysLeft !== null ? ` · ${pace.daysLeft} days left` : "")
        + (pace.requiredPerDay !== null ? ` · required ≈ ${pace.requiredPerDay}/day`
          : pace.requiredPerDayUpperBound !== null ? ` · required ≤ ${pace.requiredPerDayUpperBound}/day (baseline unknown — measure it first)` : "")
        + ` · host sensor: ${pace.status === "no_sensor" ? "none yet (not a strategy failure)" : pace.status}`);
    }
    if (plan.mission.boundaries.length) lines.push(`Boundaries (the only limits): ${plan.mission.boundaries.map((b) => b.text).join("; ")}`);
    const active = plan.strategies.filter((s) => s.status === "active").map((s) => `${s.id}: ${s.hypothesis}`);
    if (active.length) lines.push(`Active strategies: ${active.join(" | ")}`);
  }
  if (tactics.length) {
    lines.push("Current tactic(s) — work on these now, not on the whole plan:");
    for (const tactic of tactics) {
      const strategy = strategyOf(tactic.strategy_id);
      lines.push(`- ${tactic.id}${strategy ? ` [strategy ${strategy.id}: ${strategy.hypothesis}; KPI: ${strategy.kpi || "—"}]` : ""}: ${tactic.description}`);
      lines.push(`  Done when: ${tactic.done_when}${tactic.kind === "recurring" ? ` (recurring; runs so far ${tactic.runs})` : ""}`);
      const guidance = guidanceLine(tactic);
      if (guidance) lines.push(`  Host guidance (persistence policy): ${guidance}`);
    }
    // 목록은 순서가 이미 정해진 계획이다 — 남은 전술의 id 를 보여 줘야 같은 턴에 이어서 끝낸 전술도 표식할 수 있다.
    // (실측 2026-09-24 E2E: 한 패스에 t1~t3 을 다 했는데 t1 만 알아서 t1 만 표식했다.) 트리는 활성 전술만(R9).
    if (plan.shape === "tactic_list") {
      const current = new Set(tactics.map((t) => t.id));
      const later = [...plan.tactics].filter((t) => (t.status === "active" || t.status === "proposed") && !current.has(t.id)).sort((a, b) => a.ord - b.ord);
      if (later.length) lines.push(`Then, in order: ${later.map((t) => `${t.id}: ${t.description} (done when: ${t.done_when})`).join(" | ")}`);
    }
  } else {
    lines.push("Every planned tactic is done or retired. Verify the goal's acceptance criteria; if work remains, add a tactic with an add_tactic plan-op.");
  }
  const review = reviewDue(plan, nowMs);
  if (review) {
    lines.push("Strategy review is due: compare each active strategy against the key-result pace above. You may retire a strategy whose timebox has elapsed (cite evidence) or add a strategy that cites a key result. Missing sensor data is an infrastructure state, not a reason to retire a strategy.");
  }
  lines.push("Protocol (machine markers, each on its own line; the host strips them from the reply):");
  lines.push('- Tactic finished: <<agentlas-tactic>>{"id":"t1","status":"done","evidence":"what proves done_when"} — emit one for EVERY tactic you finish, including later tactics finished in this same turn.');
  lines.push('- Tactic cannot proceed: <<agentlas-tactic>>{"id":"t1","status":"blocked","cause":"tool_missing|tool_refused|resource_busy|effect_uncertain|unknown|boundary","boundary":"payment|credential|security_consent|owner_stop|purpose_change","evidence":"..."} — the host picks the next move; never abandon the goal.');
  lines.push('- Plan changes: <<agentlas-plan-op>>{"op":"replace_tactic","id":"t1","with":[{"description":"...","done_when":"..."}]} · {"op":"add_tactic","strategy_id":"s1","description":"...","done_when":"..."}' +
    (plan.shape === "mission_tree" ? ' · {"op":"retire_strategy","id":"s2","evidence":"..."} · {"op":"add_strategy","hypothesis":"...","serves_krs":["kr id"],"kpi":"...","timebox_hours":72,"tactics":[{"description":"...","done_when":"..."}]}' : ""));
  lines.push("Do not invent caps or pacing limits; only the mission boundaries and the goal's permissions limit you.");
  if (input.record !== false) {
    if (tactics.length) {
      recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_dispatch", createdAt: new Date(nowMs).toISOString(),
        payload: { runId: input.runId ?? null, tacticIds: tactics.map((t) => t.id),
          strategyIds: [...new Set(tactics.map((t) => t.strategy_id).filter((id): id is string => Boolean(id)))] } });
    }
    if (review) {
      recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "strategy_review", createdAt: new Date(nowMs).toISOString(),
        payload: { runId: input.runId ?? null, sensor: "none", sensorState: "infra_no_sensor",
          paces: paces.map(({ krId, pace }) => ({ krId, ...pace })),
          activeStrategies: plan.strategies.filter((s) => s.status === "active").map((s) => s.id) } });
    }
  }
  return lines.join("\n");
}

/** 같은 턴 안의 다음 패스에 붙일 짧은 안내(방금 완료된 전술 뒤의 다음 전술). */
export function goalPlanContinuationNote(goalId: string, nowMs = Date.now()): string | null {
  const plan = readGoalPlan(goalId);
  if (!plan) return null;
  const next = selectActiveTactics(plan, { nowMs, dispatchesToday: dispatchesToday(plan, nowMs) });
  if (!next.length) return "Goal plan: every planned tactic is done or retired — verify the acceptance criteria before claiming completion.";
  return `Goal plan — next tactic: ${next.map((t) => `${t.id}: ${t.description} (done when: ${t.done_when})`).join(" | ")}. Emit the tactic marker when it is done.`;
}

// ── 표식 적용 ────────────────────────────────────────────────────────────────

function causeOfMarker(marker: TacticMarker): FailureCause {
  if (marker.cause === "boundary") {
    return isPersistenceBoundaryKind(marker.boundary) ? { kind: "boundary", boundary: marker.boundary } : { kind: "unknown" };
  }
  return { kind: marker.cause };
}

function tacticHistory(plan: LiveGoalPlan, tacticId: string): PersistenceAttempt[] {
  return listGoalPlanDecisions(plan.goalId, { revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", limit: 200 })
    .filter((row) => row.payload.tacticId === tacticId && typeof row.payload.move === "string")
    .reverse()
    .map((row) => ({ cause: row.payload.cause as PersistenceAttempt["cause"], move: row.payload.move as PersistenceAttempt["move"],
      boundary: (row.payload.moveBoundary ?? null) as PersistenceAttempt["boundary"] }));
}

export interface GoalPlanMarkerOutcome {
  text: string;
  applied: Array<{ kind: "tactic" | "plan_op"; id: string; result: string }>;
}

function applyTacticMarker(plan: LiveGoalPlan, marker: TacticMarker, runId: string | null, nowMs: number): string {
  const tactic = plan.tactics.find((t) => t.id === marker.id);
  if (!tactic) return "tactic_not_found";
  if (tactic.status === "done" || tactic.status === "retired") return "tactic_not_open";
  const at = new Date(nowMs).toISOString();
  if (marker.status === "done") {
    if (!marker.evidence) return "evidence_required";
    const recurringInTree = tactic.kind === "recurring" && plan.shape === "mission_tree";
    updateGoalPlanNode(plan, tactic.id, { status: recurringInTree ? "active" : "done",
      payload: { runs: tactic.runs + 1, evidence: marker.evidence.slice(0, 600), guidance: null, deferredUntil: null } });
    recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", createdAt: at,
      payload: { tacticId: tactic.id, status: recurringInTree ? "ran" : "done", evidence: marker.evidence.slice(0, 600), runId } });
    return recurringInTree ? "recurring_ran" : "done";
  }
  const cause = causeOfMarker(marker);
  // 계획 층은 런타임·도구를 바꾸지 않는다(그건 목표 원장과 도구 선택의 몫, "재시도하는 층은 하나").
  const decision = decidePersistenceMove({ cause, history: tacticHistory(plan, tactic.id),
    goal: { status: "active", switchableRuntimes: 0, switchableTools: 0 }, nowMs });
  const move = decision.move;
  const failures = tactic.failures + 1;
  updateGoalPlanNode(plan, tactic.id, { payload: { failures,
    guidance: { move: move.kind, cause: cause.kind === "boundary" ? `boundary:${cause.boundary}` : cause.kind,
      at: move.kind === "retry_backoff" ? move.at : null, boundary: move.kind === "escalate_boundary" ? move.boundary : null },
    deferredUntil: move.kind === "retry_backoff" ? move.at : null } });
  recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", createdAt: at,
    payload: { tacticId: tactic.id, status: "blocked", cause: cause.kind, causeBoundary: cause.kind === "boundary" ? cause.boundary : null,
      move: move.kind, moveBoundary: move.kind === "escalate_boundary" ? move.boundary : null, moveAt: move.kind === "retry_backoff" ? move.at : null,
      reasonCode: decision.reasonCode, evidence: marker.evidence.slice(0, 600), runId } });
  if (plan.shape === "single_tactic" && failures >= SINGLE_TACTIC_PROMOTION_FAILURES) {
    recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "reshape_requested", createdAt: at,
      payload: { reason: "single_tactic_failed_twice", tacticId: tactic.id, failures } });
  }
  return `blocked:${move.kind}`;
}

function nextId(plan: LiveGoalPlan, prefix: "t" | "s", taken: Set<string>): string {
  let n = (prefix === "t" ? plan.tactics.length : plan.strategies.length) + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  taken.add(id);
  return id;
}

function applyPlanOp(plan: LiveGoalPlan, op: PlanOp, runId: string | null, nowMs: number): string {
  const checked = checkPlanOp(plan, op, nowMs);
  const at = new Date(nowMs).toISOString();
  const receipt = (result: string, extra: Record<string, unknown> = {}) => recordGoalPlanDecision({ goalId: plan.goalId, revision: plan.revision,
    planSeq: plan.planSeq, kind: "plan_op", createdAt: at, payload: { op: op.op, result, runId, ...extra } });
  if (!checked.ok) { receipt("rejected", { reason: checked.reason }); return `rejected:${checked.reason}`; }
  const taken = new Set([...plan.tactics.map((t) => t.id), ...plan.strategies.map((s) => s.id)]);
  const maxOrd = Math.max(0, ...plan.tactics.map((t) => t.ord)) + 1;
  switch (op.op) {
    case "replace_tactic": {
      const target = plan.tactics.find((t) => t.id === op.id)!;
      updateGoalPlanNode(plan, target.id, { status: "retired", payload: { retiredBy: "replace_tactic" } });
      // 쪼갠 조각들은 원래 자리에 들어간다(뒤 전술보다 앞).
      for (const later of plan.tactics.filter((t) => t.ord > target.ord)) updateGoalPlanNode(plan, later.id, { ord: later.ord + op.with.length });
      const ids = op.with.map((draft, index) => {
        const id = nextId(plan, "t", taken);
        insertGoalPlanNode(plan, { nodeId: id, kind: "tactic", parentId: target.strategy_id, status: "active", ord: target.ord + 1 + index,
          payload: goalPlanTacticPayload({ id, strategy_id: target.strategy_id, ...draft }) });
        return id;
      });
      receipt("applied", { replaced: target.id, added: ids });
      return `applied:${ids.join(",")}`;
    }
    case "add_tactic": {
      const id = nextId(plan, "t", taken);
      const strategyId = plan.shape === "mission_tree" ? op.strategy_id : null;
      insertGoalPlanNode(plan, { nodeId: id, kind: "tactic", parentId: strategyId, status: "active", ord: maxOrd,
        payload: goalPlanTacticPayload({ id, strategy_id: strategyId, description: op.description, done_when: op.done_when, kind: op.kind }) });
      receipt("applied", { added: [id] });
      return `applied:${id}`;
    }
    case "retire_strategy": {
      updateGoalPlanNode(plan, op.id, { status: "retired", payload: { retiredAt: at, retireEvidence: op.evidence.slice(0, 600) } });
      for (const tactic of plan.tactics.filter((t) => t.strategy_id === op.id && (t.status === "active" || t.status === "proposed"))) {
        updateGoalPlanNode(plan, tactic.id, { status: "retired", payload: { retiredBy: "retire_strategy" } });
      }
      const promoted = plan.strategies.filter((s) => s.status === "proposed").sort((a, b) => a.priority - b.priority)[0];
      if (promoted) updateGoalPlanNode(plan, promoted.id, { status: "active", payload: { activatedAt: at } });
      receipt("applied", { retired: op.id, evidence: op.evidence.slice(0, 600), promoted: promoted?.id ?? null });
      return `applied:${op.id}`;
    }
    case "add_strategy": {
      const id = nextId(plan, "s", taken);
      const krIds = new Set((plan.mission?.key_results ?? []).map((kr) => kr.id));
      insertGoalPlanNode(plan, { nodeId: id, kind: "strategy", parentId: plan.mission ? "mission" : null, status: "active",
        ord: plan.strategies.length, payload: { id, hypothesis: op.hypothesis, serves_krs: op.serves_krs.filter((ref) => krIds.has(ref)),
          kpi: op.kpi, actions_per_day: op.actions_per_day, timebox_hours: op.timebox_hours, observation_window_hours: op.observation_window_hours,
          priority: plan.strategies.length, activatedAt: at } });
      const tacticIds = op.tactics.map((draft, index) => {
        const tid = nextId(plan, "t", taken);
        insertGoalPlanNode(plan, { nodeId: tid, kind: "tactic", parentId: id, status: "active", ord: maxOrd + index,
          payload: goalPlanTacticPayload({ id: tid, strategy_id: id, ...draft }) });
        return tid;
      });
      receipt("applied", { added: id, tactics: tacticIds });
      return `applied:${id}`;
    }
  }
}

/**
 * 한 패스(또는 최종) 본문에서 표식을 떼어 원장에 반영한다. 계획이 없거나 표식이 없으면 본문을 그대로 돌려준다.
 * 실패는 삼키고 본문만 돌려준다 — 계획 원장 오류가 사람의 답을 막지 않는다.
 */
export function applyGoalPlanMarkers(input: { goalId: string | null; text: string; runId?: string | null; nowMs?: number }): GoalPlanMarkerOutcome {
  const extracted = extractGoalPlanMarkers(input.text);
  if (!input.goalId || (!extracted.tactics.length && !extracted.ops.length)) return { text: extracted.text, applied: [] };
  const applied: GoalPlanMarkerOutcome["applied"] = [];
  const nowMs = input.nowMs ?? Date.now();
  try {
    for (const marker of extracted.tactics) {
      const plan = readGoalPlan(input.goalId);
      if (!plan) break;
      applied.push({ kind: "tactic", id: marker.id, result: applyTacticMarker(plan, marker, input.runId ?? null, nowMs) });
    }
    for (const op of extracted.ops) {
      const plan = readGoalPlan(input.goalId);
      if (!plan) break;
      applied.push({ kind: "plan_op", id: op.op, result: applyPlanOp(plan, op, input.runId ?? null, nowMs) });
    }
  } catch (error) {
    console.warn("[goal-plan] marker application failed:", error instanceof Error ? error.message : error);
  }
  return { text: extracted.text, applied };
}

/**
 * 턴 실패(goalPassStop)는 목표 원장이 다음 수를 이미 골랐다(ownerLayer goal_ledger). 여기서는 두 번째 결정을 내리지 않고
 * 현재 전술에 실패 사실만 적는다 — 같은 실패를 두 층이 겹쳐 재시도하지 않게(§6-4).
 */
export function recordGoalPlanPassStop(goalId: string, cause: FailureCause, runId: string | null, nowMs = Date.now()): void {
  try {
    const plan = readGoalPlan(goalId);
    if (!plan) return;
    const current = selectActiveTactics(plan, { nowMs })[0];
    if (!current) return;
    recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", createdAt: new Date(nowMs).toISOString(),
      payload: { tacticId: current.id, status: "turn_failed", cause: cause.kind, ownerLayer: "goal_ledger", runId } });
  } catch (error) {
    console.warn("[goal-plan] pass-stop receipt failed:", error instanceof Error ? error.message : error);
  }
}

export function goalPlanView(goalId: string, nowMs = Date.now()): GoalPlanView | null {
  try {
    const plan = readGoalPlan(goalId);
    if (!plan) return null;
    const current = selectActiveTactics(plan, { nowMs, dispatchesToday: dispatchesToday(plan, nowMs) })[0] ?? null;
    const short = (t: LiveTactic) => ({ id: t.id, description: t.description.slice(0, GOAL_SHAPE_LIMITS.shortText), status: t.status });
    return {
      shape: plan.shape, problemNature: plan.problem_nature, fallback: plan.fallback, revision: plan.revision, planSeq: plan.planSeq,
      currentTactic: current ? { id: current.id, description: current.description.slice(0, GOAL_SHAPE_LIMITS.shortText), strategyId: current.strategy_id } : null,
      mission: plan.mission ? { objective: plan.mission.objective, keyResults: missionPaces(plan, nowMs).map(({ metric, target, unit, pace }) => ({
        metric, target, unit, requiredPerDay: pace.requiredPerDay ?? pace.requiredPerDayUpperBound, daysLeft: pace.daysLeft, sensor: pace.status })) } : null,
      strategies: plan.strategies.map((s) => ({ id: s.id, hypothesis: s.hypothesis.slice(0, GOAL_SHAPE_LIMITS.shortText), status: s.status,
        tactics: plan.tactics.filter((t) => t.strategy_id === s.id && t.status !== "retired").map(short) })),
      tactics: plan.tactics.filter((t) => t.status !== "retired").sort((a, b) => a.ord - b.ord).map(short),
    };
  } catch {
    return null;
  }
}
