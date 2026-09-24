/**
 * 지속 정책(Persistence Policy) — 실패·보류 뒤 "다음 수"를 고르는 단 한 곳 (2026-09-24 오너 지시).
 *
 *   "보통 ai가 안되면 포기하지 않고 계속 방법 찾지 않나... 목표 연계부터 자율작업까지 유연하게
 *    ai가 계속 살아있을 수 있도록 해야함. 사이언스의 alive agent를 나중에 ... 붙일거라서 그 기반작업이 되야함."
 *
 * 앱이 포기한 이유는 방법이 없어서가 아니라 "다른 방법으로 넘어가는 손"이 한 곳에 없어서였다
 * (docs/2026-09-24-PLAN-persistent-autonomy-foundation.md §0). 자동화·목표·One 복구가 각자 다른
 * 어휘로 판단했고, 각자 몇 군데에서 "사람을 기다림"으로 떨어졌다. 이 모듈이 그 어휘와 결정을 하나로 묶는다.
 *
 * 규칙(§6-1):
 *  1. 끝은 둘뿐이다 — 완료, 또는 기록된 결정적 규칙에 의한 취소(cancel_with_reason). 그 사이의
 *     모든 멈춤은 다시 깨어날 시각을 가진 대기(retry_backoff)다. 사다리를 다 돌아도 포기하지 않고 쉰다.
 *  2. 사람을 부르는 것은 경계(결제·자격증명·보안 동의·오너 정지·목적 변경)뿐이다. 경계가 아닌 원인은
 *     escalate_boundary 를 절대 내지 않는다. 같은 경계는 한 번만 묻는다.
 *  3. 원인은 호출자가 **기계 표식**으로 고른다(산문 파싱 금지). 이 함수는 타입만 받는다.
 *  4. 같은 원인에 같은 수는 최대 2번(헛돌기 방지). 재시도는 시간·도구·런타임·계획 중 하나를 바꾼다.
 *  5. 모든 대기에는 지터가 붙는다(두 자동화가 같은 정각에 부딪히던 A6).
 *
 * 순수 함수다 — DB·시계·런타임·난수는 호출자가 넣는다(계약이 그대로 돌린다). Alive 는 두 번째 정책을
 * 갖지 않고 이 결정의 깨어남 공급원이 된다(§4-3).
 */

/** 사람만 넘을 수 있는 경계. 이 밖의 어떤 원인도 사람을 부르지 않는다. */
export const PERSISTENCE_BOUNDARY_KINDS = [
  "payment",
  "credential",
  "security_consent",
  "owner_stop",
  "purpose_change",
] as const;
export type PersistenceBoundaryKind = (typeof PERSISTENCE_BOUNDARY_KINDS)[number];

export function isPersistenceBoundaryKind(value: unknown): value is PersistenceBoundaryKind {
  return typeof value === "string" && (PERSISTENCE_BOUNDARY_KINDS as readonly string[]).includes(value);
}

/** 타입 실패 원인. 새 표식을 만들지 않고 이미 있는 표식의 이름을 한 곳에 모은다(§6-2). */
export type FailureCause =
  /** 사용 한도. 리셋 시각을 런타임이 알려줬으면 ISO 로 싣는다(없으면 null). */
  | { kind: "quota"; retryAfterAt: string | null }
  /** 로그인·인증 만료. 원 런타임에만 경계다 — 다른 런타임이 있으면 그쪽으로. */
  | { kind: "auth" }
  /** 시간 초과·용량·빈 응답·비정상 종료 — 같은 요청이 곧 다시 될 수 있다. */
  | { kind: "runtime_unavailable" }
  /** 전송·브라우저·CDP·임대 경합 — 막힘이 아니라 기다림. */
  | { kind: "resource_busy" }
  /** 도구 호출이 승인·정책으로 거절됨. */
  | { kind: "tool_refused" }
  /** 필요한 도구가 없거나 죽음. */
  | { kind: "tool_missing" }
  /** 호스트 사실: 바깥을 바꾼 호출 0 ∧ 목표 미충족 ∧ 이유 타입 없음 — 스스로 고른 보류. */
  | { kind: "self_hold" }
  /** 도구 없이 했다고 주장(호스트가 센 도구 호출 0). */
  | { kind: "claimed_without_tools" }
  /** 바깥 효과가 반영됐는지 모름 — 다시 하지 말고 본다. */
  | { kind: "effect_uncertain" }
  /** 판정기에 닿지 못함 — 실행이 아니라 판정만 다시. */
  | { kind: "judge_unavailable" }
  /** 세션 재개 충돌 — 새 세션으로. */
  | { kind: "session_conflict" }
  /** 진짜 경계. */
  | { kind: "boundary"; boundary: PersistenceBoundaryKind }
  | { kind: "unknown" };

