/*
 * The one Stop of a conversation, as every surface asks for it: `api.chat.stop(chatId)` - Main stops the chat's live run (whoever started it, a turn waiting on
 * its Goal verification included) AND takes back every send that has not started. No surface calls invoke.cancel for a person's Stop press any more: that one reaches a run id the
 * screen happened to know and leaves the waiting sends (and their words) behind.
 */
import type { ChatStopReceipt } from "@shared/types";

/** A live run was asked to stop, or there was none and the not-started sends were taken back. A run that cannot be reached is neither. */
export function chatStopAccepted(receipt: ChatStopReceipt | null | undefined): boolean {
  if (!receipt) return false;
  return receipt.status === "requested" || receipt.status === "already-requested" || (receipt.runId === null && receipt.status === "not-found");
}

/** The words of the sends that were NOT sent, for the input box (empty ones dropped). */
export function withdrawnWords(receipt: ChatStopReceipt | null | undefined): string[] {
  return (receipt?.withdrawn ?? []).map((item) => item.text).filter((words) => typeof words === "string" && words.trim());
}
