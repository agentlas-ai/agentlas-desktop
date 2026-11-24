import type Database from "better-sqlite3";
import { LEAD_ROOM_KEY_PREFIX } from "../runtime/session-scope";
import { homeListJoins, homeListSchemaOf, homeListWhere, homeRowKind, homeTaskPick, type HomeListSchema as Schema } from "../workspace-rules/scope";
import {
  HOME_LINE_FACE_LIMIT,
  HOME_LINE_PREVIEW_LIMIT,
  HOME_TREE_ID_LIMIT,
  HOME_TREE_ROW_LIMIT,
  type HomeLine,
  type HomeLineFace,
  type HomeRowsByIdsResult,
  type HomeTreeParticipant,
  type HomeTreeRow,
  type HomeTreeSnapshot,
} from "../../shared/home-tree";
import { AGENT_DISPLAY_NAME_EN_SQL, AGENT_DISPLAY_NAME_SQL } from "../../shared/agent-display-name";

/*
 * Home's left tree, read side. Every function here only SELECTs. The tree is a view over rows that
 * already exist; nothing is migrated, backfilled, ensured (no CREATE TABLE) or written — a table this build has not met yet
 * (an older store, a daemon-only store) simply contributes no exclusion.
 *
 * What the tree leaves out (§3.3, decided by row facts only, never by title or text):
 *   1 archived chats                                  chats.archived_at
 *   2 a dissolved / archived seat's chats             one_seats.dissolved_at / archived_at   (rooms stay readable elsewhere)
 *   3 the personal agent's own conversation           one_supervisor_conversations
 *   4 rooms the personal agent runs (not released)    one_personal_agent_rooms
 *   5 dispatch / child sessions                       kind <> 'user', parent_chat_id, one_team_dispatches.child_chat_id
 *   6 empty rooms (nothing sent yet, not new)         used_at, with a 5 minute grace so a room just made is not invisible
 * plus Science conversations (surface_pack), which have their own screen.
 */

const MAX_VISIBLE_AGENTS = 3;

interface RawRow {
  id: string;
  project_id: string | null;
  title: string | null;
  agent_id: string | null;
  origin_surface: string | null;
  seat_kind: string | null;
  activity_at: string;
  task_id: string | null;
  task_title: string | null;
  tf_members: string | null;
  tf_id: string | null;
}

