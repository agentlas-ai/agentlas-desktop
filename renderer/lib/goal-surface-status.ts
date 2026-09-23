import type { ChatContinuitySnapshot } from "@shared/types";

/**
 * Renderer-only projection of the Main continuity snapshot.
 *
 * A durable `running` row is not enough to say that a worker is alive: the
 * exact Goal-bound invocation must also be active. Likewise, a timer wait is
 * a schedule, not a stopped Goal. Keeping this decision in one pure helper
 * prevents the One chip and the Work continuity rail from drifting apart.
 */
export type GoalSurfaceState =
  | "unknown"
  | "active_run"
  | "active_unconfirmed"
  | "queued"
  | "scheduled_wait"
  | "waiting"
  | "waiting_confirmation"
  | "blocked_uncertain"
  | "checking_effects"
  | "blocked"
  | "paused_app_closed"
  | "paused_crash_recovery"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

type Invocation = NonNullable<ChatContinuitySnapshot["invocation"]>;
type Automation = ChatContinuitySnapshot["automations"][number];
type Wait = NonNullable<NonNullable<ChatContinuitySnapshot["goal"]>["wait"]>;

export type GoalSurfaceStatusInput = {
  runStatus?: string | null;
  pauseReason?: string | null;
  blockedReason?: string | null;
  wait?: Wait | null;
  invocation?: Invocation | null;
  automations?: readonly Automation[];
  /** False means the renderer only has a retained snapshot, not live authority. */
  observationFresh: boolean;
  /** Main is running a read-only effect observation for this blocked Goal (look before asking). */
  effectObservationChecking?: boolean;
};

export type GoalAutomationSummary = {
  /** A scheduler lease is queued; it is not proof that a model is running. */
  queued: number;
  /** Main has a recent durable running row; this is deliberately not called live. */
  recentRunning: number;
  /** An enabled schedule has a concrete next run time. */
  scheduled: number;
  /** A disabled schedule still has a queued/running ledger row and needs review. */
  held: number;
  /** Main recorded an automation error but no successor run is scheduled. */
  reconciliationHold: number;
};

export type GoalSurfaceStatus = {
  state: GoalSurfaceState;
  invocationConfirmed: boolean;
  automation: GoalAutomationSummary;
};

function hasNextRun(value: string | null): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function automationSummary(rows: readonly Automation[]): GoalAutomationSummary {
  return rows.reduce<GoalAutomationSummary>((summary, row) => {
    if (row.liveState === "queued") summary.queued += 1;
    if (row.liveState === "running") summary.recentRunning += 1;
    if (row.enabled && hasNextRun(row.nextRunAt)) summary.scheduled += 1;
    if (row.enabled && !row.nextRunAt && row.lastRunStatus === "error") summary.reconciliationHold += 1;
    if (!row.enabled && (row.liveState === "queued" || row.liveState === "running")) summary.held += 1;
    return summary;
  }, { queued: 0, recentRunning: 0, scheduled: 0, held: 0, reconciliationHold: 0 });
}

/** Classify only from a fresh Main observation and never infer liveness from text. */
export function classifyGoalSurfaceStatus(input: GoalSurfaceStatusInput): GoalSurfaceStatus {
  const automation = automationSummary(input.automations ?? []);
  const invocationConfirmed = input.invocation?.relationship === "goal-bound"
    && input.invocation.state === "active";
  const fallback: GoalSurfaceStatus = { state: "unknown", invocationConfirmed, automation };
  if (!input.observationFresh) return fallback;

  const status = input.runStatus ?? null;
  const blockedReason = input.blockedReason ?? null;
  const wait = input.wait ?? null;

  if (status === "completed") return { ...fallback, state: "completed" };
  if (status === "cancelled") return { ...fallback, state: "cancelled" };
  if (status === "failed") return { ...fallback, state: "failed" };
  if (status === "paused") {
    if (input.pauseReason === "app_closed") return { ...fallback, state: "paused_app_closed" };
    if (input.pauseReason === "crash_recovery") return { ...fallback, state: "paused_crash_recovery" };
    return { ...fallback, state: "paused" };
  }
  if (status === "blocked") {
    if (input.effectObservationChecking) return { ...fallback, state: "checking_effects" };
    if (blockedReason === "goal_wait_ongoing_authority_required") return { ...fallback, state: "waiting_confirmation" };
    if (blockedReason === "goal_wait_claimed_dispatch_uncertain"
      || blockedReason === "goal_wait_claimed_binding_changed"
      || blockedReason === "goal_resume_effect_boundary_uncertain") {
      return { ...fallback, state: "blocked_uncertain" };
    }
    return { ...fallback, state: "blocked" };
  }
  if (wait?.state === "pending") {
    return { ...fallback, state: wait.subjectKind === "timer" ? "scheduled_wait" : "waiting" };
  }
  if (status === "waiting_worker" || status === "waiting_tool" || status === "waiting_user") {
    return { ...fallback, state: "waiting" };
  }
  if (status === "verifying") return { ...fallback, state: "verifying" };
  if (status === "queued") return { ...fallback, state: "queued" };
  if (status === "running") {
    return { ...fallback, state: invocationConfirmed ? "active_run" : "active_unconfirmed" };
  }
  return fallback;
}

export function goalSurfaceStatusLabel(state: GoalSurfaceState, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  switch (state) {
    case "active_run": return ko ? "이 Goal 실행 중 · Main에서 확인됨" : "This Goal is running · confirmed by Main";
    case "active_unconfirmed": return ko ? "Goal 실행 기록 있음 · 실제 실행을 재확인하는 중" : "Goal run recorded · rechecking the live invocation";
    case "queued": return ko ? "이 Goal의 다음 실행 준비 중" : "Preparing this Goal's next run";
    case "scheduled_wait": return ko ? "다음 Goal 주기 예약됨" : "Next Goal cycle scheduled";
    case "waiting": return ko ? "이 Goal의 결과·입력 대기 중" : "This Goal is waiting for a result or input";
    case "waiting_confirmation": return ko ? "다음 Goal 판단 주기 확인 대기" : "The next Goal decision cycle awaits confirmation";
    case "blocked_uncertain": return ko ? "이전 호출·효과 경계 불확실 · 자동 재실행 중단 · 확인 필요" : "Previous dispatch/effect boundary uncertain · automatic replay stopped · review needed";
    case "checking_effects": return ko ? "이전 작업이 반영됐는지 직접 확인하는 중" : "Checking whether the earlier action went through";
    case "blocked": return ko ? "Goal이 실제로 차단됨 · 조치 필요" : "Goal is actually blocked · action needed";
    case "paused_app_closed": return ko ? "앱 종료로 멈춤 · 재개 조건 확인 중" : "Paused when the app closed · checking whether safe resume is possible";
    case "paused_crash_recovery": return ko ? "중단된 실행을 복구해 멈춤 · 안전한 재개 조건 확인 중" : "Paused after recovering an interrupted run · checking safe resume conditions";
    case "paused": return ko ? "일시정지 · 기록 보존" : "Paused · history preserved";
    case "verifying": return ko ? "결과를 성공 기준과 대조하는 중" : "Checking the result against acceptance criteria";
    case "completed": return ko ? "완료" : "Completed";
    case "failed": return ko ? "실패" : "Failed";
    case "cancelled": return ko ? "중지됨" : "Stopped";
    case "unknown": return ko ? "Goal 상태 확인 중" : "Checking Goal state";
  }
}
