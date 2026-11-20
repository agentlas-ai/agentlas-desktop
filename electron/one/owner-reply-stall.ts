/**
 * An owner message of the personal agent never waits in silence.
 *
 * What went wrong: "no alerts 23:00-07:00" was saved as a shared boundary, and the owner's very next question (23:48) was held by that boundary as if it were a check-in: the user row was
 * stored, the command was retried fifteen times with backoff, no run ever started, and the screen showed nothing until Stop, which then left no line either. The cause is fixed in
 * checkin-admission.ts (`ownerAuthored`); this module is the host's own check so that ANY cause of a held owner message is visible, not only that one:
 *   - a reply command that waits for its next try for more than OWNER_REPLY_STALL_NOTICE_MS says so once, in the conversation;
 *   - a Stop that takes a waiting reply back says so (the reply is withdrawn and the owner reads that it was not sent);
 *   - the newest user row of the conversation that has no run, no command and no queue entry after SILENT_OWNER_ROW_MS says so once (nothing safe can resend it for the owner: the line asks for a resend).
 * Pure SQL over rows that already exist: no table, no timer, no model call. A line is written once per message (the marker is the line's own host-notice run id).
 */
import type Database from "better-sqlite3";

/** How long an owner message may wait for its next try before the conversation says so (the shared backoff steps are 1-2 s early on, so a short wait stays silent). */
export const OWNER_REPLY_STALL_NOTICE_MS = 20_000;
/** How long a saved owner message may have no run, no command and no queue entry before it is called silent. Longer than any start path of one message (admission, preparation, key gate). */
export const SILENT_OWNER_ROW_MS = 60_000;
/** The sweep for silent rows runs at most this often per process (one indexed read of the newest rows of one conversation). */
export const SILENT_OWNER_SWEEP_EVERY_MS = 10_000;
/** A silent row is looked for only among the last day's rows: the run events that prove a start are kept longer than that. */
const SILENT_LOOKBACK_MS = 24 * 3_600_000;

type Locale = "ko" | "en";

export function ownerReplyStallLine(locale: Locale): string {
  return locale === "ko"
    ? "이 메시지는 아직 시작하지 못했어요. 앱이 계속 다시 시도하고 있어요. 중지하면 보내지 않아요."
    : "This message has not started yet. The app keeps trying. Stop takes it back and nothing is sent.";
}
export function ownerReplyStoppedLine(locale: Locale): string {
  return locale === "ko" ? "중지했어요. 이 메시지는 시작되지 않아서 보내지 않았어요." : "Stopped. This message had not started, so it was not sent.";
}
export function silentOwnerRowLine(locale: Locale): string {
  return locale === "ko"
    ? "이 메시지는 시작되지 않았어요. 앱이 시작한 기록이 없어요. 한 번 더 보내 주세요."
    : "This message did not start: the app has no record of starting it. Please send it once more.";
}

/** Marker run ids of the lines above, one per message / command (the `host_notice_json` run id is the idempotency key). */
export const ownerReplyStallMarker = (runId: string): string => `${runId}:stalled`;
export const silentOwnerRowMarker = (messageId: string): string => `silent-owner:${messageId}`;

/** Has a host line with this marker already been written in the conversation? */
export function hostLineWritten(db: Database.Database, chatId: string, marker: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND host_notice_json LIKE ? LIMIT 1").get(chatId, `%"runId":${JSON.stringify(marker)}%`));
}

export type NoticeWriter = (chatId: string, markerRunId: string, text: string, kind?: "info") => void;

/** The stalled-reply line: once per command, only after the wait passed OWNER_REPLY_STALL_NOTICE_MS since the first try. Returns whether a line was written now. */
export function noteStalledOwnerReply(db: Database.Database, write: NoticeWriter, input: { chatId: string; runId: string; firstAt: number; now: number; locale: Locale }): boolean {
  if (input.now - input.firstAt < OWNER_REPLY_STALL_NOTICE_MS) return false;
  const marker = ownerReplyStallMarker(input.runId);
  if (hostLineWritten(db, input.chatId, marker)) return false;
  try { write(input.chatId, marker, ownerReplyStallLine(input.locale)); return true; } catch { return false; }
}

export interface SilentOwnerRow { id: string; createdAt: string }

/**
 * The conversation's newest owner message when nothing accounts for it: no `origin_user_message` run event, no supervisor command that still lives (stored, dispatching, held, accepted),
 * no queued send of the conversation, and no later assistant or system row (a Stop line, an answer, a failure line is such a row). Older than `graceMs`. Null when everything is accounted for.
 */
export function findSilentOwnerRow(db: Database.Database, chatId: string, now: number, graceMs = SILENT_OWNER_ROW_MS): SilentOwnerRow | null {
  const cutoff = new Date(now - graceMs).toISOString();
  const floor = new Date(now - SILENT_LOOKBACK_MS).toISOString();
  const last = db.prepare(
    "SELECT id, created_at AS createdAt FROM chat_messages WHERE chat_id = ? AND role = 'user' AND row_scope IS NULL AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(chatId, floor) as SilentOwnerRow | undefined;
  if (!last || last.createdAt > cutoff) return null;
  const later = db.prepare(
    "SELECT 1 FROM chat_messages WHERE chat_id = ? AND role IN ('assistant','system') AND (row_scope IS NULL OR row_scope <> 'view') AND created_at >= ? LIMIT 1",
  ).get(chatId, last.createdAt);
  if (later) return null;
  const started = db.prepare("SELECT 1 FROM run_events WHERE chat_id = ? AND kind = 'origin_user_message' AND ts >= ? AND payload_json LIKE ? LIMIT 1")
    .get(chatId, new Date(Date.parse(last.createdAt) - 5_000).toISOString(), `%${last.id}%`);
  if (started) return null;
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (hasTable("one_supervisor_requests") && db.prepare("SELECT 1 FROM one_supervisor_requests WHERE user_message_id = ? AND state IN ('stored','dispatching','held','accepted') LIMIT 1").get(last.id)) return null;
  if (hasTable("pending_chat_sends") && db.prepare("SELECT 1 FROM pending_chat_sends WHERE chat_id = ? AND state IN ('queued','starting','held','uncertain') LIMIT 1").get(chatId)) return null;
  if (hasTable("queued_owner_inputs") && db.prepare("SELECT 1 FROM queued_owner_inputs WHERE chat_id = ? AND state IN ('active','placed') LIMIT 1").get(chatId)) return null;
  return last;
}

/** One sweep: writes the silent-row line once for the newest unaccounted owner message. Returns the message id it wrote for, or null. Never throws. */
export function sweepSilentOwnerRow(db: Database.Database, write: NoticeWriter, input: { chatId: string; now: number; locale: Locale }): string | null {
  try {
    const silent = findSilentOwnerRow(db, input.chatId, input.now);
    if (!silent) return null;
    const marker = silentOwnerRowMarker(silent.id);
    if (hostLineWritten(db, input.chatId, marker)) return null;
    write(input.chatId, marker, silentOwnerRowLine(input.locale));
    return silent.id;
  } catch { return null; }
}
