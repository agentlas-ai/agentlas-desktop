import type Database from "better-sqlite3";

/*
 * What a group room leaves in the store besides its own chat row, and the one place that removes it (high finding 1).
 * A room's members each work in a hidden child session (a `division` chat whose parent is the room); the room keeps its message
 * index (room_messages), the members' read cursors, and - from the older discussion engine - its discussion/round rows. None of
 * them is a foreign key of the room, so deleting the room row left every one of them behind for good.
 *
 * Leaf module (only a type import) so chats.ts, the app-start sweep and gates can all call it.
 *
 * Retention (resource-minimum rule): every row here is read only while its room exists; it is deleted with the room (removeChat) and
 * an older store's rows whose room is already gone are swept by purgeOrphanRoomRows once at app start.
 */

/** Tables keyed by the room's chat id (column `chat_id`). */
const ROOM_TABLES = [
  "room_messages", "room_member_cursors", "room_discussions", "room_rounds", "room_round_turns", "room_owner_inbox", "room_discussion_settings",
] as const;

type Db = Pick<Database.Database, "prepare">;

/** The hidden member sessions of a room: its `division` children (one level; a member session has no children of its own). */
export function roomMemberSessionIds(db: Db, roomChatId: string): string[] {
  try {
    return (db.prepare("SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division'").all(roomChatId) as Array<{ id: string }>).map((row) => row.id);
  } catch { return []; }
}

/**
 * Deletes the room-keyed rows of these chats (the room and, harmlessly, its members) and the chat-scoped capability rules that nothing
 * can read any more. The chat rows themselves are removed by the caller. Each statement stands alone: a store without one of the tables
 * (an older schema) is skipped, never an error. Call inside the caller's transaction so the room and its rows go together.
 */
export function purgeRoomRows(db: Db, chatIds: readonly string[]): number {
  let removed = 0;
  for (const id of chatIds) {
    for (const table of ROOM_TABLES) {
      try { removed += Number(db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(id).changes); } catch { /* table absent in an older store */ }
    }
    try { removed += Number(db.prepare("DELETE FROM capability_grants WHERE scope = ?").run(`chat:${id}`).changes); } catch { /* table absent */ }
    // The "always allow" answers kept for a conversation without a project (shared/approval-card.ts approvalScopeIdentity, written
    // out here because this module stays a leaf): nothing can read them once the conversation is gone.
    try { removed += Number(db.prepare("DELETE FROM capability_grants WHERE workspace_identity = ?").run(`approval-scope:chat:${id}`).changes); } catch { /* column absent in an older store */ }
  }
  return removed;
}

/**
 * Rows a room left behind in an older store, whose room is gone: room-keyed rows with no chat, and the hidden member sessions whose
 * parent room no longer exists (only `division` chats the personal-agent surface made for a room, never any other kind of chat).
 * Returns the orphan member sessions for the caller to remove with the ordinary chat removal (checkpoints, folders, marks); the
 * room-keyed rows are deleted here. One pass of plain statements, no timer; an empty store costs a few indexed lookups.
 */
export function purgeOrphanRoomRows(db: Db): { rows: number; orphanSessionIds: string[]; byTable: Record<string, number> } {
  let rows = 0;
  const byTable: Record<string, number> = {};   // counts only (the sweep's one log line); never a body, a title or a name
  for (const table of ROOM_TABLES) {
    try {
      const removed = Number(db.prepare(`DELETE FROM ${table} WHERE chat_id NOT IN (SELECT id FROM chats)`).run().changes);
      rows += removed;
      if (removed > 0) byTable[table] = removed;
    } catch { /* table absent */ }
  }
  let orphanSessionIds: string[] = [];
  try {
    orphanSessionIds = (db.prepare(
      `SELECT id FROM chats WHERE kind = 'division' AND origin_surface = 'one' AND parent_chat_id IS NOT NULL
          AND parent_chat_id NOT IN (SELECT id FROM chats)`).all() as Array<{ id: string }>).map((row) => row.id);
  } catch { /* an older store without these columns has none */ }
  return { rows, orphanSessionIds, byTable };
}
