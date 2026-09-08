// Sandboxed native live web surface for Work.
//
// WebContentsView is used instead of iframe so real apps that set
// frame-ancestors/X-Frame-Options still run in-app. The loaded page receives no
// Agentlas preload, no Node integration or Desktop IPC. Browser tabs share only
// the persistent Agentlas native-browser session; app previews remain isolated.
import { BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { WorkLiveViewBounds, WorkLiveViewStatus, WorkLiveViewInput, WorkLiveBrowserTab } from "../shared/types";

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
  taskScopeId?: string;
  state: WorkLiveViewStatus["state"];
  navigationEpoch: number;
  pendingUrl: string;
  error?: string;
};

const activeViews = new Map<string, ActiveWorkView>();
export const NATIVE_BROWSER_PARTITION = "persist:agentlas-browser-default";
export const MAX_NATIVE_BROWSER_TABS_PER_OWNER = 8;
type NativeTaskOwner = { ownerId: number; window: BrowserWindow; taskScopeId: string; send: (status: WorkLiveViewStatus) => void };
const nativeTaskOwners = new Map<string, NativeTaskOwner>();
const ownerCleanup = new Map<number, { window: BrowserWindow; listener: () => void }>();
const MAX_NATIVE_TASK_BINDINGS_PER_OWNER = 64;

function ensureOwnerCleanup(ownerId: number, window: BrowserWindow): void {
  if (ownerCleanup.has(ownerId)) return;
  const listener = () => closeWorkLiveViewsForOwner(ownerId);
  ownerCleanup.set(ownerId, { window, listener });
  window.once("closed", listener);
}

/** Main calls only after verifying an actual chat and its trusted Desktop sender. */
export function registerNativeBrowserTask(owner: NativeTaskOwner): void {
  if (owner.window.isDestroyed()) throw new Error("native-browser-owner-closed");
  ensureOwnerCleanup(owner.ownerId, owner.window);
  const ownerKey = key(owner.ownerId, owner.taskScopeId);
  if (!nativeTaskOwners.has(ownerKey)) {
    const bindings = [...nativeTaskOwners.entries()].filter(([, entry]) => entry.ownerId === owner.ownerId);
    if (bindings.length >= MAX_NATIVE_TASK_BINDINGS_PER_OWNER) {
      const unused = bindings.find(([, entry]) => ![...activeViews.values()].some((active) =>
        active.ownerId === owner.ownerId && active.taskScopeId === entry.taskScopeId));
      if (!unused) throw new Error("native-browser-task-binding-limit");
      nativeTaskOwners.delete(unused[0]);
    }
  }
  nativeTaskOwners.set(ownerKey, owner);
}

export function nativeBrowserTaskOwner(taskScopeId: string): NativeTaskOwner | null {
  const matches = [...nativeTaskOwners.values()].filter((owner) => owner.taskScopeId === taskScopeId && !owner.window.isDestroyed());
  // An unattended or ambiguous window binding cannot select a guest on the model's behalf.
  return matches.length === 1 ? matches[0] : null;
}

function browserTab(active: ActiveWorkView): WorkLiveBrowserTab {
  return { viewId: active.viewId, taskScopeId: active.taskScopeId!, state: active.state, visible: active.visible && active.state === "ready",
    url: active.view.webContents.getURL() || active.pendingUrl, title: active.view.webContents.getTitle(),
    canGoBack: active.view.webContents.navigationHistory.canGoBack(),
    canGoForward: active.view.webContents.navigationHistory.canGoForward(), error: active.error };
}

export function listWorkBrowserTabs(ownerId: number, taskScopeId: string): WorkLiveBrowserTab[] {
  return [...activeViews.values()].filter((active) => active.ownerId === ownerId
    && active.mode === "browser" && active.taskScopeId === taskScopeId && isCurrent(active)).map(browserTab);
}

