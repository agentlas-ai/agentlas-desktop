import { GOAL_OWNER_QUESTION_REASONS, GOAL_OWNER_REVIEW_REASONS } from "./goal-display-state";












export function goalStopReasonText(
  reason: string | null | undefined,
  blockedReason: string | null | undefined,
  locale: "ko" | "en",
): string {
  const ko = locale === "ko";
  if (GOAL_OWNER_QUESTION_REASONS.has(blockedReason ?? "")) {
    return ko
      ? "목표가 오너님의 답을 기다리고 있어 멈췄습니다. 이 대화에 남긴 질문에 답해 주시면 이어갑니다."
      : "The goal stopped because it is waiting for your answer. Reply to its question in this conversation and it continues.";
  }
  if (GOAL_OWNER_REVIEW_REASONS.has(blockedReason ?? "")) {
    return ko
      ? "완료 근거가 부족해 자동 이어가기를 멈췄습니다. 목표 패널의 현재 완료 조건을 검토하고, 이 대화에 근거를 보내거나 목표를 수정한 뒤 재개해 주세요."
      : "Automatic continuation stopped without enough completion evidence. Review the current criteria in the Goal panel, send evidence in this conversation or edit the goal, then select Resume.";
  }
  switch (reason) {
    case "goal_terminal":
      return ko ? "이 목표는 이미 끝난 상태라 더 이어가지 않습니다." : "This goal has already ended, so it does not continue.";
    case "goal_paused":
      return ko ? "목표가 일시정지 상태라 이어가지 않았습니다." : "The goal is paused, so it did not continue.";
    case "budget_wallclock_exhausted":
      return ko ? "목표에 정한 시간 한도를 다 써서 멈췄습니다." : "The goal used up its time limit and stopped.";
    case "budget_cycles_exhausted":
      return ko ? "목표에 정한 반복 횟수 한도를 다 써서 멈췄습니다." : "The goal used up its allowed number of passes and stopped.";
    case "budget_cost_exhausted":
      return ko ? "목표에 정한 비용 한도를 다 써서 멈췄습니다." : "The goal used up its cost limit and stopped.";
    case "budget_cost_unavailable":
      return ko ? "비용을 잴 수 없어 비용 한도를 지킬 수 없으므로 멈췄습니다." : "The goal stopped because its cost could not be measured against its cost limit.";
    default:
      return ko ? "목표가 막힘 상태라 이어가기를 멈췄습니다." : "The goal is blocked, so its continuation stopped.";
  }
}
