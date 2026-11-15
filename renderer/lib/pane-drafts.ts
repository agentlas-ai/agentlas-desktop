/*
 * What a person has typed in a room pane's composer but not sent, kept per chat while the window lives (Space unmounts every
 * tab but the active one, so without this a tab switch threw the text away). Screen state only: memory, no storage, no table.
 *
 * Bounded: 16 chats (the most recently written are kept) and 200,000 characters each. A chat that is deleted or archived is
 * forgotten by Space when it notices (`forgetPaneDrafts`); sending clears the entry.
 */
const MAX_CHATS = 16;
const MAX_CHARS = 200_000;
const drafts = new Map<string, string>();

export function readPaneDraft(chatId: string): string {
  return drafts.get(chatId) ?? "";
}

export function writePaneDraft(chatId: string, text: string): void {
  drafts.delete(chatId); // re-insert so the Map's order is "least recently written first"
  if (!text) return;
  drafts.set(chatId, text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text);
  while (drafts.size > MAX_CHATS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/** Another account signed in: what the last one typed and did not send is not shown to this one. */
export function clearPaneDrafts(): void { drafts.clear(); }

export function forgetPaneDrafts(chatIds: Iterable<string>): void {
  for (const id of chatIds) drafts.delete(id);
}

export function paneDraftCountForTests(): number { return drafts.size; }
