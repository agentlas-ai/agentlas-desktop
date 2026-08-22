// Sandboxed native live web surface for Work.
//
// WebContentsView is used instead of iframe so real apps that set
// frame-ancestors/X-Frame-Options still run in-app. The loaded page receives no
// Agentlas preload, no Node integration, no Desktop IPC, and no shared cookies.
import { BrowserWindow, WebContentsView } from "electron";
import type { WorkLiveViewBounds, WorkLiveViewStatus } from "../shared/types";

type ActiveWorkView = {
  ownerId: number;
  viewId: string;
  view: WebContentsView;
  window: BrowserWindow;
  origin: string;
  loopbackPort: string | null;
  send: (status: WorkLiveViewStatus) => void;
  visible: boolean;
  mode: "app" | "browser";
};

const activeViews = new Map<string, ActiveWorkView>();

function key(ownerId: number, viewId: string): string {
  return `${ownerId}:${viewId}`;
}

function sanitizeViewId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : null;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function sanitizeWorkLiveUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value ?? "").trim());
    if (!url.hostname || url.username || url.password) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && loopbackHost(url.hostname)) return url;
  } catch {
    // invalid URL
  }
  return null;
}

function sameLiveAppTarget(active: ActiveWorkView, target: string): boolean {
  if (target === "about:blank") return true;
  try {
    const url = new URL(target);
    if (url.origin === active.origin) return true;
    // localhost and 127.0.0.1 are aliases for the same explicitly selected
    // loopback app only when the port is unchanged.
    return Boolean(
      active.loopbackPort
      && loopbackHost(url.hostname)
      && url.port === active.loopbackPort,
    );
  } catch {
    return false;
  }
}

function permittedNavigation(active: ActiveWorkView, target: string): boolean {
  if (active.mode === "browser") return sanitizeWorkLiveUrl(target) !== null;
  return sameLiveAppTarget(active, target);
}

function sanitizeBounds(bounds: WorkLiveViewBounds, window: BrowserWindow): WorkLiveViewBounds {
  const round = (value: unknown) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? number : 0;
  };
  const content = window.getContentBounds();
  const width = Math.max(1, Math.min(Math.max(1, content.width * 2), round(bounds?.width)));
  const height = Math.max(1, Math.min(Math.max(1, content.height * 2), round(bounds?.height)));
  return {
    // Negative coordinates let the OS clip the native surface at the content
    // edge without remapping the page's viewport.
    x: Math.max(-width + 1, Math.min(content.width - 1, round(bounds?.x))),
    y: Math.max(-height + 1, Math.min(content.height - 1, round(bounds?.y))),
    width,
    height,
  };
}

function emit(active: ActiveWorkView, status: Omit<WorkLiveViewStatus, "viewId">): void {
  try { active.send({ viewId: active.viewId, ...status }); } catch {}
}

function closeActive(active: ActiveWorkView, notify = true): void {
  activeViews.delete(key(active.ownerId, active.viewId));
  try {
    if (!active.window.isDestroyed()) active.window.contentView.removeChildView(active.view);
  } catch {}
  try { active.view.webContents.close(); } catch {}
  if (notify) emit(active, { state: "closed" });
}

export function closeWorkLiveView(ownerId: number, viewId: string): { ok: true } {
  const active = activeViews.get(key(ownerId, viewId));
  if (active) closeActive(active);
  return { ok: true };
}

export function closeWorkLiveViewsForOwner(ownerId: number): void {
  for (const active of [...activeViews.values()]) {
    if (active.ownerId === ownerId) closeActive(active, false);
  }
}

