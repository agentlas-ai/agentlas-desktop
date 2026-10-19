import type Database from "better-sqlite3";
import { emitDesktopStoreChange } from "./change-bus";

/**










 */
export function watchExternalChatChanges(currentDb: () => Database.Database, options: { intervalMs?: number } = {}): () => void {
  let watcher = createWatcher(currentDb());
  const timer = setInterval(() => {
    try {
      // A reopened store (update preflight, recovery) gets fresh statements; its first tick only takes a baseline.
      const db = currentDb();
      if (db !== watcher.db) { watcher = createWatcher(db); return; }
      watcher.tick();
    } catch { /* A busy or closing store skips one tick; the next commit is observed again. */ }
  }, options.intervalMs ?? 400);
  timer.unref?.();
  return () => clearInterval(timer);
}

function createWatcher(db: Database.Database): { db: Database.Database; tick(): void } {
  const dataVersion = db.prepare("PRAGMA data_version").pluck();
  const maxMessageRowid = db.prepare("SELECT COALESCE(MAX(rowid), 0) FROM chat_messages").pluck();
  const maxEventRowid = db.prepare("SELECT COALESCE(MAX(rowid), 0) FROM run_events").pluck();
  const changedMessageChats = db.prepare(
    "SELECT DISTINCT chat_id FROM chat_messages WHERE rowid > ? LIMIT 200").pluck();
  // A Goal result presentation re-labels an existing message; the message row itself does not change.
  const changedPresentationChats = db.prepare(`SELECT DISTINCT chat_id FROM run_events
    WHERE rowid > ? AND kind = 'goal_result_presentation' AND chat_id IS NOT NULL LIMIT 200`).pluck();
  let version = dataVersion.get() as number;
  let messageRowid = maxMessageRowid.get() as number;
  let eventRowid = maxEventRowid.get() as number;
  const tick = (): void => {
    const next = dataVersion.get() as number;
    if (next === version) return;
    version = next;
    const chatIds = new Set<string>();
    const nextMessageRowid = maxMessageRowid.get() as number;
    if (nextMessageRowid > messageRowid) {
      for (const id of changedMessageChats.all(messageRowid) as string[]) chatIds.add(id);
    }
    messageRowid = Math.max(messageRowid, nextMessageRowid);
    const nextEventRowid = maxEventRowid.get() as number;
    if (nextEventRowid > eventRowid) {
      for (const id of changedPresentationChats.all(eventRowid) as string[]) chatIds.add(id);
    }
    eventRowid = Math.max(eventRowid, nextEventRowid);
    for (const id of chatIds) emitDesktopStoreChange({ entity: "chat", id });
  };
  return { db, tick };
}
