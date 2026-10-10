import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";

/**
 * Goal custody is Desktop-only. A controller attempt is admitted by
 * admitGoalProducer (long-run/episode-disposition.ts), which requires the Goal's
 * hostOwnerKind "desktop" / executionLocation "desktop-local" and this process's
 * Desktop app-instance epoch, initialised only by Main's app-runtime coordinator.
 * The native daemon never initialises it, so a Goal-bound owner turn started there
 * has no producer admission and the dispatch check refuses it with
 * goal_episode_admission_missing (production 2026-10-10T18:33Z, room "Youtube
 * launch": an owner message to a user-paused Goal resumed the Goal in the ledger,
 * then failed in the daemon with no controller attempt).
 *
 * An owner message to a stopped Goal resumes it (stoppedGoalMessageReopens), so
 * the turn must run in the process that owns the Goal -- exactly where the Goal's
 * own host wake-ups already run. True when this chat is bound to a live Desktop
 * Goal.
 */
export function chatGoalRequiresDesktopOwner(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  const goalId = getChat(chatId)?.goalId;
  if (!goalId) return false;
  const run = getLongRunByGoalId(goalId);
  return Boolean(run && run.surface !== "science" && run.hostOwnerKind === "desktop"
    && !LONG_RUN_TERMINAL_STATUSES.has(run.status));
}
