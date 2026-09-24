/**
 * 골 구조 판단(Goal shape) — 일을 시작하기 전에 "이 목표에 어떤 모양의 계획이 맞는가"를 먼저 정한다.
 * (2026-09-24 오너 최우선: "AI가 골을 대계-전략-전술로 짜고 진행할건지, 전술 목표만 짜고 갈건지,
 *  전략-전술 다중으로 짤건지 먼저 판단하고 그 다음에 이어져야 함." — 도메인 무관, Threads 전용 아님.)
 *
 * 설계 근거: docs/2026-09-24-PLAN-persistent-autonomy-foundation.md "골 구조 판단" 절(S-1 규칙 R1~R9).
 *  - R1 Cynefin: clear→single_tactic, complicated→tactic_list, complex→mission_tree, chaotic→single_tactic(안정화 한 수).
 *  - R2 ADaPT/"가장 단순한 해법": 기본은 단순한 모양, 실패한 전술만 쪼갠다(replace_tactic), 단일 전술 2회 실패면 재판단.
 *  - R3 OKR: KR 목표값은 오너 문장의 숫자와 결정적으로 일치해야 한다(모델이 수치를 지어내지 않는다).
 *  - R4 Rumelt: 트리에는 진단(가장 큰 장애물)이 필수. 전략=지도 방침, 전술=전략을 인용하는 일관된 행동.
 *  - R5 임무형 지휘: 경계는 오너 인용이거나 명시적 플랫폼 규정(숫자 없음)뿐. 지어낸 상한은 경계가 아니다.
 *  - R7 HTN/GOAP·McKee: 모든 전술은 관찰 가능한 완료 조건(done_when)을 가진다.
 *  - R9 Task-Decoupled Planning: 턴에는 활성 전술의 문맥만 준다.
 *
 * 순수 모듈 — DB·시계·런타임·난수 없음. 호스트(Main)가 모델 답을 이 검증에 통과시킨 것만 저장한다.
 */

export const GOAL_SHAPE_SCHEMA = "agentlas.goal-shape.v1" as const;

export const GOAL_SHAPE_KINDS = ["single_tactic", "tactic_list", "mission_tree"] as const;
export type GoalShapeKind = (typeof GOAL_SHAPE_KINDS)[number];
export const PROBLEM_NATURES = ["clear", "complicated", "complex", "chaotic"] as const;
export type ProblemNature = (typeof PROBLEM_NATURES)[number];

/** R1: 문제의 성질에 맞는 모양. 어긋나면 받되 기록한다(판단은 모델 몫, 기록은 호스트 몫). */
export const NATURE_SHAPE: Readonly<Record<ProblemNature, GoalShapeKind>> = {
  clear: "single_tactic",
  complicated: "tactic_list",
  complex: "mission_tree",
  chaotic: "single_tactic",
};

export const GOAL_SHAPE_LIMITS = {
  strategies: 6,
  tactics: 12,
  keyResults: 6,
  boundaries: 10,
  text: 600,
  shortText: 200,
  minReviewHours: 1,
  maxReviewHours: 168,
  defaultReviewHours: 24,
  defaultTimeboxHours: 72,
} as const;

export interface GoalKeyResult {
  id: string;
  metric: string;
  target: number;
  unit: string;
  /** 오너 문장에서 호스트가 찾은 원문 조각(R3). */
  target_text: string;
  deadline: string | null;
  /** 호스트가 계산한 절대 마감(ISO). 못 계산하면 null. */
  deadline_at: string | null;
  baseline: number | null;
}

export interface GoalBoundary {
  text: string;
  source: "owner" | "platform_rule";
  quote?: string;
  rule_ref?: string;
}

export interface GoalMission {
  objective: string;
  diagnosis: string;
  key_results: GoalKeyResult[];
  boundaries: GoalBoundary[];
}

export interface GoalStrategy {
  id: string;
  hypothesis: string;
  serves_krs: string[];
  kpi: string;
  actions_per_day: number | null;
  timebox_hours: number;
  observation_window_hours: number;
  priority: number;
}

