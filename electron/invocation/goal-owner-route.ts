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
 * Any Work turn can bind a Goal, not only a chat that already has one: a message
 * to a stopped Goal resumes it (stoppedGoalMessageReopens), a goal chip gets its
 * ledger row during the first turn, and automatic intake may admit a Goal mid-turn.
 * So a Work owner turn starts on Desktop, where the Goal's own host wake-ups run.
 *
 * A goal-free One chat cannot. Its turns run inside the One personal domain
 * (personal native capabilities, vault credentials), which the daemon adopts when it
 * runs; Desktop's supervisor is then closed, and the ordinary One turn observer refuses
 * a One turn started on Desktop with supervisor_native_owner_required before anything
 * runs (production 1.2.90, 2026-10-10T23:17Z: every One message was refused). So it
 * starts in the daemon.
 *
 * A One Goal room is held by Desktop, and its own wake-ups already run there as One
 * turns. Its owner turns start on Desktop too and run the same way, outside the
 * personal domain (observeOrdinaryOneNativeSource in one/supervisor.ts). In the daemon
 * they failed their first turn with goal_episode_admission_missing (room "Youtube
 * launch", 2026-10-08..11). A chat whose Goal ended, or is held elsewhere (Science, a
 * non-Desktop host), stays in the daemon.
 */
export function ownerTurnStartsOnDesktop(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  const chat = getChat(chatId);
  if (!chat) return false;
  const run = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
  if (run && (run.surface === "science" || run.hostOwnerKind !== "desktop")) return false;
  if (chat.originSurface === "work") return true;
  return chat.originSurface === "one" && run !== null && !GOAL_ENDED.has(run.status);
}

const GOAL_ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelling", "cancelled"]);

/** A One Goal room's owner turn, started on Desktop by ownerTurnStartsOnDesktop. */
export function oneGoalRoomTurnOnDesktop(chatId: unknown): boolean {
  if (!ownerTurnStartsOnDesktop(chatId)) return false;
  return getChat(chatId as string)?.originSurface === "one";
}
