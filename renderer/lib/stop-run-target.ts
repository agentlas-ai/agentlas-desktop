/*
 * Which run a Stop press ends - one rule, here.
 *
 * The screen only knows the id of a run it started itself. A run Main started on its own - the continuation of a question the person answered or skipped,
 * a Goal's next pass, a message another conversation sent - has no id here, and Stop pressed during it did nothing but look at an unsent message: three more
 * answers were written within 30 seconds after the person pressed Stop. Main knows which turn is current for a chat
 * (invoke.currentTurn), so a Stop with no local id asks it, and ends that turn through the same cancel every Stop uses.
 */
export interface CurrentTurnBridge { currentTurn?: (chatId: string) => Promise<{ runId?: string | null } | null | undefined> }

export async function resolveStopRunId(local: string | null | undefined, chatId: string | null | undefined, bridge: CurrentTurnBridge | null | undefined): Promise<string | null> {
  if (typeof local === "string" && local) return local;
  if (!chatId || typeof bridge?.currentTurn !== "function") return null;
  try {
    const turn = await bridge.currentTurn(chatId);
    return typeof turn?.runId === "string" && turn.runId ? turn.runId : null;
  } catch { return null; }
}
