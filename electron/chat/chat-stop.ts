/**
 * One Stop for a conversation.
 *
 * A Stop ends everything that can still write into the chat on its own:
 *  - the sends that are waiting to start (queued in `pending_chat_sends`, a message being prepared, queued directions): each one becomes
 *    `withdrawn`. It is not sent, its saved speech bubble is removed when no run ever read it, and its text is handed back so the window
 *    puts it in the input box. `withdrawn` never comes back to life (a restart and the custody recovery only read queued/held rows);
 *  - the writers that have no run of their own (Goal wakes, the idle/rest report, the blocked-Goal sweep, the startup replay, a pass-stop
 *    notice, a daemon turn's Goal follow-up): they ask `ownerStopHoldsWriters` right before they write, and write nothing while the Stop
 *    is newer than the last thing the person said or did.
 *
 * The epoch is `chats.stop_epoch` (schema v142, store/chats.ts getChatStopEpoch / bumpChatStopEpoch / appendChatMessageIfStopEpoch): a writer
 * that is writing right now compares its start-time epoch inside the write transaction, so a Stop and a wake at the same instant leave exactly
 * one winner. A wake that comes LATER (the Goal's timer fires after the Stop) is not racing: it is held by time - the Stop time is the marker
 * the send queue already reads (`owner-stop:<chatId>`, invocation/earlier-attempt.ts recordOwnerStop) - and a writer is held while that time is
 * not older than the person's last signal (a tie goes to the Stop). No new table, no new column of this module.
 * The person's signals are: a user row of the chat, a Goal control they pressed (`goal_wake_owner_control`, `run.user_control`).
 *
 * Pure of Electron: every function takes the store handle. The conversation's window is told through one store change.
 */
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { appendChatMessageIfStopEpoch, bumpChatStopEpoch, getChatStopEpoch, type appendChatMessage } from "../store/chats";

type AppendOptions = Parameters<typeof appendChatMessage>[3];
import { recordOwnerStop } from "../invocation/earlier-attempt";
import { withdrawQueuedSends, type WithdrawnQueuedSend } from "../invocation/pending-chat-sends";

type Statement = { run(...p: unknown[]): { changes?: number }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
export interface StopDb { prepare(sql: string): Statement; transaction?<T>(fn: () => T): { immediate(): T } & (() => T) }

/** meta key of the Stop time of a chat: the marker the send queue reads (invocation/earlier-attempt.ts, a gate keeps the two equal). */
export const CHAT_STOP_MARKER_PREFIX = "owner-stop:";

/** What a Stop handed back: a message that was not sent. The window puts `text` in the input box. */
export interface WithdrawnOwnerInput {
  /** pending_chat_sends row id, or the preflight steer id. (Directions queued behind a LIVE turn are withdrawn by the run's own Stop, service.ts clearQueuedDirectionsForStop.) */
  id: string;
  source: "pending_chat_send" | "preflight_steer";
  intentId: string | null;
  text: string;
  /** The saved speech bubble was removed (nothing ever read it). false: it stays in the transcript (an earlier attempt had read it). */
  bubbleRemoved: boolean;
}
export interface ChatStopResult { chatId: string; epoch: number; stoppedAt: string; withdrawn: WithdrawnOwnerInput[] }

/** The chat's Stop counter (chats.stop_epoch; 0 for a chat that is gone or a store before schema v142). */
export function readStopEpoch(_db: StopDb | null, chatId: string): number {
  try { return getChatStopEpoch(chatId); } catch { return 0; }
}

/** The time of the person's last Stop of this chat (ISO), null when there is none. */
export function lastOwnerStopAt(db: StopDb, chatId: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`${CHAT_STOP_MARKER_PREFIX}${chatId}`) as { value: string } | undefined;
    return row && typeof row.value === "string" && Number.isFinite(Date.parse(row.value)) ? row.value : null;
  } catch { return null; }
}

/**
 * The newest thing the person said or did in this chat: a user row, a Goal control (the window's resume or message press), and, when the
 * caller names the Goal, that Goal's own control event. ISO time, null when there is nothing.
 */
export function lastOwnerSignalAt(db: StopDb, chatId: string, longRunId?: string | null): string | null {
  const times: string[] = [];
  const take = (sql: string, ...params: unknown[]): void => {
    try { const row = db.prepare(sql).get(...params) as { at: string | null } | undefined; if (row?.at) times.push(row.at); } catch { /* a ledger this store lacks has no signal */ }
  };
  take("SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND role = 'user'", chatId);
  take("SELECT MAX(ts) AS at FROM run_events WHERE chat_id = ? AND kind = 'goal_wake_owner_control'", chatId);
  if (longRunId) take("SELECT MAX(occurred_at) AS at FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control'", longRunId);
  return times.sort().at(-1) ?? null;
}

/**
 * True when the person's Stop of this chat is not older than their last signal: nothing may write an assistant row or start a turn in
 * this chat on its own until they speak or press a Goal control again. Never throws; an unreadable store says "not stopped" so a
 * writer is never frozen by a read error (the Stop itself is also cleared by the person's next word).
 */
