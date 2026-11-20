import type { Chat } from "../../shared/types";
import { ISOLATED_CHILD_KEY_PREFIX, clearLeadRoom, clearOneTaskforceSessionScope, markIsolatedChat, markLeadRoom, purgeOrphanChatMarks } from "../runtime/session-scope";
import { createChat, getChat, renameChat } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { applySeatSnapshotToChats, dissolveSeat, ensureSoloSeatForAgent } from "../store/seats";
import { getDb } from "../store/db";
import { getProject } from "../store/projects";
import { currentUiLocale } from "../ui-locale";
import { assertManagedOneTeamAvailable } from "../managed-one/auth";
import { ensureOneOrgSeat } from "./org";
import type { RoomDb } from "./room-discussion-store";
import { forgetMemberCursor, startMemberFromNow } from "./room-member-view";
import { isPersonalAgentId, withoutPersonalAgents } from "./personal-agent-id";
import { agentChatState } from "./agent-chat-state";
import { composeOneTaskforceForChat, createAgentGroupRoom, currentGroupTitle, updateOneTaskforce } from "./taskforces";
import { oneDispatchSidebarPredicate } from "./dispatch-presentation";

/*
 * The new Agent Chat model (Agentlas 2.0 §4.2). A room is a `chats` row; the agent is a separate object that
 * is only SEATED to take part:
 *   - every new Agent Chat is a NEW row. Nothing here looks for "the agent's room" (the old getOrCreate* are untouched and
 *     now only see rooms that belong to no project);
 *   - the room may belong to a project (`chats.project_id`);
 *   - a solo room is born with the isolation mark, so its journal and native session are its own (runtime/session-scope.ts);
 *     a group room already has its own scope (bindOneTaskforceSessionScope);
 *   - seating an agent writes ONE `one_org_members` row and nothing else (no conversation, no folder, no installed copy),
 *     and is idempotent.
 * No table or column is added.
 */

export type AgentChatReceipt = import("../../shared/types").AgentChatReceipt;

const ko = (): boolean => currentUiLocale() === "ko";

function cleanProjectId(projectId: unknown): string | null {
  return typeof projectId === "string" && projectId.trim() && getProject(projectId.trim()) ? projectId.trim() : null;
}

