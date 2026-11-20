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
    wait_observe: ko ? "다음 확인 대기" : "Wait",
    repair_verified_failure: ko ? "실패 고치기" : "Fix the failure",
    gather_missing_evidence: ko ? "자료 더 모으기" : "Gather more",
    hold_for_user: ko ? "당신의 결정 대기" : "Waiting for you",
    inspect_before_action: ko ? "먼저 상태 확인" : "Check first",
  };
  return labels[value];
}

function strategyStateLabel(
  state: NonNullable<NonNullable<ChatContinuitySnapshot["goal"]>["episodeStrategy"]>["state"] | null,
  ko: boolean,
): string {
  if (state === "changed") return ko ? "다음 행동 바뀜" : "Next step changed";
  if (state === "unchanged") return ko ? "그대로 유지" : "Unchanged";
  if (state === "unknown") return ko ? "확인 못 함 · 변경 없음" : "Unclear · no change";
  return ko ? "판단 대기" : "Not judged yet";
}

function automationLabel(
  row: ChatContinuitySnapshot["automations"][number],
  ko: boolean,
): string {
  if (!row.enabled) return ko ? "꺼짐" : "off";
  if (row.liveState === "running") return ko ? "최근 실행함" : "ran recently";
  if (row.liveState === "queued") return ko ? "대기 중" : "queued";
  if (row.nextRunAt) return ko ? "다음 실행 예약" : "next run set";
  return ko ? "상태 모름" : "state unknown";
}

// Read-only: a described episode strategy is not an applied change, and this card has no write callback.
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
  const observedSurface = classifyGoalSurfaceStatus({
    runStatus: goal.runStatus,
    pauseReason: goal.pauseReason,
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
      <strong>{ko ? "다음 단계" : "Next step"}</strong>
      <span>{strategyStateLabel(status, ko)}</span>
    </summary>
    <div className={styles.body}>
      <p className={styles.state} data-strategy-state={status ?? "pending"}>
        <strong>{ko ? "상태" : "State"}</strong>
        <span>{surfaceConsistent ? surfaceLabel : (ko ? "다시 확인 중" : "Rechecking")}</span>
      </p>
      {strategy ? <>
        <p><strong>{ko ? "이번 판단" : "Judgment"}</strong> · {strategyStateLabel(strategy.state, ko)}</p>
        <p><strong>{ko ? "다음" : "Next"}</strong> · {nextActionLabel(strategy.nextAction, ko)}</p>
        <p className={styles.metrics}>
          {ko ? "확인" : "Checks"} · {ko ? "통과" : "passed"} {strategy.metrics.passed}
          {` · ${ko ? "고칠 수 있는 실패" : "fixable"} ${strategy.metrics.repairableFailed}`}
          {` · ${ko ? "불확실" : "unclear"} ${strategy.metrics.inconclusive}`}
        </p>
      </> : <p>{ko ? "아직 판단 없음" : "No judgment yet"}</p>}
      <p className={styles.next}>
        <strong>{ko ? "다음 확인" : "Next check"}</strong> · {nextWake ? nextWake : (ko ? "시각 모름" : "time unknown")}
        {goal.wait?.state === "pending" && ` · ${ko ? "앱 켜둔 때만" : "app open only"}`}
      </p>
      <div className={styles.automations}>
        <strong>{ko ? "자동화" : "Automations"}</strong>
        <span>{ko ? `목표에 연결 ${goalBound.length}` : `${goalBound.length} linked`}</span>
        {unverified.length > 0 && <span>{ko ? `연결 불확실 ${unverified.length}` : `${unverified.length} unclear link`}</span>}
        {independent.length > 0 && <span>{ko ? `따로 ${independent.length}` : `${independent.length} separate`}</span>}
        {rows.length === 0 && <span>{ko ? "없음" : "None"}</span>}
        {rows.length > 0 && <ul>
          {rows.slice(0, 4).map((row) => <li key={row.automationId} data-automation-id={row.automationId}>
            <span>{row.relationship === "goal-bound" ? (ko ? "연결" : "linked")
              : row.relationship === "unverified" ? (ko ? "연결 불확실" : "unclear link")
                : (ko ? "따로" : "separate")}</span>
            <span>{automationLabel(row, ko)}</span>
            {row.nextRunAt && <time dateTime={row.nextRunAt}>{formatWhen(row.nextRunAt, locale)}</time>}
          </li>)}
          {rows.length > 4 && <li>{ko ? `+${rows.length - 4}` : `+${rows.length - 4}`}</li>}
        </ul>}
      </div>
    </div>
  </details>;
}
