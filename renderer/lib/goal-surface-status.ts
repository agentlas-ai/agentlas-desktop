import type { ChatContinuitySnapshot } from "@shared/types";
import { goalDisplayState } from "@shared/goal-display-state";

// Renderer-only projection of the Main continuity snapshot: a running row alone does not say a worker is alive, and a timer wait is a schedule, not a stopped Goal. Only an explicit owner pause is `paused` (shared/goal-display-state.ts).
export type GoalSurfaceState =
  | "unknown"
  | "active_run"
  | "active_unconfirmed"
  /** Between turns: waiting for the next scheduled/continuation run or a host-owned step. Same look as running. */
  | "active_idle"
  /** An explicit owner-needed state: approval/budget stop, waiting_user, or the goal asked a question. */
  | "needs_owner"
  | "queued"
  | "waiting_confirmation"
  | "blocked_uncertain"
  | "checking_effects"
  | "blocked"
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
  const display = goalDisplayState({ status, pauseReason: input.pauseReason, blockedReason });
  if (status === "paused") {
    // A pause the app took itself (app_closed, crash_recovery, runtime_unavailable, agent_paused) continues on its own.
    if (display === "running") return { ...fallback, state: "active_idle" };
    if (display === "needs_owner") return { ...fallback, state: "needs_owner" };
    return { ...fallback, state: "paused" };
  }
  if (status === "blocked") {
    if (input.effectObservationChecking) return { ...fallback, state: "checking_effects" };
    if (display === "needs_owner") return { ...fallback, state: "needs_owner" };
    if (blockedReason === "goal_wait_ongoing_authority_required") return { ...fallback, state: "waiting_confirmation" };
    if (blockedReason === "goal_wait_claimed_dispatch_uncertain"
      || blockedReason === "goal_wait_claimed_binding_changed"
      || blockedReason === "goal_resume_effect_boundary_uncertain") {
      return { ...fallback, state: "blocked_uncertain" };
    }
    return { ...fallback, state: "blocked" };
  }
  if (status === "waiting_user") return { ...fallback, state: "needs_owner" };
  // A Goal held for the owner's answer to its own question (waiting_tool + the question code) is waiting for the owner, not operating.
  if (display === "needs_owner") return { ...fallback, state: "needs_owner" };
  // Waiting for the next scheduled cycle, a watched result, a worker or a host-owned retry is the goal operating.
  if (wait?.state === "pending") return { ...fallback, state: "active_idle" };
  if (status === "waiting_worker" || status === "waiting_tool") return { ...fallback, state: "active_idle" };
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
    case "active_run": return ko ? "목표 진행 중" : "Goal running";
    case "active_unconfirmed": return ko ? "진행 확인 중" : "Checking progress";
    case "active_idle": return ko ? "목표 대기 중 · 곧 이어감" : "Goal waiting · continues";
    case "needs_owner": return ko ? "답이나 승인 필요" : "Needs your answer";
    case "queued": return ko ? "다음 실행 준비 중" : "Next run getting ready";
    case "waiting_confirmation": return ko ? "다음 확인 대기" : "Next check pending";
    case "blocked_uncertain": return ko ? "확인 필요 · 자동 재실행 멈춤" : "Check needed · replay stopped";
    case "checking_effects": return ko ? "반영 여부 확인 중" : "Checking if it went through";
    case "blocked": return ko ? "막힘 · 조치 필요" : "Blocked";
    case "paused": return ko ? "일시정지" : "Paused";
    case "verifying": return ko ? "결과 확인 중" : "Checking result";
    case "completed": return ko ? "완료" : "Completed";
    case "failed": return ko ? "실패" : "Failed";
    case "cancelled": return ko ? "중지됨" : "Stopped";
    case "unknown": return ko ? "상태 확인 중" : "Checking";
  }
}
