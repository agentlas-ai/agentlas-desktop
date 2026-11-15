import type Database from "better-sqlite3";
import { personalReadable, type ClassificationRules } from "../../shared/memory-classification";

/*
 * Which conversation a turn belongs to, for the workspace rules (Agentlas 2.0 P2, and 5.3). Four decisions, all read from rows the app already keeps:
 *
 *   workspaceConversationKind(db, chatId)        "work" | "solo" | "group" | null  - the kind of the Home tree row this conversation is (a child conversation climbs to its root);
 *                                                null = it is not a row of the Workspace list at all
 *   isPersonalAgentConversation(db, chatId)      the personal agent's own conversation, however it was started (desktop, phone, Telegram, mail)
 *   loadsWorkspaceRules(db, turn, rulesOn)       this turn is shown "my rules" (the owner's Workspace-wide instructions)
 *   readsPersonal(db, turn, actorId, rulesOn, rules)  this subject may read Personal lines in this turn
 *
 * The Home tree (electron/home/home-tree.ts) takes its list conditions, its kind calculation and the personal agent's own-conversation condition FROM THIS FILE: the list and
 * the decision are one function, so they cannot drift apart (pass criterion 3). Everything here only SELECTs. No Electron: the background service and the gates
 * load this file too; the caller passes the database, the switch (`workspaceRulesOn()`) and the ruleset (`memoryClassificationRules()`).
 *
 * Unknown means no: a conversation, a table or a column this build cannot read gives `null` / false, and a turn that is not a Workspace turn loads no rules.
 */

const NEW_ROOM_GRACE_MS = 5 * 60_000;
const MAX_ROOT_DEPTH = 16;

export interface HomeListSchema {
  tasks: boolean;
  hasMessages: boolean;
  taskforces: boolean;
  seats: boolean;
  seatDissolved: boolean;
  dispatches: boolean;
  supervisorConversations: boolean;
  personalRooms: boolean;
  agents: boolean;
  chatColumns: Set<string>;
}

const schemaCache = new WeakMap<Database.Database, { at: number; schema: HomeListSchema }>();
// Table creation happens at migration time and by lazily-ensured markers (personal rooms), so a short TTL covers a table
// that appears while the app runs without re-reading sqlite_master on every patch.
const SCHEMA_TTL_MS = 10_000;

function tableColumns(db: Database.Database, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  } catch { return new Set(); }
}

export function homeListSchemaOf(db: Database.Database, now = Date.now()): HomeListSchema {
  const cached = schemaCache.get(db);
  if (cached && now - cached.at < SCHEMA_TTL_MS) return cached.schema;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
  const seatColumns = tables.has("one_seats") ? tableColumns(db, "one_seats") : new Set<string>();
  const schema: HomeListSchema = {
    tasks: tables.has("tasks"),
    hasMessages: tables.has("chat_messages"),
    taskforces: tables.has("one_taskforces"),
    seats: tables.has("one_seats"),
    seatDissolved: seatColumns.has("dissolved_at"),
    dispatches: tables.has("one_team_dispatches"),
    supervisorConversations: tables.has("one_supervisor_conversations"),
    personalRooms: tables.has("one_personal_agent_rooms"),
    agents: tables.has("installed_agents"),
    chatColumns: tables.has("chats") ? tableColumns(db, "chats") : new Set(),
  };
  schemaCache.set(db, { at: now, schema });
  return schema;
}

/** The live task of a chat (the Work list's row condition); `column` picks what to read, `NULL` when the build has no tasks table. */
export function homeTaskPick(s: HomeListSchema, column: "id" | "title" | "updated_at"): string {
  return s.tasks
    ? `(SELECT t.${column} FROM tasks t WHERE t.origin_chat_id = c.id AND t.archived_at IS NULL AND t.status <> 'archived' ORDER BY t.updated_at DESC, t.id LIMIT 1)`
    : "NULL";
}

/** The joins the list conditions refer to (aliases `s` for the seat and `tf` for the room's taskforce). */
export function homeListJoins(s: HomeListSchema, has: (name: string) => boolean): { seat: string; taskforce: string } {
  return {
    seat: s.seats && has("seat_id") ? "LEFT JOIN one_seats s ON s.id = c.seat_id" : "",
    taskforce: s.taskforces ? "LEFT JOIN one_taskforces tf ON tf.chat_id = c.id" : "",
  };
}

/**
 * The condition that is true for the personal agent's OWN conversation held with nobody else seated (started from the phone, mail or Telegram, or on the desktop's personal-agent
 * entry): an agent chat of the One surface whose agent is the root agent, not a room (no taskforce) and not a seat another agent sits in. A room whose agent was deleted is also held by
 * the root agent, but its seat remembers the agent that sat there: it is not this. `null` when the build cannot tell (a chats table without the two columns).
 */
