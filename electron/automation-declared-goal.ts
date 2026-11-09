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

const GOAL_TEXT_MAX = 1_000;
/** The run's own instruction, when the automation has no saved goal: it defines the replies the run may give (for example "[quiet]"). */
const INSTRUCTION_TEXT_MAX = 900;

function owningGoalRevision(a: Pick<Automation, "id" | "goalId">) {
  const goalId = readCurrentGoalAutomationBinding(a.id)?.goalId
    ?? a.goalId
    ?? getAutomationStrategyGoalOrigin(a.id)?.goalId
    ?? null;
  return goalId ? getChatGoalRevision(goalId) : null;
}

/**
 * Is this automation one episode of an ongoing Goal (retained until the owner stops it)? Machine
 * field only (the revision's lifecycle), resolved exactly as the judge's declared goal is. An ongoing
 * Goal is never "met" by one run, so an accepted run with no outward effect is a hold
 * (persistence-ledger.ts). Unreadable → false: the stricter rule never applies by guess.
 */
export function automationServesOngoingGoal(a: Pick<Automation, "id" | "goalId">): boolean {
  try {
    return owningGoalRevision(a)?.lifecycle === "ongoing";
  } catch {
    return false;
  }
}

export function declaredGoalForAutomation(a: Pick<Automation, "id" | "name" | "goal" | "goalId"> & { promptTemplate?: string | null }): DeclaredAutomationGoal {
  const saved = String(a.goal ?? "").trim();
  if (saved) return { name: a.name ?? null, goal: saved };
  // With no saved goal the judge used to see a name and, at best, the owning Goal. It never saw what the run was told to do, so a reply the
  // instruction itself defines ("nothing changed: answer exactly [quiet]") read as "no result in the record" and went to the owner every
  // 15 minutes (64 of 103 needs_input rows of one tracker, a real installation).
  const instruction = String(a.promptTemplate ?? "").replace(/\s+/g, " ").trim();
  const instructionLine = instruction && instruction !== String(a.name ?? "").trim()
    ? `Instruction given to every run: ${instruction.slice(0, INSTRUCTION_TEXT_MAX)}` : null;
  try {
    const revision = owningGoalRevision(a);
    if (!revision) return { name: a.name ?? null, goal: instructionLine };
    const lifecycle = revision.lifecycle === "ongoing"
      ? "ongoing (retained until the owner stops it; each run is one episode toward it)"
      : "finite";
    const objective = revision.objective.replace(/\s+/g, " ").trim().slice(0, GOAL_TEXT_MAX);
    const owning = `Owning Goal (revision ${revision.revision}, ${lifecycle}): ${objective}`;
    return { name: a.name ?? null, goal: instructionLine ? `${instructionLine}\n${owning}` : owning };
  } catch {
    return { name: a.name ?? null, goal: instructionLine };
  }
}
