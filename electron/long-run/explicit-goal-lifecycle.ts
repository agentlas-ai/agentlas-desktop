import { getDb } from "../store/db";
import { correctExplicitGoalLifecycle, getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId } from "../store/long-runs";
import type { GoalLifecycle } from "../../shared/auto-goal";

/**












 */
export const GOAL_LIFECYCLE_JUDGED_KIND = "run.goal_lifecycle_judged";

type IntakeJudge = typeof import("./judged-auto-goal-intent").resolveAutomaticGoalIntent;
let judgeOverride: IntakeJudge | null = null;
/** Test seam: a gate supplies the intake verdict without a model. */
export function setExplicitGoalLifecycleJudge(judge: IntakeJudge | null): void { judgeOverride = judge; }

export async function settleExplicitGoalLifecycle(goalId: string, options: { signal?: AbortSignal } = {}): Promise<GoalLifecycle | null> {
  const revision = getChatGoalRevision(goalId);
  if (!revision) return null;
  if (revision.revision !== 1 || revision.reason !== "explicit_goal_turn" || revision.lifecycle === "ongoing") return revision.lifecycle ?? null;
  const run = getLongRunByGoalId(goalId);
  if (!run) return null;
  const prior = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
    .get(run.id, GOAL_LIFECYCLE_JUDGED_KIND) as { payload_json: string } | undefined;
  if (prior) {
    let judged: unknown;
    try { judged = (JSON.parse(prior.payload_json) as { lifecycle?: unknown }).lifecycle; } catch { judged = null; }
    if (judged !== "ongoing") return "finite";
    correctExplicitGoalLifecycle(goalId);
    return getChatGoalRevision(goalId)?.lifecycle ?? null;
  }
  const judge = judgeOverride ?? (await import("./judged-auto-goal-intent")).resolveAutomaticGoalIntent;
  const decision = await judge(revision.originalRequest, { signal: options.signal });
  if (decision.classification !== "classified") return null;
  const lifecycle: GoalLifecycle = decision.intent === "execute" && decision.lifecycle === "ongoing" ? "ongoing" : "finite";
  appendLongRunEvent({ runId: run.id, kind: GOAL_LIFECYCLE_JUDGED_KIND, actorKind: "host",
    payload: { goalId, revision: 1, lifecycle, intent: decision.intent, sourceMessageId: revision.originalRequest.messageId } });
  if (lifecycle === "ongoing") correctExplicitGoalLifecycle(goalId);
  return getChatGoalRevision(goalId)?.lifecycle ?? null;
}
