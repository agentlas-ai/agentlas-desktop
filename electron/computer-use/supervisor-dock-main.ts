import { BrowserWindow, screen } from "electron";
import { getOneWindow } from "../one-window-manager";
import { getOneProfile } from "../store/one-profile";
import { currentUiLocale } from "../ui-locale";
import { invokeNativeInputDriver } from "./native-driver";
import { configureSupervisorDock, registerSupervisorDockOverlayWindow, SupervisorDock, type DockBadgeState, type DockPorts } from "./supervisor-dock";
import { supervisorBadgeBounds, supervisorBadgeText, supervisorBadgeWidth, supervisorCursorLabelBounds, supervisorDockName, type DockRect } from "./supervisor-dock-layout";

/*
 * Main-process ports for the supervisor right-dock (the controller is supervisor-dock.ts). This file imports Electron at
 * the top, so only main.ts may import it: the background service must never reach it
 * (scripts/test-daemon-loads-without-electron.cjs).
 *
 * Overlay windows are transparent, frameless, non-focusable, click-through and always on top. They load a static page
 * from an in-memory partition (no preload, no Node, no navigation, no network) and are updated only through
 * textContent / className set from JSON-encoded strings, so an agent name can never become markup.
 */
const BADGE_HEIGHT = 22;
const CURSOR_HEIGHT = 20;
const PAGE = (body: string) => "data:text/html;charset=utf-8," + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
  + "<style>html,body{margin:0;background:transparent;overflow:hidden;user-select:none;-webkit-user-select:none;cursor:default}"
  + "body{font:600 11px/1 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',system-ui,sans-serif}"
  + "#p{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:100vh;padding:0 10px 0 8px;border-radius:999px;background:#b1345f;color:#fff;white-space:nowrap;overflow:hidden}"
  + "#p.done{background:#1f9d62}#t{overflow:hidden;text-overflow:ellipsis}"
  + "#i{flex:none;width:6px;height:6px;border-radius:50%;background:#fff;animation:b 1.1s ease-in-out infinite}"
  + "#p.done #i{width:8px;height:4px;border-radius:0;background:none;border:solid #fff;border-width:0 0 2px 2px;transform:rotate(-45deg) translate(1px,-1px);animation:none}"
  + "#c{display:none}.cursor #i{display:none}.cursor{padding:0 8px}"
  + "@keyframes b{0%,100%{opacity:1}50%{opacity:.3}}</style>" + body);
const BADGE_PAGE = PAGE('<div id="p"><span id="i"></span><span id="t"></span></div>');
const CURSOR_PAGE = PAGE('<div id="p" class="cursor"><span id="i"></span><span id="t"></span></div>');

class Overlay {
  private badgeWindow: BrowserWindow | null = null;
  private cursorWindow: BrowserWindow | null = null;
  private badgeReady: Promise<void> = Promise.resolve();
  private cursorReady: Promise<void> = Promise.resolve();

  private create(bounds: DockRect, page: string): { window: BrowserWindow; ready: Promise<void> } {
    const window = new BrowserWindow({
      ...bounds, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
      ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
      webPreferences: { partition: "supervisor-dock-overlay", sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        spellcheck: false, backgroundThrottling: false, devTools: false },
    });
    const unregister = registerSupervisorDockOverlayWindow(window.id);
    window.on("closed", unregister);
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    const ready = new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
      window.webContents.once("did-fail-load", () => resolve());
    });
    void window.loadURL(page).catch(() => undefined);
    return { window, ready };
  }
  private async paint(window: BrowserWindow, ready: Promise<void>, text: string, state: DockBadgeState | "cursor"): Promise<void> {
    await ready;
    if (window.isDestroyed()) return;
    const script = `(()=>{const p=document.getElementById("p"),t=document.getElementById("t");if(!p||!t)return;t.textContent=${JSON.stringify(text)};`
      + `p.className=${JSON.stringify(state === "done" ? "done" : state === "cursor" ? "cursor" : "")};})()`;
    try { await window.webContents.executeJavaScript(script, false); } catch { /* the overlay is cosmetic */ }
    if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
  }

  badge(target: DockRect, state: DockBadgeState, name: string, locale: "ko" | "en"): void {
    const text = supervisorBadgeText(name, state, locale);
    const width = supervisorBadgeWidth(text) + (state === "done" ? 0 : 6);
    const area = screen.getDisplayMatching({ x: Math.round(target.x), y: Math.round(target.y), width: Math.round(target.width), height: Math.round(target.height) }).workArea;
    const bounds = supervisorBadgeBounds(target, { width, height: BADGE_HEIGHT }, area);
    if (!this.badgeWindow || this.badgeWindow.isDestroyed()) {
      const created = this.create(bounds, BADGE_PAGE);
      this.badgeWindow = created.window; this.badgeReady = created.ready;
    } else this.badgeWindow.setBounds(bounds);
    void this.paint(this.badgeWindow, this.badgeReady, text, state);
  }
  cursor(point: { x: number; y: number }, name: string): void {
    const text = supervisorDockName(name);
    const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
    const bounds = supervisorCursorLabelBounds(point, { width: supervisorBadgeWidth(text) - 20, height: CURSOR_HEIGHT }, area);
    if (!this.cursorWindow || this.cursorWindow.isDestroyed()) {
      const created = this.create(bounds, CURSOR_PAGE);
      this.cursorWindow = created.window; this.cursorReady = created.ready;
    } else this.cursorWindow.setBounds(bounds);
    void this.paint(this.cursorWindow, this.cursorReady, text, "cursor");
  }
  hide(): void {
    for (const window of [this.badgeWindow, this.cursorWindow]) if (window && !window.isDestroyed()) window.destroy();
    this.badgeWindow = null; this.cursorWindow = null;
  }
}

/** Installs the real ports. Called once from main.ts after the One window host is configured. */
export function installSupervisorDock(): void {
  const overlay = new Overlay();
  const ports: DockPorts = {
    platform: process.platform,
    selfPid: process.pid,
    driver: (request) => invokeNativeInputDriver(request),
    workAreaFor: (rect) => {
      const x = Math.round(rect.x), y = Math.round(rect.y), width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
      return screen.getDisplayMatching({ x, y, width, height }).workArea;
    },
    oneWindow: () => {
      const window = getOneWindow();
      if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return null;
      return {
        visible: true, fullScreen: window.isFullScreen() || window.isMaximized(),
        get bounds() { return window.getBounds(); },
        setBounds: (bounds) => { if (!window.isDestroyed()) window.setBounds(bounds); },
      };
    },
    agentName: () => { try { return getOneProfile().displayName; } catch { return "Hope"; } },
    locale: () => (currentUiLocale() === "ko" ? "ko" : "en"),
    overlay: { badge: (t, s, n, l) => overlay.badge(t, s, n, l), cursor: (p, n) => overlay.cursor(p, n), hide: () => overlay.hide() },
    setTimer: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
  configureSupervisorDock(new SupervisorDock(ports));
}
