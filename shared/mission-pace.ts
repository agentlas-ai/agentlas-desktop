/**
 * 대계 KR 속도 계산(순수) — "하루에 얼마가 필요하고, 지금 얼마가 부족한가"(docs/2026-09-24-PLAN M-1·M-3-4).
 *
 * required = (target − current) / days_left, observed = 관측 표본의 기울기(하루당), gap = required − observed.
 * 값이 줄어야 하는 KR(기준선이 목표보다 큼, 예 '이탈률 20% → 5%')은 부호를 뒤집어 같은 식으로 계산한다 — required·observed·gap 은
 * 항상 "목표 쪽으로 간 양"이고, current·remaining 만 원래 값의 부호로 돌려준다(Agent Strategy 의 computeKpiMetrics 와 같은 정규화).
 * 센서가 없으면 추측하지 않는다: status "no_sensor" 는 **인프라 상태**이지 전략 실패가 아니다(M-3-4).
 * 결측은 보간하지 않는다.
 */

export interface MetricSample { value: number; observedAt: string }

export interface MissionPaceInput {
  target: number;
  baseline: number | null;
  /** 계획이 만들어진 시각(기준선의 시각). */
  startAt: string;
  deadlineAt: string | null;
  nowMs: number;
  /** 호스트 센서 표본(시간순 무관). 없으면 빈 배열. */
  samples: readonly MetricSample[];
}

/** 값이 목표 쪽으로 늘어야 하는지(up) 줄어야 하는지(down). 기준선을 모르면 up — Agent Strategy 의 KPI 방향과 같은 규칙 하나. */
export type KrDirection = "up" | "down";
export function krDirection(baseline: number | null, target: number): KrDirection {
  return baseline !== null && baseline > target ? "down" : "up";
}

export type MissionPaceStatus = "no_deadline" | "no_sensor" | "achieved" | "deadline_passed" | "on_pace" | "behind" | "ahead";

export interface MissionPace {
  status: MissionPaceStatus;
  /** requiredPerDay·observedPerDay·gapPerDay 는 이 방향으로 목표에 다가가는 양이고, current·remaining 은 원래 값의 부호다. */
  direction: KrDirection;
  current: number | null;
  remaining: number | null;
  daysLeft: number | null;
  requiredPerDay: number | null;
  observedPerDay: number | null;
  gapPerDay: number | null;
  /** 관측 기울기 대비 필요 속도의 배수(비현실 목표 보고용, M-3-2 규칙 4). */
  requiredOverObserved: number | null;
  /** 기준선도 표본도 없을 때의 상한(0에서 시작한다고 볼 때의 하루 필요량). 추정이 아니라 상한이다. */
  requiredPerDayUpperBound: number | null;
}

const DAY_MS = 86_400_000;
const round = (value: number | null): number | null => value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;

/** 두 점 이상이면 첫·마지막 표본의 기울기(하루당). 한 점이면 기준선과의 기울기. */
function observedSlope(samples: readonly MetricSample[], baseline: number | null, startMs: number): number | null {
  const sorted = [...samples].filter((s) => Number.isFinite(s.value) && Number.isFinite(Date.parse(s.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1]!;
  const first = sorted.length > 1 ? sorted[0]! : baseline !== null ? { value: baseline, observedAt: new Date(startMs).toISOString() } : null;
  if (!first) return null;
  const days = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / DAY_MS;
  return days > 0 ? (last.value - first.value) / days : null;
}

export function missionPace(input: MissionPaceInput): MissionPace {
  // 아래 식은 "값이 커질수록 전진"이다. 줄여야 하는 KR 은 값을 뒤집어 넣고(-0 은 0 으로), 값을 내놓을 때만 원래 부호로 돌린다.
  const direction = krDirection(input.baseline, input.target);
  const sign = direction === "down" ? -1 : 1;
  const flip = (value: number): number => (sign === 1 || value === 0 ? value : -value);
  const target = flip(input.target);
  const baseline = input.baseline === null ? null : flip(input.baseline);
  const samples = sign === 1 ? input.samples : input.samples.map((s) => ({ ...s, value: flip(s.value) }));
  const startMs = Date.parse(input.startAt);
  const deadlineMs = input.deadlineAt ? Date.parse(input.deadlineAt) : Number.NaN;
  const latest = [...samples].filter((s) => Number.isFinite(s.value) && Number.isFinite(Date.parse(s.observedAt)))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  const current = latest ? latest.value : null;
  const reference = current ?? baseline;
  const remaining = reference === null ? null : target - reference;
  const daysLeft = Number.isFinite(deadlineMs) ? (deadlineMs - input.nowMs) / DAY_MS : null;
  const observed = observedSlope(samples, baseline, Number.isFinite(startMs) ? startMs : input.nowMs);
  const requiredPerDay = remaining !== null && daysLeft !== null && daysLeft > 0 ? Math.max(0, remaining) / daysLeft : null;
  const base = { direction, current: current === null ? null : flip(current), remaining: remaining === null ? null : round(flip(remaining)),
    daysLeft: round(daysLeft), requiredPerDay: round(requiredPerDay),
    observedPerDay: round(observed), gapPerDay: requiredPerDay !== null && observed !== null ? round(requiredPerDay - observed) : null,
    requiredOverObserved: requiredPerDay !== null && observed !== null && observed > 0 ? round(requiredPerDay / observed) : null,
    requiredPerDayUpperBound: reference === null && daysLeft !== null && daysLeft > 0 ? round(Math.max(0, target) / daysLeft) : null };
  if (current !== null && current >= target) return { ...base, status: "achieved" };
  if (daysLeft === null) return { ...base, status: current === null ? "no_sensor" : "no_deadline" };
  if (daysLeft <= 0) return { ...base, status: "deadline_passed" };
  if (current === null || observed === null) return { ...base, status: "no_sensor" };
  const gap = (requiredPerDay ?? 0) - observed;
  const tolerance = Math.max(1e-9, (requiredPerDay ?? 0) * 0.1);
  return { ...base, status: gap > tolerance ? "behind" : gap < -tolerance ? "ahead" : "on_pace" };
}
