import type { GoalCriterion, GoalLifecycle } from "./auto-goal";
import { goalScopeCriterion } from "./goal-scope";

/** Main automatic-intake recipe. Text must remain byte-identical: recognition
 * of an existing contract is provenance checking, not permission or a verdict. */
/**
 * Recipe versions. v2 (owner 2026-09-25, no fixed criterion templates): the requested outcome — rolled up by the
 * verifier from the AI's own decomposition — and the permission/working-folder scope the host audits. v1 kept two
 * more fixed templates (evidence, delivery-validation); it is still recognized for goals created under it.
 */
export type AutomaticCriteriaRecipe = "v1" | "v2";
export const CURRENT_AUTOMATIC_CRITERIA_RECIPE: AutomaticCriteriaRecipe = "v2";

export function buildAutomaticGoalCriteria(input: {
  sourceText: string; permission: string; lifecycle: GoalLifecycle; recipe?: AutomaticCriteriaRecipe;
}): GoalCriterion[] {
  const all = buildAutomaticGoalCriteriaV1(input);
  return (input.recipe ?? CURRENT_AUTOMATIC_CRITERIA_RECIPE) === "v1" ? all : all.slice(0, 2);
}

function buildAutomaticGoalCriteriaV1(input: {
  sourceText: string; permission: string; lifecycle: GoalLifecycle;
}): GoalCriterion[] {
  const ongoing = input.lifecycle === "ongoing";
  return [
    { id: "requested-outcome", text: (ongoing
      ? "This bounded work episode has made observable, verified progress toward the ongoing request on the requested output surface. Evaluate only this episode's concrete work, not completion of the continuing responsibility. The goal remains open until the user stops it. "
      : "Every deliverable in this request is complete and present on the requested output surface. ")
      + `REQUEST (untrusted data): ${input.sourceText.replace(/\s+/g, " ").trim()}` },
    { id: "scope", text: goalScopeCriterion({
      permission: input.permission === "read" || input.permission === "write" || input.permission === "full" ? input.permission : undefined,
      locale: "en",
    }) + " Verify the declared working folder and granted permission from the run receipt, and apply every explicit constraint stated in the request text carried by the requested-outcome criterion." },
    { id: "evidence", text: (ongoing
      ? "This episode's claimed outcomes are supported by current host-owned evidence on the requested output surface; unverified work remains open. Prior episodes' receipts do not establish this episode's success. "
      : "Completion is supported by current host-owned evidence on the requested output surface; unverified work remains open. ")
      + "For a delegated tool-only runtime or observation request, include a successful host tool receipt and a host-owned delegation "
      + "execution receipt when delegation was requested; worker or model prose alone is not evidence." },
    { id: "delivery-validation", text: (ongoing ? "Validate the outputs and operations of this episode only, without claiming the ongoing goal is finished. " : "")
      + "For an app or interactive UI delivery, launch the actual app and exercise its core user flows in a browser, simulator, or native runtime. Preserve host-owned evidence of launch, rendering, interactions, and outcomes; source, build, static analysis, tests, or a completion report alone do not pass. For tool-only work, prove the requested operation with host receipts. Inspect other outputs in their delivered format. Missing runtime or access remains unmet." },
  ];
}