export type FailureCauseKind = FailureCause["kind"];

export const FAILURE_CAUSE_KINDS: readonly FailureCauseKind[] = [
  "quota", "auth", "runtime_unavailable", "resource_busy", "tool_refused", "tool_missing", "self_hold",
  "claimed_without_tools", "effect_uncertain", "judge_unavailable", "session_conflict", "boundary", "unknown",
];

/** 고를 수 있는 다음 수. 여기에 "포기"는 없다. */
export type PersistenceMove =
  /** 같은 방법, 시간만 바꿈(지터 포함). `at` 은 다시 깨어날 ISO 시각. */
  | { kind: "retry_backoff"; at: string }
  /** 풀의 다른 구성원으로(실패한 런타임 제외). */
  | { kind: "switch_runtime" }
  /** 같은 능력의 설치된 무자격 대안 도구로. */
  | { kind: "switch_tool" }
  /** 원인 사실을 넣어 다른 계획으로. */
  | { kind: "replan" }
  /** 읽기 전용으로 현재 상태를 본다. */
  | { kind: "observe" }
  /** 경계만 — 한 번 묻고, 나머지 일은 계속한다. */
  | { kind: "escalate_boundary"; boundary: PersistenceBoundaryKind }
  /** 기록된 결정적 규칙에 의한 취소(목표가 이미 끝났거나 오너가 정한 예산이 다함). */
  | { kind: "cancel_with_reason"; reason: string };

export type PersistenceMoveKind = PersistenceMove["kind"];

export const PERSISTENCE_MOVE_KINDS: readonly PersistenceMoveKind[] = [
  "retry_backoff", "switch_runtime", "switch_tool", "replan", "observe", "escalate_boundary", "cancel_with_reason",
];

/** 같은 원인에 같은 수를 쓸 수 있는 최대 횟수(§6-4 잠정값 — P1-7 실측으로 확정). */
export const MAX_SAME_MOVE_PER_CAUSE = 2;

