import type { RuntimeSelection } from "../../shared/types";
import { runtimeSelectionReceiptMatches } from "../../shared/runtime-selection-receipt";
import { readChatSelectionIntent } from "./chat-selection-intent";

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