export async function createWorkBrowserTab(ownerId: number, taskScopeId: string, url = "about:blank"):
  Promise<{ ok: boolean; tab?: WorkLiveBrowserTab; reason?: string }> {
  const owner = nativeTaskOwners.get(key(ownerId, taskScopeId));
  if (!owner || owner.window.isDestroyed()) return { ok: false, reason: "task-not-bound" };
  const viewId = `browser_${randomUUID().replace(/-/g, "")}`;
  const result = await openWorkLiveView({ ...owner, viewId, url, mode: "browser", visible: false,
    bounds: { x: 0, y: 0, width: 1000, height: 750 } });
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  return result.ok && active ? { ok: true, tab: browserTab(active) } : { ok: false, reason: result.reason ?? "guest-unavailable" };
}

/** Main-only access for the scoped CDP relay; never exposed through renderer IPC. */
export function nativeBrowserGuest(ownerId: number, taskScopeId: string, viewId: string): WebContents | null {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  return active?.mode === "browser" ? active.view.webContents : null;
}


function isCurrent(active: ActiveWorkView): boolean {
  return activeViews.get(key(active.ownerId, active.viewId)) === active
    && !active.window.isDestroyed() && !active.view.webContents.isDestroyed();
}

/** Exact registered guest only. Main's renderer and unrelated CDP targets never qualify. */
function registeredGuest(ownerId: number, viewId: unknown, taskScopeId?: string): ActiveWorkView | null {
  const id = sanitizeViewId(viewId);
  const active = id ? activeViews.get(key(ownerId, id)) : undefined;
  return active && isCurrent(active) && (active.mode !== "browser" || active.taskScopeId === taskScopeId) ? active : null;
}

function showOnly(active: ActiveWorkView): void {
  for (const other of activeViews.values()) {
    if (other.ownerId !== active.ownerId || other === active) continue;
    other.visible = false;
    try { other.view.setVisible(false); } catch {}
  }
}


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
  if (active.mode === "browser") return target === "about:blank" || sanitizeWorkLiveUrl(target) !== null;
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
  if (status.state !== "closed" && !isCurrent(active)) return;
  active.state = status.state;
  if (status.state === "error") active.error = status.error;
  else if (status.state === "loading" || status.state === "ready") active.error = undefined;
  try {
    const history = status.state !== "closed" ? active.view.webContents.navigationHistory : null;
    active.send({ viewId: active.viewId, taskScopeId: active.taskScopeId,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false, ...status });
  } catch {}
}

function closeActive(active: ActiveWorkView, notify = true): void {
  activeViews.delete(key(active.ownerId, active.viewId));
  try {
    if (!active.window.isDestroyed()) active.window.contentView.removeChildView(active.view);
  } catch {}
  try { active.view.webContents.close(); } catch {}
  if (notify) emit(active, { state: "closed" });
}

export function closeWorkLiveView(ownerId: number, viewId: string, taskScopeId?: string): { ok: boolean } {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  if (!active && activeViews.has(key(ownerId, viewId))) return { ok: false };
  if (active) closeActive(active);
  return { ok: true };
}

export function closeWorkLiveViewsForOwner(ownerId: number): void {
  const cleanup = ownerCleanup.get(ownerId);
  if (cleanup) {
    cleanup.window.removeListener("closed", cleanup.listener);
    ownerCleanup.delete(ownerId);
  }
  for (const [id, owner] of nativeTaskOwners) if (owner.ownerId === ownerId) nativeTaskOwners.delete(id);
  for (const active of [...activeViews.values()]) {
    if (active.ownerId === ownerId) closeActive(active, false);
  }
}

