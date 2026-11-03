import type Database from "better-sqlite3";

/** Created by the canonical store owner migration. Existing marker-only rows are not backfilled. */
export function createChatFileMessageBindings(db: Pick<Database.Database, "exec">): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_file_groups (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_file_message_bindings (
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES chat_file_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_file_message_bindings_chat ON chat_file_message_bindings(chat_id, message_id);`);
}

/** Bind only an explicitly selected group to the just-inserted owner message in the same transaction. */
export function bindChatFileGroupToMessage(db: Database.Database, input: { chatId: string; messageId: string; groupId: string }): void {
  if (!db.inTransaction || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.groupId)) {
    throw new Error("chat_file_message_binding_invalid");
  }
  const match = db.prepare(`SELECT 1 FROM chat_messages m JOIN chat_file_groups g ON g.chat_id = m.chat_id
    WHERE m.id = ? AND m.chat_id = ? AND m.role = 'user' AND g.id = ?
    AND EXISTS (SELECT 1 FROM chat_file_items i WHERE i.chat_id = m.chat_id AND i.group_id = g.id)`).get(input.messageId, input.chatId, input.groupId);
  if (!match) throw new Error("chat_file_message_binding_unavailable");
  db.prepare("INSERT INTO chat_file_message_bindings (message_id, chat_id, group_id) VALUES (?, ?, ?)")
    .run(input.messageId, input.chatId, input.groupId);
}

/** No marker text or cross-chat identifier can substitute for the durable host-owned row. */
export function hasChatFileMessageBinding(db: Database.Database, input: { chatId: string; messageId: string; groupId: string }): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM chat_file_message_bindings b
    JOIN chat_messages m ON m.id = b.message_id AND m.chat_id = b.chat_id AND m.role = 'user'
    JOIN chat_file_groups g ON g.id = b.group_id AND g.chat_id = b.chat_id
    WHERE b.chat_id = ? AND b.message_id = ? AND b.group_id = ?`).get(input.chatId, input.messageId, input.groupId));
}
