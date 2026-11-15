import { createRoomDiscussionStore, type RoomDb } from "./room-discussion-store";
import type { RoomPost } from "./room-discussion-core";

/*
 * What a member sees of a room (Agentlas 2.0 item 4). `room_member_cursors` holds, per (room, member), the last
 * room sequence number the member has been shown:
 *   - a member that JOINED a room later has its cursor set to the room's latest number at that moment (agent-chat.ts), so it is
 *     shown only what is said after it joined;
 *   - a member with no cursor yet (the room's first agent, or a room made before cursors) is shown the last `recent` posts, then
 *     only the new ones;
 *   - a member that was taken out forgets its cursor, so coming back starts from "now" again.
 * This is the one reader of that table in the product path (the room-lead router); the writer is `markRoomSeen`.
 */

export const ROOM_RECENT_POSTS = 12;

function storeOf(db: () => RoomDb) {
  return createRoomDiscussionStore({ db, appendChatMessage: () => { throw new Error("room_member_view_is_read_only"); } });
}

export interface RoomView { posts: RoomPost[]; uptoSeq: number; cursor: number | null }

/** The posts this member has not been shown yet. Pure read besides the one-time seq index of an older room. */
export function readRoomForMember(db: () => RoomDb, chatId: string, agentId: string, options: { recent?: number } = {}): RoomView {
  const store = storeOf(db);
  const uptoSeq = store.log.maxSeq(chatId);
  const cursor = store.state.cursor(chatId, agentId);
  const recent = Math.max(0, Math.floor(options.recent ?? ROOM_RECENT_POSTS));
  const afterSeq = cursor ?? Math.max(0, uptoSeq - recent);
  return { posts: afterSeq >= uptoSeq ? [] : store.log.listPosts(chatId, { afterSeq, uptoSeq }), uptoSeq, cursor };
}

/** The member has now been shown everything up to `seq`. Never moves a cursor back. */
export function markRoomSeen(db: () => RoomDb, chatId: string, agentId: string, seq: number): void {
  storeOf(db).state.setCursor(chatId, agentId, seq);
}

/** A member joins at the room's current end. Runs inside the caller's transaction (a write on the caller's connection, no own transaction). */
export function startMemberFromNow(db: () => RoomDb, chatId: string, agentIds: readonly string[]): number {
  const store = storeOf(db);
  const seq = store.log.maxSeq(chatId);
  for (const agentId of agentIds) store.state.setCursor(chatId, agentId, seq);
  return seq;
}

/** A member leaves: its cursor goes, so a later return starts from "now". */
export function forgetMemberCursor(db: () => RoomDb, chatId: string, agentId: string): void {
  db().prepare("DELETE FROM room_member_cursors WHERE chat_id = ? AND member_agent_id = ?").run(chatId, agentId);
}
