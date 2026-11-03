/**
 * Segment budget: one resource allowance for one stretch ("segment") of a long run.
 *
 * A segment has a wall-clock allowance plus optional token, cost, tool-call and cycle caps. When one is spent the run parks
 * (`paused` with pause reason `budget`) and the owner extends it, which starts the next segment (epoch + 1) with fresh usage.
 * Time the run spends waiting on the host (a scheduling hold, not work) does not count: the clock stops while a host wait is
 * open and the deadline moves out by the waited time when it closes.
 *
 * This file is pure and has no imports. Agentlas Science keeps a byte-identical vendored copy (src/segment-budget.ts, pinned
 * by scripts/research-goal-shared-origin.json), so Desktop goals and Science research decide "spent" with the same code.
 * Runs without a segment budget never reach any of it.
 */

export const SEGMENT_BUDGET_SCHEMA = "agentlas.segment-budget.v1" as const;
export const SEGMENT_BUDGET_DEFAULT_WALL_MINUTES = 30;

export type SegmentBudgetExhaustReason = "wall-time" | "tokens" | "cost" | "tool-calls" | "cycles";

export interface SegmentBudgetLimits {
  wallTimeMinutes: number;
  tokens: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  cycles: number | null;
}

/** null = not measured. A cap on an unmeasured quantity never trips (unknown is not zero). */
export interface SegmentBudgetUsage {
  tokensUsed: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  cycles: number | null;
}

export interface SegmentBudgetState {
  schema: typeof SEGMENT_BUDGET_SCHEMA;
  epoch: number;
  startedAt: string;
  deadlineAt: string;
  limits: SegmentBudgetLimits;
  usage: SegmentBudgetUsage;
  /** Open host wait: the clock is stopped at this instant. */
  hostWait: { startedAt: string } | null;
  hostWaitElapsedMs: number;
  status: "active" | "exhausted";
  exhaustedReason: SegmentBudgetExhaustReason | null;
  exhaustedAt: string | null;
  /**
   * Counters of the run when the segment began, for hosts whose cycle and cost figures are run-wide totals: usage in the segment
   * is the total minus this. Absent when the reporter already counts per segment (Science).
   */
  baseline?: { cycles: number; costUsd: number } | null;
}

export const emptySegmentUsage = (): SegmentBudgetUsage => ({ tokensUsed: null, costUsd: null, toolCalls: null, cycles: null });

export function defaultSegmentLimits(wallTimeMinutes = SEGMENT_BUDGET_DEFAULT_WALL_MINUTES): SegmentBudgetLimits {
  return { wallTimeMinutes, tokens: null, costUsd: null, toolCalls: null, cycles: null };
}

/** Sum of the per-run figures where the aggregate was never reported; a figure no run reported stays unknown. */
export function resolveSegmentUsage(
  usage: SegmentBudgetUsage,
  usageByRun: Record<string, SegmentBudgetUsage> | undefined,
): SegmentBudgetUsage {
  const resolved = { ...usage };
  for (const key of ["tokensUsed", "costUsd", "toolCalls", "cycles"] as const) {
    if (resolved[key] !== null) continue;
    const known = Object.values(usageByRun ?? {}).map((value) => value[key]).filter((value): value is number => value !== null);
    if (known.length) resolved[key] = known.reduce((sum, value) => sum + value, 0);
  }
  return resolved;
}

/**
 * The one decision: which allowance of this segment is spent at `nowMs`, if any. Order is fixed (wall time first), which is the
 * reason a run that overran several caps at once reports. While a host wait is open the clock reads the instant the wait began.
 */
