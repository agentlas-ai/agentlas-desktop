/** One request the app keeps for an outside cause and continues by itself (electron/invocation/kept-requests.ts reads and closes it). */
export interface KeptRequestView {
  /** The id the cancel takes (the original run of the failed turn). */
  id: string;
  chatId: string;
  chatTitle: string | null;
  /** The Goal this request belongs to (an earlier build kept the request of a Goal's own turn); null for a one-off request, which has Cancel only. */
  goalId: string | null;
  /** The owner's own words, cut for a list row. */
  promptPreview: string | null;
  /** The closed cause word (shared/owner-failure-class ExternalFailureCause) or "internal". */
  cause: string;
  keptSince: string;
  /** When the app looks again by itself: the provider's stated time, else the next timed check; null = only a signal or a restart releases it. */
  nextCheckAt: string | null;
  /** True when the app will continue it with at most write access and ask again before a delete or a send (it was sent with full access). */
  asksAgainBeforeEffects: boolean;
}
