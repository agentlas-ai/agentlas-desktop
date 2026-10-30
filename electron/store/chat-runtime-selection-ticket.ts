import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// An opaque equality token, never a timestamp or a client-provided ordering.
// This internal namespace does not change Chat's persisted or wire shape.
const KEY_PREFIX = "chat_runtime_selection_intent.v1:";
const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS chat_runtime_selection_intent_update_v1
   AFTER UPDATE OF runtime_selection_json ON chats BEGIN
     UPDATE meta SET value=lower(hex(randomblob(32))) WHERE key='${KEY_PREFIX}' || NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS chat_runtime_selection_intent_insert_v1
   AFTER INSERT ON chats BEGIN
     UPDATE meta SET value=lower(hex(randomblob(32))) WHERE key='${KEY_PREFIX}' || NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS chat_runtime_selection_intent_delete_v1
   AFTER DELETE ON chats BEGIN
     DELETE FROM meta WHERE key='${KEY_PREFIX}' || OLD.id;
   END`,
] as const;

export type ChatRuntimeSelectionTicket = Readonly<{ chatId: string; token: string }>;

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function canonicalTrigger(sql: string): string {
  // SQLite removes IF NOT EXISTS in sqlite_master. SQL formatting can also
  // change across builds; the namespace inside a string literal cannot.
  return sql.replace(/^(CREATE\s+TRIGGER)\s+IF\s+NOT\s+EXISTS\s+/i, "$1 ")
    .split(/('(?:''|[^'])*')/g)
    .map((part, index) => index % 2 ? part : part.toLowerCase().replace(/\s+/g, " "))
    .join("").trim().replace(/;$/, "");
}

/** Only the existing migration owner calls this; no Chat row is rewritten. */
export function createChatRuntimeSelectionTicketSchema(db: Database.Database): void {
  // The triggers write the shared key/value table. Every real store has it (store/db.ts creates it early); a store shaped
  // without it must still upgrade and keep saving chats, not fail every chat write with "no such table: main.meta".
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const sql of TRIGGERS) db.exec(sql);
  assertChatRuntimeSelectionTicketSchema(db);
}

function assertChatRuntimeSelectionTicketSchema(db: Database.Database): void {
  const rows = db.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'
    AND name IN ('chat_runtime_selection_intent_update_v1', 'chat_runtime_selection_intent_insert_v1',
                 'chat_runtime_selection_intent_delete_v1')`).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  if (rows.length !== TRIGGERS.length || rows.some((row) => row.tbl_name !== "chats" || !row.sql)
    || !TRIGGERS.every((sql) => rows.some((row) => row.sql && canonicalTrigger(row.sql) === canonicalTrigger(sql)))) {
    throw codedError("chat_runtime_selection_guard_unavailable");
  }
}

/** The caller must hold an IMMEDIATE transaction while validating the request
 * and reserving its ticket. This is the Main-received order, not UI-click order. */
export function reserveChatRuntimeSelectionTicket(db: Database.Database, chatId: string): ChatRuntimeSelectionTicket {
  if (!db.inTransaction) throw codedError("chat_runtime_selection_transaction_required");
  assertChatRuntimeSelectionTicketSchema(db);
  if (!db.prepare("SELECT id FROM chats WHERE id=?").get(chatId)) throw codedError("chat_runtime_selection_chat_missing");
  const ticket = { chatId, token: randomUUID() };
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(KEY_PREFIX + chatId, ticket.token);
  return ticket;
}

/** Check inside the same IMMEDIATE transaction as the pin and Goal event. */
export function assertChatRuntimeSelectionTicketCurrent(db: Database.Database, ticket: ChatRuntimeSelectionTicket): void {
  assertChatRuntimeSelectionTicketSchema(db);
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(KEY_PREFIX + ticket.chatId) as { value: string } | undefined;
  if (row?.value !== ticket.token) throw codedError("chat_runtime_selection_superseded");
}