export interface GoalTactic {
  id: string;
  strategy_id: string | null;
  description: string;
  done_when: string;
  kind: "one_off" | "recurring";
}

export interface GoalShapePlan {
  schemaVersion: typeof GOAL_SHAPE_SCHEMA;
  shape: GoalShapeKind;
  problem_nature: ProblemNature;
  rationale: string;
  mission: GoalMission | null;
  strategies: GoalStrategy[];
  tactics: GoalTactic[];
  review_every_hours: number | null;
}

export type GoalShapeValidation =
  | { ok: true; plan: GoalShapePlan; notes: string[] }
  | { ok: false; reason: string };

// ── 오너 숫자(R3) ─────────────────────────────────────────────────────────────

export interface OwnerNumber { value: number; text: string }

const KO_UNITS: Record<string, number> = { "십": 10, "백": 100, "천": 1_000, "만": 10_000, "십만": 100_000, "백만": 1_000_000, "천만": 10_000_000, "억": 100_000_000, "조": 1_000_000_000_000 };
const EN_UNITS: Record<string, number> = { k: 1_000, thousand: 1_000, m: 1_000_000, mm: 1_000_000, million: 1_000_000, b: 1_000_000_000, bn: 1_000_000_000, billion: 1_000_000_000 };

/**
 * 오너 문장에 있는 수량을 모두 뽑는다: "1만"→10000, "10,000"→10000, "100만"/"백만"→1000000, "$10k"→10000, "1.5억"→150000000.
 * 모델 KR 목표값의 대조 집합이다. 문장을 해석하지 않고 숫자 모양만 본다.
 */