export function personalSoloCondition(s: HomeListSchema, has: (name: string) => boolean): string | null {
  if (!(has("agent_id") && has("origin_surface"))) return null;
  const seatedElse = s.seats && has("seat_id")
    ? "EXISTS (SELECT 1 FROM one_seat_occupants o WHERE o.seat_id = c.seat_id AND o.agent_id IS NOT NULL AND o.agent_id NOT IN (SELECT id FROM installed_agents WHERE slug = 'agentlas-one' OR id = 'builtin-agentlas-one'))"
    : "0=1";
  return `c.origin_surface = 'one' AND c.agent_id IN (SELECT id FROM installed_agents WHERE slug = 'agentlas-one' OR id = 'builtin-agentlas-one')${s.taskforces ? " AND tf.id IS NULL" : ""} AND NOT ${seatedElse}`;
}

/**
 * The conditions a chat has to meet to be a row of the Workspace list (the Home tree, decided by row facts only, never by title or text). `params` holds the one
 * placeholder of these conditions (the grace instant of a room just made); a query that adds its own conditions after them appends its own parameters after it.
 */
export function homeListWhere(s: HomeListSchema, now: number): { where: string[]; params: unknown[] } {
  const has = (name: string) => s.chatColumns.has(name);
  const where: string[] = [
    "c.archived_at IS NULL",
    has("kind") ? "c.kind = 'user'" : "1=1",
    has("parent_chat_id") ? "c.parent_chat_id IS NULL" : "1=1",
    has("surface_pack") ? "c.surface_pack IS NULL" : "1=1",
  ];
  if (s.seats && has("seat_id")) {
    if (s.seatDissolved) where.push("(s.id IS NULL OR s.dissolved_at IS NULL)");
  }
  if (s.dispatches) where.push("NOT EXISTS (SELECT 1 FROM one_team_dispatches d WHERE d.child_chat_id = c.id AND d.parent_chat_id <> c.id)");
  if (s.supervisorConversations) where.push("NOT EXISTS (SELECT 1 FROM one_supervisor_conversations p WHERE p.chat_id = c.id)");
  if (s.personalRooms) where.push("NOT EXISTS (SELECT 1 FROM one_personal_agent_rooms r WHERE r.chat_id = c.id AND r.released_at IS NULL)");
  // Surface split. An agent chat ('one') needs to have been used (or be a room/new); a Work row needs a live task, as the
  // Work lists always did.
  const oneUsed = [has("used_at") ? "c.used_at IS NOT NULL" : "1=1", "c.created_at >= ?"].join(" OR ");
  const originOne = has("origin_surface") ? "c.origin_surface = 'one'" : "0=1";
  where.push(`((${originOne} AND (${oneUsed})) OR (NOT (${originOne}) AND ${homeTaskPick(s, "id")} IS NOT NULL))`);
  // The personal agent is the assistant, not a room member: a conversation the root agent holds with nobody
  // else seated opens from the personal agent's own entry, not from Agent Chats.
  const solo = personalSoloCondition(s, has);
  if (solo) where.push(`NOT (${solo})`);
  return { where, params: [new Date(now - NEW_ROOM_GRACE_MS).toISOString()] };
}

/** The kind of a list row: a Work session (not of the One surface), a group room (a taskforce or a group seat), or an agent chat. The Home tree and `workspaceConversationKind` both use it. */
export function homeRowKind(row: { origin_surface: string | null; tf_id: string | null; seat_kind: string | null }): "work" | "group" | "solo" {
  if (row.origin_surface !== "one") return "work";
  return Boolean(row.tf_id) || row.seat_kind === "group" ? "group" : "solo";
}

export type WorkspaceConversationKind = "work" | "solo" | "group";

/**
 * The conversation that stands for `chatId`: a dispatch or division child climbs to the conversation it belongs to (`parent_chat_id`, or the dispatch table when the chat only has
 * that), up to 16 steps. null = the chat is unknown, the chain loops or it is deeper than that.
 */
export function rootConversationId(db: Database.Database, chatId: string | null | undefined, now = Date.now()): string | null {
  if (typeof chatId !== "string" || !chatId) return null;
  try {
    const s = homeListSchemaOf(db, now);
    if (!s.chatColumns.size) return null;
    const seen = new Set<string>();
    let id = chatId;
    for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
      if (seen.has(id)) return null;
      seen.add(id);
      const row = db.prepare(`SELECT ${s.chatColumns.has("parent_chat_id") ? "parent_chat_id" : "NULL"} AS parent FROM chats WHERE id = ?`).get(id) as { parent: string | null } | undefined;
      if (!row) return null;
      let parent: string | null = row.parent || null;
      if (!parent && s.dispatches) {
        const dispatch = db.prepare("SELECT parent_chat_id AS parent FROM one_team_dispatches WHERE child_chat_id = ? AND parent_chat_id <> ? LIMIT 1").get(id, id) as { parent: string | null } | undefined;
        parent = dispatch?.parent || null;
      }
      if (!parent) return id;
      id = parent;
    }
    return null;
  } catch { return null; }
}

/**
 * The kind of the Workspace list row this conversation is, or null when it is not one (archived, the personal agent's own conversation, a Science conversation, a Work session
 * without a live task, an empty room, a dissolved seat ...: exactly the Home tree's own conditions). A child conversation is judged by its root.
 */
