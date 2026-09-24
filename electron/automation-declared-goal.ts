/**
 * What the outcome judge is told this automation was approved to do.
 *
 * `automations.goal` is empty for automations a Goal chat created or updated
 * in place (measured 2026-09-24: the Threads automation had goal = NULL while
 * its owning ongoing Goal carried the owner's growth mandate). The judge then
 * saw only the name, so a run that chose to hold was read as "the goal being
 * met". When the saved goal is empty, carry the owning Goal's current revision
 * instead: the verified binding first, then the monitor-origin Goal as
 * read-only context (never as authority).
 */
import type { Automation } from "../shared/types";
import { getChatGoalRevision } from "./store/chat-goals";
import { readCurrentGoalAutomationBinding } from "./long-run/automation-provenance";
import { getAutomationStrategyGoalOrigin } from "./store/automation-strategy-proposals";
import type { DeclaredAutomationGoal } from "./automation-result";

const GOAL_TEXT_MAX = 1_800;

export function declaredGoalForAutomation(a: Pick<Automation, "id" | "name" | "goal" | "goalId">): DeclaredAutomationGoal {
  const saved = String(a.goal ?? "").trim();
  if (saved) return { name: a.name ?? null, goal: saved };
  try {
    const goalId = readCurrentGoalAutomationBinding(a.id)?.goalId
      ?? a.goalId
      ?? getAutomationStrategyGoalOrigin(a.id)?.goalId
      ?? null;
    const revision = goalId ? getChatGoalRevision(goalId) : null;
    if (!revision) return { name: a.name ?? null, goal: null };
    const lifecycle = revision.lifecycle === "ongoing"
      ? "ongoing (retained until the owner stops it; each run is one episode toward it)"
      : "finite";
    const objective = revision.objective.replace(/\s+/g, " ").trim().slice(0, GOAL_TEXT_MAX);
    return {
      name: a.name ?? null,
      goal: `Owning Goal (revision ${revision.revision}, ${lifecycle}): ${objective}`,
    };
  } catch {
    return { name: a.name ?? null, goal: null };
  }
}