export function extractOwnerNumbers(text: string): OwnerNumber[] {
  const source = String(text ?? "");
  const out: OwnerNumber[] = [];
  const push = (value: number, raw: string) => {
    if (Number.isFinite(value) && value >= 0) out.push({ value, text: raw.trim() });
  };
  const numeric = /(\d+(?:[.,]\d+)*)\s*(십만|백만|천만|십|백|천|만|억|조|thousand|million|billion|bn|mm|k|m|b)?(?![a-z])/giu;
  for (const match of source.matchAll(numeric)) {
    const rawNumber = match[1]!;
    const unit = (match[2] ?? "").toLowerCase();
    const normalized = /,\d{3}(?:$|[.,])/.test(rawNumber) ? rawNumber.replace(/,/g, "") : rawNumber.replace(/,/g, ".");
    const base = Number(normalized);
    if (!Number.isFinite(base)) continue;
    const multiplier = KO_UNITS[unit] ?? EN_UNITS[unit] ?? 1;
    push(base * multiplier, match[0]);
    if (multiplier !== 1) push(base, rawNumber);
  }
  // 숫자 없이 쓴 한자어 단위: "백만", "천만", "일억" 등.
  const words = /(?<![\d가-힣])(일|이|삼|사|오|육|칠|팔|구|십)?(십만|백만|천만|억|조)(?![가-힣]*\d)/gu;
  const digit: Record<string, number> = { "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9, "십": 10 };
  for (const match of source.matchAll(words)) {
    push((match[1] ? digit[match[1]]! : 1) * KO_UNITS[match[2]!]!, match[0]);
  }
  return out;
}

function ownerNumberFor(target: number, owner: readonly OwnerNumber[]): OwnerNumber | null {
  return owner.find((candidate) => Math.abs(candidate.value - target) <= Math.max(1e-9, Math.abs(target) * 1e-9)) ?? null;
}

/** ISO 기간(P30D, P1M, P2W, PT12H) 또는 날짜를 절대 시각으로. 못 읽으면 null. */
export function resolveGoalDeadline(deadline: string | null | undefined, startAtIso: string): string | null {
  if (!deadline || typeof deadline !== "string") return null;
  const start = Date.parse(startAtIso);
  if (!Number.isFinite(start)) return null;
  const trimmed = deadline.trim();
  const duration = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/i.exec(trimmed);
  if (duration && trimmed.length > 1 && trimmed.toUpperCase() !== "PT") {
    const [, y, mo, w, d, h] = duration;
    const at = new Date(start);
    if (y) at.setUTCFullYear(at.getUTCFullYear() + Number(y));
    if (mo) at.setUTCMonth(at.getUTCMonth() + Number(mo));
    const extraMs = (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400_000 + Number(h ?? 0) * 3_600_000;
    const result = at.getTime() + extraMs;
    return result > start ? new Date(result).toISOString() : null;
  }
  const absolute = Date.parse(trimmed);
  return Number.isFinite(absolute) && absolute > start ? new Date(absolute).toISOString() : null;
}

// ── 파싱·검증 ────────────────────────────────────────────────────────────────

/** 모델 답에서 JSON 객체 하나를 꺼낸다(코드펜스 허용). 산문 해석은 하지 않는다. */
export function parseGoalShapeDraft(text: string | null | undefined): unknown {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown, max: number = GOAL_SHAPE_LIMITS.text): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const idOf = (value: unknown): string => {
  const raw = str(value, 40);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(raw) ? raw : "";
};
const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const clampHours = (value: unknown, fallback: number): number => {
  const n = finiteOrNull(value);
  return n === null ? fallback : Math.min(GOAL_SHAPE_LIMITS.maxReviewHours * 4, Math.max(GOAL_SHAPE_LIMITS.minReviewHours, Math.round(n)));
};
const slug = (value: string): string =>
  value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "kr";

function tacticsFrom(raw: unknown, notes: string[]): GoalTactic[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tactics: GoalTactic[] = [];
  for (const item of raw) {
    if (!isRecord(item)) { notes.push("tactic_not_object"); continue; }
    const id = idOf(item.id);
    const description = str(item.description);
    const doneWhen = str(item.done_when);
    if (!id || seen.has(id)) { notes.push("tactic_id_invalid_or_duplicate"); continue; }
    // R7: 완료 조건이 없는 것은 전술이 아니다.
    if (!description || !doneWhen) { notes.push(`tactic_${id}_missing_done_when`); continue; }
    seen.add(id);
    tactics.push({ id, strategy_id: idOf(item.strategy_id) || null, description, done_when: doneWhen,
      kind: item.kind === "recurring" ? "recurring" : "one_off" });
  }
  if (tactics.length > GOAL_SHAPE_LIMITS.tactics) notes.push("tactics_capped");
  return tactics.slice(0, GOAL_SHAPE_LIMITS.tactics);
}

/**
 * 모델 답을 검증한다. 고치지 않고 **받거나 줄이거나 강등**한다. 줄이거나 강등한 이유는 notes 에 남는다.
 * ownerText 는 오너가 쓴 원문(목표 원 요청 + 개정 문장). createdAtIso 는 기한 계산 기준.
 */
export function validateGoalShape(raw: unknown, ownerText: string, createdAtIso: string): GoalShapeValidation {
  if (!isRecord(raw)) return { ok: false, reason: "shape_not_object" };
  const notes: string[] = [];
  const declared = raw.shape;
  if (!GOAL_SHAPE_KINDS.includes(declared as GoalShapeKind)) return { ok: false, reason: "shape_invalid" };
  const nature = PROBLEM_NATURES.includes(raw.problem_nature as ProblemNature) ? raw.problem_nature as ProblemNature : null;
  if (!nature) return { ok: false, reason: "problem_nature_invalid" };
  const rationale = str(raw.rationale);
  if (!rationale) return { ok: false, reason: "rationale_required" };
  let shape = declared as GoalShapeKind;
  const tactics = tacticsFrom(raw.tactics, notes);
  if (!tactics.length) return { ok: false, reason: "tactics_required" };

  let mission: GoalMission | null = null;
  let strategies: GoalStrategy[] = [];
  let reviewEveryHours: number | null = null;

  if (shape === "mission_tree") {
    const m = isRecord(raw.mission) ? raw.mission : null;
    const objective = str(m?.objective);
    const diagnosis = str(m?.diagnosis);
    // R4: 진단 없는 트리는 소망 목록이다.
    if (!m || !objective || !diagnosis) {
      notes.push("tree_downgraded_missing_diagnosis_or_objective");
      shape = "tactic_list";
    } else {
      const owner = extractOwnerNumbers(ownerText);
      const krs: GoalKeyResult[] = [];
      const krIds = new Set<string>();
      for (const item of Array.isArray(m.key_results) ? m.key_results : []) {
        if (!isRecord(item)) continue;
        const metric = str(item.metric, GOAL_SHAPE_LIMITS.shortText);
        const target = finiteOrNull(item.target);
        if (!metric || target === null) { notes.push("kr_incomplete_dropped"); continue; }
        const matched = ownerNumberFor(target, owner);
        // R3: 오너가 준 숫자가 아니면 KR 이 아니다.
        if (!matched) { notes.push(`kr_number_not_in_owner_text:${metric}`); continue; }
        let id = slug(metric);
        while (krIds.has(id)) id = `${id}_2`;
        krIds.add(id);
        const deadline = str(item.deadline, 40) || null;
        const baseline = finiteOrNull(item.baseline);
        krs.push({ id, metric, target, unit: str(item.unit, 40), target_text: matched.text, deadline,
          deadline_at: resolveGoalDeadline(deadline, createdAtIso), baseline });
      }
      const boundaries: GoalBoundary[] = [];
      const ownerFlat = ownerText.replace(/\s+/g, " ");
      for (const item of Array.isArray(m.boundaries) ? m.boundaries : []) {
        if (!isRecord(item)) continue;
        const text = str(item.text, GOAL_SHAPE_LIMITS.shortText);
        if (!text) continue;
        if (item.source === "owner") {
          const quote = str(item.quote, GOAL_SHAPE_LIMITS.shortText);
          // R5: 오너 경계는 원문 인용이어야 한다.
          if (quote && ownerFlat.includes(quote)) boundaries.push({ text, source: "owner", quote });
          else notes.push("boundary_owner_quote_not_found");
        } else if (item.source === "platform_rule") {
          const ruleRef = str(item.rule_ref, GOAL_SHAPE_LIMITS.shortText);
          // R5: 플랫폼 규정은 출처가 있어야 하고, 숫자 상한은 오너만 줄 수 있다.
          if (!ruleRef) notes.push("boundary_platform_rule_ref_missing");
          else if (/\d/.test(text)) notes.push("boundary_platform_rule_numeric_limit_dropped");
          else boundaries.push({ text, source: "platform_rule", rule_ref: ruleRef });
        } else {
          notes.push("boundary_source_invalid");
        }
      }
      const krMetricToId = new Map(krs.map((kr) => [kr.metric.toLowerCase(), kr.id]));
      const seen = new Set<string>();
      for (const item of Array.isArray(raw.strategies) ? raw.strategies : []) {
        if (!isRecord(item)) continue;
        const id = idOf(item.id);
        const hypothesis = str(item.hypothesis);
        if (!id || seen.has(id) || !hypothesis) { notes.push("strategy_invalid_dropped"); continue; }
        seen.add(id);
        const serves = (Array.isArray(item.serves_krs) ? item.serves_krs : [])
          .map((ref) => str(ref, GOAL_SHAPE_LIMITS.shortText))
          .map((ref) => krIds.has(ref) ? ref : krMetricToId.get(ref.toLowerCase()) ?? (krIds.has(slug(ref)) ? slug(ref) : ""))
          .filter((ref): ref is string => Boolean(ref) && krIds.has(ref));
        const budget = isRecord(item.budget) ? item.budget : {};
        const perDay = finiteOrNull(budget.actions_per_day ?? item.actions_per_day);
        strategies.push({ id, hypothesis, serves_krs: [...new Set(serves)], kpi: str(item.kpi, GOAL_SHAPE_LIMITS.shortText),
          actions_per_day: perDay !== null && perDay > 0 ? Math.min(1_000, Math.round(perDay)) : null,
          timebox_hours: clampHours(item.timebox_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours),
          observation_window_hours: clampHours(item.observation_window_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours),
          priority: strategies.length });
      }
      if (strategies.length > GOAL_SHAPE_LIMITS.strategies) notes.push("strategies_capped");
      strategies = strategies.slice(0, GOAL_SHAPE_LIMITS.strategies);
      const strategyIds = new Set(strategies.map((strategy) => strategy.id));
      // R4: 트리 안의 전술은 존재하는 전략을 인용해야 한다. 인용 없는 전술은 트리에 들어오지 않는다(버림).
      // 인용한 전술이 하나도 없으면 트리가 아니다 — 목록으로 강등하고 전술은 보존한다.
      // 실측 2026-09-24(1만 달러): 전술 8개 중 교차 추적 전술 1개만 전략이 없었는데 트리 전체를 버렸다 — 과한 강등.
      const orphan = tactics.filter((tactic) => !tactic.strategy_id || !strategyIds.has(tactic.strategy_id));
      if (!strategies.length || orphan.length === tactics.length) {
        notes.push(!strategies.length ? "tree_downgraded_no_strategy" : "tree_downgraded_no_tactic_cites_a_strategy");
        shape = "tactic_list";
        strategies = [];
      } else {
        if (orphan.length) {
          notes.push(`tactic_without_strategy_dropped:${orphan.map((t) => t.id).join(",")}`);
          const drop = new Set(orphan.map((t) => t.id));
          tactics.splice(0, tactics.length, ...tactics.filter((t) => !drop.has(t.id)));
        }
        const cited = new Set(tactics.map((tactic) => tactic.strategy_id));
        const empty = strategies.filter((strategy) => !cited.has(strategy.id));
        if (empty.length) notes.push(`strategy_without_tactic_dropped:${empty.map((s) => s.id).join(",")}`);
        strategies = strategies.filter((strategy) => cited.has(strategy.id)).map((strategy, index) => ({ ...strategy, priority: index }));
        mission = { objective, diagnosis, key_results: krs.slice(0, GOAL_SHAPE_LIMITS.keyResults),
          boundaries: boundaries.slice(0, GOAL_SHAPE_LIMITS.boundaries) };
        const review = finiteOrNull(raw.review_every_hours);
        reviewEveryHours = review === null ? GOAL_SHAPE_LIMITS.defaultReviewHours
          : Math.min(GOAL_SHAPE_LIMITS.maxReviewHours, Math.max(GOAL_SHAPE_LIMITS.minReviewHours, Math.round(review)));
      }
    }
  }
  if (shape !== "mission_tree") {
    if (raw.mission || (Array.isArray(raw.strategies) && raw.strategies.length && declared !== "mission_tree")) notes.push("non_tree_mission_or_strategies_ignored");
    for (const tactic of tactics) tactic.strategy_id = null;
    if (shape === "single_tactic" && tactics.length > 1) { notes.push("single_with_many_tactics_recorded_as_list"); shape = "tactic_list"; }
    if (shape === "tactic_list" && tactics.length === 1) { notes.push("list_with_one_tactic_recorded_as_single"); shape = "single_tactic"; }
  }
  if (NATURE_SHAPE[nature] !== shape) notes.push(`nature_shape_mismatch:${nature}->${shape}`);
  return { ok: true, notes, plan: {
    schemaVersion: GOAL_SHAPE_SCHEMA, shape, problem_nature: nature, rationale,
    mission, strategies, tactics, review_every_hours: shape === "mission_tree" ? reviewEveryHours : null,
  } };
}

/** 판단 실패 시의 결정적 폴백: 목표 전체를 하나의 전술로. 다음 턴 시작에 다시 판단한다(목표를 막지 않는다). */
export function fallbackGoalShape(objective: string): GoalShapePlan {
  return {
    schemaVersion: GOAL_SHAPE_SCHEMA,
    shape: "single_tactic",
    problem_nature: "clear",
    rationale: "Host fallback: the shape judgment was unavailable, so the whole goal is one tactic until it is re-judged.",
    mission: null,
    strategies: [],
    tactics: [{ id: "t1", strategy_id: null, description: str(objective) || "Complete the goal.",
      done_when: "Every acceptance criterion of the goal is met with evidence.", kind: "one_off" }],
    review_every_hours: null,
  };
}

// ── 살아 있는 계획(저장소 읽기 모델) ─────────────────────────────────────────

export type PlanNodeStatus = "proposed" | "active" | "done" | "retired";

export interface LiveTactic extends GoalTactic {
  status: PlanNodeStatus;
  ord: number;
  runs: number;
  failures: number;
  evidence: string | null;
  /** 지속 정책이 고른 다음 수의 안내(없으면 null). */
  guidance: { move: string; cause: string; at: string | null; boundary: string | null } | null;
  /** retry_backoff 로 미룬 시각. 이 전에는 다른 전술이 있으면 고르지 않는다. */
  deferredUntil: string | null;
}

export interface LiveStrategy extends GoalStrategy {
  status: PlanNodeStatus;
  activatedAt: string;
}

export interface LiveGoalPlan {
  goalId: string;
  revision: number;
  planSeq: number;
  shape: GoalShapeKind;
  problem_nature: ProblemNature;
  rationale: string;
  fallback: boolean;
  mission: GoalMission | null;
  strategies: LiveStrategy[];
  tactics: LiveTactic[];
  review_every_hours: number | null;
  createdAt: string;
}

/** 트리에서 처음 활성으로 두는 전략 수(나머지는 proposed — 리뷰가 올린다). */
export const INITIAL_ACTIVE_STRATEGIES = 3;

/**
 * 다음에 실행할 전술을 고른다.
 * 단일=그 전술, 목록=순서상 첫 미완, 트리=활성 전략마다 첫 미완(우선순위 순, 오늘 예산을 다 쓴 전략은 건너뜀).
 * 미룬(deferred) 전술은 다른 후보가 있으면 뒤로 간다. 경계 대기 전술도 마찬가지.
 */
export function selectActiveTactics(plan: LiveGoalPlan, input: { nowMs: number; dispatchesToday?: Readonly<Record<string, number>>; limit?: number }): LiveTactic[] {
  const limit = Math.max(1, input.limit ?? 2);
  const open = (tactic: LiveTactic) => tactic.status === "active" || tactic.status === "proposed";
  const waiting = (tactic: LiveTactic) => Boolean(
    (tactic.deferredUntil && Date.parse(tactic.deferredUntil) > input.nowMs) || tactic.guidance?.move === "escalate_boundary");
  const ordered = [...plan.tactics].filter(open).sort((a, b) => a.ord - b.ord);
  const rank = (candidates: LiveTactic[]) => [...candidates.filter((t) => !waiting(t)), ...candidates.filter(waiting)];
  if (plan.shape === "single_tactic") return rank(ordered).slice(0, 1);
  if (plan.shape === "tactic_list") return rank(ordered).slice(0, 1);
  const picks: LiveTactic[] = [];
  const strategies = plan.strategies.filter((s) => s.status === "active").sort((a, b) => a.priority - b.priority);
  for (const strategy of strategies) {
    const used = input.dispatchesToday?.[strategy.id] ?? 0;
    if (strategy.actions_per_day !== null && used >= strategy.actions_per_day) continue;
    const first = rank(ordered.filter((tactic) => tactic.strategy_id === strategy.id))[0];
    if (first) picks.push(first);
  }
  return rank(picks).slice(0, limit);
}

// ── 표식(산문 파싱 아님) ─────────────────────────────────────────────────────

export const TACTIC_MARKER = "<<agentlas-tactic>>";
export const PLAN_OP_MARKER = "<<agentlas-plan-op>>";

export const TACTIC_BLOCK_CAUSES = ["tool_missing", "tool_refused", "resource_busy", "effect_uncertain", "self_hold", "unknown", "boundary"] as const;
export type TacticBlockCause = (typeof TACTIC_BLOCK_CAUSES)[number];

export interface TacticMarker { id: string; status: "done" | "blocked"; evidence: string; cause: TacticBlockCause; boundary: string | null }
export type PlanOp =
  | { op: "replace_tactic"; id: string; with: Array<Pick<GoalTactic, "description" | "done_when" | "kind">> }
  | { op: "add_tactic"; strategy_id: string | null; description: string; done_when: string; kind: GoalTactic["kind"] }
  | { op: "retire_strategy"; id: string; evidence: string }
  | { op: "add_strategy"; hypothesis: string; serves_krs: string[]; kpi: string; timebox_hours: number; observation_window_hours: number;
      actions_per_day: number | null; tactics: Array<Pick<GoalTactic, "description" | "done_when" | "kind">> };

function parseMarkerJson(line: string): Record<string, unknown> | null {
  try { const value = JSON.parse(line); return isRecord(value) ? value : null; } catch { return null; }
}

function tacticDraft(value: unknown): Pick<GoalTactic, "description" | "done_when" | "kind"> | null {
  if (!isRecord(value)) return null;
  const description = str(value.description);
  const doneWhen = str(value.done_when);
  return description && doneWhen ? { description, done_when: doneWhen, kind: value.kind === "recurring" ? "recurring" : "one_off" } : null;
}

function planOpOf(raw: Record<string, unknown>): PlanOp | null {
  switch (raw.op) {
    case "replace_tactic": {
      const drafts = (Array.isArray(raw.with) ? raw.with : []).map(tacticDraft).filter((d): d is NonNullable<typeof d> => Boolean(d));
      return idOf(raw.id) && drafts.length ? { op: "replace_tactic", id: idOf(raw.id), with: drafts.slice(0, 6) } : null;
    }
    case "add_tactic": {
      const draft = tacticDraft(raw);
      return draft ? { op: "add_tactic", strategy_id: idOf(raw.strategy_id) || null, ...draft } : null;
    }
    case "retire_strategy":
      return idOf(raw.id) ? { op: "retire_strategy", id: idOf(raw.id), evidence: str(raw.evidence) } : null;
    case "add_strategy": {
      const drafts = (Array.isArray(raw.tactics) ? raw.tactics : []).map(tacticDraft).filter((d): d is NonNullable<typeof d> => Boolean(d));
      const hypothesis = str(raw.hypothesis);
      const perDay = finiteOrNull(raw.actions_per_day);
      return hypothesis && drafts.length ? { op: "add_strategy", hypothesis, kpi: str(raw.kpi, GOAL_SHAPE_LIMITS.shortText),
        serves_krs: (Array.isArray(raw.serves_krs) ? raw.serves_krs : []).map((v) => str(v, 60)).filter(Boolean),
        timebox_hours: clampHours(raw.timebox_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours),
        observation_window_hours: clampHours(raw.observation_window_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours),
        actions_per_day: perDay !== null && perDay > 0 ? Math.round(perDay) : null, tactics: drafts.slice(0, 6) } : null;
    }
    default: return null;
  }
}

/** 본문에서 전술·계획 표식을 떼어 낸다. 표식은 한 줄에 JSON 하나. 모양이 틀린 표식도 본문에서는 지운다. */
export function extractGoalPlanMarkers(text: string): { text: string; tactics: TacticMarker[]; ops: PlanOp[]; malformed: number } {
  const tactics: TacticMarker[] = [];
  const ops: PlanOp[] = [];
  let malformed = 0;
  const kept: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const tacticAt = line.indexOf(TACTIC_MARKER);
    const opAt = line.indexOf(PLAN_OP_MARKER);
    if (tacticAt < 0 && opAt < 0) { kept.push(line); continue; }
    const isTactic = tacticAt >= 0 && (opAt < 0 || tacticAt < opAt);
    const at = isTactic ? tacticAt : opAt;
    const before = line.slice(0, at).trimEnd();
    const json = line.slice(at + (isTactic ? TACTIC_MARKER : PLAN_OP_MARKER).length).trim();
    const raw = parseMarkerJson(json);
    if (before) kept.push(before);
    if (!raw) { malformed += 1; continue; }
    if (isTactic) {
      const id = idOf(raw.id);
      const status = raw.status === "done" || raw.status === "blocked" ? raw.status : null;
      if (!id || !status) { malformed += 1; continue; }
      const cause = TACTIC_BLOCK_CAUSES.includes(raw.cause as TacticBlockCause) ? raw.cause as TacticBlockCause : "unknown";
      tactics.push({ id, status, evidence: str(raw.evidence), cause, boundary: str(raw.boundary, 40) || null });
    } else {
      const op = planOpOf(raw);
      if (op) ops.push(op); else malformed += 1;
    }
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), tactics, ops, malformed };
}

