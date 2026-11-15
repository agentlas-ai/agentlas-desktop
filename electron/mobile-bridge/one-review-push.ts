/**
 * The personal agent's review of a settled hand-off does not ring the phone while other hand-offs are still open (
 * "중간 답변 때도 알림이 온다"; on this computer 4 of the last 7 personal-agent pushes were unprompted one-delegation-review messages,
 * one per settled hand-off, 113 reviews in two days).
 *
 * The message is saved and goes to the phone's open conversation as always; only its PUSH waits. Whether work is left is read from the
 * supervisor's own tables, never from text: a work/science request of this One that is not settled (stored, dispatching, accepted,
 * held), or a settled result not yet reviewed (pending, or claimed by a review that is still open). The saved words of a review that
 * rang nothing are kept in memory; when nothing is left they ring once as the same oneMessage notice (the last one saved), whether the
 * last review spoke (it rings itself) or ended quiet (this releases the held one). A question for the owner, a direct answer to the
 * owner, a check-in and every other personal-agent message are untouched, and a check that cannot be read rings as it always did.
 * No table, column or timer: signals are the personal chat's runs settling and the data_version watch. A restart finds a held review
 * again from the supervisor's ledger (catchUp); the push store's key keeps one already sent from ringing twice.
 */
import { getDb } from "../store/db";
import type { MobilePushNotice } from "./push";

export const REVIEW_PUSH_CATCH_UP_MS = 10 * 60_000;
const OPEN = "('stored','dispatching','accepted','held')";
type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };

/** The One id of a personal conversation, or null when the supervisor does not know the chat. */
export function oneIdOfChat(chatId: string, db: Db = getDb()): string | null {
  const row = db.prepare("SELECT one_id AS oneId FROM one_supervisor_conversations WHERE chat_id=?").get(chatId) as { oneId?: string } | undefined;
  return row?.oneId ?? null;
}

/** The run is a review of settled hand-offs (the supervisor's request row carries its purpose). */
export function isDelegationReviewRun(runId: string, db: Db = getDb()): boolean {
  const row = db.prepare("SELECT payload_json AS payload FROM one_supervisor_requests WHERE run_id=? LIMIT 1").get(runId) as { payload?: string } | undefined;
  return !!row?.payload && (JSON.parse(row.payload) as { purpose?: unknown }).purpose === "one-delegation-review";
}

/** Hand-offs of this One still to be heard from. Throws when the ledger cannot be read (the caller rings as before). `exceptRunId`: the review that is speaking now. */
export function handOffsLeft(oneId: string, exceptRunId?: string, db: Db = getDb()): number {
  const open = db.prepare(`SELECT COUNT(*) AS n FROM one_supervisor_requests WHERE one_id=? AND kind IN ('work','science') AND state IN ${OPEN}`).get(oneId) as { n: number };
  const unreviewed = db.prepare(`SELECT COUNT(*) AS n FROM one_supervisor_notices n WHERE n.one_id=? AND n.state<>'scheduled'
    AND (n.review_state='pending' OR (n.review_state='claimed' AND n.review_run_id IS NOT ? AND EXISTS (
      SELECT 1 FROM one_supervisor_requests r WHERE r.run_id=n.review_run_id AND r.state IN ${OPEN})))`).get(oneId, exceptRunId ?? null) as { n: number };
  return Number(open.n) + Number(unreviewed.n);
}

interface Held { oneId: string; messageId: string; preview: string; at: number }
/** Audit 62 (bridge B10): a hold has an end. "Open" counts a hand-off in the `held` state (outcome unknown), which may stay for hours; a review word held longer than this rings anyway (read at the next signal, no timer). */
export const REVIEW_PUSH_HOLD_MAX_MS = 30 * 60_000;

export interface ReviewPushHoldOptions {
  hostId: string;
  emit(notice: MobilePushNotice): void;
  left?(oneId: string, exceptRunId?: string): number;
  oneId?(chatId: string): string | null;
  isReview?(runId: string): boolean;
  /** The lock-screen text of a saved message (catch-up only: a live hold keeps its own). */
  preview?(messageId: string): string | null;
  now?(): number;
}

