import { GOAL_OWNER_QUESTION_REASONS } from "./goal-display-state";

/**
 * The owner-facing sentence for why a goal continuation hard-stopped.
 *
 * The goal ledger decides with typed codes (goal_blocked, budget_*, …) and a
 * typed blocked reason. Those codes used to be pasted into the goal chat as
 * the notice body: owner Youtube launch 2026-09-28 11:46Z and X Marketing
 * 2026-09-27 21:46Z both read "goal_blocked · goal_owner_answer_required".
 * The codes stay in the ledger and run events; the chat gets a sentence that
 * says what happened and what the owner can do. Unknown codes get a neutral
 * sentence instead of the raw code.
 */
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
