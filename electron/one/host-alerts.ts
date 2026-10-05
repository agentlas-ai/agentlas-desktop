/**
 * Things the app could not get past on its own, reported to the owner by their One.
 *
 * Owner 2026-10-05 ("카드도 바꾸고 그런것들이 다 supervisor one에 전달되서 주인에게 보고하겠지?"): a browser that
 * is really unavailable, a sign-in or human check only the owner can pass, or a Goal the AGI monitor found stuck is
 * told to the owner by One (the supervisor conversation), instead of only a card in whichever room it happened in.
 *
 * Producers call reportHostAlertToOne. The supervisor registers itself as the sink (supervisor.ts), so neither side
 * imports the other. The return value says whether the owner will hear about it through One; when it is false the
 * producer keeps its own fallback (a card), so nothing is lost when One is not running.
 */
export interface OneHostAlert {
  /** The conversation it happened in. */
  chatId: string;
  /** A machine code for what happened (never parsed from prose). */
  code: string;
  /** What the app recorded, in the owner's language. Data for One, not instructions. */
  detail: string;
  /** Dedupe key within the room and code; defaults to the current hour. */
  key?: string;
}

let sink: ((alert: OneHostAlert) => boolean) | null = null;

export function registerOneHostAlertSink(fn: (alert: OneHostAlert) => boolean): () => void {
  sink = fn;
  return () => { if (sink === fn) sink = null; };
}

export function reportHostAlertToOne(alert: OneHostAlert): boolean {
  if (!alert.chatId || !alert.code) return false;
  try { return sink ? sink(alert) : false; } catch { return false; }
}
