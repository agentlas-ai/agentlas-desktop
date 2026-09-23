"use client";

import type { ChatContinuitySnapshot } from "../../../shared/types";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel, type GoalSurfaceStatus } from "@/lib/goal-surface-status";
import styles from "./GoalStrategyStatus.module.css";

type Props = {
  continuity: ChatContinuitySnapshot | null;
  surface: GoalSurfaceStatus;
  locale: "ko" | "en";
};

function formatWhen(value: string | null | undefined, locale: "ko" | "en"): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function nextActionLabel(
  value: NonNullable<NonNullable<ChatContinuitySnapshot["goal"]>["episodeStrategy"]>["nextAction"],
  ko: boolean,
): string {
  const labels = {
    wait_observe: ko ? "다음 관찰 대기" : "Wait for the next observation",
    repair_verified_failure: ko ? "확인된 실패 수리" : "Repair a verified failure",
    gather_missing_evidence: ko ? "부족한 증거 수집" : "Gather missing evidence",
    hold_for_user: ko ? "사용자 판단 대기" : "Wait for your decision",
    inspect_before_action: ko ? "행동 전 현재 상태 확인" : "Inspect state before acting",
  };
  return labels[value];
}

function strategyStateLabel(
  state: NonNullable<NonNullable<ChatContinuitySnapshot["goal"]>["episodeStrategy"]>["state"] | null,
  ko: boolean,
): string {
  if (state === "changed") return ko ? "검증 후 다음 행동 변경" : "Next action changed after verification";
  if (state === "unchanged") return ko ? "검증 후 기존 행동 유지" : "Existing action retained after verification";
  if (state === "unknown") return ko ? "증거 미확정 · 자동 변경 없음" : "Evidence inconclusive · no automatic change";
  return ko ? "이번 주기 판단 대기" : "This cycle has not been evaluated yet";
}

function automationLabel(
  row: ChatContinuitySnapshot["automations"][number],
  ko: boolean,
): string {
  if (!row.enabled) return ko ? "꺼짐" : "off";
  if (row.liveState === "running") return ko ? "최근 원장에 실행 기록" : "recent run recorded";
  if (row.liveState === "queued") return ko ? "스케줄러 대기" : "queued by scheduler";
  if (row.nextRunAt) return ko ? "다음 실행 예약" : "next run scheduled";
  return ko ? "현재 실행 상태 미확인" : "live state not confirmed";
}

/**
 * Read-only Goal strategy projection.
 *
 * `episodeStrategy` is a host-verified description for one settled episode;
 * it is not an applied Graph revision or a permission grant. Keep this
 * distinction visible in One so a changed next action cannot look like an
 * already-applied automation mutation.
 */
