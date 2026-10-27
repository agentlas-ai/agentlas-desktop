// Durable inbound line for Telegram updates (no-dead-end sweep 2026-10-25).
//
// The poller saves Telegram's offset the moment an update arrives (telegram_bindings.last_update_id), so Telegram never
// sends it again, and then hands the update to a per-room lane that waits for the room's running turn. Before this file,
// a message waiting in that lane lived only in memory: when the app quit, updated or crashed (or the poller restarted),
// the owner's Telegram message was gone for good, with no reply.
//
// Every update now has a row here from the moment it is queued until its handling has ended. A row that never started
// handling ("queued") is handed to its lane again when the poller starts. A row whose handling had started ("handling")
// is not run a second time: that turn may already have acted (the same rule as the desktop send queue's unconfirmed
// placement); the owner is told once that it stopped before finishing (telegram/connect.ts announceInterruptedTelegramTurns)
// and the row is cleared. Rows older than the window are cleared too: a day-old instruction is not run
// behind the owner's back. The token is never stored; a poller is identified by a hash of it.
// No Electron import: the gate drives this module with a real SQLite handle.
import { createHash } from "node:crypto";

export interface TelegramInboundDb {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): { changes: number }; all(...params: unknown[]): unknown[] };
}

/** Undelivered updates older than this are not replayed (the owner wrote them a day ago). */
export const TELEGRAM_INBOUND_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function telegramPollerKey(token: string): string {
  return createHash("sha256").update(`telegram-poller\0${token}`, "utf8").digest("hex").slice(0, 32);
}

function ensure(db: TelegramInboundDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_inbound_updates (
    poller_key TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    chat_key TEXT NOT NULL,
    update_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','handling')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poller_key, update_id)
  )`);
}

/** The update is accepted: it is in the durable line before it waits for its room. */
export function persistTelegramInbound(db: TelegramInboundDb, input: { pollerKey: string; updateId: number; chatKey: string; update: unknown; now?: number }): void {
  ensure(db);
  db.prepare(`INSERT OR IGNORE INTO telegram_inbound_updates (poller_key, update_id, chat_key, update_json, state, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)`).run(input.pollerKey, input.updateId, input.chatKey, JSON.stringify(input.update), input.now ?? Date.now());
}

/**
 * The update has just ACTED (a command ran, a report toggle changed, the run started): from here on it is never replayed. Called at that
 * first effect, not when the room's lane picks the update up: the judges, the attachment download, the acknowledgement and the start
 * retries before it have no effect, and an interruption in them leaves the row queued for the next poller start.
 */
export function markTelegramInboundHandling(db: TelegramInboundDb, pollerKey: string, updateId: number): void {
  ensure(db);
  db.prepare("UPDATE telegram_inbound_updates SET state = 'handling' WHERE poller_key = ? AND update_id = ?").run(pollerKey, updateId);
}

/** Its handling ended (whatever the outcome): the row leaves the line. */
export function finishTelegramInbound(db: TelegramInboundDb, pollerKey: string, updateId: number): void {
  ensure(db);
  db.prepare("DELETE FROM telegram_inbound_updates WHERE poller_key = ? AND update_id = ?").run(pollerKey, updateId);
}

/**
 * At poller start: the updates accepted by an earlier process that never started handling, in arrival order. Rows that
 * had started handling, and rows past the replay window, are cleared and reported.
 */
export function takeReplayableTelegramInbound(db: TelegramInboundDb, pollerKey: string, now = Date.now(), options: { keepInterrupted?: boolean } = {}):
  { replay: Array<{ updateId: number; chatKey: string; update: unknown }>; interrupted: Array<{ updateId: number; chatKey: string; update: unknown }>; clearedHandling: number; clearedExpired: number } {
  ensure(db);
  // The turns an earlier process had started and did not finish (quit, update, crash): never run again, but the owner was told
  // "I will send the result" and must hear that it stopped. The caller announces them; with keepInterrupted the rows stay until it
  // has (finishTelegramInbound), so a send that failed is tried again at the next start instead of lost.
  const interrupted: Array<{ updateId: number; chatKey: string; update: unknown }> = [];
  for (const row of db.prepare("SELECT update_id, chat_key, update_json FROM telegram_inbound_updates WHERE poller_key = ? AND state = 'handling' AND created_at >= ? ORDER BY update_id")
    .all(pollerKey, now - TELEGRAM_INBOUND_REPLAY_WINDOW_MS) as Array<{ update_id: number; chat_key: string; update_json: string }>) {
    try { interrupted.push({ updateId: row.update_id, chatKey: row.chat_key, update: JSON.parse(row.update_json) }); }
    catch { finishTelegramInbound(db, pollerKey, row.update_id); }
  }
  const clearedHandling = options.keepInterrupted ? 0
    : db.prepare("DELETE FROM telegram_inbound_updates WHERE poller_key = ? AND state = 'handling'").run(pollerKey).changes;
  const clearedExpired = db.prepare("DELETE FROM telegram_inbound_updates WHERE poller_key = ? AND created_at < ?")
    .run(pollerKey, now - TELEGRAM_INBOUND_REPLAY_WINDOW_MS).changes;
  const rows = db.prepare("SELECT update_id, chat_key, update_json FROM telegram_inbound_updates WHERE poller_key = ? AND state = 'queued' ORDER BY update_id")
    .all(pollerKey) as Array<{ update_id: number; chat_key: string; update_json: string }>;
  const replay: Array<{ updateId: number; chatKey: string; update: unknown }> = [];
  for (const row of rows) {
    try { replay.push({ updateId: row.update_id, chatKey: row.chat_key, update: JSON.parse(row.update_json) }); }
    catch { finishTelegramInbound(db, pollerKey, row.update_id); }
  }
  return { replay, interrupted, clearedHandling, clearedExpired };
}