export interface ReviewPushHold {
  /** A personal-agent final: true when its push is withheld (the caller then does not send it). Any other personal message is newer than a held one and lets it go. */
  consider(runId: string, chatId: string, message: { messageId: string; preview: string }, asksOwner: boolean): boolean;
  /** Rings the held review when no hand-off is left. */
  evaluate(): void;
  catchUp(db?: Db): number;
  /** A run settled: a delegation review that ended quiet releases a held word. */
  afterSettle(runId: string): void;
  readonly size: number;
}

export function createReviewPushHold(options: ReviewPushHoldOptions): ReviewPushHold {
  const held = new Map<string, Held>(); // by One id
  const leftOf = options.left ?? ((oneId, except) => handOffsLeft(oneId, except));
  const oneOf = options.oneId ?? ((chatId) => oneIdOfChat(chatId));
  const reviewRun = options.isReview ?? ((runId) => isDelegationReviewRun(runId));
  const clock = () => options.now?.() ?? Date.now();
  const notice = (entry: { messageId: string; preview: string }): MobilePushNotice => ({
    category: "oneMessage", destination: "personalOne", hostId: options.hostId, entityId: options.hostId, messageId: entry.messageId,
    dedupeKey: `one-message:${options.hostId}:${entry.messageId}`, subject: "One", ...(entry.preview ? { body: entry.preview } : {}),
    occurredAt: new Date(clock()).toISOString(),
  });
  return {
    consider(runId, chatId, message, asksOwner) {
      let oneId: string | null = null;
      try { oneId = oneOf(chatId); } catch { oneId = null; }
      // Whatever rings now is the newest saved word: an older held review is not rung after it.
      const letGo = () => { if (oneId) held.delete(oneId); };
      if (asksOwner || !oneId) { letGo(); return false; }
      try {
        if (!reviewRun(runId)) { letGo(); return false; }
        if (leftOf(oneId, runId) <= 0) { letGo(); return false; }
      } catch { letGo(); return false; } // cannot tell: rings as it always did
      held.set(oneId, { oneId, messageId: message.messageId, preview: message.preview, at: clock() });
      return true;
    },
    evaluate() {
      for (const [oneId, entry] of [...held]) {
        let left = 0;
        try { left = leftOf(oneId); } catch { left = 0; } // cannot tell: it rings
        if (left > 0 && clock() - entry.at < REVIEW_PUSH_HOLD_MAX_MS) continue;
        held.delete(oneId);
        options.emit(notice(entry));
      }
    },
    catchUp(db = getDb()) {
      let sent = 0;
      try {
        const since = new Date(clock() - REVIEW_PUSH_CATCH_UP_MS).toISOString();
        // Per One, the newest review in the window that spoke: a withheld word is such a message with nothing left to wait for. A review that
        // ended quiet has no message of its own, so the search goes on to the one before it.
        const rows = db.prepare(`SELECT r.one_id AS oneId, r.origin_chat_id AS chatId, r.created_at AS createdAt, r.updated_at AS updatedAt
          FROM one_supervisor_requests r WHERE r.command_id LIKE 'review:%' AND r.state IN ('completed','accepted') AND r.updated_at>?
          AND r.payload_json LIKE '%"purpose":"one-delegation-review"%' ORDER BY r.rowid DESC LIMIT 40`).all(since) as
          Array<{ oneId: string; chatId: string; createdAt: string; updatedAt: string }>;
        const done = new Set<string>();
        for (const row of rows) {
          if (done.has(row.oneId) || held.has(row.oneId)) continue;
          if (leftOf(row.oneId) > 0) { done.add(row.oneId); continue; }
          const message = db.prepare(`SELECT id FROM chat_messages WHERE chat_id=? AND role='assistant' AND text<>'' AND host_notice_json IS NULL AND created_at>=? AND created_at<=?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(row.chatId, row.createdAt, row.updatedAt) as { id: string } | undefined;
          if (!message) continue;
          done.add(row.oneId);
          const preview = options.preview?.(message.id);
          if (preview === null) continue;
          options.emit(notice({ messageId: message.id, preview: preview ?? "" }));
          sent += 1;
        }
      } catch { /* the next start looks again */ }
      return sent;
    },
    afterSettle(runId) {
      // A review that ended quiet releases what an earlier one withheld (after a restart the hold is found again from the ledger).
      try { if (reviewRun(runId)) { this.evaluate(); this.catchUp(); } } catch { /* the next settle looks again */ }
    },
    get size() { return held.size; },
  };
}
