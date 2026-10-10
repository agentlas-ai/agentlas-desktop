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
 * One turns cannot. They run inside the One personal domain (personal native
 * capabilities, vault credentials), which the daemon adopts when it runs; Desktop's
 * supervisor is then closed, and the ordinary One turn observer refuses a One turn
 * started on Desktop with supervisor_native_owner_required before anything runs
 * (production 1.2.90, 2026-10-10T23:17Z: every One message was refused). A One chat
 * therefore starts in the daemon, as before 1.2.89. An owner turn in a One Goal room
 * keeps its known first-turn gap there (goal_episode_admission_missing) until One
 * turns can carry Desktop Goal custody; the Goal's Desktop wake-ups still run.
 * A chat whose Goal is held elsewhere (Science, a non-Desktop host) also stays in the daemon.
 */
export function ownerTurnStartsOnDesktop(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  const chat = getChat(chatId);
  if (!chat) return false;
  const run = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
  if (run && (run.surface === "science" || run.hostOwnerKind !== "desktop")) return false;
  return chat.originSurface === "work";
}