/** 리셋 시각 뒤 여유(Science 규칙: 리셋+15초, 최소 30초). */
export const QUOTA_RESET_GRACE_MS = 15_000;
export const MIN_RETRY_DELAY_MS = 30_000;
/** 런타임이 알려준 리셋이라도 이보다 멀면 믿지 않는다(Science 와 같은 상한). */
export const MAX_PROVIDER_RESET_WAIT_MS = 30 * 24 * 60 * 60_000;
/** 리셋 힌트가 없을 때의 느린 탐침: 30분 → 2시간 → 6시간(Science quotaTurnRetryDelayMs). */
export const QUOTA_PROBE_DELAYS_MS = [30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;
/** 일시 오류 백오프: 30초 → 2분 → 8분(목표 턴 재시도와 같은 표). */
export const TRANSIENT_DELAYS_MS = [30_000, 2 * 60_000, 8 * 60_000] as const;
/** 사다리를 다 돈 뒤의 휴식 — 포기 대신 쉰다. 관측이 바뀌면 호출자가 더 일찍 깨운다. */
export const LADDER_REST_MS = 6 * 60 * 60_000;

/**
 * 원인별 사다리(§6-3). 앞 칸이 이미 이 원인에서 쓰였으면(같은 수 2회 상한 포함) 다음 칸으로 간다.
 * 칸이 반복되는 것은 의도다 — 자기 보류는 "재계획 → 런타임 전환 → 재계획 → 런타임 전환 → 관찰".
 */
export const PERSISTENCE_LADDERS: Readonly<Record<Exclude<FailureCauseKind, "boundary">, readonly PersistenceMoveKind[]>> = {
  quota: ["retry_backoff", "switch_runtime", "retry_backoff"],
  auth: ["switch_runtime", "escalate_boundary"],
  runtime_unavailable: ["retry_backoff", "switch_runtime", "retry_backoff", "replan"],
  resource_busy: ["retry_backoff", "retry_backoff", "switch_runtime"],
  tool_refused: ["switch_tool", "replan", "switch_runtime"],
  tool_missing: ["switch_tool", "replan"],
  self_hold: ["replan", "switch_runtime", "replan", "switch_runtime", "observe"],
  claimed_without_tools: ["switch_runtime", "replan", "switch_runtime", "replan"],
  effect_uncertain: ["observe", "observe"],
  judge_unavailable: ["retry_backoff", "retry_backoff"],
  session_conflict: ["retry_backoff", "switch_runtime"],
  unknown: ["observe", "replan", "switch_runtime"],
};

/** 한 번의 과거 결정(같은 범위 — 자동화 하나, 목표 하나). 원장에서 읽어 온다. */
export interface PersistenceAttempt {
  cause: FailureCauseKind;
  move: PersistenceMoveKind;
  /** escalate_boundary 였으면 그 경계. 같은 경계를 두 번 묻지 않기 위해. */
  boundary?: PersistenceBoundaryKind | null;
}

export interface PersistenceBudgetState {
  /** 오너가 정한 벽시계 마감(없으면 null — 없는 예산은 다 쓴 예산이 아니다). */
  deadlineAt?: string | null;
  /** 원장이 이미 "예산 소진"이라고 기록했는가(주기·비용). */
  exhausted?: boolean;
}

export interface PersistenceGoalState {
  /** 목표(또는 자동화)가 아직 살아 있는가. 끝난 것에는 다음 수가 없다. */
  status: "active" | "completed" | "cancelled";
  /** 실패한 것을 뺀, 지금 넘어갈 수 있는 런타임 수. 0이면 switch_runtime 칸은 건너뛴다. */
  switchableRuntimes: number;
  /** 같은 능력의 설치된 무자격 대안 도구 수. 0이면 switch_tool 칸은 건너뛴다. */
  switchableTools?: number;
}

export interface PersistenceDecisionInput {
  cause: FailureCause;
  /** 이 범위의 최근 결정 — 마지막 진전 이후의 것만(호출자가 자른다). */
  history: readonly PersistenceAttempt[];
  budget?: PersistenceBudgetState;
  goal: PersistenceGoalState;
  nowMs: number;
  /** [0,1) 난수. 계약은 고정값을 넣는다. */
  random?: () => number;
}

export interface PersistenceDecision {
  move: PersistenceMove;
  cause: FailureCause;
  /** 왜 이 수인가 — 유한 어휘(화면·측정이 같은 사실을 본다). */
  reasonCode:
    | "ladder"
    | "ladder_exhausted_rest"
    | "boundary_escalation"
    | "boundary_already_asked"
    | "goal_terminal"
    | "budget_exhausted";
  /** 이 원인에서 이 수를 쓴 횟수(이번 포함). */
  sameMoveCount: number;
  /** 사다리 몇 번째 칸인가(없으면 -1). */
  ladderStep: number;
}

function clampRandom(random: (() => number) | undefined): number {
  const value = random ? random() : Math.random();
  return Number.isFinite(value) ? Math.min(0.999_999, Math.max(0, value)) : 0.5;
}

/**
 * Equal jitter(AWS Architecture Blog, Brooker 2015): 기다림의 절반은 지키고 나머지 절반을 흩뜨린다.
 * 전체 지터는 0에 가까운 대기를 낼 수 있어 한도·전송 점유에서 곧바로 다시 부딪힌다.
 */
export function jitteredDelayMs(baseMs: number, random?: () => number): number {
  const base = Math.max(MIN_RETRY_DELAY_MS, Math.floor(baseMs));
  return Math.floor(base / 2 + clampRandom(random) * (base / 2));
}

/**
 * 한도 대기 시각. 리셋 힌트가 믿을 만하면 리셋+15초(최소 30초), 아니면 30분→2시간→6시간 탐침.
 * 리셋 힌트에는 지터를 넣지 않는다 — 공급자 시계가 정답이다.
 */
export function quotaRetryAtMs(retryAfterAt: string | null | undefined, priorQuotaWaits: number, nowMs: number, random?: () => number): number {
  const reset = retryAfterAt ? Date.parse(retryAfterAt) : Number.NaN;
  if (Number.isFinite(reset) && reset > nowMs && reset - nowMs <= MAX_PROVIDER_RESET_WAIT_MS) {
    return nowMs + Math.max(MIN_RETRY_DELAY_MS, reset - nowMs + QUOTA_RESET_GRACE_MS);
  }
  const step = Math.max(0, Math.min(QUOTA_PROBE_DELAYS_MS.length - 1, priorQuotaWaits));
  return nowMs + jitteredDelayMs(QUOTA_PROBE_DELAYS_MS[step]!, random);
}

function backoffAtMs(cause: FailureCause, priorSameMove: number, nowMs: number, random?: () => number): number {
  if (cause.kind === "quota") return quotaRetryAtMs(cause.retryAfterAt, priorSameMove, nowMs, random);
  const step = Math.max(0, Math.min(TRANSIENT_DELAYS_MS.length - 1, priorSameMove));
  return nowMs + jitteredDelayMs(TRANSIENT_DELAYS_MS[step]!, random);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 다음 수를 고른다. 이 함수는 "포기"를 낼 수 없다: 사다리가 다 떨어져도 retry_backoff(휴식)이고,
 * 사람을 부르는 것은 경계 원인(또는 auth 에서 넘어갈 런타임이 하나도 없을 때의 자격증명 경계)뿐이다.
 */
export function decidePersistenceMove(input: PersistenceDecisionInput): PersistenceDecision {
  const { cause, nowMs } = input;
  const history = input.history.filter((entry) => entry.cause === cause.kind);
  const countOf = (move: PersistenceMoveKind): number => history.filter((entry) => entry.move === move).length;
  const decide = (move: PersistenceMove, reasonCode: PersistenceDecision["reasonCode"], ladderStep: number): PersistenceDecision => ({
    move, cause, reasonCode, ladderStep, sameMoveCount: countOf(move.kind) + 1,
  });

  // 0. 결정적 끝 규칙 — 이미 끝난 목표, 오너가 정한 예산의 소진. 산문 추측 없음.
  if (input.goal.status !== "active") {
    return decide({ kind: "cancel_with_reason", reason: `goal_${input.goal.status}` }, "goal_terminal", -1);
  }
  const deadline = input.budget?.deadlineAt ? Date.parse(input.budget.deadlineAt) : Number.NaN;
  if (input.budget?.exhausted === true || (Number.isFinite(deadline) && nowMs >= deadline)) {
    return decide({ kind: "cancel_with_reason", reason: "budget_exhausted" }, "budget_exhausted", -1);
  }

  // 1. 진짜 경계 — 한 번만 묻는다. 이미 물었으면 해소 이벤트를 기다리며 쉰다(사람을 또 부르지 않는다).
  const alreadyAsked = (boundary: PersistenceBoundaryKind): boolean => input.history.some(
    (entry) => entry.move === "escalate_boundary" && entry.boundary === boundary,
  );
  if (cause.kind === "boundary") {
    if (!alreadyAsked(cause.boundary)) {
      return decide({ kind: "escalate_boundary", boundary: cause.boundary }, "boundary_escalation", 0);
    }
    return decide({ kind: "retry_backoff", at: iso(nowMs + jitteredDelayMs(LADDER_REST_MS, input.random)) },
      "boundary_already_asked", -1);
  }

  // 2. 사다리. 이 원인에서 이미 내린 결정 수만큼 칸이 전진하고, 같은 수 2회 상한·쓸 수 없는 칸은 건너뛴다.
  const ladder = PERSISTENCE_LADDERS[cause.kind];
  const usable = (move: PersistenceMoveKind): boolean => {
    if (countOf(move) >= MAX_SAME_MOVE_PER_CAUSE) return false;
    if (move === "switch_runtime" && input.goal.switchableRuntimes <= 0) return false;
    if (move === "switch_tool" && (input.goal.switchableTools ?? 0) <= 0) return false;
    // 자격증명 경계는 넘어갈 런타임이 하나도 없을 때만, 그리고 한 번만.
    if (move === "escalate_boundary" && (cause.kind !== "auth" || input.goal.switchableRuntimes > 0 || alreadyAsked("credential"))) return false;
    return true;
  };
  for (let step = Math.min(history.length, ladder.length); step < ladder.length; step += 1) {
    const move = ladder[step]!;
    if (!usable(move)) continue;
    return decide(materialize(move, cause, countOf(move), nowMs, input.random), "ladder", step);
  }
  // 앞 칸을 다 썼는데 전진 위치 앞쪽에 아직 쓸 수 있는 칸이 남았으면 그것을 쓴다(건너뛴 칸이 되살아난 경우).
  for (let step = 0; step < ladder.length; step += 1) {
    const move = ladder[step]!;
    if (!usable(move)) continue;
    return decide(materialize(move, cause, countOf(move), nowMs, input.random), "ladder", step);
  }
  // 3. 사다리 소진 — 포기하지 않고 쉰다. 한도는 리셋 시각을, 나머지는 긴 휴식을 쓴다.
  const restAt = cause.kind === "quota"
    ? quotaRetryAtMs(cause.retryAfterAt, QUOTA_PROBE_DELAYS_MS.length - 1, nowMs, input.random)
    : nowMs + jitteredDelayMs(LADDER_REST_MS, input.random);
  return decide({ kind: "retry_backoff", at: iso(restAt) }, "ladder_exhausted_rest", -1);
}

function materialize(
  move: PersistenceMoveKind,
  cause: FailureCause,
  priorSameMove: number,
  nowMs: number,
  random: (() => number) | undefined,
): PersistenceMove {
  switch (move) {
    case "retry_backoff": return { kind: "retry_backoff", at: iso(backoffAtMs(cause, priorSameMove, nowMs, random)) };
    case "escalate_boundary": return { kind: "escalate_boundary", boundary: "credential" };
    case "cancel_with_reason": return { kind: "cancel_with_reason", reason: "ladder" };
    default: return { kind: move };
  }
}

/** run_events 는 중첩 객체를 문자열로 접는다 — 결정 영수증은 평평한 칸으로 싣는다. */
export const PERSISTENCE_DECISION_EVENT_KIND = "persistence_decision" as const;
export const PERSISTENCE_DECISION_SCHEMA = "agentlas.persistence-decision.v1" as const;

export type PersistenceSurface = "automation" | "goal" | "one" | "recovery";

export interface PersistenceDecisionPayload {
  schemaVersion: typeof PERSISTENCE_DECISION_SCHEMA;
  surface: PersistenceSurface;
  /** 결정을 낳은 실행(자동화 run id, 목표 invocation run id). 다음 실행이 "이 결정이 내 직전 실행의 것인가"를 본다. */
  sourceRunId: string | null;
  cause: FailureCauseKind;
  causeBoundary: PersistenceBoundaryKind | null;
  causeRetryAfterAt: string | null;
  move: PersistenceMoveKind;
  moveAt: string | null;
  moveBoundary: PersistenceBoundaryKind | null;
  moveReason: string | null;
  reasonCode: PersistenceDecision["reasonCode"];
  sameMoveCount: number;
  ladderStep: number;
  /** 같은 실패를 여러 층이 겹쳐 재시도하지 않게, 누가 잡았는지(§6-4). */
  ownerLayer: "scheduler" | "goal_ledger" | "one_recovery" | "optimizer";
}

export function persistenceDecisionPayload(
  decision: PersistenceDecision,
  context: { surface: PersistenceSurface; sourceRunId: string | null; ownerLayer: PersistenceDecisionPayload["ownerLayer"] },
): PersistenceDecisionPayload {
  const move = decision.move;
  return {
    schemaVersion: PERSISTENCE_DECISION_SCHEMA,
    surface: context.surface,
    sourceRunId: context.sourceRunId,
    cause: decision.cause.kind,
    causeBoundary: decision.cause.kind === "boundary" ? decision.cause.boundary : null,
    causeRetryAfterAt: decision.cause.kind === "quota" ? decision.cause.retryAfterAt : null,
    move: move.kind,
    moveAt: move.kind === "retry_backoff" ? move.at : null,
    moveBoundary: move.kind === "escalate_boundary" ? move.boundary : null,
    moveReason: move.kind === "cancel_with_reason" ? move.reason : null,
    reasonCode: decision.reasonCode,
    sameMoveCount: decision.sameMoveCount,
    ladderStep: decision.ladderStep,
    ownerLayer: context.ownerLayer,
  };
}

/** 원장에서 읽은 평평한 영수증을 다시 과거 결정으로. 모르는 값은 버린다(부재를 지어내지 않는다). */
export function parsePersistenceDecisionPayload(value: unknown): PersistenceDecisionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== PERSISTENCE_DECISION_SCHEMA) return null;
  if (!FAILURE_CAUSE_KINDS.includes(raw.cause as FailureCauseKind)) return null;
  if (!PERSISTENCE_MOVE_KINDS.includes(raw.move as PersistenceMoveKind)) return null;
  const str = (key: string): string | null => (typeof raw[key] === "string" ? raw[key] as string : null);
  const num = (key: string): number => (Number.isSafeInteger(raw[key]) ? raw[key] as number : 0);
  const surface = str("surface");
  const ownerLayer = str("ownerLayer");
  return {
    schemaVersion: PERSISTENCE_DECISION_SCHEMA,
    surface: (["automation", "goal", "one", "recovery"].includes(surface ?? "") ? surface : "automation") as PersistenceSurface,
    sourceRunId: str("sourceRunId"),
    cause: raw.cause as FailureCauseKind,
    causeBoundary: isPersistenceBoundaryKind(raw.causeBoundary) ? raw.causeBoundary : null,
    causeRetryAfterAt: str("causeRetryAfterAt"),
    move: raw.move as PersistenceMoveKind,
    moveAt: str("moveAt"),
    moveBoundary: isPersistenceBoundaryKind(raw.moveBoundary) ? raw.moveBoundary : null,
    moveReason: str("moveReason"),
    reasonCode: (str("reasonCode") ?? "ladder") as PersistenceDecision["reasonCode"],
    sameMoveCount: num("sameMoveCount"),
    ladderStep: Number.isSafeInteger(raw.ladderStep) ? raw.ladderStep as number : -1,
    ownerLayer: (["scheduler", "goal_ledger", "one_recovery", "optimizer"].includes(ownerLayer ?? "")
      ? ownerLayer : "scheduler") as PersistenceDecisionPayload["ownerLayer"],
  };
}

export function persistenceAttemptOf(payload: PersistenceDecisionPayload): PersistenceAttempt {
  return { cause: payload.cause, move: payload.move, boundary: payload.moveBoundary };
}
