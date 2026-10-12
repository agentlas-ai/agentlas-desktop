import type { GoalResumeConfirmation, GoalResumeReview } from "./types";

/** Called only by the explicit Continue button after showing the review. */
export function confirmGoalResumeReview(review: GoalResumeReview): GoalResumeConfirmation {
  return { runId: review.runId, version: review.version,
    ...(review.automationOwnership ? { automationOwnership: { ...review.automationOwnership, acknowledged: true as const } } : {}) };
}
