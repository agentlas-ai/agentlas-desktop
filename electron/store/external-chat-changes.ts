import type Database from "better-sqlite3";
import { emitDesktopStoreChange } from "./change-bus";

/**
 * Chat rows another process committed (the background service hosts One, room and Goal turns since 2026-10-12) reach
 * this process's change bus, so open windows and the phone bridge re-read them at once.
 *
 * The change bus is process-local. A daemon-hosted turn writes its answer, its Goal result presentation and teammate
 * posts from the daemon, whose bus has no listener in any window; Main's `store:changed` never fired, and the open
 * conversation only showed the answer after the owner left the screen and came back (owner 2026-10-14, room
 * "X Marketing": "답변 없어서 다른데 갔다 오면 답이 생겨져있음").
 *
 * `PRAGMA data_version` changes only when another connection commits, so an idle poll is one pragma and Main's own
 * writes (which already emit) are not read twice. Only ids cross the bus, never row content.
 */
export function watchExternalChatChanges(currentDb: () => Database.Database, options: { intervalMs?: number } = {}): () => void {
  let watcher = createWatcher(currentDb());
  const intervalMs = options.intervalMs ?? 400;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    timer = setTimeout(poll, delay);
    timer.unref?.();
  };
  const poll = () => {
    if (stopped) return;
    let delay = intervalMs;
    try {
      // A reopened store (update preflight, recovery) gets fresh statements; its first tick only takes a baseline.
      const db = currentDb();
      if (db !== watcher.db) watcher = createWatcher(db);
      else if (watcher.tick()) delay = Math.min(intervalMs, 10);
    } catch { /* A busy or closing store skips one tick; the next commit is observed again. */ }
    if (!stopped) schedule(delay);
  };
  schedule(intervalMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

function createWatcher(db: Database.Database): { db: Database.Database; tick(): boolean } {
  const dataVersion = db.prepare("PRAGMA data_version").pluck();
  const maxMessageRowid = db.prepare("SELECT COALESCE(MAX(rowid), 0) FROM chat_messages").pluck();
  const maxEventRowid = db.prepare("SELECT COALESCE(MAX(rowid), 0) FROM run_events").pluck();
  const changedMessages = db.prepare(
    "SELECT rowid, chat_id FROM chat_messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 200");
  // Scan bounded rowid ranges: an index on (kind, ts) can otherwise force a
  // sort of all historical presentations on every external commit.
  const changedEvents = db.prepare(
    "SELECT rowid, chat_id, kind FROM run_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 512");
  let version = dataVersion.get() as number;
  let messageRowid = maxMessageRowid.get() as number;
  let eventRowid = maxEventRowid.get() as number;
  let backlog = false;
  const notified = new Set<string>();
  const tick = (): boolean => {
    const next = dataVersion.get() as number;
    if (next === version && !backlog) return false;
    const chatIds = new Set<string>();
    const nextMessageRowid = maxMessageRowid.get() as number;
    const nextEventRowid = maxEventRowid.get() as number;
    let observedMessageRowid = messageRowid;
    let observedEventRowid = eventRowid;
    let more = false;
    if (nextMessageRowid > messageRowid) {
      const rows = changedMessages.all(messageRowid, nextMessageRowid) as Array<{ rowid: number; chat_id: string }>;
      for (const row of rows) chatIds.add(row.chat_id);
      observedMessageRowid = rows.length === 200 ? rows[rows.length - 1].rowid : nextMessageRowid;
      more ||= observedMessageRowid < nextMessageRowid;
    }
    if (nextEventRowid > eventRowid) {
      const rows = changedEvents.all(eventRowid, nextEventRowid) as Array<{ rowid: number; chat_id: string | null; kind: string }>;
      // A Goal result presentation re-labels an existing message.
      for (const row of rows) if (row.kind === "goal_result_presentation" && row.chat_id !== null) chatIds.add(row.chat_id);
      observedEventRowid = rows.length === 512 ? rows[rows.length - 1].rowid : nextEventRowid;
      more ||= observedEventRowid < nextEventRowid;
    }
    // Publish cursors only after every query succeeds. Otherwise a transient
    // busy/closing read would permanently skip both rows and their notices.
    if (next !== version) notified.clear();
    version = next;
    messageRowid = observedMessageRowid;
    eventRowid = observedEventRowid;
    backlog = more;
    for (const id of chatIds) {
      if (notified.has(id)) continue;
      // The set only avoids repeated invalidation during one backlog. A cap
      // bounds memory; clearing it can only produce an extra invalidation.
      if (notified.size >= 4096) notified.clear();
      notified.add(id);
      emitDesktopStoreChange({ entity: "chat", id });
    }
    if (!backlog) notified.clear();
    return backlog;
  };
  return { db, tick };
}
