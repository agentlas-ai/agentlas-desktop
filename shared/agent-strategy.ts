/**
 * Agent Strategy v1 — KPI 상태가 바뀌면 전략을 다시 짠다 (설계: output/agent-strategy-20261010/DESIGN.md).
 *
 * 이미 있는 "대계(mission) → 전략 → 전술" 트리(shared/goal-shape.ts)에 꽂는 순수 계산기다.
 *  - 센서는 호스트가 소유한다: 호스트가 검증·저장한 표본만 상태 계산에 쓴다(산문 "좋아졌다"는 입력이 아니다).
 *  - 상태가 시간을 이긴다: 재계획은 KPI 상태 전이 때 발화한다. 시간 기반 검토는 백스톱으로 남는다.
 *  - 선언형 표: 상태 경계·히스테리시스·한도는 아래 상수 표에서 파생한다(분기문 땜질 금지).
 *  - 센서 없음/표본 부족은 인프라 상태(no_data)이지 전략 실패가 아니다.
 *
 * 순수 모듈 — DB·시계·런타임·난수 없음. Memory Sphere(기억 쓰기)와 무관하다: 목표 원장 곁 테이블만 쓴다.
 */
import { GOAL_SHAPE_LIMITS } from "./goal-shape";

export const STRATEGY_SHIFT_SCHEMA = "agentlas.strategy-shift.v1" as const;
export const KPI_MARKER = "<<agentlas-kpi>>";
export const STRATEGY_SHIFT_MARKER = "<<agentlas-strategy-shift>>";

export const KPI_STATES = ["no_data", "ahead", "on_pace", "behind", "stalled", "breakout", "declining"] as const;
export type KpiState = (typeof KPI_STATES)[number];
export type AgentStrategyMode = "on" | "shadow" | "off";

/** AGENTLAS_AGENT_STRATEGY=on|shadow|off. 기본은 on(오너 결정 2026-10-10), 알 수 없는 값도 on. */
export function resolveAgentStrategyMode(raw: string | null | undefined): AgentStrategyMode {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "off" || value === "shadow" ? value : "on";
}

/** 한도·창·임계값 — 보정은 이 표 한 곳에서만 한다(가설 값: Thread 1건으로 보정, 섀도 운영 뒤 조정). */
export const AGENT_STRATEGY_LIMITS = {
  minSamples: 3,
  defaultWindowHours: 72,
  /** 단창 = max(floor, 장창/divisor). 표본이 하루 1개 수준이라 SRE의 1/12 대신 1/3. */
  shortWindowFloorHours: 24,
  shortWindowDivisor: 3,
  /** 단창이 되려면 표본 두 개 사이가 이만큼은 벌어져야 한다(몇 분 간격 기울기는 잡음). */
  minShortSpanHours: 6,
  /** 장창 안 표본의 시간 폭이 W_L 의 이 비율 미만이면 no_data. */
  minWindowCoverage: 0.5,
  /** 표본이 드물면 장창을 늘려 minSamples 개를 담되 이 길이를 넘기지 않는다. */
  maxWindowHours: 336,
  confirmations: 2,
  cooldownFloorHours: 48,
  /** 같은 상태로 다시 발화할 때의 쿨다운 배수. */
  repeatCooldownMultiplier: 2,
  triggerBudgetPerDay: 1,
  shiftBudgetPer7Days: 3,
  /** 필요 속도/관측 속도가 이 배수 이상이면 전략 교체가 아니라 오너 보고. */
  infeasibleRatio: 10,
  maxStructuralChanges: 2,
  maxResubmits: 2,
  triggerExpiryHours: 72,
  lowEvidenceSamples: 3,
  lowEvidenceConfidenceCap: 4,
  maxTrackedKpis: 6,
  valueCeilingMultiple: 10,
  suspectRelativeJump: 0.5,
  suspectMinAbsJump: 5,
  noiseFractionPerDay: 0.01,
  integerNoisePerDay: 0.25,
  evidenceMaxChars: 300,
  textMaxChars: 300,
  minDistinctRunsToFire: 2,
} as const;

/** ρ = vLong / required. [lo, hi) 구간 — enter 로 들어오고 stay 안에 있는 동안 머문다(슈미트 트리거). */
export const KPI_BANDS: Readonly<Record<"stalled" | "behind" | "on_pace" | "ahead", { enter: readonly [number, number]; stay: readonly [number, number] }>> = {
  stalled: { enter: [-Infinity, 0.3], stay: [-Infinity, 0.5] },
  behind: { enter: [0.3, 0.8], stay: [0.2, 0.9] },
  on_pace: { enter: [0.8, 1.25], stay: [0.6, 1.4] },
  ahead: { enter: [1.25, Infinity], stay: [1.0, Infinity] },
};
/** breakout: 단창 기울기가 직전 장창의 accel 배 이상(진입)/ stayAccel 배 미만이면 해제. */
export const KPI_BREAKOUT = { accel: 2, ofRequired: 0.8, stayAccel: 1.3 } as const;
/** 목표값 없는 추적 KPI: |v| < enter 면 stalled, stay 배수까지 머문다. */
export const KPI_TRACKED_STALL = { enterEpsilons: 1, stayEpsilons: 1.5 } as const;

