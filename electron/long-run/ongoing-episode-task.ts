/**
 * An ongoing Goal always has an open task for the episode that is about to run.
 *
 * Measured 2026-09-27 (owner's One "Thread Marketing" goal, read-only copy of the store): its only task for the
 * current revision (task:goal-revision:3) failed on 09-22, and every later turn — user resumes, observation resumes —
 * ran with no open task. The invocation service binds the controller attempt only to an open task, so none of those
 * turns had a long_run_worker_attempts row, and the cycle wait was refused with goal_wait_attempt_missing (hidden
 * behind goal_wait_effects_uncertain, which is checked first). The wait-wake path already opens `task:ongoing:<waitId>`
 * for this case; every other way an ongoing episode starts now does the same, keyed by the invocation.
 */
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