export function segmentBudgetExhaustion(
  input: { deadlineAt: string; hostWaitStartedAt: string | null; limits: SegmentBudgetLimits; usage: SegmentBudgetUsage },
  nowMs: number,
): SegmentBudgetExhaustReason | null {
  const { limits, usage } = input;
  return (input.hostWaitStartedAt ? Date.parse(input.hostWaitStartedAt) : nowMs) >= Date.parse(input.deadlineAt) ? "wall-time"
    : limits.tokens !== null && usage.tokensUsed !== null && usage.tokensUsed >= limits.tokens ? "tokens"
    : limits.costUsd !== null && usage.costUsd !== null && usage.costUsd >= limits.costUsd ? "cost"
    : limits.toolCalls !== null && usage.toolCalls !== null && usage.toolCalls >= limits.toolCalls ? "tool-calls"
    : limits.cycles !== null && usage.cycles !== null && usage.cycles >= limits.cycles ? "cycles"
    : null;
}

function validLimit(key: string, value: number | null): boolean {
  if (value === null) return key !== "wallTimeMinutes";
  if (!Number.isFinite(value) || value < 0) return false;
  if (key === "wallTimeMinutes") return Number.isSafeInteger(value) && value >= 1;
  return key === "costUsd" || Number.isSafeInteger(value);
}

export function segmentLimitsValid(limits: Partial<SegmentBudgetLimits>): boolean {
  return Object.entries(limits).every(([key, value]) => ["wallTimeMinutes", "tokens", "costUsd", "toolCalls", "cycles"].includes(key)
    && validLimit(key, value as number | null));
}

/** Starts the next segment: epoch + 1, fresh clock, fresh usage. `previous` only supplies the epoch and the limits to carry on. */
export function startSegmentBudget(
  previous: SegmentBudgetState | null,
  input: { nowMs: number; limits?: Partial<SegmentBudgetLimits>; baseline?: { cycles: number; costUsd: number } | null },
): SegmentBudgetState {
  const limits = { ...defaultSegmentLimits(), ...previous?.limits, ...input.limits };
  if (!segmentLimitsValid(limits)) throw new Error("segment_budget_limit_invalid");
  return {
    schema: SEGMENT_BUDGET_SCHEMA,
    epoch: (previous?.epoch ?? 0) + 1,
    startedAt: new Date(input.nowMs).toISOString(),
    deadlineAt: new Date(input.nowMs + limits.wallTimeMinutes * 60_000).toISOString(),
    limits,
    usage: emptySegmentUsage(),
    hostWait: null,
    hostWaitElapsedMs: 0,
    status: "active",
    exhaustedReason: null,
    exhaustedAt: null,
    ...(input.baseline ? { baseline: { cycles: input.baseline.cycles, costUsd: input.baseline.costUsd } } : {}),
  };
}

/** Marks the segment spent when an allowance is. An exhausted segment never reopens; only a new segment does. */
export function evaluateSegmentBudget(state: SegmentBudgetState, nowMs: number): SegmentBudgetState {
  if (state.status !== "active") return state;
  const reason = segmentBudgetExhaustion({ deadlineAt: state.deadlineAt, hostWaitStartedAt: state.hostWait?.startedAt ?? null,
    limits: state.limits, usage: state.usage }, nowMs);
  return reason ? { ...state, status: "exhausted", exhaustedReason: reason, exhaustedAt: new Date(nowMs).toISOString() } : state;
}

/** Usage figures only grow within a segment; a lower number is a bug in the reporter, not a refund. */
export function observeSegmentUsage(state: SegmentBudgetState, usage: Partial<SegmentBudgetUsage>, nowMs: number): SegmentBudgetState {
  if (state.status !== "active") return state;
  const next = { ...state.usage };
  for (const [key, value] of Object.entries(usage) as Array<[keyof SegmentBudgetUsage, number | null | undefined]>) {
    if (!(key in next)) throw new Error("segment_budget_usage_invalid");
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0 || (key !== "costUsd" && !Number.isSafeInteger(value))) throw new Error("segment_budget_usage_invalid");
    if (next[key] !== null && value < next[key]!) throw new Error("segment_budget_usage_regressed");
    next[key] = value;
  }
  return evaluateSegmentBudget({ ...state, usage: next }, nowMs);
}