function select(s: Schema, extraWhere: string, order: boolean, limit: number, now: number): { sql: string; params: unknown[] } {
  const has = (name: string) => s.chatColumns.has(name);
  const taskPick = (column: "id" | "title" | "updated_at") => homeTaskPick(s, column);
  // "Recent" is when the last VISIBLE line appeared (rule store/chats.ts listRecentOneChats), not chats.updated_at:
  // a model pick, goal binding, continuous mode or working-folder change moves updated_at without a new line and must not move the row.
  // A Work row follows its task; a room without any line yet keeps the time it was made.
  const lastLine = s.hasMessages
    ? "(SELECT m.created_at FROM chat_messages m WHERE m.chat_id = c.id AND (m.role IN ('user','assistant') OR m.host_notice_json IS NOT NULL) ORDER BY m.created_at DESC LIMIT 1)"
    : "NULL";
  const originIsOne = has("origin_surface") ? "c.origin_surface = 'one'" : "0=1";
  const activity = `CASE WHEN ${originIsOne} THEN COALESCE(${lastLine}, c.created_at) ELSE COALESCE(${taskPick("updated_at")}, ${lastLine}, c.created_at) END`;
  // The list conditions are the workspace rules' own (workspace-rules/scope.ts): one definition for the list and for "which conversation is this".
  const { where, params } = homeListWhere(s, now);
  if (extraWhere) where.push(extraWhere);
  const joins = homeListJoins(s, has);
  return {
    sql: `SELECT c.id, c.project_id, c.title, c.agent_id, ${has("origin_surface") ? "c.origin_surface" : "NULL"} AS origin_surface,
        ${has("seat_kind") ? "c.seat_kind" : "NULL"} AS seat_kind, ${activity} AS activity_at,
        ${taskPick("id")} AS task_id, ${taskPick("title")} AS task_title,
        ${s.taskforces ? "tf.member_agent_ids_json" : "NULL"} AS tf_members, ${s.taskforces ? "tf.id" : "NULL"} AS tf_id
      FROM chats c
      ${joins.seat}
      ${joins.taskforce}
      WHERE ${where.join("\n        AND ")}
      ${order ? "ORDER BY activity_at DESC, c.id" : ""}
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    params,
  };
}

function memberIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch { return []; }
}

/**
 * The name a row shows for an agent: the owner's own display name when one is saved (installed_agents.local_display_name), else the package
 * name. Every other screen reads the same order (renderer pickLocalized), so a rename shows in the tree too. A store from before
 * that column simply has the package name.
 */
function agentRows<T>(db: Database.Database, extra: string, chunk: string[]): Array<T & { nameEn: string }> {
  const marks = chunk.map(() => "?").join(",");
  // `nameEn` is the English-UI name (owner's name > English name > package name); a store with no `name_en` column gives the package name in both.
  try {
    return db.prepare(`SELECT id, ${AGENT_DISPLAY_NAME_SQL} AS name, ${AGENT_DISPLAY_NAME_EN_SQL} AS nameEn${extra} FROM installed_agents WHERE id IN (${marks})`).all(...chunk) as Array<T & { nameEn: string }>;
  } catch {
    return (db.prepare(`SELECT id, name, name AS nameEn${extra} FROM installed_agents WHERE id IN (${marks})`).all(...chunk) as Array<T & { nameEn: string }>);
  }
}

function agentNames(db: Database.Database, s: Schema, ids: Iterable<string>): Map<string, { name: string; nameEn: string }> {
  const out = new Map<string, { name: string; nameEn: string }>();
  if (!s.agents) return out;
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    for (const row of agentRows<{ id: string; name: string }>(db, "", chunk)) {
      out.set(row.id, { name: row.name, nameEn: row.nameEn || row.name });
    }
  }
  return out;
}

function toRows(db: Database.Database, s: Schema, raw: RawRow[]): HomeTreeRow[] {
  const shown = raw.map((row) => {
    const members = row.tf_id ? memberIds(row.tf_members) : [];
    const isGroup = Boolean(row.tf_id) || row.seat_kind === "group";
    const ids = isGroup ? members : row.agent_id ? [row.agent_id] : [];
    return { row, isGroup, members, ids: ids.slice(0, MAX_VISIBLE_AGENTS) };
  });
  const names = agentNames(db, s, shown.flatMap((x) => x.ids));
  return shown.map(({ row, isGroup, members, ids }) => {
    const work = row.origin_surface !== "one";
    const agentNames = work ? [] : ids.map((id) => names.get(id)?.name ?? "");
    const agentNamesEn = work ? [] : ids.map((id) => names.get(id)?.nameEn ?? "");
    return {
      id: row.id,
      kind: homeRowKind(row),
      projectId: row.project_id ?? null,
      title: work ? (row.task_title || row.title || "") : (row.title ?? ""),
      taskId: work ? row.task_id : null,
      agentNames,
      ...(work ? {} : { agentIds: ids }),
      ...(agentNamesEn.some((name, index) => name !== agentNames[index]) ? { agentNamesEn } : {}),
      memberCount: work ? 0 : isGroup ? members.length : ids.length,
      updatedAt: row.activity_at,
    } satisfies HomeTreeRow;
  });
}

/** Every row the tree shows, newest first. At most HOME_TREE_ROW_LIMIT; `truncated` says when there was more. */
export function homeTree(db: Database.Database, now = Date.now()): HomeTreeSnapshot {
  const s = homeListSchemaOf(db, now);
  if (!s.chatColumns.size) return { rows: [], truncated: false };
  const { sql, params } = select(s, "", true, HOME_TREE_ROW_LIMIT + 1, now);
  const raw = db.prepare(sql).all(...params) as RawRow[];
  const truncated = raw.length > HOME_TREE_ROW_LIMIT;
  return { rows: toRows(db, s, truncated ? raw.slice(0, HOME_TREE_ROW_LIMIT) : raw), truncated };
}

function cleanIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const value of input) {
    if (typeof value === "string" && value.length > 0 && value.length <= 200 && !out.includes(value)) out.push(value);
    if (out.length >= HOME_TREE_ID_LIMIT) break;
  }
  return out;
}

/** Chat ids that these ids (chat ids, task ids or taskforce ids, as the store-change bus carries them) refer to. */
function resolveChatIds(db: Database.Database, s: Schema, ids: string[]): string[] {
  const out = new Set(ids);
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  if (s.tasks) for (const r of db.prepare(`SELECT origin_chat_id AS id FROM tasks WHERE id IN (${marks}) AND origin_chat_id IS NOT NULL`).all(...ids) as Array<{ id: string }>) out.add(r.id);
  if (s.taskforces) for (const r of db.prepare(`SELECT chat_id AS id FROM one_taskforces WHERE id IN (${marks})`).all(...ids) as Array<{ id: string }>) out.add(r.id);
  return [...out];
}

/** Patch read: only the rows behind these ids. A store change of one chat reads one row, never the whole tree. */
export function homeRowsByIds(db: Database.Database, input: unknown, now = Date.now()): HomeRowsByIdsResult {
  const s = homeListSchemaOf(db, now);
  const ids = cleanIds(input);
  if (!ids.length || !s.chatColumns.size) return { rows: [], chatIds: [] };
  const chatIds = resolveChatIds(db, s, ids).slice(0, HOME_TREE_ID_LIMIT * 2);
  const { sql, params } = select(s, `c.id IN (${chatIds.map(() => "?").join(",")})`, true, chatIds.length, now);
  return { rows: toRows(db, s, db.prepare(sql).all(...params, ...chatIds) as RawRow[]), chatIds };
}

/** A group room's members in room order (the first one is who the room was made with). Opening this creates nothing. */
export function homeParticipants(db: Database.Database, chatId: unknown, now = Date.now()): HomeTreeParticipant[] {
  const s = homeListSchemaOf(db, now);
  if (typeof chatId !== "string" || !chatId || !s.taskforces) return [];
  const row = db.prepare("SELECT member_agent_ids_json AS m FROM one_taskforces WHERE chat_id = ?").get(chatId) as { m: string } | undefined;
  if (!row) return [];
  const ids = memberIds(row.m).slice(0, 200);
  const names = agentNames(db, s, ids);
  return ids.map((agentId) => {
    const found = names.get(agentId);
    return { agentId, name: found?.name ?? null, ...(found && found.nameEn !== found.name ? { nameEn: found.nameEn } : {}) };
  });
}

/** Most rows one search answers. */
const SEARCH_LIMIT = 100;

/**
 * Title search over EVERY listed row, including the ones older than the tree's row limit (those are not on screen, so the
 * renderer cannot find them itself). One bounded query per call; the renderer waits for a pause in typing before asking.
 */
export function homeSearch(db: Database.Database, input: unknown, now = Date.now()): HomeTreeRow[] {
  const s = homeListSchemaOf(db, now);
  const text = typeof input === "string" ? input.normalize("NFC").trim().slice(0, 80) : "";
  if (text.length < 2 || !s.chatColumns.size) return [];
  const like = `%${text.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
  const taskTitle = s.tasks ? "(SELECT 1 FROM tasks t WHERE t.origin_chat_id = c.id AND t.archived_at IS NULL AND LOWER(t.title) LIKE ? ESCAPE '\\')" : "0=1";
  const { sql, params } = select(s, `(LOWER(c.title) LIKE ? ESCAPE '\\' OR ${taskTitle !== "0=1" ? "EXISTS " : ""}${taskTitle})`, true, SEARCH_LIMIT, now);
  return toRows(db, s, db.prepare(sql).all(...params, like, ...(s.tasks ? [like] : [])) as RawRow[]);
}

interface RawLine {
  id: string;
  agent_id: string | null;
  origin_surface: string | null;
  seat_kind: string | null;
  runtime: string | null;
  preview: string | null;
  tf_id: string | null;
  tf_members: string | null;
}

function runnerOf(json: string | null): { kind: string; label?: string } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; label?: unknown };
    if (typeof parsed.kind !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parsed.kind)) return null;
    const label = typeof parsed.label === "string" ? parsed.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    return { kind: parsed.kind, ...(label ? { label } : {}) };
  } catch { return null; }
}

