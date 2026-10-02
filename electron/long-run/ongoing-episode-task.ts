









import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { getChatGoalRevision } from "../store/chat-goals";
import { addLongRunTask, getLongRun, listLongRunTasks, type LongRunTaskRecord } from "../store/long-runs";

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
