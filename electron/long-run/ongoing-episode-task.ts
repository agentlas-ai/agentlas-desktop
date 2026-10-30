









import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { getChatGoalRevision, getArmedChatGoalContract } from "../store/chat-goals";
import { getChat } from "../store/chats";
import { getDb } from "../store/db";
import { addLongRunTask, getLongRun, listLongRunTasks, getLongRunGoalRevisionBinding, longRunOwnerHold, type LongRunTaskRecord } from "../store/long-runs";

export function ensureOngoingEpisodeTask(input: { longRunId: string; invocationRunId: string }): LongRunTaskRecord | null {
  const run = getLongRun(input.longRunId);
  if (!run || run.surface === "science" || LONG_RUN_TERMINAL_STATUSES.has(run.status)) return null;
  const open = listLongRunTasks(run.id, true);
  if (open.length) return open[0];
  if (getChatGoalRevision(run.goalId)?.lifecycle !== "ongoing") return null;
  return addLongRunTask({ runId: run.id, id: `task:ongoing:${input.invocationRunId}`, title: "Next ongoing work cycle",
    objective: run.objective, acceptanceCriteria: run.acceptanceCriteria,
    criterionIndices: run.acceptanceCriteria.map((_, index) => index) });
}

/** A live Goal may need another controller after all earlier tasks closed.
 * Keep those task receipts intact; the same active revision owns the new task.
 * This creates no continuation authority and never resumes a stopped Goal. */
export function ensureGoalEpisodeTask(input: { longRunId: string; invocationRunId: string; rootChatId: string }): LongRunTaskRecord | null {
  return getDb().transaction(() => {
    const run = getLongRun(input.longRunId);
    if (!run || run.status !== "running" || !["one", "work"].includes(run.surface)
      || run.rootChatId !== input.rootChatId || run.hostOwnerKind !== "desktop" || run.executionLocation !== "desktop-local"
      || longRunOwnerHold(run.id) || getChat(input.rootChatId)?.goalId !== run.goalId) return null;
    const open = listLongRunTasks(run.id, true);
    if (open.length) return open[0];
    const revision = getChatGoalRevision(run.goalId);
    if (!revision || revision.chatId !== input.rootChatId || !getArmedChatGoalContract(run.goalId)
      || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) return null;
    return addLongRunTask({ runId: run.id,
      id: `task:${revision.lifecycle === "ongoing" ? "ongoing" : "episode"}:${input.invocationRunId}`,
      title: run.objective.slice(0, 240), objective: run.objective, acceptanceCriteria: run.acceptanceCriteria,
      criterionIndices: run.acceptanceCriteria.map((_, index) => index) });
  }).immediate();
}
