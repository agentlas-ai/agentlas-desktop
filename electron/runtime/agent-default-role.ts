import { getDb } from "../store/db";

/*
 * Which global model order an agent follows when the owner chose nothing for it: the Worker order, in a one-to-one chat
 * too. Decided from rows only. What keeps the Orchestrator order (exactly as before): the personal agent and the Work controller (the
 * agents a person talks to as "the" assistant), Work sessions, group rooms and the sessions of their members, delegated and teammate turns
 * (those name their own role), a Hub-called agent, a Science or Finance conversation (a screen pack's own), an automation ledger.
 * Only the one-to-one chat of an ordinary agent follows Worker. The Dashboard order is read at the turn; nothing is copied.
 */
const ASSISTANT_SLUGS = new Set(["agentlas-one", "agentlas-orchestrator"]);

/** The role an agent follows by default, by agent alone (what its profile shows). The personal agent and the Work controller start from Orchestrator. */
export function defaultRoleForAgent(agentId: string | null | undefined): "worker" | "orchestrator" {
  if (!agentId) return "orchestrator";
  try {
    const row = getDb().prepare("SELECT slug FROM installed_agents WHERE id = ?").get(agentId) as { slug?: string } | undefined;
    return row?.slug && ASSISTANT_SLUGS.has(row.slug) ? "orchestrator" : "worker";
  } catch { return "orchestrator"; }
}

/** The role this conversation's turn follows when its agent has nothing stored: "worker" only for the one-to-one chat of an ordinary agent. */
export function defaultRoleForChat(chatId: string | null | undefined): "worker" | "orchestrator" {
  if (!chatId) return "orchestrator";
  try {
    const db = getDb();
    const chat = db.prepare("SELECT agent_id AS agentId, kind, origin_surface AS surface, surface_pack AS pack, parent_chat_id AS parent, seat_kind AS seatKind FROM chats WHERE id = ?")
      .get(chatId) as { agentId: string; kind: string | null; surface: string | null; pack: string | null; parent: string | null; seatKind: string | null } | undefined;
    if (!chat || chat.surface !== "one" || (chat.kind !== "user" && chat.kind !== null) || chat.parent || chat.pack || chat.seatKind === "group") return "orchestrator";
    const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table));
    if (has("one_taskforces") && db.prepare("SELECT 1 FROM one_taskforces WHERE chat_id = ?").get(chatId)) return "orchestrator";
    if (has("one_supervisor_conversations") && db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE chat_id = ?").get(chatId)) return "orchestrator";
    if (has("one_personal_agent_rooms") && db.prepare("SELECT 1 FROM one_personal_agent_rooms WHERE chat_id = ? AND released_at IS NULL").get(chatId)) return "orchestrator";
    if (has("one_org_members") && db.prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id = ? AND source = 'hub' AND archived_at IS NULL").get(chat.agentId)) return "orchestrator";
    return defaultRoleForAgent(chat.agentId);
  } catch { return "orchestrator"; }
}
