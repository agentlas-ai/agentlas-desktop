import { showNativeAgentPointer } from "./native-agent-pointer";
// Main-owned CDP compatibility endpoint for Agentlas native browser guests.
// No Electron remote-debugging port or renderer-supplied endpoint is exposed.
import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
interface RelaySocket {
  readyState: number;
  on(event: "message", listener: (data: unknown) => void): void;
  once(event: "close", listener: () => void): void;
  send(value: string): void;
  close(code?: number): void;
}
interface RelaySocketServer {
  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer, listener: (socket: RelaySocket) => void): void;
  close(): void;
}
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: { noServer: true; maxPayload: number }) => RelaySocketServer };
import type { WebContents } from "electron";
import { onHostShutdown } from "../host-lifecycle";
import { createWorkBrowserTab, listWorkBrowserTabs, nativeBrowserGuest, nativeBrowserTaskOwner,
  closeWorkLiveView, sanitizeWorkLiveUrl, captureNativeBrowserGuest, nativeBrowserGuestViewport, presentNativeBrowserGuest } from "../work-live-view";

type GrantInput = { chatId: string; runId: string; permission: "read" | "write" | "full"; signal: AbortSignal; presentation?: "foreground" | "background"; onScreenshot?: (capture: { png: Buffer; isCurrent: () => boolean }) => void | Promise<void> };
type Guest = { viewId: string; wc: WebContents; targetId: string; browserContextId: string; sessionId: string; children: Set<string>; lastPresentationAt?: number; detach: () => void };
type Lease = { id: string; guests: Map<string, Guest>; socket: RelaySocket | null; connecting: boolean; autoAttach: boolean; current: string | null };
const reservedGuests = new Set<string>();
const MAX_SESSIONS = 8;
/** Preserve host-owned capture diagnostics without leaking arbitrary CDP errors. */
export function nativeBrowserCommandFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^native-browser-(?:capture-(?:unavailable|busy|budget-exceeded|queue-full|stale(?:-task)?|timeout|empty)|screenshot-(?:format-unsupported|stale|clip-invalid|beyond-viewport-unsupported)|grant-revoked|target-missing)$/.test(message)
    ? message : "native-browser-command-failed";
}

async function waitForStableNativeBrowserViewport(
  ownerId: number,
  taskScopeId: string,
  viewId: string,
  guest: Guest,
  current: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  let previous = nativeBrowserGuestViewport(ownerId, taskScopeId, viewId);
  if (!previous) throw new Error("native-browser-screenshot-stale");
  let stableSamples = 0;
  // Opening the Browser rail resizes the native guest through a
  // ResizeObserver. Wait for that transition to settle before pinning the
  // screenshot's URL/viewport, while retaining the later stale checks.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal.aborted || !current() || nativeBrowserGuest(ownerId, taskScopeId, guest.viewId) !== guest.wc) {
      throw new Error("native-browser-screenshot-stale");
    }
    const next = nativeBrowserGuestViewport(ownerId, taskScopeId, viewId);
    if (!next) throw new Error("native-browser-screenshot-stale");
    if (next.width === previous.width && next.height === previous.height) stableSamples += 1;
    else { previous = next; stableSamples = 0; }
    if (stableSamples >= 2) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  throw new Error("native-browser-screenshot-stale");
}

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface NativeBrowserRelayGrant {
  endpoint: string;
  token: string;
  release: () => void;
}

