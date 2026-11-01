import type { RuntimeSelection } from "../../shared/types";
import { runtimeSelectionReceiptMatches } from "../../shared/runtime-selection-receipt";
import { readChatSelectionIntent, subscribeChatSelectionIntent } from "./chat-selection-intent";

/** A composer retains its draft only while the desired choice is still on its way to Main (a few moments).
 * This is a synchronous read before draft clearing/ID creation, never a queue
 * or automatic resend. Callers of exact active-run controls do not use it.
 * An unanswered or overtaken choice never holds a send: the conversation's saved selection is what runs, and the
 * chip shows it again on the next read. */
export function chatSelectionSendBlocked(chatId: string | null, renderedSelection?: RuntimeSelection | null): boolean {
  const desired = readChatSelectionIntent(chatId);
  if (!desired) return false;
  if (desired.status === "pending") return true;
  if (desired.status !== "confirmed") return false;
  // Work sends its React chat snapshot. An ACK may arrive before that snapshot
  // renders, so confirmation alone cannot authorize the previous model tuple.
  return renderedSelection !== undefined && !runtimeSelectionReceiptMatches(desired.selection, renderedSelection);
}

/** The longest a send waits for a choice that is still on its way to Main. A choice that never answers does not hold a send:
 * the conversation's saved selection is what runs (the same rule as above). */
export const CHAT_SELECTION_SETTLE_MAX_MS = 8_000;
const CHAT_SELECTION_SETTLE_POLL_MS = 100;

/**
 * One calm status line for a send that went on the conversation's saved model because the owner's new choice never reached Main in time. The
 * four composers share this guard, so the line is drawn here (a transient status element) rather than in each of them; it names nothing to do
 * and nothing is held (regression review 2, N9: the send used to go on the old model with no word, and the chip changed back silently).
 */
export function noteSelectionNotSavedInTime(): void {
  if (typeof document === "undefined") return;
  try {
    const ko = (document.documentElement?.lang || "").toLowerCase().startsWith("ko");
    const line = document.createElement("div");
    line.setAttribute("role", "status");
    line.setAttribute("data-testid", "chat-selection-not-saved");
    line.textContent = ko
      ? "모델 선택이 제때 저장되지 않아, 이 대화에 저장된 모델로 보냈어요."
      : "Your model choice was not saved in time, so this message was sent on the model saved for this conversation.";
    Object.assign(line.style, { position: "fixed", left: "50%", bottom: "96px", transform: "translateX(-50%)", zIndex: "2147483000",
      maxWidth: "min(560px, 92vw)", padding: "8px 14px", borderRadius: "10px", font: "13px/1.4 system-ui, sans-serif",
      background: "var(--paper, #fff)", color: "var(--ink, #111)", border: "1px solid var(--line, #d0d0d0)", boxShadow: "0 2px 10px rgba(0,0,0,.12)" });
    document.body.appendChild(line);
    const gone = setTimeout(() => line.remove(), 9_000);
    (gone as { unref?: () => void }).unref?.();
  } catch { /* a line that cannot be drawn never holds the send */ }
}

/**
 * A send pressed while the model choice is still on its way to Main (a few moments) is not refused and does not leave the Send
 * button greyed: it waits here and `again` runs once the choice has settled. `again` must call the surface's LATEST send (a ref
 * to it, so the draft and the rendered selection are read fresh) and tell it to skip this guard, because after `maxMs` it runs
 * whatever the choice's state. `rendered` reads the selection the surface currently shows (Work and the One chat compare it with
 * the confirmed choice). Returns a function that drops the wait (a second press, another conversation, unmount).
 */
export function sendWhenChatSelectionSettles(
  chatId: string | null,
  rendered: () => RuntimeSelection | null | undefined,
  again: () => void,
  maxMs: number = CHAT_SELECTION_SETTLE_MAX_MS,
): () => void {
  let done = false;
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { done = true; if (timer) clearInterval(timer); if (limit) clearTimeout(limit); unsubscribe(); };
  const finish = () => { if (done) return; stop(); again(); };
  const check = () => { if (!done && !chatSelectionSendBlocked(chatId, rendered())) finish(); };
  unsubscribe = subscribeChatSelectionIntent(check);
  timer = setInterval(check, CHAT_SELECTION_SETTLE_POLL_MS);
  // The wait is over and the choice never confirmed: the send goes on the conversation's saved model, and the owner is told so.
  limit = setTimeout(() => { if (!done && chatSelectionSendBlocked(chatId, rendered())) noteSelectionNotSavedInTime(); finish(); }, maxMs);
  return () => { if (!done) stop(); };
}
