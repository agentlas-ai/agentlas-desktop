/*
 * Which composer a decision card (a question, a key request, a browser approval) is drawn above - one rule, here.
 *
 * A card belongs to the conversation that asked (its scope stamp's chat, computed once by Main): it is drawn in that conversation's own composer
 * slot and nowhere else. A room's member session asks in the room's name, so the room's slot takes it. A card whose conversation has no slot on
 * screen is not drawn above any other conversation's input - not in a new chat's start box, not in One's own composer, not in a personal
 * composer: the portal then leaves it where it was written (the app-wide sheet / the surface that raised it). A card that names no conversation
 * (an API-key request, a strategy question, an `ask_user` with no chat) belongs to no conversation's composer at all: it goes to the app-wide sheet.
 * The old "focused pane, else the newest slot" choice for it is gone: it put a question of conversation X above a new chat's input and held that
 * turn.
 *
 * Pure: slots are described, nothing is read from the document here.
 */
export interface DecisionSlotInfo {
  /** The conversation this composer belongs to; null for a composer that is tied to none. A slot tied to none takes no card. */
  chat: string | null;
  /** A composer for a conversation that does not exist yet (the start box of a new chat). It takes no card at all. */
  draft?: boolean;
}

export function pickDecisionSlot<T extends DecisionSlotInfo>(
  slots: readonly T[],
  owner: string | null | undefined,
  options: { roomOf: (chatId: string) => string | null; focus?: string | null },
): T | null {
  if (!owner) return null;
  const room = options.roomOf(owner);
  const own = slots.filter((slot) => !slot.draft && slot.chat !== null && (slot.chat === owner || slot.chat === room));
  return own.length > 0 ? own[own.length - 1] : null;
}

/**
 * The cards to draw when each conversation may show one: the first request of every owner (a room and its member sessions are one owner), in arrival
 * order; a request that names no conversation shares one owner. The window used to hold a single card, so a second conversation's question waited
 * invisibly behind the first.
 */
export function firstRequestPerOwner<T extends { chatId?: string | null }>(requests: readonly T[], roomOf: (chatId: string) => string | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const request of requests) {
    const owner = request.chatId ? roomOf(request.chatId) ?? request.chatId : "\0orphan";
    if (seen.has(owner)) continue;
    seen.add(owner);
    out.push(request);
  }
  return out;
}