/** 발화 대상 상태. on_pace/ahead 로의 전이는 기록만 하고 흔들지 않는다. */
export const KPI_FIRE_STATES: readonly KpiState[] = ["stalled", "declining", "behind", "breakout"];
const BAD_GROUP: readonly KpiState[] = ["behind", "stalled", "declining"];

export interface KpiSample {
  id: string;
  value: number;
  observedAt: string;
  runId?: string | null;
  evidence?: string;
}

export interface KpiSpec {
  target: number | null;
  baseline: number | null;
  deadlineAt: string | null;
  direction: "up" | "down";
  minSamples?: number;
  cadenceHours?: number;
}

export interface KpiMetrics {
  status: KpiState;
  /** 두 창이 같은 쪽(좋음/나쁨)을 가리키는가. false 면 전이를 인정하지 않는다. */
  agree: boolean;
  samples: number;
  latestSampleId: string | null;
  current: number | null;
  vLong: number | null;
  vShort: number | null;
  vPrev: number | null;
  requiredPerDay: number | null;
  remaining: number | null;
  daysLeft: number | null;
  rho: number | null;
  /** 필요 속도 / 관측 속도. 관측이 노이즈 이하이면 Infinity(= 도달 불가). 목표 없으면 null. */
  requiredOverObserved: number | null;
  infeasible: boolean;
  achieved: boolean;
  deadlinePassed: boolean;
  stale: boolean;
  distinctRuns: number;
  longWindowHours: number;
  reason: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const round2 = (value: number | null): number | null => value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const inRange = (value: number, [lo, hi]: readonly [number, number]): boolean => value >= lo && value < hi;

// ── 시크릿 스크럽 (electron/automation-strategy.ts normalizeFailureText 와 같은 규칙 — 순수 모듈이라 복제) ──
const SECRET_REDACT_RE = /(?:(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}|(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*\S+|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY|Bearer\s+[A-Za-z0-9._~-]{12,})/gi;
const URL_REDACT_RE = /https?:\/\/([^\s/?#]+)[^\s]*/gi;

/** 사람이 읽는 짧은 글(근거·진단)에서 시크릿과 URL 세부(경로·쿼리)를 지운다. */
export function scrubStrategyText(raw: unknown, max: number = AGENT_STRATEGY_LIMITS.textMaxChars): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ")
    .replace(SECRET_REDACT_RE, "[redacted]")
    .replace(URL_REDACT_RE, (_m, host: string) => `<url:${host}>`)
    .trim().slice(0, max);
}

// ── 순수 통계 ────────────────────────────────────────────────────────────────

/** 최소제곱 기울기(값/일). 표본 2개 미만이거나 시간 폭이 0 이면 null. */
export function slopePerDay(samples: ReadonlyArray<{ value: number; observedAt: string }>): number | null {
  const points = samples.map((s) => ({ t: Date.parse(s.observedAt), v: s.value })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (points.length < 2) return null;
  const t0 = points[0]!.t;
  const xs = points.map((p) => (p.t - t0) / DAY_MS);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = points.reduce((a, p) => a + p.v, 0) / points.length;
  let num = 0; let den = 0;
  points.forEach((p, i) => { num += (xs[i]! - meanX) * (p.v - meanY); den += (xs[i]! - meanX) ** 2; });
  // 1e-9 단위로 맞춘다: 부동소수 오차가 경계값(ρ=0.3 등)을 한 칸 밀어내지 않게.
  return den > 0 ? Math.round((num / den) * 1e9) / 1e9 : null;
}

/**
 * 급변 표본(evidence "suspect:" 접두)은 뒤 표본이 같은 수준을 확인해 줄 때만 계산에 넣는다 —
 * 한 번의 이상한 읽기만으로는 전이를 일으키지 않는다(설계 4.3).
 */
export function trustedKpiSamples(samples: readonly KpiSample[]): KpiSample[] {
  const sorted = [...samples].filter((s) => finiteNumber(s.value) && Number.isFinite(Date.parse(s.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return sorted.filter((s, index) => {
    if (!String(s.evidence ?? "").startsWith("suspect:")) return true;
    return sorted.slice(index + 1).some((later) => Math.abs(later.value - s.value) <= AGENT_STRATEGY_LIMITS.suspectRelativeJump * Math.max(Math.abs(s.value), 1));
  });
}

/** 새 표본이 직전 표본 대비 급변인가(저장은 하되 suspect 표시). */
export function isSuspectJump(previous: number | null, value: number): boolean {
  if (previous === null) return false;
  const jump = Math.abs(value - previous);
  return jump > AGENT_STRATEGY_LIMITS.suspectRelativeJump * Math.max(Math.abs(previous), 1) && jump >= AGENT_STRATEGY_LIMITS.suspectMinAbsJump;
}

function noiseFloor(latest: number, samples: readonly KpiSample[]): number {
  const integer = samples.length > 0 && samples.every((s) => Number.isInteger(s.value));
  return Math.max(AGENT_STRATEGY_LIMITS.noiseFractionPerDay * Math.abs(latest), integer ? AGENT_STRATEGY_LIMITS.integerNoisePerDay : 0);
}

/** ρ 구간표에서 상태를 고른다(enter), prev 가 아직 stay 안이면 prev 를 유지(히스테리시스). */
function rhoState(rho: number, prev: KpiState | null): KpiState {
  const bands = Object.entries(KPI_BANDS) as Array<[keyof typeof KPI_BANDS, (typeof KPI_BANDS)[keyof typeof KPI_BANDS]]>;
  const fresh = (bands.find(([, band]) => inRange(rho, band.enter))?.[0] ?? "ahead") as KpiState;
  if (prev && prev !== fresh && prev in KPI_BANDS && inRange(rho, KPI_BANDS[prev as keyof typeof KPI_BANDS].stay)) return prev;
  return fresh;
}

export interface KpiMetricsContext {
  nowMs: number;
  /** 활성 전략 observation_window_hours 의 최솟값(없으면 72). */
  windowHours?: number;
  /** 직전에 확정된 상태(히스테리시스 기준). */
  prevState?: KpiState | null;
}

const emptyMetrics = (status: KpiState, reason: string, extra: Partial<KpiMetrics> = {}): KpiMetrics => ({
  status, agree: true, samples: 0, latestSampleId: null, current: null, vLong: null, vShort: null, vPrev: null,
  requiredPerDay: null, remaining: null, daysLeft: null, rho: null, requiredOverObserved: null, infeasible: false,
  achieved: false, deadlinePassed: false, stale: false, distinctRuns: 0, longWindowHours: AGENT_STRATEGY_LIMITS.defaultWindowHours,
  reason, ...extra,
});

/** 표본 시계열 → 상태·속도. 부호는 direction 으로 정규화한다(down 이면 값이 줄어드는 것이 전진). */
export function computeKpiMetrics(rawSamples: readonly KpiSample[], spec: KpiSpec, ctx: KpiMetricsContext): KpiMetrics {
  const L = AGENT_STRATEGY_LIMITS;
  const sign = spec.direction === "down" ? -1 : 1;
  const minSamples = Math.max(2, spec.minSamples ?? L.minSamples);
  const windowHours = Math.max(1, ctx.windowHours ?? L.defaultWindowHours);
  const trusted = trustedKpiSamples(rawSamples).filter((s) => Date.parse(s.observedAt) <= ctx.nowMs + 5 * 60_000)
    .map((s) => ({ ...s, value: s.value * sign }));
  const latest = trusted[trusted.length - 1];
  if (!latest) return emptyMetrics("no_data", "no_samples");
  const cadence = spec.cadenceHours ?? 24;
  const stale = ctx.nowMs - Date.parse(latest.observedAt) > 2 * cadence * HOUR_MS;
  const longStart = ctx.nowMs - windowHours * HOUR_MS;
  const cap = ctx.nowMs - L.maxWindowHours * HOUR_MS;
  let longSet = trusted.filter((s) => Date.parse(s.observedAt) >= longStart);
  if (longSet.length < minSamples) longSet = trusted.filter((s) => Date.parse(s.observedAt) >= cap).slice(-minSamples);
  const base = { samples: longSet.length, latestSampleId: latest.id, current: latest.value * sign, stale,
    distinctRuns: new Set(longSet.map((s) => s.runId ?? "")).size };
  if (longSet.length < minSamples) return emptyMetrics("no_data", "too_few_samples", base);
  const span = Date.parse(longSet[longSet.length - 1]!.observedAt) - Date.parse(longSet[0]!.observedAt);
  if (span < L.minWindowCoverage * windowHours * HOUR_MS) return emptyMetrics("no_data", "window_not_covered", base);
  const longWindowHours = Math.max(windowHours, Math.ceil(span / HOUR_MS));

  const shortHours = Math.max(L.shortWindowFloorHours, windowHours / L.shortWindowDivisor);
  let shortSet = longSet.filter((s) => Date.parse(s.observedAt) >= ctx.nowMs - shortHours * HOUR_MS);
  const spanOf = (set: typeof longSet) => set.length < 2 ? 0 : Date.parse(set[set.length - 1]!.observedAt) - Date.parse(set[0]!.observedAt);
  if (shortSet.length < 2 || spanOf(shortSet) < L.minShortSpanHours * HOUR_MS) {
    // 표본이 드물면 단창을 마지막 표본들까지 넓힌다(최소 2개·최소 간격).
    shortSet = longSet.slice(-2);
    for (let n = 2; n < longSet.length && spanOf(shortSet) < L.minShortSpanHours * HOUR_MS; n += 1) shortSet = longSet.slice(-(n + 1));
  }
  const vLong = slopePerDay(longSet);
  const vShort = spanOf(shortSet) >= L.minShortSpanHours * HOUR_MS ? slopePerDay(shortSet) : vLong;
  const older = trusted.filter((s) => Date.parse(s.observedAt) < Date.parse(longSet[0]!.observedAt) && Date.parse(s.observedAt) >= ctx.nowMs - 2 * L.maxWindowHours * HOUR_MS).slice(-minSamples);
  const vPrev = older.length >= 2 ? slopePerDay(older) : null;
  if (vLong === null || vShort === null) return emptyMetrics("no_data", "slope_unavailable", { ...base, longWindowHours });

  const current = latest.value;
  const eps = noiseFloor(current, trusted);
  const deadlineMs = spec.deadlineAt ? Date.parse(spec.deadlineAt) : Number.NaN;
  const daysLeft = Number.isFinite(deadlineMs) ? (deadlineMs - ctx.nowMs) / DAY_MS : null;
  const target = spec.target === null ? null : spec.target * sign;
  const achieved = target !== null && current >= target;
  const deadlinePassed = daysLeft !== null && daysLeft <= 0;
  const remaining = target === null ? null : Math.max(0, target - current);
  const required = target !== null && daysLeft !== null && daysLeft > 0 ? remaining! / daysLeft : null;
  const rho = required !== null && required > 0 ? vLong / required : null;
  const ratio = required !== null && required > 0 ? (vLong > eps ? required / vLong : Infinity) : null;

  const classify = (v: number, prev: KpiState | null): KpiState => {
    if (achieved) return "ahead";
    if (vLong < -eps && v < -eps) return "declining";
    const stayDecline = prev === "declining" && v < 0;
    if (stayDecline) return "declining";
    const accel = vPrev === null ? false : v > eps && v >= KPI_BREAKOUT.accel * Math.max(vPrev, eps) && (required === null || v >= KPI_BREAKOUT.ofRequired * required);
    const stayBreak = prev === "breakout" && vPrev !== null && v > eps && v >= KPI_BREAKOUT.stayAccel * Math.max(vPrev, eps);
    if (accel || stayBreak) return "breakout";
    if (rho !== null && required !== null && required > 0) return rhoState(v / required, prev);
    // 목표값(또는 마감) 없는 추적 KPI: on_pace/behind 를 쓰지 않는다 — 멈춤/하락/돌파만 판정, 나머지는 움직이는 중(on_pace).
    const stall = prev === "stalled" ? KPI_TRACKED_STALL.stayEpsilons : KPI_TRACKED_STALL.enterEpsilons;
    return Math.abs(v) < stall * eps ? "stalled" : "on_pace";
  };
  const status = classify(vLong, ctx.prevState ?? null);
  const shortStatus = classify(vShort, null);
  const agree = BAD_GROUP.includes(status) === BAD_GROUP.includes(shortStatus);
  return {
    status, agree, samples: longSet.length, latestSampleId: latest.id, current: round2(current * sign), vLong: round2(vLong * sign), vShort: round2(vShort * sign),
    vPrev: vPrev === null ? null : round2(vPrev * sign), requiredPerDay: round2(required), remaining: round2(remaining), daysLeft: round2(daysLeft),
    rho: round2(rho), requiredOverObserved: ratio === null ? null : Number.isFinite(ratio) ? round2(ratio) : Infinity,
    infeasible: ratio !== null && ratio >= L.infeasibleRatio && (status === "stalled" || status === "behind"),
    achieved, deadlinePassed, stale, distinctRuns: base.distinctRuns, longWindowHours,
    reason: agree ? "ok" : "windows_disagree",
  };
}

// ── 상태 기계: 히스테리시스 + 연속 확인 + 발화 관문 ───────────────────────────

export interface KpiStateRow {
  state: KpiState;
  since: string;
  pendingState: KpiState | null;
  pendingCount: number;
  lastSampleId: string | null;
  lastFiredAt: string | null;
  /** 이번 상태 에피소드에서 이미 발화한 상태(또는 "target_infeasible"). 상태가 바뀌면 null. */
  lastFiredState: string | null;
  triggerId: string | null;
  triggerCreatedAt: string | null;
}

export const emptyKpiStateRow = (nowIso: string): KpiStateRow => ({ state: "no_data", since: nowIso, pendingState: null, pendingCount: 0,
  lastSampleId: null, lastFiredAt: null, lastFiredState: null, triggerId: null, triggerCreatedAt: null });

export interface StrategyGateContext {
  nowMs: number;
  windowHours: number;
  ownerPaused: boolean;
  /** 활성 전략의 activatedAt + observation_window_hours. 전부 아직 보호 창 안이면 발화하지 않는다. */
  activeStrategies: ReadonlyArray<{ activatedAt: string; observationWindowHours: number }>;
  firedLast24h: number;
  appliedShiftsLast7d: number;
}

export interface KpiStepResult {
  next: KpiStateRow;
  transitioned: boolean;
  from: KpiState;
  fire: { kind: "strategy_shift" | "target_infeasible" } | null;
  blockedBy: string | null;
}

export function stepKpiState(prev: KpiStateRow, metrics: KpiMetrics, gate: StrategyGateContext): KpiStepResult {
  const L = AGENT_STRATEGY_LIMITS;
  const nowIso = new Date(gate.nowMs).toISOString();
  const next: KpiStateRow = { ...prev };
  let transitioned = false;
  const isNewSample = metrics.latestSampleId !== null && metrics.latestSampleId !== prev.lastSampleId;
  if (metrics.latestSampleId) next.lastSampleId = metrics.latestSampleId;
  if (metrics.status !== "no_data" && !metrics.stale && metrics.agree) {
    if (metrics.status === prev.state) {
      next.pendingState = null; next.pendingCount = 0;
    } else if (metrics.status === prev.pendingState) {
      if (isNewSample) next.pendingCount = prev.pendingCount + 1;
    } else {
      next.pendingState = metrics.status; next.pendingCount = 1;
    }
    if (next.pendingState && next.pendingCount >= L.confirmations) {
      next.state = next.pendingState; next.since = nowIso; next.pendingState = null; next.pendingCount = 0;
      next.lastFiredState = null; transitioned = true;
    }
  } else if (metrics.status !== "no_data" && !metrics.stale && !metrics.agree) {
    next.pendingState = null; next.pendingCount = 0;
  }
  const none = (blockedBy: string | null): KpiStepResult => ({ next, transitioned, from: prev.state, fire: null, blockedBy });
  const state = next.state;
  if (!KPI_FIRE_STATES.includes(state)) return none(null);
  if (next.triggerId) return none("trigger_pending");
  if (metrics.status === "no_data" || metrics.stale) return none("no_fresh_data");
  const infeasible = metrics.infeasible && (state === "stalled" || state === "behind");
  const sameEpisode = next.lastFiredState === state || (infeasible && next.lastFiredState === "target_infeasible");
  const cooldownBase = Math.max(L.cooldownFloorHours, gate.windowHours);
  let cooldownHours = cooldownBase;
  if (sameEpisode) {
    // 같은 상태가 계속될 때는 쿨다운을 2배로 하고, 오너 보고(target_infeasible)는 상태가 바뀌기 전엔 반복하지 않는다.
    if (next.lastFiredState === "target_infeasible") return none("already_reported");
    cooldownHours = cooldownBase * L.repeatCooldownMultiplier;
  }
  if (next.lastFiredAt && gate.nowMs - Date.parse(next.lastFiredAt) < cooldownHours * HOUR_MS) return none(sameEpisode ? "episode_cooldown" : "cooldown");
  if (gate.ownerPaused) return none("owner_paused");
  const guarded = gate.activeStrategies.length > 0 && gate.activeStrategies.every((s) =>
    Date.parse(s.activatedAt) + s.observationWindowHours * HOUR_MS > gate.nowMs);
  if (guarded) return none("protection_window");
  if (gate.firedLast24h >= L.triggerBudgetPerDay) return none("daily_budget");
  if (!infeasible && gate.appliedShiftsLast7d >= L.shiftBudgetPer7Days) return none("weekly_shift_budget");
  if (metrics.distinctRuns < L.minDistinctRunsToFire) return none("single_run_evidence");
  return { next, transitioned, from: prev.state, fire: { kind: infeasible ? "target_infeasible" : "strategy_shift" }, blockedBy: null };
}

/** 발화한 행을 만든다(트리거 id·시각 기록). */
export function withFiredTrigger(row: KpiStateRow, kind: "strategy_shift" | "target_infeasible", triggerId: string, nowIso: string): KpiStateRow {
  return { ...row, triggerId, triggerCreatedAt: nowIso, lastFiredAt: nowIso, lastFiredState: kind === "target_infeasible" ? "target_infeasible" : row.state };
}

/** 대기 트리거가 너무 오래 응답을 못 받았는가(3일). */
export function triggerExpired(row: Pick<KpiStateRow, "triggerId" | "triggerCreatedAt">, nowMs: number): boolean {
  return Boolean(row.triggerId) && Date.parse(row.triggerCreatedAt ?? "") + AGENT_STRATEGY_LIMITS.triggerExpiryHours * HOUR_MS <= nowMs;
}

// ── 표본 표식 ────────────────────────────────────────────────────────────────

export interface KpiMarker {
  kpi: string;
  value: number;
  observedAt: string | null;
  source: string;
  evidence: string;
  /** 모르는 kpi id 이고 name 이 있으면 목표값 없는 추적 KPI 를 선언한다(오너 숫자 없는 목표용). */
  define: { name: string; unit: string; direction: "up" | "down" } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clip = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const kpiIdOf = (value: unknown): string => {
  const raw = clip(value, 40).toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,39}$/.test(raw) ? raw : "";
};
const idOf = (value: unknown): string => {
  const raw = clip(value, 40);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(raw) ? raw : "";
};
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;

function parseKpiMarker(raw: Record<string, unknown>): KpiMarker | null {
  const kpi = kpiIdOf(raw.kpi);
  const value = num(raw.value);
  if (!kpi || value === null) return null;
  const name = clip(raw.name, 80);
  return { kpi, value, observedAt: clip(raw.observed_at, 40) || null, source: scrubStrategyText(raw.source, 80),
    evidence: scrubStrategyText(raw.evidence, AGENT_STRATEGY_LIMITS.evidenceMaxChars),
    define: name ? { name, unit: clip(raw.unit, 40), direction: raw.direction === "down" ? "down" : "up" } : null };
}

export interface ShiftAddStrategy {
  hypothesis: string;
  serves_krs: string[];
  kpi: string;
  expected_delta: string;
  kill_if: string;
  ice: { impact: number; confidence: number; ease: number };
  timebox_hours: number;
  observation_window_hours: number;
  tactics: Array<{ description: string; done_when: string; kind: "one_off" | "recurring" }>;
}
export const SHIFT_DECISIONS = ["hold", "pivot", "double_down", "escalate_owner"] as const;
export type ShiftDecision = (typeof SHIFT_DECISIONS)[number];
export interface StrategyShiftMarker {
  schema: typeof STRATEGY_SHIFT_SCHEMA;
  trigger_id: string;
  diagnosis: string;
  decision: ShiftDecision;
  evidence_refs: string[];
  retire: Array<{ id: string; evidence: string }>;
  add: ShiftAddStrategy[];
  reason_ko: string;
}

const hours = (value: unknown, fallback: number): number => {
  const n = num(value);
  return n === null ? fallback : Math.min(GOAL_SHAPE_LIMITS.maxReviewHours * 4, Math.max(GOAL_SHAPE_LIMITS.minReviewHours, Math.round(n)));
};

/** 구조 파싱(의미 검증은 validateStrategyShift). 틀리면 null. */
export function parseStrategyShift(raw: unknown): StrategyShiftMarker | null {
  if (!isRecord(raw) || raw.schema !== STRATEGY_SHIFT_SCHEMA) return null;
  const decision = SHIFT_DECISIONS.find((d) => d === raw.decision);
  const triggerId = clip(raw.trigger_id, 80);
  if (!decision || !triggerId) return null;
  const retire = (Array.isArray(raw.retire) ? raw.retire : []).filter(isRecord).slice(0, 6)
    .map((item) => ({ id: idOf(item.id), evidence: scrubStrategyText(item.evidence, GOAL_SHAPE_LIMITS.text) })).filter((item) => item.id);
  const add: ShiftAddStrategy[] = (Array.isArray(raw.add) ? raw.add : []).filter(isRecord).slice(0, 6).map((item) => {
    const ice = isRecord(item.ice) ? item.ice : {};
    const score = (value: unknown) => Math.min(10, Math.max(1, Math.round(num(value) ?? 1)));
    const tactics = (Array.isArray(item.tactics) ? item.tactics : []).filter(isRecord).slice(0, 6).map((t) => ({
      description: scrubStrategyText(t.description, GOAL_SHAPE_LIMITS.text), done_when: scrubStrategyText(t.done_when, GOAL_SHAPE_LIMITS.text),
      kind: t.kind === "recurring" ? "recurring" as const : "one_off" as const })).filter((t) => t.description && t.done_when);
    return { hypothesis: scrubStrategyText(item.hypothesis, GOAL_SHAPE_LIMITS.text), serves_krs: (Array.isArray(item.serves_krs) ? item.serves_krs : []).map((v) => clip(v, 60)).filter(Boolean),
      kpi: scrubStrategyText(item.kpi, GOAL_SHAPE_LIMITS.shortText), expected_delta: scrubStrategyText(item.expected_delta, GOAL_SHAPE_LIMITS.shortText),
      kill_if: scrubStrategyText(item.kill_if, GOAL_SHAPE_LIMITS.shortText),
      ice: { impact: score(ice.impact), confidence: score(ice.confidence), ease: score(ice.ease) },
      timebox_hours: hours(item.timebox_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours),
      observation_window_hours: hours(item.observation_window_hours, GOAL_SHAPE_LIMITS.defaultTimeboxHours), tactics };
  });
  return { schema: STRATEGY_SHIFT_SCHEMA, trigger_id: triggerId, diagnosis: scrubStrategyText(raw.diagnosis), decision,
    evidence_refs: (Array.isArray(raw.evidence_refs) ? raw.evidence_refs : []).map((v) => clip(v, 80)).filter(Boolean).slice(0, 20),
    retire, add, reason_ko: scrubStrategyText(raw.reason_ko, GOAL_SHAPE_LIMITS.shortText) };
}

/** 본문에서 KPI·전략 변경 표식을 떼어 낸다. 표식은 한 줄에 JSON 하나, 틀린 표식도 본문에서는 지운다. */
export function extractAgentStrategyMarkers(text: string): { text: string; kpis: KpiMarker[]; shifts: StrategyShiftMarker[]; malformed: number } {
  const kpis: KpiMarker[] = []; const shifts: StrategyShiftMarker[] = [];
  let malformed = 0;
  const kept: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const kpiAt = line.indexOf(KPI_MARKER);
    const shiftAt = line.indexOf(STRATEGY_SHIFT_MARKER);
    if (kpiAt < 0 && shiftAt < 0) { kept.push(line); continue; }
    const isKpi = kpiAt >= 0 && (shiftAt < 0 || kpiAt < shiftAt);
    const at = isKpi ? kpiAt : shiftAt;
    const before = line.slice(0, at).trimEnd();
    if (before) kept.push(before);
    let raw: unknown = null;
    try { raw = JSON.parse(line.slice(at + (isKpi ? KPI_MARKER : STRATEGY_SHIFT_MARKER).length).trim()); } catch { raw = null; }
    if (isKpi) {
      const marker = isRecord(raw) ? parseKpiMarker(raw) : null;
      if (marker) kpis.push(marker); else malformed += 1;
    } else {
      const shift = parseStrategyShift(raw);
      if (shift) shifts.push(shift); else malformed += 1;
    }
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), kpis, shifts, malformed };
}

// ── 표본 검증 ────────────────────────────────────────────────────────────────

export interface KpiSampleCheckContext {
  nowMs: number;
  target: number | null;
  baseline: number | null;
  recent: ReadonlyArray<{ value: number; observedAt: string }>;
}
export type KpiSampleCheck =
  | { ok: true; value: number; observedAt: string; evidence: string; suspect: boolean }
  | { ok: false; reason: "value_invalid" | "value_out_of_range" | "observed_at_invalid" | "observed_in_future" | "evidence_required" | "duplicate_observation" | "duplicate_same_day" };

export function checkKpiSample(marker: KpiMarker, ctx: KpiSampleCheckContext): KpiSampleCheck {
  if (!finiteNumber(marker.value)) return { ok: false, reason: "value_invalid" };
  const observedMs = marker.observedAt === null ? ctx.nowMs : Date.parse(marker.observedAt);
  if (!Number.isFinite(observedMs)) return { ok: false, reason: "observed_at_invalid" };
  if (observedMs > ctx.nowMs + 5 * 60_000) return { ok: false, reason: "observed_in_future" };
  const evidence = scrubStrategyText(marker.evidence, AGENT_STRATEGY_LIMITS.evidenceMaxChars);
  if (!evidence) return { ok: false, reason: "evidence_required" };
  // 비교할 기준(목표·기준선·이전 표본)이 하나도 없는 첫 표본은 상한이 없다 — 첫 값이 얼마든 받는다.
  const references = [ctx.target, ctx.baseline, ...ctx.recent.map((s) => s.value)].filter((v): v is number => finiteNumber(v)).map(Math.abs);
  const ceiling = references.length ? AGENT_STRATEGY_LIMITS.valueCeilingMultiple * Math.max(1, ...references) : Infinity;
  if (marker.value < 0 || marker.value > ceiling) return { ok: false, reason: "value_out_of_range" };
  const observedAt = new Date(observedMs).toISOString();
  if (ctx.recent.some((s) => Date.parse(s.observedAt) === observedMs)) return { ok: false, reason: "duplicate_observation" };
  const day = observedAt.slice(0, 10);
  if (ctx.recent.some((s) => s.observedAt.slice(0, 10) === day && s.value === marker.value)) return { ok: false, reason: "duplicate_same_day" };
  const before = [...ctx.recent].filter((s) => Date.parse(s.observedAt) < observedMs).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  const suspect = isSuspectJump(before ? before.value : null, marker.value);
  return { ok: true, value: marker.value, observedAt, evidence: suspect ? `suspect: ${evidence}`.slice(0, AGENT_STRATEGY_LIMITS.evidenceMaxChars) : evidence, suspect };
}

// ── 전략 변경 검증 ───────────────────────────────────────────────────────────

export interface StrategyShiftContext {
  nowMs: number;
  trigger: { id: string; kind: "strategy_shift" | "target_infeasible"; kpiId: string } | null;
  sampleIds: ReadonlySet<string>;
  strategies: ReadonlyArray<{ id: string; status: string; activatedAt: string; observationWindowHours: number; openTactics: number }>;
  krIds: ReadonlySet<string>;
  openTactics: number;
  appliedShiftsLast7d: number;
}
export type StrategyShiftCheck =
  | { ok: true; shift: StrategyShiftMarker; iceScores: number[]; retiredOpenTactics: number; addedTactics: number }
  | { ok: false; reason: string };

/** 호스트 검증(순수). 거절 사유는 유한 코드. 통과한 것만 원자 적용으로 간다. */
export function validateStrategyShift(shift: StrategyShiftMarker, ctx: StrategyShiftContext): StrategyShiftCheck {
  const L = AGENT_STRATEGY_LIMITS;
  const fail = (reason: string): StrategyShiftCheck => ({ ok: false, reason });
  if (!ctx.trigger || ctx.trigger.id !== shift.trigger_id) return fail("trigger_mismatch");
  if (!shift.diagnosis) return fail("diagnosis_required");
  if (shift.evidence_refs.some((ref) => !ctx.sampleIds.has(ref))) return fail("evidence_unknown");
  const changes = shift.retire.length + shift.add.length;
  if (shift.decision !== "hold" && shift.evidence_refs.length === 0) return fail("evidence_required");
  if (shift.decision !== "pivot") {
    if (changes) return fail("changes_not_allowed_for_decision");
    return { ok: true, shift, iceScores: [], retiredOpenTactics: 0, addedTactics: 0 };
  }
  if (ctx.trigger.kind === "target_infeasible") return fail("pivot_not_allowed_when_infeasible");
  if (!shift.reason_ko) return fail("reason_required");
  if (!changes) return fail("nothing_to_change");
  if (changes > L.maxStructuralChanges) return fail("too_many_changes");
  if (ctx.appliedShiftsLast7d >= L.shiftBudgetPer7Days) return fail("shift_budget");
  const retiring = new Set<string>();
  let retiredOpenTactics = 0;
  for (const item of shift.retire) {
    const strategy = ctx.strategies.find((s) => s.id === item.id);
    if (!strategy || strategy.status !== "active" || retiring.has(item.id)) return fail("strategy_not_found");
    if (!item.evidence) return fail("evidence_required");
    if (Date.parse(strategy.activatedAt) + strategy.observationWindowHours * HOUR_MS > ctx.nowMs) return fail("protection_window");
    retiring.add(item.id); retiredOpenTactics += strategy.openTactics;
  }
  const remainingActive = ctx.strategies.filter((s) => s.status === "active" && !retiring.has(s.id)).length;
  const liveStrategies = ctx.strategies.filter((s) => s.status !== "retired" && !retiring.has(s.id)).length;
  if (remainingActive + shift.add.length < 1) return fail("last_active_strategy");
  if (liveStrategies + shift.add.length > GOAL_SHAPE_LIMITS.strategies) return fail("strategy_cap");
  const evidenceCount = shift.evidence_refs.length;
  const iceScores: number[] = [];
  let addedTactics = 0;
  for (const add of shift.add) {
    if (!add.hypothesis) return fail("hypothesis_required");
    if (ctx.krIds.size && !add.serves_krs.some((ref) => ctx.krIds.has(ref))) return fail("strategy_must_cite_kr");
    if (!add.tactics.length) return fail("strategy_needs_tactics");
    if (!add.expected_delta || !add.kill_if) return fail("expected_delta_and_kill_if_required");
    const confidence = evidenceCount < L.lowEvidenceSamples ? Math.min(add.ice.confidence, L.lowEvidenceConfidenceCap) : add.ice.confidence;
    iceScores.push(Math.round(((add.ice.impact + confidence + add.ice.ease) / 3) * 100) / 100);
    addedTactics += add.tactics.length;
  }
  if (ctx.openTactics - retiredOpenTactics + addedTactics > GOAL_SHAPE_LIMITS.tactics) return fail("tactic_cap");
  return { ok: true, shift, iceScores, retiredOpenTactics, addedTactics };
}
