"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatContinuitySnapshot } from "@shared/types";
import { ipc, ipcEvents } from "@/lib/ipc";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel } from "@/lib/goal-surface-status";
import { AutomationStrategyPanel } from "./automation/AutomationStrategyPanel";
import styles from "./ContinuityStatus.module.css";

type Props = { chatId: string | null; locale: "ko" | "en"; detail?: boolean };

function when(value: string | null | undefined, locale: "ko" | "en"): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function goalStatus(snapshot: ChatContinuitySnapshot, ko: boolean, observationStale: boolean): string {
  const goal = snapshot.goal;
  if (!goal) return ko ? "연결된 Goal 없음" : "No linked Goal";
  // A retained snapshot is evidence of the last observation, not current
  // authority. Keep the explicit stale copy instead of classifying it as a
  // paused or blocked Goal while Main is being re-read.
  if (observationStale) return ko ? "Goal 상태 재확인 중" : "Rechecking Goal status";
  const status = classifyGoalSurfaceStatus({
    runStatus: goal.runStatus,
    blockedReason: goal.blockedReason,
    wait: goal.wait,
    invocation: snapshot.invocation,
    automations: snapshot.automations,
    observationFresh: !observationStale,
    effectObservationChecking: goal.effectObservation === "checking",
  });
  return goalSurfaceStatusLabel(status.state, ko ? "ko" : "en");
}

function invocationStatus(snapshot: ChatContinuitySnapshot, ko: boolean, observationStale: boolean): string | null {
  const run = snapshot.invocation;
  if (!run) return null;
  const relation = run.relationship === "goal-bound"
    ? (ko ? "Goal 실행" : "Goal run")
    : (ko ? "Goal 연결 미확인 실행" : "Goal link unverified");
  const state = run.state === "active" && !observationStale
    ? (ko ? "Main에서 실행 확인" : "Active in Main")
    : run.state === "unconfirmed"
      ? (ko ? "실행 여부 재확인 필요" : "Run status needs recheck")
      : (ko ? "모델 호출 종료" : "Model call ended");
  return `${relation} · ${state}`;
}

function nextActionLabel(value: NonNullable<NonNullable<ChatContinuitySnapshot["goal"]>["episodeStrategy"]>["nextAction"], ko: boolean): string {
  const labels = {
    wait_observe: ko ? "다음 관찰 대기" : "Wait for next observation",
    repair_verified_failure: ko ? "확인된 실패 수리" : "Repair verified failure",
    gather_missing_evidence: ko ? "부족한 증거 수집" : "Gather missing evidence",
    hold_for_user: ko ? "사용자 판단 대기" : "Wait for user decision",
    inspect_before_action: ko ? "재실행 전 상태 확인" : "Inspect before acting",
  };
  return labels[value];
}

/** One bounded Main snapshot per observation. Its read failure never changes
 * Goal/automation authority, and a quiet durable ledger is not a dead agent. */