export function stripGoalPlanMarkers(text: string): string {
  return extractGoalPlanMarkers(text).text;
}

/**
 * 계획 연산을 검증한다(적용은 저장소가 한다). 거절 사유는 유한 코드.
 * 트리의 전략 접기는 관찰 기간(timebox) 전에는 금지(뒤집기 방지), 근거 필수. 전략 추가는 KR 인용·상한 6.
 */
export function checkPlanOp(plan: LiveGoalPlan, op: PlanOp, nowMs: number): { ok: true } | { ok: false; reason: string } {
  const openTactics = plan.tactics.filter((t) => t.status === "active" || t.status === "proposed");
  switch (op.op) {
    case "replace_tactic": {
      const target = plan.tactics.find((t) => t.id === op.id);
      if (!target) return { ok: false, reason: "tactic_not_found" };
      if (target.status === "done" || target.status === "retired") return { ok: false, reason: "tactic_not_open" };
      if (openTactics.length - 1 + op.with.length > GOAL_SHAPE_LIMITS.tactics) return { ok: false, reason: "tactic_cap" };
      return { ok: true };
    }
    case "add_tactic": {
      if (openTactics.length + 1 > GOAL_SHAPE_LIMITS.tactics) return { ok: false, reason: "tactic_cap" };
      if (plan.shape === "mission_tree") {
        const strategy = plan.strategies.find((s) => s.id === op.strategy_id);
        if (!strategy || strategy.status === "retired") return { ok: false, reason: "tactic_must_cite_live_strategy" };
      }
      return { ok: true };
    }
    case "retire_strategy": {
      if (plan.shape !== "mission_tree") return { ok: false, reason: "not_a_tree" };
      const strategy = plan.strategies.find((s) => s.id === op.id);
      if (!strategy || strategy.status === "retired") return { ok: false, reason: "strategy_not_found" };
      if (!op.evidence) return { ok: false, reason: "evidence_required" };
      if (Date.parse(strategy.activatedAt) + strategy.timebox_hours * 3_600_000 > nowMs) return { ok: false, reason: "timebox_not_elapsed" };
      if (plan.strategies.filter((s) => s.status === "active" && s.id !== op.id).length === 0) return { ok: false, reason: "last_active_strategy" };
      return { ok: true };
    }
    case "add_strategy": {
      if (plan.shape !== "mission_tree") return { ok: false, reason: "not_a_tree" };
      if (plan.strategies.filter((s) => s.status !== "retired").length + 1 > GOAL_SHAPE_LIMITS.strategies) return { ok: false, reason: "strategy_cap" };
      const krIds = new Set((plan.mission?.key_results ?? []).map((kr) => kr.id));
      if (krIds.size && !op.serves_krs.some((ref) => krIds.has(ref))) return { ok: false, reason: "strategy_must_cite_kr" };
      if (openTactics.length + op.tactics.length > GOAL_SHAPE_LIMITS.tactics) return { ok: false, reason: "tactic_cap" };
      return { ok: true };
    }
  }
}

/** 화면용 요약(IPC 로 나가는 읽기 모델 — 산문 요약 없음). */
export interface GoalPlanView {
  shape: LiveGoalPlan["shape"];
  problemNature: LiveGoalPlan["problem_nature"];
  fallback: boolean;
  revision: number;
  planSeq: number;
  currentTactic: { id: string; description: string; strategyId: string | null } | null;
  mission: { objective: string; keyResults: Array<{ metric: string; target: number; unit: string; requiredPerDay: number | null; daysLeft: number | null; sensor: string }> } | null;
  strategies: Array<{ id: string; hypothesis: string; status: string; tactics: Array<{ id: string; description: string; status: string }> }>;
  tactics: Array<{ id: string; description: string; status: string }>;
}
