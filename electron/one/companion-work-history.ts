import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CompanionWorkContext } from "./companion-work-context";

/** Copy the verified conversation as its original ordered roles. The caller owns
 * the same transaction that admits the handoff; no text is made into host policy. */
export function seedCompanionWorkHistory(db: Database.Database, chatId: string, context: CompanionWorkContext): void {
  if (!db.inTransaction || !chatId || !context.messages.length) throw new Error("companion_work_history_invalid");
  const insert = db.prepare("INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)");
  // The source wire format carries sequence, not wall-clock times. Give the
  // imported rows distinct increasing local timestamps before this admission so
  // timestamp-only readers and later real messages preserve the same order.
  const first = Date.now() - context.messages.length;
  for (const [index, message] of context.messages.entries()) {
    insert.run(randomUUID(), chatId, message.role, message.text, new Date(first + index).toISOString());
  }
}
