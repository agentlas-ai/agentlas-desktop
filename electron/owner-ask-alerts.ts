/*
 * One typed seam for "an AI asked the owner and is waiting for the answer" that did not come out of a run's own settlement
 * A model-authored card rings through the run's settlement
 * (run-alerts onSettled → pendingQuestion, the phone's final-message push). A card the HOST writes — the AGI monitor's
 * ask — has no such settlement, so it reports here and every listener rings the same way: Main's desktop alert, the
 * phone push. No electron import: gates load this file directly.
 */
export interface OwnerAskAlert {
  chatId: string;
  /** Who asked: the AGI monitor's host-written card, or a model's live ask_user question that holds its run open. */
  source: "agi" | "ask_user";
  /** Dedupe key for one card (the action that posted it). */
  key: string;
}

const listeners = new Set<(alert: OwnerAskAlert) => void>();

export function onOwnerAsk(listener: (alert: OwnerAskAlert) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Never throws and never blocks the caller: an alert is a courtesy to the owner, not part of the action. */
export function reportOwnerAsk(alert: OwnerAskAlert): void {
  if (!alert.chatId || !alert.key) return;
  for (const listener of [...listeners]) {
    try { listener(alert); } catch { /* one broken listener must not silence the others */ }
  }
}
