/**
 * SQLite adapters for the room discussion engine (ports `RoomLogPort` and `RoomStatePort`).
 *
 * Tables (DDL in store/room-discussion-schema.ts, schema v132):
 *  - room_messages        side index over chat_messages: per-room monotonic seq, kind (post|comment), reply_to.
 *  - room_discussions     one row per owner post that opened a discussion (status, round counter, budget, host).
 *  - room_rounds          one row per round with its snapshot seq.
 *  - room_round_turns     one row per speaker per round; the finished text is kept here until it is in the log.
 *  - room_member_cursors  last room seq each member has been shown.
 *  - room_owner_inbox     owner posts that arrived mid-discussion (durable, consumed when they open a discussion).
 *  - room_discussion_settings  per-room "토론 모드" (NULL = default).
 *
 * The room log itself stays chat_messages so every existing screen keeps rendering it.
 */
import { randomUUID } from "node:crypto";
import type {
  DiscussionRecord, InboxItem, RoomLogPort, RoomMember, RoomPost, RoomStatePort, RoundRecord, TurnRecord,
} from "./room-discussion-core";

/** Minimal slice of better-sqlite3 the adapters use (node:sqlite behind a thin wrapper satisfies it in gates). */
export interface RoomDb {
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export interface RoomStoreOptions {
  db: () => RoomDb;
  /** Writes a chat message and returns its id (store/chats.appendChatMessage). */
  appendChatMessage: (chatId: string, role: "user" | "assistant", text: string, options?: { speakerAgentId?: string }) => { id: string; createdAt: string };
  resolveName?: (chatId: string, agentId: string) => string | null;
  hostId?: string;
  hostPid?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => string;
}

const LEGACY_FIRM_SYNTHESIS_MARKER = "[Results from your team — synthesize into one final answer for the user]";

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

type DiscussionRow = {
  id: string; chat_id: string; status: DiscussionRecord["status"]; stop_reason: DiscussionRecord["stopReason"];
  owner_message_id: string; root_seq: number; round_no: number; max_rounds: number; budget_units: number;
  spent_units: number; stop_requested: number; host_id: string; host_pid: number;
};

type TurnRow = {
  id: string; round_id: string; discussion_id: string; chat_id: string; member_agent_id: string; member_name: string;
  ordinal: number; mode: TurnRecord["mode"]; reason: TurnRecord["reason"]; reply_to: string | null; status: TurnRecord["status"];
  reason_code: string | null; run_id: string | null; child_chat_id: string | null; result_text: string | null; message_id: string | null;
};

function toDiscussion(row: DiscussionRow): DiscussionRecord {
  return {
    id: row.id, chatId: row.chat_id, status: row.status, stopReason: row.stop_reason, ownerMessageId: row.owner_message_id,
    rootSeq: row.root_seq, roundNo: row.round_no, maxRounds: row.max_rounds, budgetUnits: row.budget_units,
    spentUnits: row.spent_units, stopRequested: row.stop_requested === 1,
  };
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id, roundId: row.round_id, discussionId: row.discussion_id, chatId: row.chat_id, agentId: row.member_agent_id,
    name: row.member_name, ordinal: row.ordinal, mode: row.mode, reason: row.reason, replyTo: row.reply_to, status: row.status,
    reasonCode: row.reason_code, runId: row.run_id, childChatId: row.child_chat_id, resultText: row.result_text, messageId: row.message_id,
  };
}