export async function createNativeBrowserRelayGrant(input: GrantInput): Promise<NativeBrowserRelayGrant> {
  const owner = nativeBrowserTaskOwner(input.chatId);
  if (!owner || input.signal.aborted || !input.runId || !["read", "write", "full"].includes(input.permission)) throw new Error("native-browser-task-unbound");
  const secret = randomBytes(32).toString("hex");
  const leases = new Map<string, Lease>();
  let closed = false;
  let port = 0;
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const current = () => !closed && !input.signal.aborted && nativeBrowserTaskOwner(input.chatId)?.ownerId === owner.ownerId
    && !owner.window.isDestroyed();
  const authorized = (request: http.IncomingMessage) => {
    const value = request.headers.authorization;
    if (!current() || typeof value !== "string") return false;
    const candidate = Buffer.from(value), expected = Buffer.from(`Bearer ${secret}`);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };
  const send = (lease: Lease, message: unknown) => {
    if (current() && lease.socket?.readyState === 1) {
      try { lease.socket.send(JSON.stringify(message)); } catch { releaseLease(lease); }
    }
  };
  const targetInfo = (guest: Guest) => ({ targetId: guest.targetId, type: "page", title: guest.wc.getTitle(),
    url: guest.wc.getURL(), attached: true, canAccessOpener: false, browserContextId: guest.browserContextId });
  const findGuest = (lease: Lease, sessionId?: string) => [...lease.guests.values()].find((guest) =>
    guest.sessionId === sessionId || (sessionId !== undefined && guest.children.has(sessionId)));
  const announce = (lease: Lease, guest: Guest) => send(lease, { method: "Target.attachedToTarget",
    params: { sessionId: guest.sessionId, targetInfo: targetInfo(guest), waitingForDebugger: false } });
  const releaseLease = (lease: Lease) => {
    leases.delete(lease.id);
    for (const guest of lease.guests.values()) {
      guest.detach();
      reservedGuests.delete(`${owner.ownerId}:${guest.viewId}`);
    }
    lease.guests.clear();
    lease.socket?.close();
    lease.socket = null;
  };
  const addGuest = async (lease: Lease, viewId: string): Promise<Guest> => {
    if (!current()) throw new Error("native-browser-grant-revoked");
    const reservation = `${owner.ownerId}:${viewId}`;
    const wc = nativeBrowserGuest(owner.ownerId, input.chatId, viewId);
    if (!wc || reservedGuests.has(reservation)) throw new Error("native-browser-guest-busy");
    reservedGuests.add(reservation);
    if (wc.debugger.isAttached()) { reservedGuests.delete(reservation); throw new Error("native-browser-debugger-busy"); }
    try { wc.debugger.attach("1.3"); }
    catch { reservedGuests.delete(reservation); throw new Error("native-browser-debugger-unavailable"); }
    let relayAttached = true;
    const debuggerDetached = () => { relayAttached = false; releaseLease(lease); };
    wc.debugger.on("detach", debuggerDetached);
    const detachOwnedDebugger = () => {
      wc.debugger.removeListener("detach", debuggerDetached);
      if (relayAttached) {
        relayAttached = false;
        try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
      }
    };
    let identity: { targetInfo?: { targetId?: unknown; browserContextId?: unknown } };
    try {
      identity = await wc.debugger.sendCommand("Target.getTargetInfo");
      if (!current() || !leases.has(lease.id) || nativeBrowserGuest(owner.ownerId, input.chatId, viewId) !== wc) throw new Error("native-browser-grant-revoked");
    } catch {
      detachOwnedDebugger();
      reservedGuests.delete(reservation);
      throw new Error("native-browser-target-identity-missing");
    }
    if (typeof identity.targetInfo?.targetId !== "string") {
      detachOwnedDebugger();
      reservedGuests.delete(reservation);
      throw new Error("native-browser-target-identity-missing");
    }
    const guest: Guest = { viewId, wc, targetId: identity.targetInfo.targetId,
      browserContextId: typeof identity.targetInfo.browserContextId === "string" ? identity.targetInfo.browserContextId : "agentlas-native-default",
      sessionId: randomUUID(), children: new Set(), detach: () => {} };
    const message = (_event: unknown, method: string, params: Record<string, unknown>, childSessionId?: string) => {
      if (!current() || nativeBrowserGuest(owner.ownerId, input.chatId, viewId) !== wc) return;
      if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") guest.children.add(params.sessionId);
      if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") guest.children.delete(params.sessionId);
      send(lease, { method, params, sessionId: childSessionId || guest.sessionId });
    };
    const destroyed = () => {
      lease.guests.delete(guest.targetId);
      guest.detach();
      reservedGuests.delete(reservation);
      send(lease, { method: "Target.detachedFromTarget", params: { sessionId: guest.sessionId, targetId: guest.targetId } });
    };
    wc.debugger.on("message", message);
    wc.once("destroyed", destroyed);
    guest.detach = () => {
      wc.debugger.removeListener("message", message); wc.removeListener("destroyed", destroyed);
      detachOwnedDebugger();
    };
    lease.guests.set(guest.targetId, guest);
    lease.current = guest.targetId;
    if (lease.autoAttach) announce(lease, guest);
    return guest;
  };
  const createGuest = async (lease: Lease, url = "about:blank") => {
    if (url !== "about:blank" && !sanitizeWorkLiveUrl(url)) throw new Error("native-browser-navigation-denied");
    const created = await createWorkBrowserTab(owner.ownerId, input.chatId, url);
    if (!created.ok || !created.tab) throw new Error(created.reason ?? "native-browser-create-failed");
    try {
      if (!current() || !leases.has(lease.id)) throw new Error("native-browser-grant-revoked");
      return await addGuest(lease, created.tab.viewId);
    } catch (error) {
      closeWorkLiveView(owner.ownerId, created.tab.viewId, input.chatId);
      throw error;
    }
  };
  const createLease = async () => {
    if (leases.size >= MAX_SESSIONS) throw new Error("native-browser-session-limit");
    const lease: Lease = { id: randomUUID(), guests: new Map(), socket: null, connecting: false, autoAttach: false, current: null };
    leases.set(lease.id, lease);
    return lease;
  };
  const initializeLease = async (lease: Lease) => {
    const available = listWorkBrowserTabs(owner.ownerId, input.chatId).find((tab) => tab.visible === true && !reservedGuests.has(`${owner.ownerId}:${tab.viewId}`));
    if (available) await addGuest(lease, available.viewId);
    else await createGuest(lease);
  };
  const presentAction = (guest: Guest) => {
    if (!current() || input.presentation === "background") return;
    const now = Date.now(), previous = guest.lastPresentationAt;
    guest.lastPresentationAt = now;
    // One gesture/type burst presents once; a later action resumes the panel.
    if (previous !== undefined && now - previous < 1000) return;
    presentNativeBrowserGuest(owner.ownerId, input.chatId, input.runId, guest.viewId);
  };
  const dispatch = async (lease: Lease, method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
    if (!current()) throw new Error("native-browser-grant-revoked");
    if (!sessionId) {
      if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome}`,
        revision: "", userAgent: `AgentlasNativeBrowser/${process.versions.electron}` , jsVersion: process.versions.v8 };
      if (method === "Target.setAutoAttach") {
        lease.autoAttach = params.autoAttach === true;
        if (lease.autoAttach) for (const guest of lease.guests.values()) announce(lease, guest);
        return {};
      }
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.getTargets") return { targetInfos: [...lease.guests.values()].map(targetInfo) };
      if (method === "Target.getTargetInfo") {
        const guest = typeof params.targetId === "string" ? lease.guests.get(params.targetId) : lease.guests.values().next().value as Guest | undefined;
        if (!guest) throw new Error("native-browser-target-missing");
        return { targetInfo: targetInfo(guest) };
      }
      if (method === "Target.createTarget") {
        const guest = await createGuest(lease, typeof params.url === "string" ? params.url : "about:blank");
        presentAction(guest);
        return { targetId: guest.targetId };
      }
      if (method === "Target.closeTarget") {
        const guest = typeof params.targetId === "string" ? lease.guests.get(params.targetId) : undefined;
        if (!guest) return { success: false };
        return { success: closeWorkLiveView(owner.ownerId, guest.viewId, input.chatId).ok };
      }
      // CDP attachment preserves the host's download policy, as Playwright's
      // extension bridge does. Never apply global Browser settings to other tasks.
      if (method === "Browser.setDownloadBehavior") return {};
      throw new Error("native-browser-root-command-denied");
    }
    const guest = findGuest(lease, sessionId);
    if (!guest || nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) !== guest.wc) throw new Error("native-browser-target-missing");
    if (method.startsWith("Browser.") || method.startsWith("Storage.")
      || (method.startsWith("Target.") && method !== "Target.setAutoAttach")
      || ["Network.getAllCookies", "Network.setCookies", "Network.setCookie", "Network.deleteCookies",
        "Network.clearBrowserCookies", "Network.clearBrowserCache", "Security.setIgnoreCertificateErrors"].includes(method)) {
      throw new Error("native-browser-global-command-denied");
    }
    if (method === "Page.navigate" && (typeof params.url !== "string" || (params.url !== "about:blank" && !sanitizeWorkLiveUrl(params.url)))) {
      throw new Error("native-browser-navigation-denied");
    }
    // Only the authenticated run's trusted MCP adapter obtains this endpoint;
    // per-tool approval/cancellation remains in the existing launcher proxy.
    // Child session IDs are accepted only after this guest's debugger emitted them.
    if (!/^(DOM|DOMSnapshot|Accessibility|Page|Runtime|Input|Network|Emulation|Log|Performance|Target)\.[A-Za-z]+$/.test(method)) {
      throw new Error("native-browser-page-command-denied");
    }
    if (method === "Network.getCookies") {
      const origin = new URL(guest.wc.getURL()).origin;
      if (!Array.isArray(params.urls) || !params.urls.length || !params.urls.every((url) => typeof url === "string" && new URL(url).origin === origin)) {
        throw new Error("native-browser-cookie-scope-denied");
      }
    }
    lease.current = guest.targetId;
    if (method === "Page.captureScreenshot" && sessionId === guest.sessionId) {
      // Both viewport and document pixels use the same guarded hidden-host
      // lifecycle; raw CDP on an unattached guest can wait indefinitely.
      if (params.format !== undefined && params.format !== "png" && params.format !== "jpeg") throw new Error("native-browser-screenshot-format-unsupported");
      await waitForStableNativeBrowserViewport(owner.ownerId, input.chatId, guest.viewId, guest, current, input.signal);
      const url = guest.wc.getURL();
      const metrics = await guest.wc.debugger.sendCommand("Page.getLayoutMetrics");
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? metrics.cssLayoutViewport;
      const viewportSize = nativeBrowserGuestViewport(owner.ownerId, input.chatId, guest.viewId);
      const measured = await guest.wc.debugger.sendCommand("Runtime.evaluate", {
        expression: "({ width: window.innerWidth, height: window.innerHeight, pageX: window.pageXOffset, pageY: window.pageYOffset })",
        returnByValue: true,
      }).catch(() => null);
      const measuredViewport = measured?.result?.value;
      const pageX = Number(viewport?.pageX ?? measuredViewport?.pageX ?? 0);
      const pageY = Number(viewport?.pageY ?? measuredViewport?.pageY ?? 0);
      const metricWidth = Number(viewport?.clientWidth ?? viewport?.width);
      const metricHeight = Number(viewport?.clientHeight ?? viewport?.height);
      // innerWidth/innerHeight include the scrollbar gutter and are the CSS
      // viewport dimensions used by callers that build a full-window clip.
      // They remain a visible viewport bound, unlike document dimensions.
      const cssWidth = Number(measuredViewport?.width) || metricWidth;
      const cssHeight = Number(measuredViewport?.height) || metricHeight;
      const zoomFactor = Number(guest.wc.getZoomFactor());
      if (!viewportSize || !Number.isFinite(pageX) || !Number.isFinite(pageY)
        || !Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth < 1 || cssHeight < 1
        || !Number.isFinite(zoomFactor) || zoomFactor <= 0) {
        throw new Error("native-browser-screenshot-stale");
      }
      // capturePage receives the native surface's coordinate space. It is
      // safe only when that surface matches the CSS layout viewport at the
      // default page zoom; emulation, scrollbar changes, and page zoom all
      // require the guarded CDP capture below, even when a clip fits both.
      const nativeViewportMatchesCss = Math.abs(cssWidth - viewportSize.width) <= 1
        && Math.abs(cssHeight - viewportSize.height) <= 1
        && Math.abs(zoomFactor - 1) <= 0.001;
      const clip = params.clip as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; scale?: unknown } | undefined;
      let rect: { x: number; y: number; width: number; height: number } | undefined;
      let documentClip: { x: number; y: number; width: number; height: number } | undefined;
      if (clip) {
        const values = [clip.x, clip.y, clip.width, clip.height];
        if (!values.every((value) => typeof value === "number" && Number.isFinite(value)) || (clip.scale !== undefined && clip.scale !== 1)) throw new Error("native-browser-screenshot-clip-invalid");
        const clipX = Number(clip.x);
        const clipY = Number(clip.y);
        const clipWidth = Number(clip.width);
        const clipHeight = Number(clip.height);
        rect = { x: Math.round(clipX - pageX), y: Math.round(clipY - pageY), width: Math.round(clipWidth), height: Math.round(clipHeight) };
        if (clipX < 0 || clipY < 0 || rect.width < 1 || rect.height < 1) throw new Error("native-browser-screenshot-clip-invalid");
        // CDP's captureBeyondViewport contract is expressed in CSS pixels. The
        // native guest may be a narrow sidebar while the page remains emulated
        // at a wider CSS viewport, so do not compare these coordinate spaces.
        const insideCssViewport = clipX >= pageX && clipY >= pageY
          && clipX + clipWidth <= pageX + cssWidth
          && clipY + clipHeight <= pageY + cssHeight;
        if (!insideCssViewport && params.captureBeyondViewport === false) {
          throw new Error("native-browser-screenshot-beyond-viewport-unsupported");
        }
        const insideNativeViewport = rect.x >= 0 && rect.y >= 0
          && rect.x + rect.width <= Math.ceil(viewportSize.width)
          && rect.y + rect.height <= Math.ceil(viewportSize.height);
        if (!nativeViewportMatchesCss || !insideNativeViewport || !insideCssViewport) {
          documentClip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight };
        }
      } else {
        // With no explicit clip, CDP means the current CSS viewport. Preserve
        // that viewport whenever it differs from the native surface.
        if (!nativeViewportMatchesCss) {
          documentClip = { x: pageX, y: pageY, width: cssWidth, height: cssHeight };
        }
      }
      const image = await captureNativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId, documentClip ? undefined : rect, input.signal,
        documentClip ? { kind: "document", clip: documentClip, captureBeyondViewport: params.captureBeyondViewport !== false, isAuthorized: () => current() && leases.get(lease.id) === lease
          && lease.guests.get(guest.targetId) === guest && nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) === guest.wc } : undefined);
      if (!current() || nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) !== guest.wc
        || guest.wc.getURL() !== url || image.isEmpty()) throw new Error("native-browser-screenshot-stale");
      const png = image.toPNG();
      await input.onScreenshot?.({ png, isCurrent: () => current() && leases.get(lease.id) === lease
        && lease.guests.get(guest.targetId) === guest && nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) === guest.wc
        && guest.wc.getURL() === url });
      if (!current() || nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) !== guest.wc || guest.wc.getURL() !== url) {
        throw new Error("native-browser-capture-stale");
      }
      return { data: (params.format === "jpeg" ? image.toJPEG(typeof params.quality === "number" ? Math.max(0, Math.min(100, Math.round(params.quality))) : 80) : png).toString("base64") };
    }
    if (method === "Page.navigate" || method === "Page.reload" || method === "Page.navigateToHistoryEntry"
      || method === "Input.insertText" || (method === "Input.dispatchKeyEvent" && params.type !== "keyUp")
      || (method === "Input.dispatchMouseEvent" && (params.type === "mousePressed" || params.type === "mouseWheel"))) presentAction(guest);
    const result = await guest.wc.debugger.sendCommand(method, params, sessionId === guest.sessionId ? undefined : sessionId);
    if (!current() || nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) !== guest.wc) throw new Error("native-browser-grant-revoked");
    if (method === "Input.dispatchMouseEvent" && sessionId === guest.sessionId &&
      typeof params.x === "number" && typeof params.y === "number") {
      const phase = params.type === "mouseMoved" ? "move" : params.type === "mousePressed" ? "down" : params.type === "mouseReleased" ? "up" : null;
      if (phase) await showNativeAgentPointer(guest.wc, { phase, x: params.x, y: params.y });
    }
    return result;
  };
  const reply = (response: http.ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  server.on("request", (request, response) => {
    if (!authorized(request)) return reply(response, 403, { error: "native-browser-grant-denied" });
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/session" && request.method === "POST") {
      void createLease().then((lease) => reply(response, 200, { endpoint: `http://127.0.0.1:${port}/session/${lease.id}` }))
        .catch(() => reply(response, 409, { error: "native-browser-session-unavailable" }));
      return;
    }
    const match = /^\/session\/([a-f0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
    const lease = match ? leases.get(match[1]) : undefined;
    if (!lease) return reply(response, 404, { error: "native-browser-session-missing" });
    if (request.method === "DELETE") { releaseLease(lease); return reply(response, 200, { ok: true }); }
    if (match?.[2]?.replace(/\/$/, "") === "json/version") return reply(response, 200, { Browser: `Chrome/${process.versions.chrome}`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/session/${lease.id}/devtools/browser` });
    if (match?.[2]?.replace(/\/$/, "") === "json/list") {
      const guest = lease.current ? lease.guests.get(lease.current) : undefined;
      return reply(response, 200, guest ? [{ id: guest.targetId, type: "page", url: guest.wc.getURL(), title: guest.wc.getTitle() }] : []);
    }
    reply(response, 404, { error: "native-browser-route-missing" });
  });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/session\/([a-f0-9-]+)\/devtools\/browser$/.exec(request.url ?? "");
    const lease = match ? leases.get(match[1]) : undefined;
    if (!authorized(request) || !lease || lease.socket || lease.connecting) { socket.destroy(); return; }
    lease.connecting = true;
    // MCP initialization/listing allocates only a lease; no tab or browser is
    // started until Playwright actually connects for a browser operation.
    void initializeLease(lease).then(() => {
      if (!current() || !leases.has(lease.id) || socket.destroyed) { releaseLease(lease); socket.destroy(); return; }
      websocket.handleUpgrade(request, socket, head, (ws) => {
      lease.socket = ws;
      ws.on("message", (data) => {
        let value: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
        try { value = JSON.parse(String(data)); } catch { ws.close(1003); return; }
        if (!Number.isSafeInteger(value.id) || typeof value.method !== "string" || value.method.length > 128) { ws.close(1003); return; }
        const params = value.params && typeof value.params === "object" && !Array.isArray(value.params) ? value.params as Record<string, unknown> : {};
        const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
        void dispatch(lease, value.method, params, sessionId).then((result) => send(lease, { id: value.id, sessionId, result }))
          .catch((error) => send(lease, { id: value.id, sessionId, error: { code: -32000, message: nativeBrowserCommandFailure(error) } }));
      });
      ws.once("close", () => releaseLease(lease));
      });
    }).catch(() => { releaseLease(lease); socket.destroy(); });
  });
  const release = () => {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener("abort", release);
    owner.window.removeListener("closed", release);
    unregisterShutdown();
    for (const lease of [...leases.values()]) releaseLease(lease);
    websocket.close();
    server.close();
  };
  const unregisterShutdown = onHostShutdown(release);
  input.signal.addEventListener("abort", release, { once: true });
  owner.window.once("closed", release);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  } catch { release(); throw new Error("native-browser-relay-unavailable"); }
  const address = server.address();
  if (!address || typeof address === "string" || !current()) { release(); server.close(); throw new Error("native-browser-relay-unavailable"); }
  port = address.port;
  return { endpoint: `http://127.0.0.1:${port}`, token: secret, release };
}
