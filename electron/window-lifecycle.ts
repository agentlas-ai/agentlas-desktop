// Window lifecycle on Windows/Linux — what closing a window and launching Agentlas again do.
//
// First real Windows run (1.3.88, Win11 ARM64, 2026-10-24): closing the window with X left a ghost —
// no window, no tray, Main/renderer/daemon still running, and launching again did nothing.
//   1. Electron fires `window-all-closed` only when every BrowserWindow is gone. A hidden helper
//      (the company sign-in page that business/shipping-console.ts keeps with show:false, print and
//      render helpers, the computer-use overlay) still counts, so the quit policy never ran.
//   2. `second-instance` returned silently when the main window had been destroyed.
//
// The rule kept here: on Windows/Linux, closing the last window a person can see and use quits
// (through the ordinary quit policy in quit-policy.ts, which may still choose the tray when work is
// running or login continuity is on). A hidden or non-focusable helper window never keeps Agentlas
// alive. A second launch always brings a main window back. macOS is unchanged: closing the last
// window keeps the app in the Dock, and Dock activation reopens it.
//
// Pure logic with structural window types — no Electron import — so a plain-Node gate drives every
// branch on any OS with fake windows and a fake app (scripts/test-window-lifecycle.cjs).

/** The part of a BrowserWindow this policy reads. */
export interface LifecycleWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  /** Overlays (computer-use cursor/badge) are created focusable:false; they are not a window a person uses. */
  isFocusable?(): boolean;
  on(event: "close" | "closed", listener: () => void): unknown;
}

/** A window that keeps the app alive on Windows/Linux: still open, shown, and one a person can focus. */
export function windowKeepsAppAlive(window: LifecycleWindow): boolean {
  if (window.isDestroyed() || !window.isVisible()) return false;
  return typeof window.isFocusable === "function" ? window.isFocusable() : true;
}

export interface LastVisibleWindowInput {
  platform: NodeJS.Platform;
  /** The window that just closed was one a person could see and use when its close began. */
  closedWindowWasUserFacing: boolean;
  /** Every window still open after the close. */
  remaining: readonly LifecycleWindow[];
  /** One's tray/shortcut shell is installed: closing a surface does not stop work (one-window-manager.ts). */
  oneWindowShellActive: boolean;
  /** The quit policy already hid Desktop in the tray (background-tray.ts). */
  backgroundHoldActive: boolean;
  /** A quit is already being resolved or carried out. */
  quitInProgress: boolean;
}

export function shouldQuitAfterWindowClosed(input: LastVisibleWindowInput): boolean {
  if (input.platform === "darwin") return false;
  if (!input.closedWindowWasUserFacing) return false;
  if (input.oneWindowShellActive || input.backgroundHoldActive || input.quitInProgress) return false;
  return !input.remaining.some(windowKeepsAppAlive);
}

export interface LastVisibleWindowHost {
  platform: NodeJS.Platform;
  getAllWindows(): readonly LifecycleWindow[];
  oneWindowShellActive(): boolean;
  backgroundHoldActive(): boolean;
  quitInProgress(): boolean;
  /** Runs the ordinary quit (noteQuitIntent("window-all-closed") + app.quit()). */
  quit(): void;
  /** Defers until Electron has removed the closed window from getAllWindows(). */
  defer?(callback: () => void): void;
}

/**
 * Watch one window. Call for every BrowserWindow (app "browser-window-created"). Whether the window
 * was user-facing is read when its close begins: a hidden helper finishing its job never quits.
 */
export function watchWindowForLastVisibleClose(window: LifecycleWindow, host: LastVisibleWindowHost): void {
  if (host.platform === "darwin") return;
  let userFacingAtClose = false;
  window.on("close", () => {
    try { userFacingAtClose = windowKeepsAppAlive(window); } catch { userFacingAtClose = false; }
  });
  window.on("closed", () => {
    const decide = (): void => {
      const remaining = host.getAllWindows().filter((candidate) => candidate !== window);
      if (shouldQuitAfterWindowClosed({
        platform: host.platform,
        closedWindowWasUserFacing: userFacingAtClose,
        remaining,
        oneWindowShellActive: host.oneWindowShellActive(),
        backgroundHoldActive: host.backgroundHoldActive(),
        quitInProgress: host.quitInProgress(),
      })) host.quit();
    };
    (host.defer ?? setImmediate)(decide);
  });
}

export interface WindowSizeRequest { width: number; height: number; minWidth: number; minHeight: number }

/**
 * The main window's first size on the display it opens on. A 1240x820 window on a 1024x768 screen
 * (work area 1024x720 under the Windows taskbar) ran below the taskbar, so the bottom of every
 * full-height layout — the company account screen's "Back to the app" — was off screen (2026-10-24).
 * Never larger than the work area; the minimum follows, so it cannot push the window back out.
 */
export function fitWindowToWorkArea(request: WindowSizeRequest, workArea: { width: number; height: number } | null): WindowSizeRequest {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return { ...request };
  const width = Math.max(1, Math.min(request.width, Math.floor(workArea.width)));
  const height = Math.max(1, Math.min(request.height, Math.floor(workArea.height)));
  return { width, height, minWidth: Math.min(request.minWidth, width), minHeight: Math.min(request.minHeight, height) };
}

export type SecondInstanceWindowAction = "ignore" | "show-existing" | "create" | "relaunch-after-quit";

/**
 * What a second launch does to the main window. Before the shell is ready the startup sequence
 * shows its own window (and a startup placeholder may already be on screen). Otherwise a launch
 * always ends with a main window on screen — recreated when the person closed it.
 *
 * Once a quit is committed a new window would only be torn down again. On Windows/Linux the launch
 * is not dropped: Agentlas starts again after this process has exited ("relaunch-after-quit",
 * quit-exit.ts). The Windows retest (2026-10-24) launched again during a 27–30 s quit and nothing
 * opened. Nothing is arranged when a relaunch is already planned for this exit (update handoff,
 * restart after a refused handoff): that relaunch opens the window. macOS is unchanged — a launch
 * there reaches the running app as `activate`, and a quitting app ignores it.
 */
export function secondInstanceWindowAction(input: {
  platform: NodeJS.Platform;
  shellReady: boolean;
  quitCommitted: boolean;
  /** This process already restarts itself when it exits. */
  relaunchPlanned: boolean;
  mainWindowAlive: boolean;
}): SecondInstanceWindowAction {
  if (input.quitCommitted) {
    return input.platform !== "darwin" && !input.relaunchPlanned ? "relaunch-after-quit" : "ignore";
  }
  if (input.mainWindowAlive) return "show-existing";
  return input.shellReady ? "create" : "ignore";
}
