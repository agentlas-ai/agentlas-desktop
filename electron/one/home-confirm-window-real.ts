/*
 * The real window behind home-confirm-window.ts. Main only (`installOneHomeConfirmWindow` is called once from main.ts). It follows the vault's window
 * (secrets/one-vault-window.ts): Main creates it, its own in-memory session, one page (`/one-confirm`) and the static files it needs, no navigation, no popups,
 * no webview, no permissions, no dev tools, content protection on (the confirmation number is kept out of screen captures where the OS supports it), and its own
 * preload (home-confirm-preload.js) instead of the owner window's. Window options are the vault's: no always-on-top, the OS title bar, so macOS, Windows and Linux look as their own windows.
 * Electron is loaded on use: the background service (ELECTRON_RUN_AS_NODE) reaches this module through other imports and has no `electron` module.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserWindow, Session } from "electron";
import { createConfirmWindowHost, type ConfirmWindowHandle, type ConfirmWindowPort } from "./home-confirm-window";
import { setOneHomeConfirmHost, oneHome } from "./home";

const electron = (): typeof import("electron") => require("electron") as typeof import("electron");
export const ONE_CONFIRM_PAGE = "/one-confirm";

export interface RealConfirmWindowOptions {
  /** `dist/electron/one/home-confirm-preload.js` */
  preloadPath: string;
  /** Production `agentlas://app`; development the loopback dev server. */
  rendererBaseUrl(): string;
  /** Registers the `agentlas` scheme handler on the isolated session; it must serve ONE_CONFIRM_PAGE and the static assets only. */
  prepareSession(session: Session): void;
}

function exactUrl(raw: string, expected: string): boolean {
  try { const url = new URL(raw); return !url.username && !url.password && url.href === expected; } catch { return false; }
}

export function realConfirmWindowPort(opts: RealConfirmWindowOptions): ConfirmWindowPort {
  return {
    create(info) {
      if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return null;   // the background service has no screen
      const e = electron();
      if (!e.app?.isReady?.() || !e.BrowserWindow) return null;
      if (!path.isAbsolute(opts.preloadPath)) return null;
      const base = new URL(opts.rendererBaseUrl());
      if (!(base.protocol === "agentlas:" && base.host === "app") && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) return null;
      const url = new URL(ONE_CONFIRM_PAGE, base).href;
      const session = e.session.fromPartition(`one-confirm:${randomUUID()}`, { cache: false });
      opts.prepareSession(session);
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.on("will-download", (event, item) => { event.preventDefault(); item.cancel(); });
      session.webRequest.onBeforeRequest((details, callback) => {
        try {
          const resource = new URL(details.url), entry = new URL(url);
          const sameOrigin = entry.protocol === resource.protocol && entry.host === resource.host;
          const staticAsset = resource.pathname.startsWith("/_next/static/") || resource.pathname.startsWith("/fonts/");
          callback({ cancel: !(sameOrigin && (resource.href === url || staticAsset)) });
        } catch { callback({ cancel: true }); }
      });
      const win: BrowserWindow = new e.BrowserWindow({
        width: 460, height: info.kind === "reviewWaiting" ? 600 : 460, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        title: "Agentlas", show: false, autoHideMenuBar: true,
        webPreferences: { preload: opts.preloadPath, session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, webviewTag: false },
      });
      win.setContentProtection(true); win.setMenu(null);
      let closedListener: (() => void) | null = null; let closedSeen = false;
      const wc = win.webContents;
      const handle: ConfirmWindowHandle = {
        isOwnSender: (event) => {
          const ev = event as { sender?: unknown; senderFrame?: { url?: string } | null } | null;
          return !win.isDestroyed() && !!ev && ev.sender === wc && !!ev.senderFrame && ev.senderFrame === (wc as unknown as { mainFrame: unknown }).mainFrame
            && exactUrl(String(ev.senderFrame.url ?? ""), url) && exactUrl(wc.getURL(), url);
        },
        isDestroyed: () => win.isDestroyed(),
        show: async () => {
          await win.loadURL(url);
          if (win.isDestroyed()) throw new Error("confirm_window_closed");
          if (!exactUrl(wc.getURL(), url)) throw new Error("confirm_window_wrong_page");
          win.show(); win.focus();
        },
        send: (channel) => { if (!win.isDestroyed() && !wc.isDestroyed()) wc.send(channel); },
        destroy: () => { if (!win.isDestroyed()) win.destroy(); },
        onClosed: (listener) => { closedListener = listener; if (closedSeen) listener(); },
      };
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", (event) => { event.preventDefault(); if (!win.isDestroyed()) win.close(); });
      wc.on("will-redirect", (event) => { event.preventDefault(); if (!win.isDestroyed()) win.close(); });
      wc.on("will-attach-webview", (event) => event.preventDefault());
      wc.on("context-menu", (event) => event.preventDefault());
      wc.on("render-process-gone", () => { if (!win.isDestroyed()) win.close(); });
      win.on("closed", () => { closedSeen = true; closedListener?.(); });
      return handle;
    },
  };
}

/** Called once from main.ts after `registerOneHomeIpc`. From then on a request for a yes opens this window (the gate answered `confirm_window_unavailable` before). */
export function installOneHomeConfirmWindow(opts: RealConfirmWindowOptions): { shutdown(): void } {
  const host = createConfirmWindowHost({
    port: realConfirmWindowPort(opts),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    gone: (id) => oneHome().confirm.windowGone(id),
  });
  setOneHomeConfirmHost(host);
  return { shutdown: () => host.shutdown() };
}
