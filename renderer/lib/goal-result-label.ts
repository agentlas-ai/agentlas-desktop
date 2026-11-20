import type { GoalResultPresentation } from "../../shared/goal-result";

/** The one line above an answer the host has not confirmed, in what the person can do with it; "" when there is nothing to say. */
export function goalResultLabel(result: GoalResultPresentation | undefined, locale: string): string {
  const showReport = Boolean(result && result.status !== "verified" && !(result.status === "pending" && !result.runId));
  if (!showReport || !result) return "";
  const ko = locale === "ko";
  if (result.verificationState === "not_requested") return ko ? "결과 · 확인 안 함" : "Result · not checked";
  // Only a measured failure says "did not pass"; the model's own judgment or an unfinished check never borrows it.
  if (result.verificationState === "inconclusive") return ko ? "결과 · 앱은 확인 못 함" : "Result · app could not check";
  if (result.status === "legacy") return ko ? "이전 결과 · 확인 여부 모름" : "Earlier result · unknown";
  if (result.status === "pending") return ko ? "결과 · 확인 중" : "Result · checking";
  if (result.verificationState === "failed") return ko ? "결과 · 기준 미달" : "Result · did not pass";
  return ko ? "결과 · 확인 안 끝남" : "Result · check unfinished";
}