export function setWorkLiveViewBounds(
  ownerId: number,
  input: { viewId: string; bounds: WorkLiveViewBounds; visible?: boolean; taskScopeId?: string },
): { ok: boolean } {
  const viewId = sanitizeViewId(input?.viewId);
  if (!viewId) return { ok: false };
  const active = registeredGuest(ownerId, viewId, input.taskScopeId);
  if (!active || active.window.isDestroyed() || active.view.webContents.isDestroyed()) return { ok: false };
  try {
    active.visible = input.visible !== false;
    if (active.visible) showOnly(active);
    active.view.setVisible(active.visible && active.state !== "error");
    active.view.setBounds(sanitizeBounds(input.bounds, active.window));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function reloadWorkLiveView(ownerId: number, viewId: string, taskScopeId?: string): { ok: boolean } {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  if (!active || active.view.webContents.isDestroyed()) return { ok: false };
  try {
    active.navigationEpoch += 1;
    active.pendingUrl = active.view.webContents.getURL();
    if (active.visible) showOnly(active);
    active.view.setVisible(active.visible);
    emit(active, { state: "loading", url: active.pendingUrl });
    active.view.webContents.reloadIgnoringCache();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function navigateWorkLiveView(
  ownerId: number,
  input: { viewId: string; url: string; taskScopeId?: string },
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const active = registeredGuest(ownerId, input?.viewId, input?.taskScopeId);
  const target = active?.mode === "browser" && input?.url === "about:blank" ? new URL("about:blank") : sanitizeWorkLiveUrl(input?.url);
  if (!active || active.view.webContents.isDestroyed()) return { ok: false, reason: "view-unavailable" };
  if (!target || !permittedNavigation(active, target.toString())) return { ok: false, reason: "navigation-not-allowed" };
  try {
    const epoch = ++active.navigationEpoch;
    active.pendingUrl = target.toString();
    emit(active, { state: "loading", url: target.toString() });
    await active.view.webContents.loadURL(target.toString());
    if (!isCurrent(active) || active.navigationEpoch !== epoch) return { ok: false, reason: "navigation-superseded" };
    return { ok: active.state !== "error", url: active.view.webContents.getURL() };
  } catch (error) {
    return { ok: false, url: target.toString(), reason: error instanceof Error ? error.message : String(error) };
  }
}

export function goBackWorkLiveView(ownerId: number, viewId: string, taskScopeId?: string): { ok: boolean } {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  if (!active || active.view.webContents.isDestroyed() || !active.view.webContents.navigationHistory.canGoBack()) return { ok: false };
  active.view.webContents.navigationHistory.goBack();
  return { ok: true };
}

export function goForwardWorkLiveView(ownerId: number, viewId: string, taskScopeId?: string): { ok: boolean } {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
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
  taskScopeId?: string;
  send: (status: WorkLiveViewStatus) => void;
}): Promise<{ ok: boolean; viewId: string; url?: string; reason?: string }> {
  const viewId = sanitizeViewId(input?.viewId);
  const url = input?.mode === "browser" && input?.url === "about:blank" ? new URL("about:blank") : sanitizeWorkLiveUrl(input?.url);
  if (!viewId) return { ok: false, viewId: String(input?.viewId ?? ""), reason: "invalid-view-id" };
  if (!url) return { ok: false, viewId, reason: "Only HTTPS or loopback HTTP live apps are allowed." };
  if (input.window.isDestroyed()) return { ok: false, viewId, reason: "window-closed" };

  const mode = input.mode === "browser" ? "browser" : "app";
  if (mode === "browser" && (typeof input.taskScopeId !== "string" || !/^[A-Za-z0-9_:.-]{8,200}$/.test(input.taskScopeId))) {
    return { ok: false, viewId, reason: "task-scope-required" };
  }
  const existing = registeredGuest(input.ownerId, viewId, input.taskScopeId);
  if (!existing && activeViews.has(key(input.ownerId, viewId))) return { ok: false, viewId, reason: "task-scope-mismatch" };
  if (existing) {
    if (existing.mode !== mode) return { ok: false, viewId, reason: "view-mode-mismatch" };
    // Remounting the same tab preserves its document, history and storage.
    existing.send = input.send;
    setWorkLiveViewBounds(input.ownerId, input);
    emit(existing, { state: existing.state, url: existing.view.webContents.getURL(),
      title: existing.view.webContents.getTitle(), error: existing.error });
    return { ok: true, viewId, url: existing.view.webContents.getURL() };
  }
  const owned = [...activeViews.values()].filter((active) => active.ownerId === input.ownerId);
  if (mode === "browser" && owned.filter((active) => active.mode === "browser").length >= MAX_NATIVE_BROWSER_TABS_PER_OWNER) {
    return { ok: false, viewId, reason: "browser-tab-limit" };
  }
  // App previews retain their single-view contract; browser tabs survive preview switches.
  if (mode === "app") for (const active of owned) if (active.mode === "app") closeActive(active);
  const partition = mode === "browser" ? NATIVE_BROWSER_PARTITION : `agentlas-work-live-${input.ownerId}-${viewId}`;
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
    mode,
    taskScopeId: mode === "browser" ? input.taskScopeId : undefined,
    state: "opening",
    navigationEpoch: 0,
    pendingUrl: url.toString(),
  };
  activeViews.set(key(input.ownerId, viewId), active);

  view.setBackgroundColor(active.mode === "browser" ? "#ffffff" : "#111111");
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view.webContents.session.setPermissionCheckHandler(() => false);
  view.webContents.on("did-start-navigation", (_event, target, isInPlace, isMainFrame) => {
    if (!isCurrent(active) || !isMainFrame || isInPlace) return;
    // Programmatic navigation increments before dispatch. Page-originated navigation
    // increments here; redirects update the same pending document below.
    if (active.state !== "loading" || active.pendingUrl !== target) active.navigationEpoch += 1;
    active.pendingUrl = target;
    emit(active, { state: "loading", url: target });
  });
  view.webContents.on("did-redirect-navigation", (_event, target, _inPlace, isMainFrame) => {
    if (isCurrent(active) && isMainFrame) active.pendingUrl = target;
  });
  view.webContents.on("did-finish-load", () => {
    // Electron can still report isLoadingMainFrame() inside did-finish-load.
    // The completion event is the document receipt; querying that flag here
    // can strand a successful redirect at loading forever.
    if (!isCurrent(active) || active.state === "error") return;
    view.setVisible(active.visible);
    emit(active, { state: "ready", url: view.webContents.getURL(), title: view.webContents.getTitle() });
  });
  view.webContents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
    if (isCurrent(active) && isMainFrame && active.state === "ready") {
      emit(active, { state: "ready", url: target, title: view.webContents.getTitle() });
    }
  });
  view.webContents.on("page-title-updated", (_event, title) => {
    if (active.state === "ready") emit(active, { state: "ready", url: view.webContents.getURL(), title });
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isCurrent(active) || !isMainFrame || errorCode === -3) return;
    // A failed older URL must not replace a newer navigation's status.
    if (validatedURL && active.pendingUrl && validatedURL !== active.pendingUrl) return;
    view.setVisible(false);
    emit(active, { state: "error", url: validatedURL || active.pendingUrl,
      error: errorDescription || `Navigation failed (${errorCode}).` });
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    if (!isCurrent(active)) return;
    view.setVisible(false);
    emit(active, { state: "error", url: view.webContents.getURL(), error: `Web runtime stopped: ${details.reason}` });
  });
  view.webContents.on("unresponsive", () => {
    if (!isCurrent(active)) return;
    view.setVisible(false);
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
  if (active.visible) showOnly(active);
  view.setBounds(sanitizeBounds(input.bounds, input.window));
  view.setVisible(active.visible);
  emit(active, { state: "opening", url: url.toString() });
  ensureOwnerCleanup(input.ownerId, input.window);
  view.webContents.once("destroyed", () => {
    if (activeViews.get(key(input.ownerId, viewId)) === active) closeActive(active);
  });
  const epoch = ++active.navigationEpoch;
  emit(active, { state: "loading", url: url.toString() });
  try {
    await view.webContents.loadURL(url.toString());
    if (!isCurrent(active) || active.navigationEpoch !== epoch) return { ok: false, viewId, reason: "navigation-superseded" };
    return { ok: active.state !== "error", viewId, url: view.webContents.getURL() };
  } catch (error) {
    if (isCurrent(active) && active.navigationEpoch === epoch) {
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


/** Public guest input is narrow; no arbitrary JavaScript or CDP method is accepted. */
export async function dispatchWorkLiveViewInput(ownerId: number, value: { viewId: string; input: WorkLiveViewInput; taskScopeId?: string }): Promise<{ ok: boolean; reason?: string }> {
  const active = registeredGuest(ownerId, value?.viewId, value?.taskScopeId);
  if (!active || active.mode !== "browser" || !active.visible || active.state !== "ready") return { ok: false, reason: "guest-unavailable" };
  const input = value?.input;
  const wc = active.view.webContents;
  try {
    if (input?.kind === "text" && typeof input.text === "string" && input.text.length <= 4096) {
      await wc.insertText(input.text);
    } else if (input?.kind === "pointer" && ["move", "down", "up"].includes(input.phase)
      && Number.isFinite(input.x) && Number.isFinite(input.y)
      && (input.button === undefined || ["left", "middle", "right"].includes(input.button))) {
      const bounds = active.view.getBounds();
      if (input.x < 0 || input.y < 0 || input.x >= bounds.width || input.y >= bounds.height) return { ok: false, reason: "input-outside-guest" };
      wc.sendInputEvent({ type: input.phase === "move" ? "mouseMove" : input.phase === "down" ? "mouseDown" : "mouseUp",
        x: Math.round(input.x), y: Math.round(input.y), button: input.button ?? "left", clickCount: 1 });
    } else if (input?.kind === "key" && ["down", "up"].includes(input.phase)
      && typeof input.key === "string" && input.key.length > 0 && input.key.length <= 64) {
      wc.sendInputEvent({ type: input.phase === "down" ? "keyDown" : "keyUp", keyCode: input.key });
    } else return { ok: false, reason: "invalid-input" };
    return isCurrent(active) ? { ok: true } : { ok: false, reason: "guest-closed" };
  } catch { return { ok: false, reason: "input-failed" }; }
}

export async function captureWorkLiveView(ownerId: number, viewId: string, taskScopeId?: string): Promise<{ ok: boolean; dataUrl?: string; reason?: string }> {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  if (!active || active.mode !== "browser" || active.state !== "ready") return { ok: false, reason: "guest-unavailable" };
  const epoch = active.navigationEpoch;
  try {
    const image = await active.view.webContents.capturePage();
    if (!isCurrent(active) || active.navigationEpoch !== epoch || active.state !== "ready") return { ok: false, reason: "guest-changed" };
    if (image.isEmpty()) return { ok: false, reason: "empty-capture" };
    return { ok: true, dataUrl: image.toDataURL() };
  } catch { return { ok: false, reason: "capture-failed" }; }
}

/** Main-only observation adapter for the next tool layer. No renderer raw-CDP IPC. */
export async function observeWorkLiveViewGuest(ownerId: number, viewId: string,
  method: "DOM.getDocument" | "Accessibility.getFullAXTree" | "Page.getLayoutMetrics",
  taskScopeId?: string,
): Promise<{ ok: boolean; result?: unknown; reason?: string }> {
  const active = registeredGuest(ownerId, viewId, taskScopeId);
  if (!active || active.mode !== "browser" || active.state !== "ready") return { ok: false, reason: "guest-unavailable" };
  if (!["DOM.getDocument", "Accessibility.getFullAXTree", "Page.getLayoutMetrics"].includes(method)) return { ok: false, reason: "command-not-allowed" };
  const epoch = active.navigationEpoch;
  const guest: WebContents = active.view.webContents;
  try {
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
    const result: unknown = await guest.debugger.sendCommand(method);
    return isCurrent(active) && active.navigationEpoch === epoch && active.state === "ready"
      ? { ok: true, result } : { ok: false, reason: "guest-changed" };
  } catch { return { ok: false, reason: "observation-failed" }; }
}
