import type { GoalResumeConfirmation, GoalResumeReview } from "./types";

/** The Main process accepts only a review of the exact current attempt set. */
export function matchesGoalResumeReview(
  review: Pick<GoalResumeReview, "runId" | "version" | "attemptSetDigest" | "attemptIds">,
  submitted: GoalResumeConfirmation | undefined,
): boolean {
  if (!submitted || submitted.runId !== review.runId || submitted.version !== review.version
    || submitted.attemptSetDigest !== review.attemptSetDigest
    || !Array.isArray(submitted.attemptIds) || !Array.isArray(submitted.reviewedAttemptIds)) return false;
  return JSON.stringify(submitted.attemptIds) === JSON.stringify(review.attemptIds)
    && JSON.stringify(submitted.reviewedAttemptIds) === JSON.stringify(review.attemptIds);
}
