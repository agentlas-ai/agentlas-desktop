import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";

/**




























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
