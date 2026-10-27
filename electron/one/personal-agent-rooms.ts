import type Database from "better-sqlite3";
import type { PersonalAgentRoomRelease } from "../../shared/one-supervisor";

/*
 * Rooms the personal agent opened (owner 2026-10-27): "개인 에이전트가 띄운 Work 는 기존 Work·One 과 다르게 돼야 한다.
 * 거기서 사용자가 챗을 치지 못하고, 굳이 찾아서 파고들어가서 보지 않는 이상 쉬운 접근은 안 된다. 개인 에이전트로 봐야
 * 한다." (The phone opened such a Work room from a notification and the owner talked to it as if it were the personal agent.)
 *
 * One durable marker per room, written by Main where the room is created and read by every surface:
 *   - a Work hand-off (one_supervisor_requests kind 'work', its workerChatId), whoever asked for it in the personal
 *     agent's panel or conversation;
 *   - a teammate session the personal conversation dispatched (one_team_dispatches whose parent is a personal
 *     conversation, one_supervisor_conversations).
 * A room the personal agent only wrote into (chat-send) is NOT one of them: it is a room someone else opened, usually the
 * owner, and it stays the owner's room.
 *
 * Such a room is read-only for the owner's own messages (code supervised_room_read_only, checked by Main at every owner
 * input route), is left out of the Work lists, and its notifications go through the personal agent. Approval and question
 * cards still answer in the room. "내가 직접 이어가기" (releasePersonalAgentRoom) hands it back: from then on it is an
 * ordinary Work room and the personal agent's tools no longer write into it (supervisor_room_released).
 *
 * Why a table rather than a judgment over one_supervisor_requests at read time: lists need one indexed lookup per page, the
 * release must be durable and survive a rebuilt judgment, and a column on chats would be a migration of the shared table
 * that the daemon host and an older app version also open. An older app ignores this table (the room is then ordinary);
 * rows a host of an older version created without the marker are backfilled from the same durable sources.
 */

export const PERSONAL_AGENT_ROOM_READ_ONLY = "supervised_room_read_only" as const;
export const PERSONAL_AGENT_ROOM_RELEASED = "supervisor_room_released" as const;

export type PersonalAgentRoomSource = "work" | "team";

const TABLE = "one_personal_agent_rooms";
const BACKFILL_INTERVAL_MS = 30_000;
const backfilledAt = new WeakMap<Database.Database, number>();
const ensured = new WeakSet<Database.Database>();

