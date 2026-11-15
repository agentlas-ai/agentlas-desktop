/**
 * What the Main-owned confirmation window's page can call (electron/one/home-confirm-preload.ts exposes it as `window.oneHomeConfirm`; nothing else is exposed there).
 * The three calls are the channels of contracts/one-home-desktop.md §8 that only that window's own webContents may use.
 */
export type OneHomeConfirmView =
  | { ok: true; requestId: string; kind: string; view: Record<string, unknown>; screenBusy: boolean }
  | { ok: false; code: string };
/** One thing a place that is not trusted made on the server (contracts/mirror-trust.md section 3). Every text is the OTHER side's words: plain text for this window only. */
export type OneHomeWaitingItem =
  | { t: "fact"; id: string; kind: string; text: string; at: string }
  | { t: "forget"; id: string; homeId?: string; kind?: string; text?: string; chars?: number; cut?: true; at: string }
  | { t: "words"; turnId: string; seq: number; text: string; chars?: number; cut?: true; at: string }
  | { t: "profile"; name: string; at: string };
export type OneHomeWaitingSelection = { facts?: string[]; gone?: string[]; turns?: string[]; profile?: boolean };
export type OneHomeWaitingDone = { facts: number; gone: number; turns: number; profile: number; apart?: number; newer?: number };
/** The review window's own calls (kind `reviewWaiting`): read the list, read one long text whole, answer over a selection. Each takes the request id of THIS window. */
export interface OneHomeWaitingBridge {
  list(requestId: string): Promise<{ ok: true; textOnly: true; items: OneHomeWaitingItem[]; total: number; screenBusy: boolean } | { ok: false; code: string }>;
  item(requestId: string, list: "turns" | "gone", id: string): Promise<{ ok: true; textOnly: true; item: OneHomeWaitingItem } | { ok: false; code: string }>;
  decide(requestId: string, decision: "accept" | "reject", selection: OneHomeWaitingSelection): Promise<{ ok: true; done: OneHomeWaitingDone; reupload: number } | { ok: false; code: string }>;
}
export interface OneHomeConfirmBridge {
  view(): Promise<OneHomeConfirmView>;
  waiting: OneHomeWaitingBridge;
  /** `answer: "no"` is the window's "this wasn't me" (only a request that carries a refusal takes it). */
  approve(requestId: string, answer?: "no"): Promise<{ ok: boolean; code?: string; [key: string]: unknown }>;
  cancel(requestId: string): Promise<{ ok: boolean; code?: string }>;
  /** Main tells the page that the request's two minutes ended (the request is already gone). */
  onExpired(listener: () => void): () => void;
}
/** Closed words the page can meet after a press, besides the owner-facing ones (renderer/lib/one-home-copy.ts REFUSAL): the press came before the first second was over. */
export const ONE_HOME_CONFIRM_TOO_EARLY = "too_early";
/** "A window opens and about 1 second goes by before the [yes] answers" (contracts/one-home-move.md §7.1, picture J). Main enforces it; the page greys the yes for the same time. */
export const CONFIRM_YES_DELAY_MS = 1000;
