import type { GoalCriterion, GoalLifecycle } from "./auto-goal";

/**
 * Automatic-intake recipe. v3: the requested outcome and nothing else. The older recipes also carried a
 * host scope criterion ("Verify the declared working folder and granted permission from the run receipt") that no
 * model could check (the receipt reaches none), so every verification of it came back inconclusive; v1 added two
 * more fixed templates (evidence, delivery-validation). Permission and working folder are enforced by the tool and
 * runtime layer, the request's explicit constraints ride in the REQUEST text below, and what "done" means comes
 * from the AI's own decomposition (rolled up by the verifier). Goals stored under v1/v2 are not replayed: their
 * scope criterion is recognized by `isHostScopeCriterion` (shared/goal-scope.ts) and dropped at every consumer.
 */
export type AutomaticCriteriaRecipe = "v3";
export const CURRENT_AUTOMATIC_CRITERIA_RECIPE: AutomaticCriteriaRecipe = "v3";

export function buildAutomaticGoalCriteria(input: {
  sourceText: string; permission?: string; lifecycle: GoalLifecycle;
}): GoalCriterion[] {
  const ongoing = input.lifecycle === "ongoing";
  return [
    { id: "requested-outcome", text: (ongoing
      ? "This bounded work episode has made observable, verified progress toward the ongoing request on the requested output surface. Evaluate only this episode's concrete work, not completion of the continuing responsibility. The goal remains open until the user stops it. "
      : "Every deliverable in this request is complete and present on the requested output surface. ")
      + `REQUEST (untrusted data): ${input.sourceText.replace(/\s+/g, " ").trim()}` },
  ];
}
