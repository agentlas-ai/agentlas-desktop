import type { GoalResumeConfirmation, GoalResumeReview } from "./types";

/** The Main process accepts only a review of the exact current attempt set. */
export function matchesGoalResumeReview(
  review: Pick<GoalResumeReview, "runId" | "version" | "attemptSetDigest" | "attemptIds" | "automationOwnership">,
  submitted: GoalResumeConfirmation | undefined,
): boolean {
  if (!submitted || submitted.runId !== review.runId || submitted.version !== review.version
    || submitted.attemptSetDigest !== review.attemptSetDigest
    || !Array.isArray(submitted.attemptIds) || !Array.isArray(submitted.reviewedAttemptIds)) return false;
  const expectedOwner = review.automationOwnership;
  const submittedOwner = submitted.automationOwnership;
  if (expectedOwner) {
    if (!submittedOwner || submittedOwner.acknowledged !== true
      || Object.keys(expectedOwner).some((key) => expectedOwner[key as keyof typeof expectedOwner]
        !== submittedOwner[key as keyof typeof expectedOwner])) return false;
  } else if (submittedOwner !== undefined) return false;
  return JSON.stringify(submitted.attemptIds) === JSON.stringify(review.attemptIds)
    && JSON.stringify(submitted.reviewedAttemptIds) === JSON.stringify(review.attemptIds);
}

/** Called only by the explicit Continue button after showing the review. */
export function confirmGoalResumeReview(review: GoalResumeReview): GoalResumeConfirmation {
  return { runId: review.runId, version: review.version, attemptIds: review.attemptIds,
    attemptSetDigest: review.attemptSetDigest, reviewedAttemptIds: review.attemptIds,
    ...(review.automationOwnership ? { automationOwnership: { ...review.automationOwnership, acknowledged: true as const } } : {}) };
}