export function setWorkLiveViewBounds(
  ownerId: number,
  input: { viewId: string; bounds: WorkLiveViewBounds; visible?: boolean },
): { ok: boolean } {
  const viewId = sanitizeViewId(input?.viewId);
  if (!viewId) return { ok: false };
  const active = activeViews.get(key(ownerId, viewId));
  if (!active || active.window.isDestroyed() || active.view.webContents.isDestroyed()) return { ok: false };
  try {
    active.visible = input.visible !== false;
    active.view.setVisible(active.visible);
    active.view.setBounds(sanitizeBounds(input.bounds, active.window));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function reloadWorkLiveView(ownerId: number, viewId: string): { ok: boolean } {
  const active = activeViews.get(key(ownerId, viewId));
  if (!active || active.view.webContents.isDestroyed()) return { ok: false };
  try {
    active.visible = true;
    active.view.setVisible(active.visible);
    emit(active, { state: "loading", url: active.view.webContents.getURL() });
    active.view.webContents.reloadIgnoringCache();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function navigateWorkLiveView(
  ownerId: number,
  input: { viewId: string; url: string },
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const active = activeViews.get(key(ownerId, input?.viewId));
  const target = sanitizeWorkLiveUrl(input?.url);
  if (!active || active.view.webContents.isDestroyed()) return { ok: false, reason: "view-unavailable" };
  if (!target || !permittedNavigation(active, target.toString())) return { ok: false, reason: "navigation-not-allowed" };
  try {
    emit(active, { state: "loading", url: target.toString() });
    await active.view.webContents.loadURL(target.toString());
    return { ok: true, url: target.toString() };
  } catch (error) {
    return { ok: false, url: target.toString(), reason: error instanceof Error ? error.message : String(error) };
  }
}

export function goBackWorkLiveView(ownerId: number, viewId: string): { ok: boolean } {
  const active = activeViews.get(key(ownerId, viewId));
  if (!active || active.view.webContents.isDestroyed() || !active.view.webContents.navigationHistory.canGoBack()) return { ok: false };
  active.view.webContents.navigationHistory.goBack();
  return { ok: true };
}

export function goForwardWorkLiveView(ownerId: number, viewId: string): { ok: boolean } {
  const active = activeViews.get(key(ownerId, viewId));
  if (!active || active.view.webContents.isDestroyed() || !active.view.webContents.navigationHistory.canGoForward()) return { ok: false };
  active.view.webContents.navigationHistory.goForward();
  return { ok: true };
}

export async function openWorkLiveView(input: {
  ownerId: number;
  window: BrowserWindow;
  viewId: string;
  url: string;
  bounds: WorkLiveViewBounds;
  visible?: boolean;
  mode?: "app" | "browser";
  send: (status: WorkLiveViewStatus) => void;
}): Promise<{ ok: boolean; viewId: string; url?: string; reason?: string }> {
  const viewId = sanitizeViewId(input?.viewId);
  const url = sanitizeWorkLiveUrl(input?.url);
  if (!viewId) return { ok: false, viewId: String(input?.viewId ?? ""), reason: "invalid-view-id" };
  if (!url) return { ok: false, viewId, reason: "Only HTTPS or loopback HTTP live apps are allowed." };
  if (input.window.isDestroyed()) return { ok: false, viewId, reason: "window-closed" };

  // A Work panel owns one native surface. Closing the previous one before
  // opening the next prevents an invisible surface from capturing input.
  closeWorkLiveViewsForOwner(input.ownerId);

  const partition = `agentlas-work-live-${input.ownerId}-${viewId}`;
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: false,
      partition,
    },
  });
  const active: ActiveWorkView = {
    ownerId: input.ownerId,
    viewId,
    view,
    window: input.window,
    origin: url.origin,
    loopbackPort: loopbackHost(url.hostname) ? url.port || (url.protocol === "https:" ? "443" : "80") : null,
    send: input.send,
    visible: input.visible !== false,
    mode: input.mode === "browser" ? "browser" : "app",
  };
  activeViews.set(key(input.ownerId, viewId), active);

  view.setBackgroundColor(active.mode === "browser" ? "#ffffff" : "#111111");
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view.webContents.session.setPermissionCheckHandler(() => false);
  view.webContents.on("did-start-loading", () => {
    emit(active, { state: "loading", url: view.webContents.getURL() || url.toString() });
  });
  view.webContents.on("did-finish-load", () => {
    view.setVisible(active.visible);
    emit(active, {
      state: "ready",
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    });
  });
  view.webContents.on("page-title-updated", (_event, title) => {
    emit(active, { state: "ready", url: view.webContents.getURL(), title });
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // ERR_ABORTED from a newer navigation is not a failure.
    active.visible = false;
    view.setVisible(false);
    emit(active, {
      state: "error",
      url: validatedURL || url.toString(),
      error: errorDescription || `Navigation failed (${errorCode}).`,
    });
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    active.visible = false;
    try { view.setVisible(false); } catch {}
    emit(active, { state: "error", url: view.webContents.getURL(), error: `Web runtime stopped: ${details.reason}` });
  });
  view.webContents.on("unresponsive", () => {
    emit(active, { state: "error", url: view.webContents.getURL(), error: "The live app is not responding." });
  });
  view.webContents.on("will-navigate", (event, target) => {
    if (permittedNavigation(active, target)) return;
    event.preventDefault();
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (permittedNavigation(active, target)) {
      void view.webContents.loadURL(target).catch(() => undefined);
    }
    return { action: "deny" };
  });

  input.window.contentView.addChildView(view);
  view.setBounds(sanitizeBounds(input.bounds, input.window));
  view.setVisible(active.visible);
  emit(active, { state: "opening", url: url.toString() });
  input.window.once("closed", () => {
    if (activeViews.get(key(input.ownerId, viewId)) === active) closeActive(active, false);
  });

  try {
    await view.webContents.loadURL(url.toString());
    return { ok: true, viewId, url: url.toString() };
  } catch (error) {
    if (activeViews.get(key(input.ownerId, viewId)) === active) {
      active.visible = false;
      try { view.setVisible(false); } catch {}
      emit(active, {
        state: "error",
        url: url.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      ok: false,
      viewId,
      url: url.toString(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