export function createRoomDiscussionStore(options: RoomStoreOptions): { log: RoomLogPort; state: RoomStatePort; messageMeta(chatId: string, limit?: number): RoomMessageMeta[]; hostId: string } {
  const db = options.db;
  const now = options.now ?? (() => new Date().toISOString());
  const hostId = options.hostId ?? randomUUID();
  const hostPid = options.hostPid ?? process.pid;
  const alive = options.isPidAlive ?? defaultPidAlive;

  // ── room log ──────────────────────────────────────────────────

  function nextSeq(chatId: string): number {
    const row = db().prepare("SELECT COALESCE(MAX(seq),0) AS n FROM room_messages WHERE chat_id=?").get(chatId) as { n: number };
    return row.n + 1;
  }

  /** Gives every message the room already holds a seq, in created_at order. Idempotent. */
  function indexRoom(chatId: string): void {
    const rows = db().prepare(
      `SELECT m.id AS id, m.role AS role, m.speaker_agent_id AS speaker, m.created_at AS created_at
         FROM chat_messages m LEFT JOIN room_messages r ON r.message_id = m.id
        WHERE m.chat_id = ? AND r.message_id IS NULL AND m.text <> ''
          AND (m.role = 'user' OR (m.role = 'assistant' AND m.host_notice_json IS NULL))
          AND NOT (m.role = 'user' AND instr(m.text, ?) > 0)
        ORDER BY m.created_at ASC, m.rowid ASC`,
    ).all(chatId, LEGACY_FIRM_SYNTHESIS_MARKER) as Array<{ id: string; role: string; speaker: string | null; created_at: string }>;
    if (rows.length === 0) return;
    db().transaction(() => {
      let seq = nextSeq(chatId);
      for (const row of rows) {
        const author = row.role === "user" ? "owner" : row.speaker ? "member" : "system";
        db().prepare(
          "INSERT OR IGNORE INTO room_messages(message_id,chat_id,seq,kind,author,speaker_agent_id,reply_to,discussion_id,round_no,created_at) VALUES(?,?,?,'post',?,?,NULL,NULL,NULL,?)",
        ).run(row.id, chatId, seq, author, row.speaker, row.created_at);
        seq += 1;
      }
    })();
  }

  type PostRow = {
    message_id: string; seq: number; kind: "post" | "comment"; author: "owner" | "member" | "system"; speaker_agent_id: string | null;
    reply_to: string | null; text: string;
  };

  function toPost(chatId: string, row: PostRow): RoomPost {
    return {
      seq: row.seq, messageId: row.message_id, author: row.author, speakerAgentId: row.speaker_agent_id,
      speakerName: row.speaker_agent_id ? options.resolveName?.(chatId, row.speaker_agent_id) ?? null : null,
      text: row.text, replyTo: row.reply_to, kind: row.kind,
    };
  }

  const POST_SELECT = `SELECT r.message_id AS message_id, r.seq AS seq, r.kind AS kind, r.author AS author, r.speaker_agent_id AS speaker_agent_id,
      r.reply_to AS reply_to, m.text AS text
    FROM room_messages r JOIN chat_messages m ON m.id = r.message_id`;

  function insertMeta(chatId: string, messageId: string, meta: {
    kind: "post" | "comment"; author: "owner" | "member" | "system"; speaker: string | null; replyTo: string | null;
    discussionId: string | null; roundNo: number | null; createdAt: string;
  }): number {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const seq = nextSeq(chatId);
      try {
        db().prepare(
          "INSERT INTO room_messages(message_id,chat_id,seq,kind,author,speaker_agent_id,reply_to,discussion_id,round_no,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(messageId, chatId, seq, meta.kind, meta.author, meta.speaker, meta.replyTo, meta.discussionId, meta.roundNo, meta.createdAt);
        return seq;
      } catch (error) {
        if (!/UNIQUE|constraint/i.test(error instanceof Error ? error.message : String(error)) || attempt === 5) throw error;
      }
    }
    throw new Error("room_seq_unavailable");
  }

  const log: RoomLogPort = {
    maxSeq(chatId) {
      indexRoom(chatId);
      return (db().prepare("SELECT COALESCE(MAX(seq),0) AS n FROM room_messages WHERE chat_id=?").get(chatId) as { n: number }).n;
    },
    listPosts(chatId, range) {
      indexRoom(chatId);
      const rows = db().prepare(`${POST_SELECT} WHERE r.chat_id=? AND r.seq>? AND r.seq<=? ORDER BY r.seq ASC`)
        .all(chatId, range.afterSeq, range.uptoSeq) as PostRow[];
      return rows.map((row) => toPost(chatId, row));
    },
    postByMessageId(chatId, messageId) {
      indexRoom(chatId);
      const row = db().prepare(`${POST_SELECT} WHERE r.chat_id=? AND r.message_id=?`).get(chatId, messageId) as PostRow | undefined;
      return row ? toPost(chatId, row) : null;
    },
    appendOwnerPost(chatId, text) {
      indexRoom(chatId);
      const written = options.appendChatMessage(chatId, "user", text);
      const seq = insertMeta(chatId, written.id, { kind: "post", author: "owner", speaker: null, replyTo: null, discussionId: null, roundNo: null, createdAt: written.createdAt });
      return { seq, messageId: written.id, author: "owner", speakerAgentId: null, speakerName: null, text, replyTo: null, kind: "post" };
    },
    appendMemberPost(chatId, input) {
      indexRoom(chatId);
      const written = options.appendChatMessage(chatId, "assistant", input.text, { speakerAgentId: input.speaker.agentId });
      const seq = insertMeta(chatId, written.id, {
        kind: input.kind, author: "member", speaker: input.speaker.agentId, replyTo: input.replyTo,
        discussionId: input.discussionId, roundNo: input.roundNo, createdAt: written.createdAt,
      });
      return {
        seq, messageId: written.id, author: "member", speakerAgentId: input.speaker.agentId, speakerName: input.speaker.name,
        text: input.text, replyTo: input.replyTo, kind: input.kind,
      };
    },
  };

  // ── state ─────────────────────────────────────────────────────

  const state: RoomStatePort = {
    setting(chatId) {
      const row = db().prepare("SELECT enabled FROM room_discussion_settings WHERE chat_id=?").get(chatId) as { enabled: number | null } | undefined;
      return row?.enabled === 1 ? true : row?.enabled === 0 ? false : null;
    },
    setSetting(chatId, enabled) {
      db().prepare(
        `INSERT INTO room_discussion_settings(chat_id,enabled,updated_at) VALUES(?,?,?)
         ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
      ).run(chatId, enabled === null ? null : enabled ? 1 : 0, now());
    },
    createDiscussion(input) {
      const id = `disc-${randomUUID()}`;
      const at = now();
      db().prepare(
        `INSERT INTO room_discussions(id,chat_id,status,stop_reason,owner_message_id,root_seq,round_no,max_rounds,budget_units,spent_units,stop_requested,host_id,host_pid,created_at,updated_at)
         VALUES(?,?,'running',NULL,?,?,0,?,?,0,0,?,?,?,?)`,
      ).run(id, input.chatId, input.ownerMessageId, input.rootSeq, input.maxRounds, input.budgetUnits, hostId, hostPid, at, at);
      return toDiscussion(db().prepare("SELECT * FROM room_discussions WHERE id=?").get(id) as DiscussionRow);
    },
    discussion(id) {
      const row = db().prepare("SELECT * FROM room_discussions WHERE id=?").get(id) as DiscussionRow | undefined;
      return row ? toDiscussion(row) : null;
    },
    runningDiscussion(chatId) {
      const row = db().prepare("SELECT * FROM room_discussions WHERE chat_id=? AND status='running' ORDER BY created_at DESC LIMIT 1").get(chatId) as DiscussionRow | undefined;
      return row ? toDiscussion(row) : null;
    },
    lastDiscussion(chatId) {
      const row = db().prepare("SELECT * FROM room_discussions WHERE chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(chatId) as DiscussionRow | undefined;
      return row ? toDiscussion(row) : null;
    },
    updateDiscussion(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status=?"); values.push(patch.status); }
      if (patch.stopReason !== undefined) { sets.push("stop_reason=?"); values.push(patch.stopReason); }
      if (patch.roundNo !== undefined) { sets.push("round_no=?"); values.push(patch.roundNo); }
      if (patch.spentUnits !== undefined) { sets.push("spent_units=?"); values.push(patch.spentUnits); }
      if (patch.stopRequested !== undefined) { sets.push("stop_requested=?"); values.push(patch.stopRequested ? 1 : 0); }
      if (sets.length === 0) return;
      sets.push("updated_at=?");
      values.push(now(), id);
      db().prepare(`UPDATE room_discussions SET ${sets.join(",")} WHERE id=?`).run(...values);
    },
    openRound(input) {
      const id = `round-${randomUUID()}`;
      db().prepare("INSERT INTO room_rounds(id,discussion_id,chat_id,round_no,snapshot_seq,status,created_at) VALUES(?,?,?,?,?,'running',?)")
        .run(id, input.discussionId, input.chatId, input.roundNo, input.snapshotSeq, now());
      return { id, discussionId: input.discussionId, roundNo: input.roundNo, snapshotSeq: input.snapshotSeq };
    },
    closeRound(roundId, status, reason) {
      db().prepare("UPDATE room_rounds SET status=?, close_reason=?, closed_at=? WHERE id=?").run(status, reason, now(), roundId);
    },
    insertTurn(input) {
      const id = `turn-${randomUUID()}`;
      const at = now();
      db().prepare(
        `INSERT INTO room_round_turns(id,round_id,discussion_id,chat_id,member_agent_id,member_name,ordinal,mode,reason,reply_to,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(id, input.roundId, input.discussionId, input.chatId, input.agentId, input.name, input.ordinal, input.mode, input.reason, input.replyTo, at, at);
      return toTurn(db().prepare("SELECT * FROM room_round_turns WHERE id=?").get(id) as TurnRow);
    },
    updateTurn(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status=?"); values.push(patch.status); }
      if (patch.reasonCode !== undefined) { sets.push("reason_code=?"); values.push(patch.reasonCode); }
      if (patch.runId !== undefined) { sets.push("run_id=?"); values.push(patch.runId); }
      if (patch.childChatId !== undefined) { sets.push("child_chat_id=?"); values.push(patch.childChatId); }
      if (patch.resultText !== undefined) { sets.push("result_text=?"); values.push(patch.resultText); }
      if (patch.messageId !== undefined) { sets.push("message_id=?"); values.push(patch.messageId); }
      if (sets.length === 0) return;
      sets.push("updated_at=?");
      values.push(now(), id);
      db().prepare(`UPDATE room_round_turns SET ${sets.join(",")} WHERE id=?`).run(...values);
    },
    turns(roundId) {
      return (db().prepare("SELECT * FROM room_round_turns WHERE round_id=? ORDER BY ordinal ASC").all(roundId) as TurnRow[]).map(toTurn);
    },
    roundsOf(discussionId) {
      return (db().prepare("SELECT id, discussion_id, round_no, snapshot_seq, status FROM room_rounds WHERE discussion_id=? ORDER BY round_no ASC").all(discussionId) as Array<{
        id: string; discussion_id: string; round_no: number; snapshot_seq: number; status: string;
      }>).map((row) => ({ id: row.id, discussionId: row.discussion_id, roundNo: row.round_no, snapshotSeq: row.snapshot_seq, status: row.status }));
    },
    cursor(chatId, agentId) {
      const row = db().prepare("SELECT last_seen_seq AS n FROM room_member_cursors WHERE chat_id=? AND member_agent_id=?").get(chatId, agentId) as { n: number } | undefined;
      return row ? row.n : null;
    },
    setCursor(chatId, agentId, seq) {
      db().prepare(
        `INSERT INTO room_member_cursors(chat_id,member_agent_id,last_seen_seq,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(chat_id,member_agent_id) DO UPDATE SET last_seen_seq=MAX(last_seen_seq, excluded.last_seen_seq), updated_at=excluded.updated_at`,
      ).run(chatId, agentId, seq, now());
    },
    addInbox(input) {
      const id = `inbox-${randomUUID()}`;
      db().prepare("INSERT INTO room_owner_inbox(id,chat_id,message_id,interrupt,status,created_at) VALUES(?,?,?,?,'pending',?)")
        .run(id, input.chatId, input.messageId, input.interrupt ? 1 : 0, now());
      return { id, chatId: input.chatId, messageId: input.messageId, interrupt: input.interrupt };
    },
    pendingInbox(chatId) {
      return (db().prepare("SELECT id, chat_id, message_id, interrupt FROM room_owner_inbox WHERE chat_id=? AND status='pending' ORDER BY created_at ASC, rowid ASC").all(chatId) as Array<{
        id: string; chat_id: string; message_id: string; interrupt: number;
      }>).map((row): InboxItem => ({ id: row.id, chatId: row.chat_id, messageId: row.message_id, interrupt: row.interrupt === 1 }));
    },
    consumeInbox(ids) {
      for (const id of ids) db().prepare("UPDATE room_owner_inbox SET status='consumed', consumed_at=? WHERE id=? AND status='pending'").run(now(), id);
    },
    orphanedDiscussions() {
      const rows = db().prepare("SELECT * FROM room_discussions WHERE status='running'").all() as DiscussionRow[];
      return rows.filter((row) => row.host_id !== hostId && !(row.host_pid > 0 && alive(row.host_pid))).map(toDiscussion);
    },
    chatsWithPendingInbox() {
      return (db().prepare("SELECT DISTINCT chat_id FROM room_owner_inbox WHERE status='pending'").all() as Array<{ chat_id: string }>).map((row) => row.chat_id);
    },
  };

  return { log, state, hostId, messageMeta: (chatId, limit = 400) => readMessageMeta(db(), chatId, limit) };
}

export interface RoomMessageMeta {
  messageId: string;
  seq: number;
  kind: "post" | "comment";
  author: "owner" | "member" | "system";
  speakerAgentId: string | null;
  replyTo: string | null;
  roundNo: number | null;
}

/** Thread projection for the screen: the newest `limit` indexed messages with their thread target. */
export function readMessageMeta(db: RoomDb, chatId: string, limit: number): RoomMessageMeta[] {
  const rows = db.prepare(
    `SELECT message_id, seq, kind, author, speaker_agent_id, reply_to, round_no
       FROM room_messages WHERE chat_id=? ORDER BY seq DESC LIMIT ?`,
  ).all(chatId, limit) as Array<{ message_id: string; seq: number; kind: "post" | "comment"; author: "owner" | "member" | "system"; speaker_agent_id: string | null; reply_to: string | null; round_no: number | null }>;
  return rows.reverse().map((row) => ({
    messageId: row.message_id, seq: row.seq, kind: row.kind, author: row.author, speakerAgentId: row.speaker_agent_id,
    replyTo: row.reply_to, roundNo: row.round_no,
  }));
}

export type { RoomMember };