function cleanTitle(title: unknown): string {
  return typeof title === "string" ? title.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

const EMPTY_ROOM = `c.origin_surface = 'one' AND c.kind = 'user' AND c.archived_at IS NULL AND c.parent_chat_id IS NULL AND c.used_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id)`;

/**
 * A room that was made and never used is the room the next Create opens (item 5): the same agent(s) and project, no
 * message, never sent to. Creating another would pile up rooms nobody opened, and there is no cleanup loop to remove them. The
 * room keeps its id; its "just made" grace in the Home tree starts again so the owner can find it.
 */
function reuseEmptyRoom(db: ReturnType<typeof getDb>, chatId: string): Chat {
  db.prepare("UPDATE chats SET created_at = ?, updated_at = ? WHERE id = ? AND used_at IS NULL").run(new Date().toISOString(), new Date().toISOString(), chatId);
  return getChat(chatId) as Chat;
}

/**
 * An empty room is reused only when the new request does not name it differently. A room the person named and saw on screen is theirs:
 * renaming it into the next request's name made the first room vanish. A request with no name, or the same name, reuses it.
 */
function emptyRoomKeepsItsName(db: ReturnType<typeof getDb>, chatId: string, requestedTitle: string): boolean {
  if (!requestedTitle) return true;
  const current = (db.prepare("SELECT title FROM chats WHERE id = ?").get(chatId) as { title: string } | undefined)?.title ?? "";
  return cleanTitle(current) === requestedTitle || !cleanTitle(current);
}

function emptySoloRoom(db: ReturnType<typeof getDb>, agentId: string, projectId: string | null): string | null {
  const row = db.prepare(
    `SELECT c.id FROM chats c
      WHERE ${EMPTY_ROOM} AND c.agent_id = ? AND c.project_id IS ?
        AND NOT EXISTS (SELECT 1 FROM one_taskforces tf WHERE tf.chat_id = c.id)
        AND EXISTS (SELECT 1 FROM meta k WHERE k.key = ? || c.id)
        AND NOT EXISTS (SELECT 1 FROM one_seats s WHERE s.id = c.seat_id AND s.dissolved_at IS NOT NULL)
      ORDER BY c.created_at DESC LIMIT 1`,
  ).get(agentId, projectId, ISOLATED_CHILD_KEY_PREFIX) as { id: string } | undefined;
  return row?.id ?? null;
}

function emptyGroupRoom(db: ReturnType<typeof getDb>, memberIds: readonly string[], projectId: string | null): string | null {
  const row = db.prepare(
    `SELECT c.id FROM chats c JOIN one_taskforces tf ON tf.chat_id = c.id
      WHERE ${EMPTY_ROOM} AND tf.member_agent_ids_json = ? AND c.project_id IS ?
        AND NOT EXISTS (SELECT 1 FROM one_seats s WHERE s.id = c.seat_id AND s.dissolved_at IS NOT NULL)
      ORDER BY c.created_at DESC LIMIT 1`,
  ).get(JSON.stringify(memberIds), projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** One agent: a new one-to-one room (or the owner's still-empty one for the same agent and project). */
export function createAgentChat(input: { agentId: string; projectId?: string | null; title?: string }): Chat {
  return openSoloRoom(input).chat;
}

function openSoloRoom(input: { agentId: string; projectId?: string | null; title?: string }): { chat: Chat; reused: boolean } {
  assertManagedOneTeamAvailable();
  const agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
  if (!agentId || isPersonalAgentId(agentId)) throw new Error(ko() ? "대화할 에이전트를 골라 주세요." : "Pick an agent to talk to.");
  const db = getDb();
  const projectId = cleanProjectId(input.projectId);
  const made = db.transaction(() => {
    ensureOneOrgSeat(agentId);
    const emptyId = emptySoloRoom(db, agentId, projectId);
    if (emptyId && emptyRoomKeepsItsName(db, emptyId, cleanTitle(input.title))) {
      const title = cleanTitle(input.title);
      if (title) renameChat(emptyId, title);
      return { chat: reuseEmptyRoom(db, emptyId), reused: true };
    }
    const chat = createChat({ agentId, title: cleanTitle(input.title), projectId, originSurface: "one", taskMode: "conversation" });
    markIsolatedChat(db, chat.id);
    return { chat, reused: false };
  }).immediate();
  purgeOrphanChatMarks(db);
  return made;
}

/**
 * A member clicked under a group room in the Workspace menu: the one-to-one with that member in the room's OWN
 * project (no project: the No Project one-to-one). The latest used one is reused; when the member has none there, one is made
 * the way "+" makes it (a still-empty one is reused, the personal agent is never a member). The agent must be in the room.
 */
export function openMemberRoom(input: { roomChatId?: unknown; agentId?: unknown }): { chatId: string; created: boolean } {
  const roomChatId = typeof input?.roomChatId === "string" ? input.roomChatId.trim() : "";
  const agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
  if (!roomChatId || !agentId || isPersonalAgentId(agentId)) throw new Error(ko() ? "열 대화를 고를 수 없어요." : "That conversation cannot be opened.");
  const db = getDb();
  const room = db.prepare("SELECT project_id AS projectId FROM chats WHERE id = ? AND kind = 'user' AND origin_surface = 'one'").get(roomChatId) as { projectId: string | null } | undefined;
  const team = room ? db.prepare("SELECT member_agent_ids_json AS members FROM one_taskforces WHERE chat_id = ?").get(roomChatId) as { members: string } | undefined : undefined;
  if (!room || !team || !safeIds(team.members).includes(agentId)) throw new Error(ko() ? "이 방의 참여자가 아니에요." : "That agent is not in this room.");
  const projectId = cleanProjectId(room.projectId);
  const found = db.prepare(
    `SELECT id FROM chats
      WHERE origin_surface = 'one' AND kind = 'user' AND archived_at IS NULL AND parent_chat_id IS NULL AND surface_pack IS NULL
        AND agent_id = ? AND project_id IS ? AND (seat_kind IS NULL OR seat_kind <> 'group')
        AND NOT EXISTS (SELECT 1 FROM one_taskforces tf WHERE tf.chat_id = chats.id)
        AND NOT EXISTS (SELECT 1 FROM one_seats s WHERE s.id = chats.seat_id AND s.dissolved_at IS NOT NULL)
        ${oneDispatchSidebarPredicate()}
      ORDER BY (used_at IS NOT NULL) DESC, updated_at DESC LIMIT 1`,
  ).get(agentId, projectId) as { id: string } | undefined;
  if (found) return { chatId: found.id, created: false };
  const made = openSoloRoom({ agentId, projectId });
  return { chatId: made.chat.id, created: !made.reused };
}

/** One agent → 1:1, two or more → a group room (order = the order picked; the first is the lead). The personal agent is never a member. */
export function createAgentChatRoom(input: { agentIds: string[]; projectId?: string | null; title?: string }): AgentChatReceipt {
  const requested = withoutPersonalAgents(Array.isArray(input?.agentIds) ? input.agentIds : []);
  const ids = requested.kept;
  const excludedPersonalAgentIds = requested.excluded;
  if (ids.length === 0) throw new Error(ko() ? "대화할 에이전트를 골라 주세요." : "Pick at least one agent.");
  if (ids.length === 1) {
    const solo = openSoloRoom({ agentId: ids[0], projectId: input.projectId, title: input.title });
    return { kind: "solo", chat: solo.chat, taskforceId: null, excludedPersonalAgentIds, ...(solo.reused ? { reused: true } : {}) };
  }
  const db = getDb();
  const projectId = cleanProjectId(input.projectId);
  const emptyId = db.transaction(() => {
    // Seating comes first, as for a new room, so a room that is reused answers for the same members.
    for (const agentId of ids) ensureOneOrgSeat(agentId);
    const found = emptyGroupRoom(db, ids, projectId);
    if (!found || !emptyRoomKeepsItsName(db, found, cleanTitle(input.title))) return null;
    const title = cleanTitle(input.title);
    if (title) renameChat(found, title);
    reuseEmptyRoom(db, found);
    return found;
  }).immediate();
  if (emptyId) {
    const tf = db.prepare("SELECT id FROM one_taskforces WHERE chat_id = ?").get(emptyId) as { id: string };
    return { kind: "group", chat: getChat(emptyId) as Chat, taskforceId: tf.id, excludedPersonalAgentIds, reused: true };
  }
  const title = cleanTitle(input.title) || defaultGroupTitle(ids);
  const taskforce = createAgentGroupRoom({ title, memberAgentIds: ids, projectId });
  purgeOrphanChatMarks(db);
  return { kind: "group", chat: getChat(taskforce.chatId) as Chat, taskforceId: taskforce.id, excludedPersonalAgentIds };
}

function defaultGroupTitle(ids: string[]): string {
  const names = ids.map((id) => (getDb().prepare("SELECT name FROM installed_agents WHERE id = ?").get(id) as { name?: string } | undefined)?.name?.trim()).filter(Boolean) as string[];
  const joined = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  return (joined || (ko() ? "그룹 대화" : "Group chat")).slice(0, 80);
}

/**
 * Add participants to a room. A one-to-one room becomes a group room (same chat, messages, task and runtime — the original agent
 * stays first); a group room just gains members. New members are seated first. A newcomer's "from the moment it joined" cursor is
 * written in the SAME transaction as the membership (a crash between the two used to leave a member who could read everything), and
 * the room-lead router reads it (room-member-view.ts).
 */
export function addAgentChatParticipants(input: { chatId: string; agentIds: string[] }): AgentChatReceipt {
  assertManagedOneTeamAvailable();
  const db = getDb();
  const chat = getChat(input?.chatId);
  if (!chat || chat.originSurface !== "one" || chat.kind === "division") throw new Error(ko() ? "이 대화방을 찾을 수 없어요." : "That room is not available.");
  if (agentChatState(chat.id).readOnly) throw new Error(ko() ? "이 대화방은 읽기 전용이에요." : "That room is read-only.");
  const existing = db.prepare("SELECT id, member_agent_ids_json FROM one_taskforces WHERE chat_id = ?").get(chat.id) as { id: string; member_agent_ids_json: string } | undefined;
  const prior: string[] = existing ? safeIds(existing.member_agent_ids_json) : chat.agentId && !isPersonalAgentId(chat.agentId) ? [chat.agentId] : [];
  const asked = withoutPersonalAgents(Array.isArray(input?.agentIds) ? input.agentIds : []);
  const requested = asked.kept.filter((id) => !prior.includes(id));
  if (requested.length === 0 && !existing) throw new Error(ko() ? "더할 에이전트를 골라 주세요." : "Pick an agent to add.");
  const result = db.transaction(() => {
    for (const agentId of requested) ensureOneOrgSeat(agentId);
    const composed = composeOneTaskforceForChat({
      chatId: chat.id, memberAgentIds: existing ? requested : [...prior, ...requested],
      withinTransaction: (added) => {
        startMemberFromNow(() => db as unknown as RoomDb, chat.id, existing ? added : requested);
        // A one-to-one room made under the new model that grows into a group is led by its first member too; a room made before
        // it (no isolation mark) keeps being run the old way.
        if (!existing && isolatedChat(db, chat.id)) markLeadRoom(db, chat.id);
      },
    });
    return composed;
  }).immediate();
  return { kind: "group", chat: getChat(chat.id) as Chat, taskforceId: result.group.id, excludedPersonalAgentIds: asked.excluded };
}

/**
 * The lead of a group room is its first member (leadOf in room-lead-router.ts takes the first member who can be asked to lead): changing the lead
 * moves that member to the front of the room's member list through the same revision-checked update every member change uses. Same members, same
 * messages, no new stored value; a run in flight keeps its lead and the next message uses the new one. A member that is only called (a Hub agent)
 * never leads, so it is refused instead of moved without effect.
 */
export function setAgentChatLead(input: { chatId: string; agentId: string }): AgentChatReceipt {
  assertManagedOneTeamAvailable();
  const db = getDb();
  const chat = getChat(input?.chatId);
  if (!chat || chat.originSurface !== "one" || chat.kind === "division") throw new Error(ko() ? "이 대화방을 찾을 수 없어요." : "That room is not available.");
  if (agentChatState(chat.id).readOnly) throw new Error(ko() ? "이 대화방은 읽기 전용이에요." : "That room is read-only.");
  const row = db.prepare("SELECT id, title, description, member_agent_ids_json, revision FROM one_taskforces WHERE chat_id = ?").get(chat.id) as
    { id: string; title: string; description: string; member_agent_ids_json: string; revision: number } | undefined;
  if (!row) throw new Error(ko() ? "그룹 대화방이 아니에요." : "That is not a group room.");
  const members = safeIds(row.member_agent_ids_json);
  if (typeof input.agentId !== "string" || !members.includes(input.agentId)) throw new Error(ko() ? "이 대화방의 참여자가 아니에요." : "That agent is not in this room.");
  const receipt = (): AgentChatReceipt => ({ kind: "group", chat: getChat(chat.id) as Chat, taskforceId: row.id, excludedPersonalAgentIds: [] });
  if (members[0] === input.agentId) return receipt();
  const seat = (require("./org") as typeof import("./org")).getOneOrgState().members.find((member) => member.installedAgentId === input.agentId && !member.archivedAt); // eslint-disable-line @typescript-eslint/no-require-imports
  if (seat?.source === "hub") throw new Error(ko() ? "호출만 하는 에이전트는 팀장이 될 수 없어요." : "An agent that is only called cannot lead.");
  updateOneTaskforce({ id: row.id, title: currentGroupTitle(chat.id, row.title), description: row.description, memberAgentIds: [input.agentId, ...members.filter((id) => id !== input.agentId)], expectedRevision: row.revision });
  return receipt();
}

/**
 * Take a participant out. Their seat history is kept (closed, never deleted); their earlier words stay in the room. A group that is
 * left with ONE participant is a one-to-one room again (item 6): the chat's agent is the one who stayed, it takes that
 * agent's own seat and a journal of its own, and the group record and its seat are closed — never a "group of one".
 */
export function removeAgentChatParticipant(input: { chatId: string; agentId: string }): AgentChatReceipt {
  assertManagedOneTeamAvailable();
  const db = getDb();
  const row = db.prepare("SELECT id, title, description, member_agent_ids_json, revision FROM one_taskforces WHERE chat_id = ?").get(input?.chatId) as
    { id: string; title: string; description: string; member_agent_ids_json: string; revision: number } | undefined;
  if (!row) throw new Error(ko() ? "그룹 대화방이 아니에요." : "That is not a group room.");
  const members = safeIds(row.member_agent_ids_json);
  if (!members.includes(input.agentId)) return { kind: "group", chat: getChat(input.chatId) as Chat, taskforceId: row.id, excludedPersonalAgentIds: [] };
  if (members.length <= 1) throw new Error(ko() ? "마지막 참여자는 뺄 수 없어요. 대화방을 닫으려면 보관하세요." : "The last participant stays; archive the room to close it.");
  const remaining = members.filter((id) => id !== input.agentId);
  try { (require("./room-lead-runtime") as typeof import("./room-lead-runtime")).stopLeadRoom(input.chatId); } catch { /* the room has no running request */ } // eslint-disable-line @typescript-eslint/no-require-imports
  // The leaving member's resident CLI is registered under its own child session, not the room: let it go now, not at the idle trim.
  try { (require("./room-lead-runtime") as typeof import("./room-lead-runtime")).releaseRoomMemberResidency(input.chatId, input.agentId); } catch { /* the idle trim finds it */ } // eslint-disable-line @typescript-eslint/no-require-imports
  const convertedToSolo = db.transaction(() => {
    updateOneTaskforce({ id: row.id, title: currentGroupTitle(input.chatId, row.title), description: row.description, memberAgentIds: remaining, expectedRevision: row.revision });
    try { forgetMemberCursor(() => db as unknown as RoomDb, input.chatId, input.agentId); } catch { /* no room tables */ }
    if (remaining.length !== 1) return false;
    const stayed = remaining[0]!;
    const room = db.prepare("SELECT project_id AS projectId, seat_id AS seatId FROM chats WHERE id = ?").get(input.chatId) as { projectId: string | null; seatId: string | null };
    const agentRow = db.prepare("SELECT 1 FROM installed_agents WHERE id = ?").get(stayed);
    if (!agentRow) return false;
    const soloSeat = ensureSoloSeatForAgent(stayed, room.projectId);
    db.prepare("UPDATE chats SET agent_id = ?, seat_id = ? WHERE id = ?").run(stayed, soloSeat, input.chatId);
    applySeatSnapshotToChats(soloSeat);
    markIsolatedChat(db, input.chatId);
    clearOneTaskforceSessionScope(db, input.chatId);
    clearLeadRoom(db, input.chatId);
    db.prepare("DELETE FROM one_taskforces WHERE id = ?").run(row.id);
    if (room.seatId && room.seatId !== soloSeat) dissolveSeat(room.seatId);
    try { db.prepare("DELETE FROM room_member_cursors WHERE chat_id = ?").run(input.chatId); } catch { /* no room tables */ }
    return true;
  }).immediate();
  if (convertedToSolo) emitDesktopStoreChange({ entity: "chat", id: input.chatId });
  return { kind: convertedToSolo ? "solo" : "group", chat: getChat(input.chatId) as Chat, taskforceId: convertedToSolo ? null : row.id, excludedPersonalAgentIds: [], ...(convertedToSolo ? { convertedToSolo: true } : {}) };
}

function isolatedChat(db: ReturnType<typeof getDb>, chatId: string): boolean {
  return db.prepare("SELECT 1 FROM meta WHERE key = ?").get(ISOLATED_CHILD_KEY_PREFIX + chatId) !== undefined;
}

function safeIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch { return []; }
}

export { agentChatState, AGENT_CHAT_READ_ONLY } from "./agent-chat-state";