export function workspaceConversationKind(db: Database.Database, chatId: string | null | undefined, now = Date.now()): WorkspaceConversationKind | null {
  const root = rootConversationId(db, chatId, now);
  if (!root) return null;
  try {
    const s = homeListSchemaOf(db, now);
    const has = (name: string) => s.chatColumns.has(name);
    const { where, params } = homeListWhere(s, now);
    const joins = homeListJoins(s, has);
    const row = db.prepare(
      `SELECT ${has("origin_surface") ? "c.origin_surface" : "NULL"} AS origin_surface, ${has("seat_kind") ? "c.seat_kind" : "NULL"} AS seat_kind, ${s.taskforces ? "tf.id" : "NULL"} AS tf_id
        FROM chats c
        ${joins.seat}
        ${joins.taskforce}
        WHERE ${where.join("\n        AND ")} AND c.id = ?
        LIMIT 1`,
    ).get(...params, root) as { origin_surface: string | null; tf_id: string | null; seat_kind: string | null } | undefined;
    return row ? homeRowKind(row) : null;
  } catch { return null; }
}

/**
 * The personal agent's own conversation: the chat is in `one_supervisor_conversations`, OR the root agent holds it alone on the One surface (phone, Telegram, mail, the desktop's own
 * entry: `personalSoloCondition`), OR it is a room the personal agent runs that was not released (`one_personal_agent_rooms`). The same three facts the Home tree leaves out of its list.
 */
export function isPersonalAgentConversation(db: Database.Database, chatId: string | null | undefined, now = Date.now()): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  try {
    const s = homeListSchemaOf(db, now);
    if (!s.chatColumns.size) return false;
    const has = (name: string) => s.chatColumns.has(name);
    if (s.supervisorConversations && db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE chat_id = ? LIMIT 1").get(chatId)) return true;
    if (s.personalRooms && db.prepare("SELECT 1 FROM one_personal_agent_rooms WHERE chat_id = ? AND released_at IS NULL LIMIT 1").get(chatId)) return true;
    const solo = personalSoloCondition(s, has);
    if (!solo) return false;
    const joins = homeListJoins(s, has);
    return Boolean(db.prepare(`SELECT 1 FROM chats c ${joins.seat} ${joins.taskforce} WHERE c.id = ? AND (${solo}) LIMIT 1`).get(chatId));
  } catch { return false; }
}

/** What the host knows about one turn (every field a plain fact the host observed; nothing here is read from a model's output). */
export interface WorkspaceTurnFacts {
  chatId: string | null | undefined;
  /** The turn belongs to an agent App (`req.agentAppMode`). */
  agentAppMode?: boolean;
  /** The companion's front turn (`companionFrontTurn`). */
  companionFrontTurn?: boolean;
  /** A check-in turn. */
  checkIn?: boolean;
  /** An effect-observation run. */
  effectObservation?: boolean;
  /** `executionContext.source` (only "science" matters; "automation" and "mobile" are not looked at). */
  executionSource?: string | null;
  /** The chat's own `surfacePack` (a Science conversation has one). */
  surfacePack?: string | null;
  /** `projectDomainBinding?.domain` ("finance" is left out). */
  projectDomain?: string | null;
}

/**
 * Whether this turn is shown "my rules": the switch is on AND the conversation (its root) is a row of the Workspace list AND the turn is none of an agent App,
 * the companion's front turn, a check-in, an effect observation, a Science turn or conversation, a Finance project binding, or the personal agent's own conversation.
 * `rulesOn` is `workspaceRulesOn()`. Switch off = false: nothing is loaded and the turn is what it was before.
 */
export function loadsWorkspaceRules(db: Database.Database, turn: WorkspaceTurnFacts, rulesOn: boolean): boolean {
  if (rulesOn !== true) return false;
  if (turn.agentAppMode || turn.companionFrontTurn || turn.checkIn || turn.effectObservation) return false;
  if (turn.executionSource === "science" || turn.surfacePack || turn.projectDomain === "finance") return false;
  const root = rootConversationId(db, turn.chatId);
  if (!root || isPersonalAgentConversation(db, root)) return false;
  return workspaceConversationKind(db, root) !== null;
}

/**
 * Whether this subject may read Personal lines in this turn. Switch off: what it always was (a Personal fact is the personal agent's, every other Personal line is read by every subject:
 * this answers for the fact). Switch on: the personal agent's own conversation AND a subject of the One family, and never when the turn loads "my rules".
 */
export function readsPersonal(db: Database.Database, turn: WorkspaceTurnFacts, actorId: string | null | undefined, rulesOn: boolean, rules: ClassificationRules | null): boolean {
  if (rulesOn !== true) return personalReadable(rules, "user_identity", "fact", actorId);
  if (loadsWorkspaceRules(db, turn, true)) return false;
  return personalReadable(rules, "user_identity", "preference", actorId, { rulesOn: true, personalRead: isPersonalAgentConversation(db, turn.chatId) });
}