export function ContinuityStatus({ chatId, locale, detail = false }: Props) {
  const [snapshot, setSnapshot] = useState<ChatContinuitySnapshot | null>(null);
  const [error, setError] = useState(false);
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null);
  const ko = locale === "ko";
  const refresh = useCallback(async (onResult: (value: ChatContinuitySnapshot | null) => void) => {
    if (!chatId) return;
    const api = ipc();
    if (!api?.chats.getContinuitySnapshot) throw new Error("continuity_bridge_unavailable");
    const value = await api.chats.getContinuitySnapshot(chatId);
    if (value && value.chatId !== chatId) throw new Error("continuity_chat_binding_changed");
    onResult(value);
  }, [chatId]);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    setSnapshot(null); setError(false); setLastConfirmedAt(null);
    const read = async () => {
      const current = ++generation;
      try {
        await refresh((value) => {
          if (disposed || current !== generation) return;
          if (value) { setSnapshot(value); setLastConfirmedAt(value.observedAt); }
          setError(!value);
        });
      } catch {
        if (!disposed && current === generation) setError(true);
      }
    };
    void read();
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (["chat", "long-run", "automation", "run-event"].includes(change.entity)) void read();
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") { setError(true); void read(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, 10_000);
    return () => { disposed = true; ++generation; off?.(); document.removeEventListener("visibilitychange", onVisibility); clearInterval(poll); };
  }, [chatId, refresh]);
  if (!chatId) return null;
  if (!snapshot) return error
    ? <p className={styles.unavailable} role="status">{ko ? "작업 상태를 확인하지 못했습니다. Goal과 예약은 변경되지 않았습니다." : "Could not check work status. The Goal and schedules were not changed."}</p>
    : null;
  const independent = snapshot.automations.filter((row) => row.relationship === "independent");
  const unverifiedSchedules = snapshot.automations.filter((row) => row.relationship === "unverified");
  const enabledSchedules = independent.filter((row) => row.enabled);
  const enabledWithoutNextTime = independent.filter((row) => row.enabled && !row.nextRunAt && row.lastRunStatus === "error");
  const disabledSchedules = independent.length - enabledSchedules.length;
  const activeSchedules = independent.filter((row) => row.liveState === "running" || row.liveState === "queued");
  const nextSchedule = independent.filter((row) => row.enabled && row.nextRunAt && Number.isFinite(Date.parse(row.nextRunAt)))
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
  const nextGoal = snapshot.goal?.wait?.state === "pending" ? when(snapshot.goal.wait.nextCheckAt, locale) : null;
  const model = snapshot.modelHandoff;
  const strategy = snapshot.goal?.episodeStrategy;
  const modelStatus = model ? model.state === "applied"
    ? (ko ? "다음 모델 적용 검증" : "Next model verified")
    : model.state === "claimed" ? (ko ? "모델 인계 중" : "Model handoff in progress")
      : (ko ? "다음 모델 적용 대기" : "Next model pending") : null;
  const observedAt = when(snapshot.observedAt, locale);
  const latestProgress = when(snapshot.freshness.lastDurableEventAt, locale);
  const claimedWaitNeedsReview = snapshot.goal?.runStatus === "blocked" && (
    snapshot.goal.blockedReason === "goal_wait_claimed_dispatch_uncertain"
    || snapshot.goal.blockedReason === "goal_wait_claimed_binding_changed"
    || snapshot.goal.blockedReason === "goal_resume_effect_boundary_uncertain");
  const goalHeading = snapshot.goal?.lifecycle === "ongoing"
    ? (ko ? "지속 Goal" : "Ongoing Goal")
    : snapshot.goal?.blockedReason === "goal_wait_ongoing_authority_required"
      ? (ko ? "Goal 확인 대기" : "Goal confirmation pending")
      : "Goal";
  const surface = snapshot.goal ? classifyGoalSurfaceStatus({
    runStatus: snapshot.goal.runStatus,
    blockedReason: snapshot.goal.blockedReason,
    wait: snapshot.goal.wait,
    invocation: snapshot.invocation,
    automations: snapshot.automations,
    observationFresh: !error,
    effectObservationChecking: snapshot.goal.effectObservation === "checking",
  }) : null;
  return <details className={detail ? styles.detail : styles.compact} open={detail || undefined} data-continuity-status={detail ? "detail" : "compact"}
    data-observation={error ? "stale" : "confirmed"} aria-label={ko ? "작업 연속성 상태" : "Work continuity status"}>
    <summary className={styles.summary}>
      <strong>{goalHeading}</strong>
      <span>{goalStatus(snapshot, ko, error)}</span>
    </summary>
    <div className={styles.content}>
    <div className={styles.line} aria-live="polite">
      {invocationStatus(snapshot, ko, error) && <span>{invocationStatus(snapshot, ko, error)}</span>}
    </div>
    <div className={styles.line} aria-live="polite">
      {nextGoal && <span>{ko ? "Goal 다음 확인" : "Goal next check"} {nextGoal} · {ko ? "앱 실행 중" : "while app runs"}</span>}
      {independent.length > 0 && <span>{error ? (ko ? "별도 예약(마지막 확인)" : "Separate schedules (last confirmed)") : (ko ? "별도 예약 켜짐" : "Separate schedules enabled")} {enabledSchedules.length}
        {disabledSchedules > 0 && ` · ${ko ? "꺼짐" : "off"} ${disabledSchedules}`}
        {activeSchedules.length > 0 && ` · ${ko ? "실행 기록상 활성" : "ledger-active"} ${activeSchedules.length}`}
        {enabledWithoutNextTime.length > 0 && ` · ${ko ? "최근 오류·다음 시각 없음" : "recent error·no next time"} ${enabledWithoutNextTime.length}`}
        {nextSchedule && ` · ${ko ? "다음 예정" : "next expected"} ${when(nextSchedule.nextRunAt, locale)}`}</span>}
      {unverifiedSchedules.length > 0 && <span>{ko ? "Goal 연결 확인 필요" : "Goal link unverified"} {unverifiedSchedules.length}</span>}
      {surface && surface.automation.held > 0 && <span>{ko ? "보류된 자동화" : "Held automations"} {surface.automation.held}</span>}
      {surface && surface.automation.reconciliationHold > 0 && <span>{ko ? "자동화 조정 보류" : "Automation reconciliation hold"} {surface.automation.reconciliationHold}</span>}
      {modelStatus && <span>{modelStatus} · {model?.requested.model ?? model?.requested.kind}</span>}
      {strategy?.state === "changed" && <span>{ko ? "검증 결과에 따라 다음 행동 변경" : "Next action changed after verification"} · {nextActionLabel(strategy.nextAction, ko)}</span>}
    </div>
    {!error && claimedWaitNeedsReview && <p className={styles.review} data-goal-claimed-wait-review="true">
      {snapshot.goal?.blockedReason === "goal_resume_effect_boundary_uncertain"
        ? (ko
          ? "다음 안전한 조치: 이전 호출의 효과 경계를 확인할 수 없어 자동 재실행하지 않습니다. 이 대화의 이전 실행 Activity와 실제 결과를 확인한 뒤 새 요청으로 이어가세요."
          : "Next safe step: the previous effect boundary could not be verified, so automatic replay is stopped. Inspect the previous execution in Activity and its actual result, then continue with a new request.")
        : (ko
          ? "다음 안전한 조치: 이 대화의 이전 실행 Activity와 실제 결과를 확인하세요. 어떤 호출이 실행됐는지 확정하기 전에는 같은 요청을 다시 보내지 마세요. 자동 재실행은 중단됐으며 Goal과 작업 기록은 보존됩니다."
          : "Next safe step: inspect the previous execution in this conversation's Activity and check its actual result. Do not send the same request again until you know whether it ran. Automatic replay is stopped; the Goal and work history are preserved.")}
    </p>}
    {detail && <div className={styles.detailRows}>
      {snapshot.invocation && <p>{ko ? "이번 실행 단계" : "Current run phase"} · {snapshot.invocation.phase}
        {snapshot.invocation.model?.model && ` · ${ko ? "실행 선택 모델" : "Selected run model"} ${snapshot.invocation.model.model}`}
        {when(snapshot.invocation.phaseAt, locale) && ` · ${when(snapshot.invocation.phaseAt, locale)}`}</p>}
      {snapshot.automations.map((row) => <p key={row.automationId} data-automation-id={row.automationId}>
        {row.relationship === "goal-bound" ? (ko ? "Goal 연계 예약" : "Goal-linked schedule")
          : row.relationship === "unverified" ? (ko ? "Goal 연결 확인 필요" : "Goal link unverified")
            : (ko ? "Goal과 별도 예약" : "Separate from Goal")}
        {!row.enabled && ` · ${ko ? "예약 꺼짐" : "Schedule off"}`}
        {row.liveState && ` · ${row.liveState === "running" ? (ko ? "최근 원장 기록상 진행" : "Recent ledger reports running") : (ko ? "스케줄러 요청됨" : "Scheduler queued")}`}
        {row.lastActivityAt && ` · ${ko ? "최근 활동" : "Last activity"} ${when(row.lastActivityAt, locale)}`}
        {row.nextRunAt && ` · ${ko ? "다음 예정" : "Next expected"} ${when(row.nextRunAt, locale)}`}
        {row.enabled && !row.nextRunAt && row.lastRunStatus === "error" && ` · ${ko ? "최근 오류 후 다음 시각 없음 · 실행 내역 확인" : "No next time after recent error · check run history"}`}
      </p>)}
      {model && <p>{ko ? "Goal 모델 변경" : "Goal model change"} · {modelStatus} · {model.requested.model ?? model.requested.kind}</p>}
      {strategy && <p data-episode-strategy={strategy.state}>{ko ? "이번 주기 검증 경로" : "Episode verification route"} · {strategy.state === "changed"
        ? (ko ? "다음 행동 변경" : "next action changed") : strategy.state === "unknown" ? (ko ? "증거 미확정 · 자동 변경 없음" : "evidence inconclusive · no automatic change") : (ko ? "기존 행동 유지" : "existing action retained")}
        {` · ${nextActionLabel(strategy.nextAction, ko)} · ${ko ? "통과" : "passed"} ${strategy.metrics.passed}, ${ko ? "증거 미확정" : "inconclusive"} ${strategy.metrics.inconclusive}`}
        {strategy.nextWakeAt && ` · ${ko ? "다음 확인" : "next check"} ${when(strategy.nextWakeAt, locale)}`}</p>}
      {latestProgress && <p>{ko ? "마지막 원장 활동" : "Last durable activity"} · {latestProgress}</p>}
    </div>}
    {snapshot.automations.map((row) => <AutomationStrategyPanel key={row.automationId} automationId={row.automationId} locale={locale} />)}
    {/* A "checked at" timestamp is noise in One's compact bubble; keep it only when stale or in the detail view. */}
    {(detail || error) && <small className={styles.observation}>{error ? (ko ? "상태 재확인 중 · 마지막 확인 " : "Rechecking status · last confirmed ")
      : (ko ? "Main 상태 확인 " : "Main state checked ")}{observedAt ?? lastConfirmedAt ?? "—"}</small>}
    </div>
  </details>;
}
