/**
 * A screen pack's conversation in its common chat (PLAN Science S6).
 *
 * A Science conversation's record is the ordinary common chat Desktop already keeps for it (store/chats.ts
 * ensureScienceRuntimeChat, tagged `surface_pack = 'science'`): the rows Work, One, the phone and search read. Two records of
 * one turn can exist there, because Science composes the prompt its runtime takes from the owner's words and its research
 * context: the owner's own words (`row_scope = 'view'`: shown by the pack's screen, never runtime input) and the composed
 * prompt the run persisted (`row_scope = 'runtime-input'`: what the runtime took, not shown). Answers the runtime wrote stay
 * NULL: shown and runtime history, exactly like a Work answer. A Work/One chat never has a scoped row, so nothing changes there.
 *
 * Writers here never invent identity: the pack supplies its own message ID (Science's message ID), so a retry or a second
 * copy of the same message is the same row, and a different body under that ID is refused.
 */
import { getDb } from "./db";

export type SurfaceConversationRole = "user" | "assistant" | "system";
export type SurfaceConversationRowScope = "view" | "runtime-input" | null;

export interface SurfaceConversationRow {
  id: string;
  role: SurfaceConversationRole;
  text: string;
  createdAt: string;
  rowScope: SurfaceConversationRowScope;
}

export interface SurfaceConversationCommit {
  pack: string;
  chatId: string;
  messageId: string;
  role: SurfaceConversationRole;
  text: string;
  createdAt: string;
}

const ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const MAX_TEXT_BYTES = 1_000_000;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function assertPackChat(pack: string, chatId: string): void {
  if (typeof pack !== "string" || !/^[a-z0-9-]{1,40}$/.test(pack) || typeof chatId !== "string" || !ID_RE.test(chatId)) fail("surface_conversation_scope_invalid");
  const row = getDb().prepare("SELECT kind, surface_pack, archived_at FROM chats WHERE id = ?").get(chatId) as
    { kind: string | null; surface_pack: string | null; archived_at: string | null } | undefined;
  if (!row) fail("surface_conversation_chat_not_found");
  if (row.surface_pack !== pack) fail("surface_conversation_chat_not_in_pack");
}

function validCommit(input: SurfaceConversationCommit): SurfaceConversationCommit {
  if (!input || typeof input !== "object") fail("surface_conversation_message_invalid");
  if (!ID_RE.test(String(input.messageId ?? ""))) fail("surface_conversation_message_id_invalid");
  if (!["user", "assistant", "system"].includes(input.role)) fail("surface_conversation_role_invalid");
  if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > MAX_TEXT_BYTES) fail("surface_conversation_text_invalid");
  if (typeof input.createdAt !== "string" || !ISO_RE.test(input.createdAt)) fail("surface_conversation_created_at_invalid");
  return input;
}

/** Insert one 'view' row with the pack's own ID, or return the same row on a retry. Caller holds the transaction. */
function commitOne(input: SurfaceConversationCommit): { id: string; createdAt: string; replayed: boolean } {
  const db = getDb();
  const existing = db.prepare("SELECT chat_id, role, text, created_at, row_scope FROM chat_messages WHERE id = ?").get(input.messageId) as
    { chat_id: string; role: string; text: string; created_at: string; row_scope: string | null } | undefined;
  if (existing) {
    // Same ID, same chat, same body: the same message (a retry, or a message already in its common chat).
    if (existing.chat_id !== input.chatId || existing.role !== input.role || existing.text !== input.text) fail("surface_conversation_message_conflict");
    return { id: input.messageId, createdAt: existing.created_at, replayed: true };
  }
  db.prepare("INSERT INTO chat_messages (id, chat_id, role, text, created_at, row_scope) VALUES (?, ?, ?, ?, ?, 'view')")
    .run(input.messageId, input.chatId, input.role, input.text, input.createdAt);
  return { id: input.messageId, createdAt: input.createdAt, replayed: false };
}

/**
 * The pack's screen shows a message the runtime did not write (the owner's words, an owner direction, a host note): it goes into
 * the pack's common chat first, under the pack's own message ID.
 */
export function commitSurfaceViewMessage(input: SurfaceConversationCommit): { id: string; createdAt: string; replayed: boolean } {
  const commit = validCommit(input);
  return getDb().transaction(() => {
    assertPackChat(commit.pack, commit.chatId);
    const result = commitOne(commit);
    if (!result.replayed) getDb().prepare("UPDATE chats SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id = ?")
      .run(commit.createdAt, commit.createdAt, commit.chatId);
    return result;
  }).immediate();
}