/**
 * What the rows ON SCREEN draw beyond a `home:tree` row: a one-line preview and up to three faces for an agent
 * chat, the runtime the session started on for a Work session. Asked for the visible ids only (at most HOME_TREE_ID_LIMIT);
 * one chats read, one agents read. Nothing is stored, so there is nothing to migrate or to prune.
 */
export function homeLines(db: Database.Database, input: unknown, now = Date.now()): HomeLine[] {
  const s = homeListSchemaOf(db, now);
  const ids = cleanIds(input);
  if (!ids.length || !s.chatColumns.size) return [];
  const has = (name: string) => s.chatColumns.has(name);
  const preview = s.hasMessages
    ? "(SELECT substr(m.text, 1, 600) FROM chat_messages m WHERE m.chat_id = c.id AND m.role IN ('user','assistant') ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)"
    : "NULL";
  const raw = db.prepare(
    `SELECT c.id, ${has("agent_id") ? "c.agent_id" : "NULL"} AS agent_id, ${has("origin_surface") ? "c.origin_surface" : "NULL"} AS origin_surface,
        ${has("seat_kind") ? "c.seat_kind" : "NULL"} AS seat_kind, ${has("runtime_selection_json") ? "c.runtime_selection_json" : "NULL"} AS runtime,
        ${preview} AS preview, ${s.taskforces ? "tf.id" : "NULL"} AS tf_id, ${s.taskforces ? "tf.member_agent_ids_json" : "NULL"} AS tf_members
      FROM chats c ${s.taskforces ? "LEFT JOIN one_taskforces tf ON tf.chat_id = c.id" : ""}
      WHERE c.id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as RawLine[];
  const faceIds = raw.map((row) => {
    if (row.origin_surface !== "one") return [];
    const group = Boolean(row.tf_id) || row.seat_kind === "group";
    return (group ? memberIds(row.tf_members) : row.agent_id ? [row.agent_id] : []).slice(0, HOME_LINE_FACE_LIMIT);
  });
  const agents = new Map<string, { name: string; nameEn: string; tone: string }>();
  const wanted = [...new Set(faceIds.flat())];
  if (s.agents) {
    for (let i = 0; i < wanted.length; i += 400) {
      const chunk = wanted.slice(i, i + 400);
      for (const row of agentRows<{ id: string; name: string; tone: string | null }>(db, ", tone", chunk)) {
        agents.set(row.id, { name: row.name, nameEn: row.nameEn || row.name, tone: row.tone || "one-puppy" });
      }
    }
  }
  // The lead-room mark is one `meta` row per room (runtime/session-scope.ts markLeadRoom); a store without `meta` has none.
  const leads = new Set<string>();
  const groupIds = raw.filter((row) => row.origin_surface === "one" && Boolean(row.tf_id)).map((row) => row.id);
  if (groupIds.length) {
    try {
      for (const row of db.prepare(`SELECT key FROM meta WHERE key IN (${groupIds.map(() => "?").join(",")})`).all(...groupIds.map((id) => LEAD_ROOM_KEY_PREFIX + id)) as Array<{ key: string }>) leads.add(row.key.slice(LEAD_ROOM_KEY_PREFIX.length));
    } catch { /* no meta table: no lead rooms */ }
  }
  return raw.map((row, index) => {
    if (row.origin_surface !== "one") {
      const runner = runnerOf(row.runtime);
      return { id: row.id, ...(runner ? { runner: runner.kind, ...(runner.label ? { runnerLabel: runner.label } : {}) } : {}) } satisfies HomeLine;
    }
    const text = (row.preview ?? "").replace(/\s+/g, " ").trim().slice(0, HOME_LINE_PREVIEW_LIMIT);
    const faces = faceIds[index]!.flatMap((agentId): HomeLineFace[] => {
      const agent = agents.get(agentId);
      return agent ? [{ agentId, name: agent.name, tone: agent.tone, ...(agent.nameEn !== agent.name ? { nameEn: agent.nameEn } : {}) }] : [];
    });
    return { id: row.id, ...(text ? { preview: text } : {}), ...(faces.length ? { faces } : {}), ...(leads.has(row.id) ? { lead: true as const } : {}) } satisfies HomeLine;
  });
}