export function GoalStrategyStatus({ continuity, surface, locale }: Props) {
  const goal = continuity?.goal;
  if (!goal) return null;
  const ko = locale === "ko";
  const strategy = goal.episodeStrategy;
  const rows = continuity.automations;
  const goalBound = rows.filter((row) => row.relationship === "goal-bound");
  const unverified = rows.filter((row) => row.relationship === "unverified");
  const independent = rows.filter((row) => row.relationship === "independent");
  const nextWakeAt = strategy?.nextWakeAt ?? (goal.wait?.state === "pending" ? goal.wait.nextCheckAt : null);
  const nextWake = formatWhen(nextWakeAt, locale);
  const status = strategy?.state ?? null;
  const dataObservation = strategy ? "verified" : "pending";
  const surfaceLabel = goalSurfaceStatusLabel(surface.state, locale);

  // Keep this pure and bounded: this component has no write-capable callback.
  // `classifyGoalSurfaceStatus` is intentionally called with the already
  // observed status only to keep this card's labels aligned with Continuity.
  const observedSurface = classifyGoalSurfaceStatus({
    runStatus: goal.runStatus,
    blockedReason: goal.blockedReason,
    wait: goal.wait,
    invocation: continuity.invocation,
    automations: rows,
    observationFresh: true,
    effectObservationChecking: goal.effectObservation === "checking",
  });
  const surfaceConsistent = observedSurface.state === surface.state;

  return <details className={styles.root} data-goal-strategy-status="true" data-strategy-observation={dataObservation}>
    <summary>
      <strong>{ko ? "전략 · 다음 주기" : "Strategy · next cycle"}</strong>
      <span>{strategyStateLabel(status, ko)}</span>
    </summary>
    <div className={styles.body}>
      <p className={styles.state} data-strategy-state={status ?? "pending"}>
        <strong>{ko ? "Goal 실행 상태" : "Goal execution state"}</strong>
        <span>{surfaceConsistent ? surfaceLabel : (ko ? "상태 재확인 중" : "Rechecking execution state")}</span>
      </p>
      {strategy ? <>
        <p><strong>{ko ? "이번 주기 판단" : "This cycle"}</strong> · {strategyStateLabel(strategy.state, ko)}</p>
        <p><strong>{ko ? "다음 행동" : "Next action"}</strong> · {nextActionLabel(strategy.nextAction, ko)}</p>
        <p className={styles.metrics}>
          {ko ? "검증 결과" : "Verification"} · {ko ? "통과" : "passed"} {strategy.metrics.passed}
          {` · ${ko ? "수리 가능 실패" : "repairable failures"} ${strategy.metrics.repairableFailed}`}
          {` · ${ko ? "증거 미확정" : "inconclusive"} ${strategy.metrics.inconclusive}`}
        </p>
      </> : <p>{ko ? "아직 정착된 주기 평가가 없습니다. 다음 실행 결과가 확인되면 표시됩니다." : "No settled cycle evaluation is available yet. It will appear after the next result is verified."}</p>}
      <p className={styles.next}>
        <strong>{ko ? "다음 주기" : "Next cycle"}</strong> · {nextWake
          ? (ko ? `${nextWake}에 확인 예정` : `check expected ${nextWake}`)
          : (ko ? "예약 시각 미확인" : "no confirmed time")}
        {goal.wait?.state === "pending" && ` · ${ko ? "앱 실행 중" : "while the app is running"}`}
      </p>
      <div className={styles.automations}>
        <strong>{ko ? "현재 자동화" : "Current automations"}</strong>
        <span>{ko ? `Goal 연결 확인 ${goalBound.length}` : `${goalBound.length} Goal-linked and verified`}</span>
        {unverified.length > 0 && <span>{ko ? `연결 미확인 ${unverified.length}` : `${unverified.length} link unverified`}</span>}
        {independent.length > 0 && <span>{ko ? `독립 예약 ${independent.length}` : `${independent.length} independent schedule(s)`}</span>}
        {rows.length === 0 && <span>{ko ? "등록된 자동화 없음" : "No automation recorded"}</span>}
        {rows.length > 0 && <ul>
          {rows.slice(0, 4).map((row) => <li key={row.automationId} data-automation-id={row.automationId}>
            <span>{row.relationship === "goal-bound" ? (ko ? "Goal 연계" : "Goal-linked")
              : row.relationship === "unverified" ? (ko ? "연결 미확인" : "link unverified")
                : (ko ? "독립" : "independent")}</span>
            <span>{automationLabel(row, ko)}</span>
            {row.nextRunAt && <time dateTime={row.nextRunAt}>{formatWhen(row.nextRunAt, locale)}</time>}
          </li>)}
          {rows.length > 4 && <li>{ko ? `외 ${rows.length - 4}개는 상세 상태에서 확인` : `${rows.length - 4} more in detailed status`}</li>}
        </ul>}
      </div>
      <p className={styles.disclaimer}>
        {ko
          ? "이 카드는 Main이 확인한 설명만 보여줍니다. 전략 변경 제안은 자동화나 Goal을 직접 수정하지 않으며, 적용은 별도의 명시적 검토·승인이 필요합니다."
          : "This card shows Main-verified observations only. A strategy suggestion does not modify the automation or Goal; applying a change requires an explicit review and approval."}
      </p>
    </div>
  </details>;
}