/** Rows of the pack's chat by ID, in the chat's own order (created_at, then insertion). Unknown IDs are simply absent. */
export function readSurfaceConversation(input: { pack: string; chatId: string; messageIds: readonly string[] }): SurfaceConversationRow[] {
  assertPackChat(input.pack, input.chatId);
  const ids = [...new Set((Array.isArray(input.messageIds) ? input.messageIds : []).filter((id) => typeof id === "string" && ID_RE.test(id)))];
  if (!ids.length) return [];
  if (ids.length > 5_000) fail("surface_conversation_read_too_large");
  type Read = { seq: number; id: string; role: SurfaceConversationRole; text: string; created_at: string; row_scope: string | null };
  const found: Read[] = [];
  const db = getDb();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    found.push(...db.prepare(`SELECT rowid AS seq, id, role, text, created_at, row_scope FROM chat_messages
      WHERE chat_id = ? AND id IN (${chunk.map(() => "?").join(",")})`).all(input.chatId, ...chunk) as Read[]);
  }
  found.sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.seq - b.seq);
  return found.map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at,
    rowScope: row.row_scope === "view" || row.row_scope === "runtime-input" ? row.row_scope : null }));
}

/**
 * The composed prompt row each run of this chat persisted (mcp/client.ts records `origin_user_message` for the row it wrote),
 * keyed by run. Read-only.
 */
export function surfaceRuntimeInputRows(input: { pack: string; chatId: string; runIds: readonly string[] }): Array<{ runId: string; messageId: string }> {
  assertPackChat(input.pack, input.chatId);
  const runIds = [...new Set((Array.isArray(input.runIds) ? input.runIds : []).filter((id) => typeof id === "string" && ID_RE.test(id)))];
  const out: Array<{ runId: string; messageId: string }> = [];
  const read = getDb().prepare(`SELECT json_extract(e.payload_json, '$.messageId') AS message_id FROM run_events e
    JOIN chat_messages m ON m.id = json_extract(e.payload_json, '$.messageId') AND m.chat_id = e.chat_id
    WHERE e.run_id = ? AND e.chat_id = ? AND e.kind = 'origin_user_message' ORDER BY e.seq LIMIT 1`);
  for (const runId of runIds) {
    const row = read.get(runId, input.chatId) as { message_id: string | null } | undefined;
    if (row?.message_id && ID_RE.test(row.message_id)) out.push({ runId, messageId: row.message_id });
  }
  return out;
}

/**
 * One-time copy of a pack conversation recorded before its common chat held it (PLAN S6, owner decision D2): every visible row
 * comes in under its own ID as a 'view' row (a row already there is the same message and is left as it is), and the composed
 * prompt rows the runtime took are marked 'runtime-input' so a reader of the chat shows the owner's words, not the prompt. Nothing
 * is deleted or rewritten; the pack keeps its own original. One transaction: all of it or none.
 */
export function importSurfaceConversation(input: {
  pack: string;
  chatId: string;
  rows: readonly Omit<SurfaceConversationCommit, "pack" | "chatId">[];
  runtimeInputRowIds: readonly string[];
}): { inserted: number; existing: number; marked: number } {
  const rows = (Array.isArray(input.rows) ? input.rows : []).map((row) => validCommit({ ...row, pack: input.pack, chatId: input.chatId }));
  if (rows.length > 20_000) fail("surface_conversation_import_too_large");
  const markIds = [...new Set((Array.isArray(input.runtimeInputRowIds) ? input.runtimeInputRowIds : []).filter((id) => typeof id === "string" && ID_RE.test(id)))];
  return getDb().transaction(() => {
    assertPackChat(input.pack, input.chatId);
    let inserted = 0, existing = 0, marked = 0;
    for (const row of rows) {
      if (commitOne(row).replayed) existing += 1; else inserted += 1;
    }
    const mark = getDb().prepare("UPDATE chat_messages SET row_scope = 'runtime-input' WHERE id = ? AND chat_id = ? AND row_scope IS NULL AND role IN ('user','system')");
    for (const id of markIds) marked += mark.run(id, input.chatId).changes;
    return { inserted, existing, marked };
  }).immediate();
}