const tableExists = (db: Database.Database, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function defaultDb(): Database.Database {
  return (require("../store/db") as typeof import("../store/db")).getDb(); // eslint-disable-line @typescript-eslint/no-require-imports
}

/** Creates the marker table (idempotent, any host). False when this store has no chats table to mark. */
export function ensurePersonalAgentRooms(db: Database.Database): boolean {
  if (ensured.has(db)) return true;
  if (!tableExists(db, "chats")) return false;
  // No foreign key: a store whose chats table differs (an older or partial schema) must still take the marker. A deleted
  // chat's row is inert (chat ids are never reused) and is never read for a chat that is not there.
  if (!tableExists(db, TABLE)) db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    chat_id TEXT PRIMARY KEY,
    one_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('work','team')),
    personal_chat_id TEXT,
    marked_at TEXT NOT NULL,
    released_at TEXT,
    released_by TEXT
  )`);
  ensured.add(db);
  return true;
}

/**
 * Marks rooms the durable sources prove the personal agent opened, never re-marking one the owner released (INSERT OR
 * IGNORE keeps the existing row). Runs at most every 30 s per store; a busy store just tries again later.
 */
export function backfillPersonalAgentRooms(db: Database.Database, now = Date.now(), force = false): number {
  if (!force && now - (backfilledAt.get(db) ?? 0) < BACKFILL_INTERVAL_MS) return 0;
  backfilledAt.set(db, now);
  if (!ensurePersonalAgentRooms(db)) return 0;
  let added = 0;
  const at = new Date(now).toISOString();
  try {
    // Read first: a store with nothing new is not written to (no write lock on a read path the daemon may share).
    const missing: Array<{ chat_id: string; one_id: string; source: PersonalAgentRoomSource; personal_chat_id: string }> = [];
    if (tableExists(db, "one_supervisor_requests")) {
      missing.push(...db.prepare(`SELECT json_extract(r.payload_json,'$.workerChatId') AS chat_id, r.one_id, 'work' AS source, r.origin_chat_id AS personal_chat_id
        FROM one_supervisor_requests r
        WHERE r.kind='work' AND json_valid(r.payload_json) AND json_type(r.payload_json,'$.workerChatId')='text'
          AND json_extract(r.payload_json,'$.workerChatId') <> r.origin_chat_id
          AND EXISTS (SELECT 1 FROM chats c WHERE c.id=json_extract(r.payload_json,'$.workerChatId'))
          AND NOT EXISTS (SELECT 1 FROM ${TABLE} m WHERE m.chat_id=json_extract(r.payload_json,'$.workerChatId'))
        ORDER BY r.rowid`).all() as typeof missing);
    }
    if (tableExists(db, "one_team_dispatches") && tableExists(db, "one_supervisor_conversations")) {
      missing.push(...db.prepare(`SELECT d.child_chat_id AS chat_id, p.one_id, 'team' AS source, d.parent_chat_id AS personal_chat_id
        FROM one_team_dispatches d JOIN one_supervisor_conversations p ON p.chat_id=d.parent_chat_id
        WHERE d.child_chat_id <> d.parent_chat_id AND EXISTS (SELECT 1 FROM chats c WHERE c.id=d.child_chat_id)
          AND NOT EXISTS (SELECT 1 FROM ${TABLE} m WHERE m.chat_id=d.child_chat_id)`).all() as typeof missing);
    }
    if (missing.length) {
      const insert = db.prepare(`INSERT OR IGNORE INTO ${TABLE}(chat_id,one_id,source,personal_chat_id,marked_at) VALUES (?,?,?,?,?)`);
      db.transaction(() => { for (const row of missing) added += insert.run(row.chat_id, row.one_id, row.source, row.personal_chat_id, at).changes; })();
    }
  } catch {
    // A locked or partially upgraded store: the rows written at creation still hold; the next read retries.
    backfilledAt.delete(db);
  }
  return added;
}

/** Called where the room is created, inside the creating transaction. */
export function markPersonalAgentRoom(db: Database.Database, input: { chatId: string; oneId: string; source: PersonalAgentRoomSource; personalChatId?: string | null }): void {
  if (!input.chatId || !input.oneId || input.chatId === input.personalChatId) return;
  if (!ensurePersonalAgentRooms(db)) return;
  db.prepare(`INSERT OR IGNORE INTO ${TABLE}(chat_id,one_id,source,personal_chat_id,marked_at) VALUES (?,?,?,?,?)`)
    .run(input.chatId, input.oneId, input.source, input.personalChatId ?? null, new Date().toISOString());
}

/** The team dispatch that just created a child room: marked only when its parent is a personal conversation. */
export function markPersonalAgentTeamRoom(db: Database.Database, childChatId: string, parentChatId: string): void {
  if (!tableExists(db, "one_supervisor_conversations")) return;
  const parent = db.prepare("SELECT one_id FROM one_supervisor_conversations WHERE chat_id=? LIMIT 2").all(parentChatId) as Array<{ one_id: string }>;
  if (parent.length !== 1) return;
  markPersonalAgentRoom(db, { chatId: childChatId, oneId: parent[0].one_id, source: "team", personalChatId: parentChatId });
}

function readable(db: Database.Database): boolean {
  try { backfillPersonalAgentRooms(db); } catch { /* reads below still answer from the rows that exist */ }
  return ensured.has(db) || tableExists(db, TABLE);
}

/** Of these rooms, the ones the personal agent runs now (marked and not released). One query per page. */
export function personalAgentRoomIdsAmong(chatIds: readonly string[], db: Database.Database = defaultDb()): Set<string> {
  const ids = [...new Set(chatIds.filter(id => typeof id === "string" && id))];
  const found = new Set<string>();
  if (!ids.length || !readable(db)) return found;
  for (let index = 0; index < ids.length; index += 400) {
    const chunk = ids.slice(index, index + 400);
    const rows = db.prepare(`SELECT chat_id FROM ${TABLE} WHERE released_at IS NULL AND chat_id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Array<{ chat_id: string }>;
    for (const row of rows) found.add(row.chat_id);
  }
  return found;
}

