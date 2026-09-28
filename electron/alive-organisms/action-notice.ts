/**
 * The one owner-visible line an Alive (AGI) action leaves in its goal chat.
 *
 * Why: the owner asked "AGI 모드가 기존 골과 차이가 뭐냐, 왜 실감이 없지" (2026-09-28). Every wake was a no-tools
 * decision recorded only in alive_* tables, so even a real resume looked exactly like the goal resuming itself.
 * Only actions post (goal.continue resumed / effect check started); wait/review/deferred/failed post nothing.
 * The reason is built from the typed stop the action continued from, never from the model's prose.
 */
import type { GoalActionNotice } from "./goal-playground";

export const ALIVE_ACTION_NOTICE_AUTOMATION_ID = "alive-orchestrator";
export const aliveActionNoticeRunId = (actionId: string): string => `alive-action:${actionId}`;

const PAUSE_KO: Record<string, string> = {
  app_closed: "앱이 닫혀 멈춰 있었어요",
  runtime_unavailable: "실행할 모델을 쓸 수 없어 멈춰 있었어요",
  agent_paused: "작업이 도중에 멈춰 있었어요",
  crash_recovery: "앱이 비정상 종료돼 멈춰 있었어요",
};
const PAUSE_EN: Record<string, string> = {
  app_closed: "it had stopped when the app closed",
  runtime_unavailable: "it had stopped because no model could run",
  agent_paused: "it had stopped mid-task",
  crash_recovery: "it had stopped after the app crashed",
};

function why(from: GoalActionNotice["from"], locale: "ko" | "en"): string {
  if (from.status === "paused" && from.pauseReason && (locale === "ko" ? PAUSE_KO : PAUSE_EN)[from.pauseReason]) {
    return (locale === "ko" ? PAUSE_KO : PAUSE_EN)[from.pauseReason];
  }
  const code = from.blockedReason ?? from.pauseReason ?? from.status;
  return locale === "ko" ? `막혀 멈춰 있었어요 (${code})` : `it was stopped (${code})`;
}

/** automation-report body: first paragraph is the name (automation-report-display.ts), then the line. */
export function aliveActionNoticeText(notice: Pick<GoalActionNotice, "code" | "from">, locale: "ko" | "en"): string {
  const reason = why(notice.from, locale);
  const line = notice.code === "goal.continue-observing"
    ? (locale === "ko" ? `AGI가 멈춘 목표의 이전 작업이 반영됐는지 먼저 확인하기 시작했어요: ${reason}`
      : `AGI started checking whether the stopped goal's earlier work took effect: ${reason}`)
    : (locale === "ko" ? `AGI가 멈춘 목표를 다시 이어갔어요: ${reason}` : `AGI resumed the stopped goal: ${reason}`);
  return `AGI\n\n${line}`;
}
