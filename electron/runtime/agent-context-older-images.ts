/**
 * Which images from EARLIER turns are sent again with a turn (the stateless API runtimes replay the journal every turn,
 * and a CLI session that lost its native state is bootstrapped the same way).
 *
 * Only the exchange just before this one: what the owner attached to their previous message, and the screenshots a tool
 * took after it. A direct follow-up ("and the button on the right?") still sees the picture. Anything older is not sent
 * again: the conversation text about it stays in the history.
 *
 * It used to be every image still in the replayable journal, attached to the current message with nothing saying which
 * turn it came from. Measured on the owner's personal agent: a one-line text question carried 23 attachments
 * from seven earlier turns (18.7 MB of base64, packed into 8 contact sheets, about 16,000 estimated tokens) on every
 * turn, and the answer spoke of "the screenshot you attached" although nothing was attached.
 */
export interface OlderImageEntry {
  seq: number;
  kind: string;
  eventId?: string;
  payload: Record<string, unknown>;
}
export interface OlderImage { mediaType: string; data: string; name?: string }

const TOOL_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The owner's own previous message: the latest input row that is not this turn, not superseded and not written by the host. */
export function previousOwnerInput(entries: readonly OlderImageEntry[], currentTurnId: string, superseded: ReadonlySet<string>): { turnId: string; seq: number } | null {
  let previous: { turnId: string; seq: number } | null = null;
  for (const entry of entries) {
    const turnId = entry.payload.turnId;
    if (entry.kind !== "message" || entry.payload.role !== "user" || typeof turnId !== "string") continue;
    if (entry.eventId !== "turn:" + turnId + ":input" || turnId === currentTurnId || superseded.has(turnId)) continue;
    if (typeof entry.payload.hostAuthored === "string" && entry.payload.hostAuthored) continue;
    if (!previous || entry.seq > previous.seq) previous = { turnId, seq: entry.seq };
  }
  return previous;
}

/** `entries` is the replayable part of the journal (after the last forward barrier). */
export function olderImagesForTurn(entries: readonly OlderImageEntry[], currentTurnId: string, superseded: ReadonlySet<string>): OlderImage[] {
  const previous = previousOwnerInput(entries, currentTurnId, superseded);
  if (!previous) return [];
  return entries.flatMap((entry): OlderImage[] => {
    if (entry.kind === "attachment" && entry.payload.turnId === previous.turnId
      && typeof entry.payload.mediaType === "string" && typeof entry.payload.data === "string") {
      return [{ mediaType: entry.payload.mediaType, data: entry.payload.data, ...(typeof entry.payload.name === "string" ? { name: entry.payload.name } : {}) }];
    }
    if (entry.kind === "tool" && entry.seq > previous.seq && entry.payload.turnId !== currentTurnId && typeof entry.payload.imageDataUrl === "string") {
      const match = TOOL_IMAGE.exec(entry.payload.imageDataUrl);
      if (match) return [{ mediaType: match[1], data: match[2] }];
    }
    return [];
  });
}