export function isPersonalAgentRoom(chatId: string, db: Database.Database = defaultDb()): boolean {
  return Boolean(chatId) && personalAgentRoomIdsAmong([chatId], db).has(chatId);
}

/** The owner took this room back from the personal agent ("내가 직접 이어가기"). */
export function personalAgentRoomReleased(chatId: string, db: Database.Database = defaultDb()): boolean {
  if (!chatId || !readable(db)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${TABLE} WHERE chat_id=? AND released_at IS NOT NULL`).get(chatId));
}

/** Rooms the owner released; supervision (approvals on the owner's behalf, follow-ups) leaves them alone. */
export function releasedPersonalAgentRoomIds(db: Database.Database): Set<string> {
  if (!tableExists(db, TABLE)) return new Set();
  return new Set((db.prepare(`SELECT chat_id FROM ${TABLE} WHERE released_at IS NOT NULL`).all() as Array<{ chat_id: string }>).map(row => row.chat_id));
}

export class PersonalAgentRoomError extends Error {
  constructor(readonly code: typeof PERSONAL_AGENT_ROOM_READ_ONLY | "supervised_room_not_found" | "supervised_room_input_invalid") {
    super(code === PERSONAL_AGENT_ROOM_READ_ONLY
      ? "This room is run by your personal agent. Talk to the personal agent instead."
      : code);
    this.name = "PersonalAgentRoomError";
  }
}

/**
 * Every route by which the owner writes a message into a room calls this first: a room the personal agent runs takes
 * no owner-typed message (approval and question answers go through their own routes and are not refused here). The
 * personal agent's own writes (its hand-off, follow-up and messages) do not pass through these routes.
 */
export function assertOwnerMayWriteRoom(chatId: unknown, db?: Database.Database): void {
  if (typeof chatId !== "string" || !chatId) return; // the route's own validation answers malformed input
  let supervised = false;
  try { supervised = isPersonalAgentRoom(chatId, db ?? defaultDb()); } catch { supervised = false; }
  if (supervised) throw new PersonalAgentRoomError(PERSONAL_AGENT_ROOM_READ_ONLY);
}


/** "내가 직접 이어가기": the room becomes an ordinary Work room. Owner-only (renderer IPC; the model's app.call is refused). */
export function releasePersonalAgentRoom(input: unknown, db: Database.Database = defaultDb()): PersonalAgentRoomRelease {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const chatId = typeof value?.chatId === "string" ? value.chatId.trim() : "";
  if (!value || Object.keys(value).some(key => key !== "chatId") || !chatId || chatId.length > 256) throw new PersonalAgentRoomError("supervised_room_input_invalid");
  if (!readable(db)) throw new PersonalAgentRoomError("supervised_room_not_found");
  const row = db.prepare(`SELECT released_at FROM ${TABLE} WHERE chat_id=?`).get(chatId) as { released_at: string | null } | undefined;
  if (!row) throw new PersonalAgentRoomError("supervised_room_not_found");
  if (row.released_at) return { chatId, released: true, releasedAt: row.released_at, alreadyReleased: true };
  const releasedAt = new Date().toISOString();
  db.prepare(`UPDATE ${TABLE} SET released_at=?, released_by='owner' WHERE chat_id=? AND released_at IS NULL`).run(releasedAt, chatId);
  try {
    // The Work lists read tasks: the room's task changes visibility too.
    const bus = require("../store/change-bus") as typeof import("../store/change-bus"); // eslint-disable-line @typescript-eslint/no-require-imports
    bus.emitDesktopStoreChange({ entity: "chat", id: chatId });
    if (tableExists(db, "tasks")) for (const task of db.prepare("SELECT id FROM tasks WHERE origin_chat_id=?").all(chatId) as Array<{ id: string }>) bus.emitTaskStoreChange(db, task.id);
  } catch { /* A store without the event bus (a gate) has no listener to tell. */ }
  return { chatId, released: true, releasedAt, alreadyReleased: false };
}
