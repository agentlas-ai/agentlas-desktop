/**
 * Room discussion DDL (schema v132) — leaf module (no store imports) so the schema ladder in db.ts can call it
 * without an import cycle. Tables are documented in electron/one/room-discussion-store.ts.
 *
 * The room log stays `chat_messages` (what the screens already render). `room_messages` is a side table that gives
 * every room message a per-room monotonic `seq`, a thread target (`reply_to`) and a kind (post | comment); a
 * message with no row here is simply a message nobody indexed yet and gets the next seq the first time the
 * engine reads the room (created_at order).
 */
import type Database from "better-sqlite3";

export function createRoomDiscussionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_discussion_settings (
      chat_id TEXT PRIMARY KEY,
      -- NULL = default (on when the room has at least two members), 0/1 = the owner's explicit choice.
      enabled INTEGER CHECK(enabled IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_messages (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('post','comment')),
      author TEXT NOT NULL CHECK(author IN ('owner','member','system')),
      speaker_agent_id TEXT,
      reply_to TEXT,
      discussion_id TEXT,
      round_no INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(chat_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_room_messages_reply ON room_messages(chat_id, reply_to);
    CREATE TABLE IF NOT EXISTS room_discussions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','stopped','interrupted','failed')),
      stop_reason TEXT,
      owner_message_id TEXT NOT NULL,
      root_seq INTEGER NOT NULL,
      round_no INTEGER NOT NULL DEFAULT 0,
      max_rounds INTEGER NOT NULL,
      budget_units INTEGER NOT NULL,
      spent_units INTEGER NOT NULL DEFAULT 0,
      stop_requested INTEGER NOT NULL DEFAULT 0,
      -- The process that runs the loop. Recovery closes only rows whose host is gone (another live process keeps its own).
      host_id TEXT NOT NULL DEFAULT '',
      host_pid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_discussions_chat ON room_discussions(chat_id, status);
    CREATE TABLE IF NOT EXISTS room_rounds (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      round_no INTEGER NOT NULL,
      snapshot_seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','interrupted')),
      close_reason TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(discussion_id, round_no)
    );
    CREATE TABLE IF NOT EXISTS room_round_turns (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      member_agent_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('message','comment')),
      reason TEXT NOT NULL,
      reply_to TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled','interrupted','refused')),
      reason_code TEXT,
      run_id TEXT,
      child_chat_id TEXT,
      -- The finished text is kept here until it is committed to the room log, so a restart between the two
      -- publishes it instead of asking the model again.
      result_text TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_round_turns_round ON room_round_turns(round_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_room_round_turns_running ON room_round_turns(status);
    CREATE TABLE IF NOT EXISTS room_member_cursors (
      chat_id TEXT NOT NULL,
      member_agent_id TEXT NOT NULL,
      last_seen_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(chat_id, member_agent_id)
    );
    CREATE TABLE IF NOT EXISTS room_owner_inbox (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      interrupt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending','consumed')),
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_room_owner_inbox_pending ON room_owner_inbox(chat_id, status, created_at);
  `);
}
