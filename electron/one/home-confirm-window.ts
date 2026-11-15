/*
 * The host of the Main-owned confirmation window (Agentlas 2.0 screens: the "yes" that passes power, contracts/one-home-desktop.md §5.4 · §12, one-home-move.md §7).
 * It implements `ConfirmHost` for the gate in home-confirm.ts and holds ONE window at a time. It knows nothing about Electron: the window comes from a port
 * (home-confirm-window-real.ts builds the real one), so the rules below are tested without opening anything.
 *
 *   - the sender check: only an IPC event from the held window's own webContents, from its main frame, on exactly the page it loaded (the port decides what "own" is);
 *   - the first second: the window takes no yes until it has been on screen for CONFIRM_YES_DELAY_MS (the gate asks `pressReady`; a refused press keeps the request);
 *   - the request's two minutes (CONFIRM_TTL_MS, the gate's own value): the window is told, the request is dropped, the window stays only to say so;
 *   - closing the window is a cancel: the gate drops the request it showed (`windowGone`);
 *   - a yes that ran but did not succeed keeps the window open to show the closed word (the press is used up); a yes that succeeded closes it;
 *   - a second request replaces the window of the first (the gate already dropped the first request).
 * A process that cannot open a window (the background service, no display) gets `null` from the port: `openWindow` is false and the gate answers `confirm_window_unavailable`.
 */
import { CONFIRM_TTL_MS, type ConfirmHost, type ConfirmOutcome } from "./home-confirm";

import { CONFIRM_YES_DELAY_MS } from "../../shared/one-home-confirm";
export { CONFIRM_YES_DELAY_MS };
export const CONFIRM_EXPIRED_CHANNEL = "oneHomeConfirm:expired";

export interface ConfirmWindowHandle {
  /** True only for an IPC event that came from this window's own webContents, its main frame, on the page it loaded. */
  isOwnSender(event: unknown): boolean;
  isDestroyed(): boolean;
  /** Loads the page and shows it. Rejects when it cannot. */
  show(): Promise<void>;
  send(channel: string): void;
  destroy(): void;
  /** Called once when the window is gone, however it went (the owner's close button, a crash, `destroy`). */
  onClosed(listener: () => void): void;
}
export interface ConfirmWindowPort {
  /** A new hidden window for this request, or null when this process cannot open one. */
  create(info: { id: string; kind: string }): ConfirmWindowHandle | null;
}
export interface ConfirmWindowHostDeps {
  port: ConfirmWindowPort;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** The request `id` is over without a yes or a cancel through the gate (closed by hand, load failed, two minutes): drop it. */
  gone(id: string): void;
}

interface Held { id: string; kind: string; handle: ConfirmWindowHandle; shownAt: number | null; timer: unknown; settled: boolean; destroying: boolean }

export function createConfirmWindowHost(deps: ConfirmWindowHostDeps): ConfirmHost & { shutdown(): void; _peek(): { id: string | null; shownAt: number | null; settled: boolean; timerArmed: boolean } } {
  let held: Held | null = null;
  const stopTimer = (h: Held): void => { if (h.timer !== null) { try { deps.clearTimer(h.timer); } catch { /* ignore */ } h.timer = null; } };
  const destroy = (h: Held): void => {
    h.destroying = true; stopTimer(h);
    if (held === h) held = null;
    try { if (!h.handle.isDestroyed()) h.handle.destroy(); } catch { /* ignore */ }
  };
  return {
    openWindow(info) {
      if (held) destroy(held);   // the gate dropped the older request already; its window goes
      let handle: ConfirmWindowHandle | null = null;
      try { handle = deps.port.create(info); } catch { handle = null; }
      if (!handle) return false;
      const h: Held = { id: info.id, kind: info.kind, handle, shownAt: null, timer: null, settled: false, destroying: false };
      held = h;
      handle.onClosed(() => {
        if (held === h) held = null;
        stopTimer(h);
        if (!h.destroying) deps.gone(h.id);   // closed by hand (or a crash): the request it showed is cancelled
      });
      h.timer = deps.setTimer(() => {
        h.timer = null;
        if (held !== h || h.settled) return;
        h.settled = true;
        deps.gone(h.id);
        try { if (!h.handle.isDestroyed()) h.handle.send(CONFIRM_EXPIRED_CHANNEL); } catch { /* the window is going */ }
      }, CONFIRM_TTL_MS);
      handle.show().then(() => { if (held === h) h.shownAt = deps.now(); }, () => { if (held === h) { destroy(h); deps.gone(h.id); } });
      return true;
    },
    closeWindow(id: string, outcome?: ConfirmOutcome) {
      const h = held;
      if (!h || h.id !== id) return;
      if (outcome && outcome.ok !== true) {   // the press ran and was refused: the owner reads the word in this window, then closes it
        h.settled = true; stopTimer(h);
        return;
      }
      destroy(h);
    },
    isConfirmSender(event) {
      const h = held;
      if (!h || h.destroying) return false;
      try { return !h.handle.isDestroyed() && h.handle.isOwnSender(event); } catch { return false; }
    },
    pressReady(event) {
      const h = held;
      if (!h || h.destroying || h.shownAt === null) return false;
      try { if (!h.handle.isOwnSender(event)) return false; } catch { return false; }
      return deps.now() - h.shownAt >= CONFIRM_YES_DELAY_MS;
    },
    shutdown() { if (held) { const h = held; destroy(h); deps.gone(h.id); } },
    _peek: () => ({ id: held?.id ?? null, shownAt: held?.shownAt ?? null, settled: held?.settled ?? false, timerArmed: held?.timer != null }),
  };
}
