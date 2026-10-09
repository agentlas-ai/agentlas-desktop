// Menu-bar (macOS) / notification-area (Windows, Linux) indicator shown while
// Agentlas keeps running without a window: login continuity ON, or the owner
// chose "백그라운드에서 계속" at quit. It is the visible handle on that process —
// "완전히 종료" is always one click away, so nothing runs invisibly.
import path from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { backgroundHoldShouldQuit, backgroundTrayText } from "./quit-policy";

export interface BackgroundHoldHost {
  locale(): "ko" | "en";
  /** Running work items, same census as the quit prompt. */
  activeWork(): Promise<number>;
  continuity(): boolean;
  /** Show the product window again (and leave background mode). */
  open(): void;
  openOne?(): void;
  /** Full quit: stop work and the service. */
  quitCompletely(): void;
}

let tray: Tray | null = null;
let ticker: NodeJS.Timeout | null = null;
let hold: { autoQuitWhenIdle: boolean } | null = null;
let holdHost: BackgroundHoldHost | null = null;
let lastStatus: string | null = null;

function trayIcon(): Electron.NativeImage {
  // dist/electron/background-tray.js → ../../build-resources/icon-1024.png
  const image = nativeImage.createFromPath(path.join(__dirname, "../../build-resources/icon-1024.png"));
  if (image.isEmpty()) return image;
  return image.resize({ width: process.platform === "win32" ? 16 : 18, height: process.platform === "win32" ? 16 : 18 });
}

export function backgroundHoldActive(): boolean {
  return hold !== null;
}

/** What the indicator shows now (QA reads it; the tray itself is native UI). */
export function backgroundHoldSnapshot(): { active: boolean; trayVisible: boolean; status: string | null; autoQuitWhenIdle: boolean | null } {
  return { active: hold !== null, trayVisible: tray !== null && !tray.isDestroyed(), status: lastStatus, autoQuitWhenIdle: hold?.autoQuitWhenIdle ?? null };
}

/** Same action as the tray's "완전히 종료" item. */
export function quitFromBackgroundHold(): boolean {
  if (!hold || !holdHost) return false;
  holdHost.quitCompletely();
  return true;
}

export function enterBackgroundHold(host: BackgroundHoldHost, options: { autoQuitWhenIdle: boolean }): void {
  hold = { autoQuitWhenIdle: options.autoQuitWhenIdle };
  holdHost = host;
  if (process.platform === "darwin") app.dock?.hide();
  const render = (count: number) => {
    if (!tray) return;
    const text = backgroundTrayText(host.locale(), count);
    lastStatus = text.status;
    tray.setToolTip(text.status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: text.status, enabled: false },
      { type: "separator" },
      { label: text.open, click: () => host.open() },
      ...(host.openOne ? [{ label: host.locale() === "ko" ? "One 열기" : "Open One", click: () => host.openOne?.() }] : []),
      { label: text.quit, click: () => host.quitCompletely() },
    ]));
  };
  if (!tray) {
    tray = new Tray(trayIcon());
    // Windows/Linux: a left click opens the app; the menu is on right click.
    if (process.platform !== "darwin") tray.on("click", () => host.open());
  }
  render(0);
  const tick = () => {
    void host.activeWork().then((count) => {
      render(count);
      if (hold && backgroundHoldShouldQuit({ autoQuitWhenIdle: hold.autoQuitWhenIdle, continuity: host.continuity() }, count)) {
        console.info("[quit] background work finished; quitting");
        host.quitCompletely();
      }
    }).catch(() => { /* next tick retries */ });
  };
  tick();
  if (ticker) clearInterval(ticker);
  ticker = setInterval(tick, 5_000);
  ticker.unref?.();
}

export function leaveBackgroundHold(): void {
  if (hold) console.info("[quit] background mode ended");
  hold = null;
  holdHost = null;
  lastStatus = null;
  if (ticker) clearInterval(ticker);
  ticker = null;
  tray?.destroy();
  tray = null;
  if (process.platform === "darwin") void app.dock?.show();
}
