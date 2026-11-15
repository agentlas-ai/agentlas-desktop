/**
 * Ask the owner once, as a card that rings (Agentlas 2.0 N1a, rule R-a). Owner "묻는건 무조건 카드로 주고 알림 울리게해" - a
 * question the HOST must put to the owner is a decision card (answerable from the desktop and the phone) that rings like a model-authored
 * one, never a line alone. The card copy is fixed host text keyed by the typed boundary (harness/owner-ask-card.ts); no model words.
 *
 * "Once" has two guards, so that every path that can ask (the goal sweep's own rules, a tactic the model reported blocked on a boundary)
 * shares them:
 *  - the same key never posts a second line (a key names one situation: a ladder event, a goal and its barrier code, a goal and a tactic);
 *  - a card that waits for an answer is not posted again within a day, whichever path asked first: the same card in the same chat, newer
 *    than the window, with no owner message after it. Once the owner has written, that card is answered, and the next time the same
 * situation needs the owner (an hour later, the same barrier again) it is a new question (#3: the window alone kept the
 *    second barrier of a day silent, no card and no ring). One owner message never asks for more than one card, so a barrier that keeps
 *    coming back cannot pile cards up.
 * Every card rings under a key of its own (the key and the card's message id): the phone dedupes pushes by key, and a second card of
 * the same situation is a second ask.
 * Never throws and starts no model: a failure to post is logged and reported to the caller as "failed" so it may be tried again.
 */
import { appendChatMessage } from "../store/chats";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { currentUiLocale } from "../ui-locale";
import { reportOwnerAsk } from "../owner-ask-alerts";
import { canonicalAskFenceText } from "../../shared/ask-fence-flatten";
import { ownerAskCard, type OwnerAskCardKind } from "./owner-ask-card";
import { HOST_OWNER_CARD_DECISIONS } from "../long-run/goal-owner-card";
import { recordHostOwnerCardPosted } from "../long-run/goal-owner-card-decision";

export const OWNER_ASK_WINDOW_MS = 24 * 60 * 60_000;

export interface OwnerAskInput {
  chatId: string;
  /** One situation, one key. */
  key: string;
  kind: OwnerAskCardKind;
  /** The plain line above the card. Omit when the situation already told the owner in its own line. */
  line?: { ko: string; en: string };
  /**
   * The Goal's ledger run, for a card whose answer is a typed decision (goal-owner-card.ts): the post is recorded on that run so the
   * owner's pick of "Keep it stopped" is applied by the host as a stop, not read as one more message that reopens the Goal (#2).
   * Only those kinds are recorded: a ledger event moves the run's version, which a turn or a sweep may be fencing on.
   */
  longRunId?: string;
}

export type OwnerAskOutcome = "asked" | "already-asked" | "failed";

export function askOwnerOnce(input: OwnerAskInput): OwnerAskOutcome {
  try {
    const db = getDb();
    const locale = currentUiLocale() === "ko" ? "ko" : "en";
    // The notice's id is the key with anything a notice id may not hold replaced; it is also what the once-per-key check looks for.
    const noticeId = input.key.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
    if (input.line && db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND host_notice_json LIKE ? LIMIT 1")
      .get(input.chatId, `%"runId":${JSON.stringify(noticeId)}%`)) return "already-asked";
    const card = canonicalAskFenceText([ownerAskCard(input.kind, locale)]);
    // A copy of this card within the window that the owner has not written after (rowid is the order the rows were stored in).
    if (db.prepare(`SELECT 1 FROM chat_messages c WHERE c.chat_id = ? AND c.role = 'assistant' AND c.text = ? AND c.created_at > ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages u WHERE u.chat_id = c.chat_id AND u.role = 'user' AND u.rowid > c.rowid) LIMIT 1`)
      .get(input.chatId, card, new Date(Date.now() - OWNER_ASK_WINDOW_MS).toISOString())) return "already-asked";
    // One quiet host-status line above the card, not a report card.
    if (input.line) appendChatMessage(input.chatId, "system", locale === "ko" ? input.line.ko : input.line.en,
      { hostNotice: { purpose: "host-status", runId: noticeId, status: "needs-owner" } });
    // noGoalResult: a host-written card is not the Goal's answer, so it must never wait for a verification verdict.
    const posted = appendChatMessage(input.chatId, "assistant", card, { noGoalResult: true });
    if (input.longRunId && Object.prototype.hasOwnProperty.call(HOST_OWNER_CARD_DECISIONS, input.kind)) {
      try { recordHostOwnerCardPosted({ longRunId: input.longRunId, cardKind: input.kind as keyof typeof HOST_OWNER_CARD_DECISIONS, sourceMessageId: posted.id }); }
      catch (error) { console.warn("[owner-ask] the card could not be recorded on the Goal's ledger:", error instanceof Error ? error.message : String(error)); }
    }
    reportOwnerAsk({ chatId: input.chatId, source: "goal", key: `${input.key}:${posted.id}` });
    emitDesktopStoreChange({ entity: "chat", id: input.chatId });
    return "asked";
  } catch (error) {
    console.warn("[owner-ask] the card could not be posted:", error instanceof Error ? error.message : String(error));
    return "failed";
  }
}