export function ownerStopHoldsWriters(chatId: string, options: { longRunId?: string | null; db?: StopDb } = {}): boolean {
  try {
    const db = options.db ?? (getDb() as unknown as StopDb);
    const stop = lastOwnerStopAt(db, chatId);
    if (!stop) return false;
    const signal = lastOwnerSignalAt(db, chatId, options.longRunId);
    return !signal || stop >= signal;
  } catch { return false; }
}

/** Same question for a run that started at `startedAtIso` (a daemon turn): was the Stop after it began and still not answered by the person? */
export function ownerStoppedSince(chatId: string, sinceIso: string, options: { longRunId?: string | null; db?: StopDb } = {}): boolean {
  try {
    const db = options.db ?? (getDb() as unknown as StopDb);
    const stop = lastOwnerStopAt(db, chatId);
    return Boolean(stop && stop >= sinceIso && ownerStopHoldsWriters(chatId, options));
  } catch { return false; }
}

/**
 * The Stop of a chat, everything that is not a live run: counter + time, the waiting sends withdrawn, the message being prepared and
 * the queued directions cancelled. The live run itself is cancelled by the caller (invoke:cancel and the room/team routes). Never throws.
 */
export function stopChatOwnerInputs(chatId: string, options: { db?: StopDb; nowMs?: number } = {}): ChatStopResult {
  const nowMs = options.nowMs ?? Date.now();
  const stoppedAt = new Date(nowMs).toISOString();
  const empty: ChatStopResult = { chatId, epoch: 0, stoppedAt, withdrawn: [] };
  if (typeof chatId !== "string" || !chatId) return empty;
  let db: StopDb;
  try { db = options.db ?? (getDb() as unknown as StopDb); } catch { return empty; }
  const withdrawn: WithdrawnOwnerInput[] = [];
  let epoch = 0;
  const body = (): void => {
    recordOwnerStop(db as never, chatId, nowMs);
    epoch = bumpChatStopEpoch(chatId);
    for (const sent of withdrawQueuedSends(db as never, chatId, nowMs) as WithdrawnQueuedSend[]) {
      withdrawn.push({ id: sent.sendId, source: "pending_chat_send", intentId: sent.intentId, text: sent.text, bubbleRemoved: sent.bubbleRemoved });
    }
    for (const steer of cancelPreparingInputs(db, chatId, stoppedAt)) withdrawn.push(steer);
  };
  try { if (db.transaction) db.transaction(body).immediate(); else body(); }
  catch (error) {
    // The Stop never waits on its bookkeeping: the live run is cancelled by the caller whatever this wrote.
    console.warn("[chat-stop] the Stop's bookkeeping was not written:", error instanceof Error ? error.message : String(error));
    return { ...empty, epoch };
  }
  // The cards of a message_send this conversation still has open belong to the send, not to a turn: the person's Stop is what closes them, and nothing is sent for them.
  try { (require("../harness/peer-send-window") as typeof import("../harness/peer-send-window")).closePeerSendsOfChat(chatId); } catch { /* the card's own deadline closes it */ } // eslint-disable-line @typescript-eslint/no-require-imports
  try { emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* cosmetic */ }
  return { chatId, epoch, stoppedAt, withdrawn };
}

/**
 * The message being prepared (one_preflight_submissions open/reserved/bound, with its queued steers) and queued preflight steers:
 * cancelled, never replayed. Only the steers carry text Main holds; the submission's own text stays in the window that is preparing it
 * (it comes back through its own Stop path).
 */
function cancelPreparingInputs(db: StopDb, chatId: string, stoppedAt: string): WithdrawnOwnerInput[] {
  const out: WithdrawnOwnerInput[] = [];
  try {
    const steers = db.prepare("SELECT steer_id, prompt_text FROM one_preflight_steers WHERE chat_id = ? AND status = 'queued'").all(chatId) as Array<{ steer_id: string; prompt_text: string }>;
    db.prepare("UPDATE one_preflight_steers SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status = 'queued'").run(stoppedAt, chatId);
    db.prepare("UPDATE one_preflight_submissions SET state = 'cancelled', updated_at = ? WHERE chat_id = ? AND state IN ('open','reserved','bound')").run(stoppedAt, chatId);
    for (const steer of steers) out.push({ id: steer.steer_id, source: "preflight_steer", intentId: null, text: steer.prompt_text, bubbleRemoved: false });
  } catch { /* a store without the preflight tables has nothing being prepared */ }
  return out;
}

/**
 * The one way a writer with no run writes an assistant row: nothing when the person's Stop is newer than anything they said or did
 * since (time), and when the Stop lands while this write is going through, the epoch compare inside the write transaction decides
 * (chats.stop_epoch: exactly one of the two wins). Returns false when nothing was written. Never throws for a held write.
 */
export function writeAssistantUnlessStopped(chatId: string, text: string, options?: AppendOptions, hold: { longRunId?: string | null } = {}): boolean {
  if (ownerStopHoldsWriters(chatId, hold)) return false;
  return appendChatMessageIfStopEpoch(chatId, "assistant", text, getChatStopEpoch(chatId), options) !== null;
}