export function suspendSegmentHostWait(state: SegmentBudgetState, nowMs: number): SegmentBudgetState {
  const evaluated = evaluateSegmentBudget(state, nowMs);
  if (evaluated.status !== "active" || evaluated.hostWait) return evaluated;
  return { ...evaluated, hostWait: { startedAt: new Date(nowMs).toISOString() } };
}

export function resumeSegmentHostWait(state: SegmentBudgetState, nowMs: number): SegmentBudgetState {
  if (!state.hostWait) return state;
  const elapsed = Math.max(0, nowMs - Date.parse(state.hostWait.startedAt));
  return { ...state, hostWait: null, deadlineAt: new Date(Date.parse(state.deadlineAt) + elapsed).toISOString(),
    hostWaitElapsedMs: state.hostWaitElapsedMs + elapsed };
}

/** Defensive read of a stored/mirrored state: anything that is not exactly this shape is null, never a guess. */
export function parseSegmentBudgetState(raw: unknown): SegmentBudgetState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.schema !== SEGMENT_BUDGET_SCHEMA || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 1) return null;
  const time = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));
  if (!time(v.startedAt) || !time(v.deadlineAt)) return null;
  const limits = v.limits as Record<string, unknown> | undefined;
  const usage = v.usage as Record<string, unknown> | undefined;
  if (!limits || !usage) return null;
  const nullableNumber = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
  if (typeof limits.wallTimeMinutes !== "number" || !validLimit("wallTimeMinutes", limits.wallTimeMinutes)) return null;
  for (const key of ["tokens", "costUsd", "toolCalls", "cycles"]) if (!nullableNumber(limits[key])) return null;
  for (const key of ["tokensUsed", "costUsd", "toolCalls", "cycles"]) if (!nullableNumber(usage[key])) return null;
  if (v.status !== "active" && v.status !== "exhausted") return null;
  const hostWait = v.hostWait;
  if (hostWait !== null && !(hostWait && typeof hostWait === "object" && time((hostWait as { startedAt?: unknown }).startedAt))) return null;
  if (typeof v.hostWaitElapsedMs !== "number" || !Number.isFinite(v.hostWaitElapsedMs) || v.hostWaitElapsedMs < 0) return null;
  const reasons = ["wall-time", "tokens", "cost", "tool-calls", "cycles"];
  if (v.exhaustedReason !== null && !reasons.includes(String(v.exhaustedReason))) return null;
  if (v.exhaustedAt !== null && !time(v.exhaustedAt)) return null;
  const baseline = v.baseline;
  if (baseline !== undefined && baseline !== null && !(typeof baseline === "object" && !Array.isArray(baseline)
    && nullableNumber((baseline as Record<string, unknown>).cycles) && (baseline as Record<string, unknown>).cycles !== null
    && nullableNumber((baseline as Record<string, unknown>).costUsd) && (baseline as Record<string, unknown>).costUsd !== null)) return null;
  return {
    schema: SEGMENT_BUDGET_SCHEMA,
    epoch: v.epoch as number,
    startedAt: v.startedAt,
    deadlineAt: v.deadlineAt,
    limits: { wallTimeMinutes: limits.wallTimeMinutes, tokens: limits.tokens as number | null, costUsd: limits.costUsd as number | null,
      toolCalls: limits.toolCalls as number | null, cycles: limits.cycles as number | null },
    usage: { tokensUsed: usage.tokensUsed as number | null, costUsd: usage.costUsd as number | null,
      toolCalls: usage.toolCalls as number | null, cycles: usage.cycles as number | null },
    hostWait: hostWait === null ? null : { startedAt: (hostWait as { startedAt: string }).startedAt },
    hostWaitElapsedMs: v.hostWaitElapsedMs,
    status: v.status,
    exhaustedReason: v.exhaustedReason as SegmentBudgetExhaustReason | null,
    exhaustedAt: v.exhaustedAt as string | null,
    ...(baseline ? { baseline: { cycles: (baseline as { cycles: number }).cycles, costUsd: (baseline as { costUsd: number }).costUsd } } : {}),
  };
}
