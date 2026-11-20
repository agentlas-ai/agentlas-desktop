/**
 * Where the record cards of a conversation (hand-off cards, receipt rows) sit among its turns: by the time each was FIRST written, before the first entry written after it (they were all drawn after
 * the last turn, so a new turn read above an older hand-off card). A card older than the first drawn entry belongs to history that is folded away and is left out; with no drawn entry every card comes last.
 * A card whose time cannot be read comes last with the rest. Pure: the caller owns the entries.
 */
export interface TimelineCard { id: string; text: string; createdAt: string; /** A received-work row of the supervisor snapshot (drawn by the screen, not from `text`). */ delegationId?: string }
export function mergeCardsIntoTimeline<E extends { card?: TimelineCard }>(
  entries: readonly E[], cards: readonly TimelineCard[], entryAt: (entry: E) => number,
): Array<E | { card: TimelineCard }> {
  const firstAt = entries.map(entryAt).find(Number.isFinite);
  const pending = cards
    .filter((card) => firstAt === undefined || !Number.isFinite(Date.parse(card.createdAt)) || Date.parse(card.createdAt) >= firstAt)
    .sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
  if (!pending.length) return [...entries];
  const merged: Array<E | { card: TimelineCard }> = [];
  for (const entry of entries) {
    const at = entryAt(entry);
    while (pending.length && Number.isFinite(at) && Date.parse(pending[0].createdAt) <= at) merged.push({ card: pending.shift()! });
    merged.push(entry);
  }
  for (const card of pending) merged.push({ card });
  return merged;
}
