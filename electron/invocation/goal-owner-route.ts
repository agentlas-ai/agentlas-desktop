import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";

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
 * Any One/Work turn can bind a Goal, not only a chat that already has one: a
 * message to a stopped Goal resumes it (stoppedGoalMessageReopens), a goal chip
 * gets its ledger row during the first turn, and automatic intake may admit a Goal
 * mid-turn. So an owner turn in a chat that can hold Desktop Goal custody starts on
 * Desktop, where the Goal's own host wake-ups already run. Only a chat whose Goal is
 * held elsewhere (Science, a non-Desktop host) may start in the daemon.
 */
export function ownerTurnCanBindGoal(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  const chat = getChat(chatId);
  if (!chat) return false;
  const run = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
  if (run && (run.surface === "science" || run.hostOwnerKind !== "desktop")) return false;
  return chat.originSurface === "one" || chat.originSurface === "work";
}
