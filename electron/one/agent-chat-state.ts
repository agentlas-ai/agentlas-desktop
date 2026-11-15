import type Database from "better-sqlite3";

/*
 * Whether a room can still take a message from the owner, and why not. Kept apart from agent-chat.ts so the owner-input guard
 * (personal-agent-rooms.ts assertOwnerMayWriteRoom) can read it without loading the room-making code.
 *
 * An agent that was deleted leaves the room readable (every earlier line keeps its speaker's name from the seat snapshot) but a
 * one-to-one room has nobody to answer: the chat row no longer names an agent, and a message sent anyway would be taken by the
 * root controller (the personal agent), which is not a member of this room (item 1). The screen offers "continue with
 * another agent" (a new Agent Chat in the same project).
 */

export const AGENT_CHAT_READ_ONLY = "agent_chat_read_only" as const;

/** `no_members`: a group room none of whose members is an installed, un-archived teammate any more (desktop 3, Workspace B-12): its lines stay readable, nobody can answer. */
export interface AgentChatState { readOnly: boolean; reason: "agent_deleted" | "room_dissolved" | "no_members" | null }

/** The members of a group room that can still be called: an installed agent that is on the org chart and not archived (the router's roster rule; a locked seat is a state that ends by itself and still counts). */
function liveGroupMemberCount(conn: Pick<Database.Database, "prepare">, chatId: string): number | null {
  try {
    const row = conn.prepare("SELECT member_agent_ids_json AS ids FROM one_taskforces WHERE chat_id = ?").get(chatId) as { ids: string } | undefined;
    if (!row) return null;
    let ids: unknown = [];
    try { ids = JSON.parse(row.ids); } catch { /* a damaged row names no one */ }
    if (!Array.isArray(ids)) return 0;
    let live = 0;
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      if (!conn.prepare("SELECT 1 FROM installed_agents WHERE id = ?").get(id)) continue;
      if (!conn.prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id = ? AND archived_at IS NULL LIMIT 1").get(id)) continue;
      live += 1;
    }
    return live;
  } catch { return null; } // a store without these tables knows no such room
}

export function agentChatState(chatId: string, db?: Pick<Database.Database, "prepare">): AgentChatState {
  const conn = db ?? (require("../store/db") as typeof import("../store/db")).getDb(); // eslint-disable-line @typescript-eslint/no-require-imports
  let row: { seatId: string | null; seatKind: string | null; origin: string | null; dissolvedAt: string | null; isGroup: number | null; agentId: string | null; kind: string | null } | undefined;
  try {
    row = conn.prepare(
      `SELECT c.seat_id AS seatId, c.seat_kind AS seatKind, c.origin_surface AS origin, s.dissolved_at AS dissolvedAt, c.agent_id AS agentId, c.kind AS kind,
              (SELECT 1 FROM one_taskforces tf WHERE tf.chat_id = c.id) AS isGroup
         FROM chats c LEFT JOIN one_seats s ON s.id = c.seat_id WHERE c.id = ?`,
    ).get(chatId) as typeof row;
  } catch {
    return { readOnly: false, reason: null }; // a store without the seat tables knows no such rooms
  }
  if (!row || row.origin !== "one" || row.kind === "division") return { readOnly: false, reason: null };
  if (row.dissolvedAt) return { readOnly: true, reason: "room_dissolved" };
  if (row.isGroup && liveGroupMemberCount(conn, chatId) === 0) return { readOnly: true, reason: "no_members" };
  if (!row.isGroup && row.seatKind === "solo" && row.seatId) {
    // The chat row may already be held by the root agent (agent deletion + root repair); the seat remembers who sat there.
    const last = conn.prepare("SELECT agent_id AS agentId FROM one_seat_occupants WHERE seat_id = ? ORDER BY since DESC, slot LIMIT 1").get(row.seatId) as { agentId: string | null } | undefined;
    // Only an agent-less room (NULL) or one the root agent holds can be a deleted agent's room; a seat shared with other rooms of an
    // agent that still exists is not.
    if (last?.agentId && !conn.prepare("SELECT 1 FROM installed_agents WHERE id = ?").get(last.agentId)) return { readOnly: true, reason: "agent_deleted" };
  }
  return { readOnly: false, reason: null };
}
