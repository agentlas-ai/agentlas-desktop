import { showNativeAgentPointer } from "./native-agent-pointer";
import { browserAnnotationActiveOn, endBrowserAnnotationsForAgent } from "./annotation";
import { AGENT_DIALOG_BINDING, agentDialogInstallSource, agentDialogRestoreSource, parseAgentDialogReport, type AgentDialogType } from "./agent-dialogs";
// Main-owned CDP compatibility endpoint for Agentlas native browser guests.
// No Electron remote-debugging port or renderer-supplied endpoint is exposed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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
import { createWorkBrowserTab, listWorkBrowserTabs, nativeBrowserGuest, acquireNativeBrowserTask, focusNativeBrowserTask,
  closeWorkLiveView, sanitizeWorkLiveUrl, captureNativeBrowserGuest, nativeBrowserGuestViewport, presentNativeBrowserGuest,
  openAgentBrowserHold, claimNativeBrowserGuest, settleAgentBrowserHold, onAgentBrowserPopup, nativeBrowserGuestLayoutAge, agentBrowserTabsOfHold, reclaimOrphanAgentBrowserTabs } from "../work-live-view";
import { observeNativeBrowserDownloads } from "./download-registry";

export type CanonicalNativeBrowserGrantInput = { chatId: string; runId: string; permission: "read" | "write" | "full"; signal: AbortSignal; presentation?: "foreground" | "background"; onScreenshot?: (capture: { png: Buffer; isCurrent: () => boolean }) => void | Promise<void> };
type Guest = { viewId: string; wc: WebContents; targetId: string; browserContextId: string; sessionId: string; children: Set<string>; lastPresentationAt?: number; detach: () => void;
  /** Re-attach the debugger to the same live page (lost CDP session); false when the page is gone or held by another client. */
  reattach: () => boolean;
  chooser: FileChooserGate;
  /** Synthetic JS dialogs reported to the agent and not yet handled, per CDP session key. */
  dialogs: Map<string, AgentDialogType[]>;
  /** Last agent command on this guest; a beforeunload right after one is the agent's. */
  lastAgentCommandAt: number;
  /** Target of the page whose window.open created this one. */
  openerId?: string;
  /** Last main-frame cross-document commit (paint holding starts here). */
  navigatedAt: number };

/*
 * ★File choosers belong to whoever clicked. Chromium's
 * Page.setInterceptFileChooserDialog is per target, not per input source: left
 * on, the owner's own clicks would never open a chooser; left off, an agent's
 * click on an upload control opens the OS "Open" panel, a modal sheet over the
 * whole Agentlas window that no agent can operate (reproduced 2026-09-28 in an
 * isolated app: a click on a JS-triggered chooser without a listener put an
 * 880x448 "열기" panel over the app).
 *
 * The relay therefore owns the real interception flag. The agent's
 * setInterceptFileChooserDialog is recorded, not forwarded. Real interception
 * is armed only around the agent's own input and for a short activation window
 * after it (JS-triggered choosers open asynchronously). Owner input while armed
 * disarms at once. An intercepted chooser goes to the agent when it asked for
 * choosers (Playwright: filechooser -> DOM.setFileInputFiles); otherwise it is
 * dropped, so no OS panel appears for an agent click.
 */
type FileChooserGate = { wants: Map<string, boolean>; armedUntil: number; real: Set<string>; timer?: ReturnType<typeof setTimeout>; agentInput: number;
  /** input-event can trail the CDP reply; events this soon after an agent gesture are the agent's. */
  agentEchoUntil: number };
const FILE_CHOOSER_ACTIVATION_MS = 3_000;
function agentGestureInput(method: string, params: Record<string, unknown>): boolean {
  if (method === "Input.dispatchMouseEvent") return params.type === "mousePressed" || params.type === "mouseReleased";
  if (method === "Input.dispatchKeyEvent") return params.type === "keyDown" || params.type === "rawKeyDown" || params.type === "char";
  if (method === "Input.dispatchTouchEvent") return params.type === "touchStart" || params.type === "touchEnd";
  return method === "Input.dispatchDragEvent" && params.type === "drop";
}
type Lease = { id: string; guests: Map<string, Guest>; socket: RelaySocket | null; connecting: boolean; autoAttach: boolean; current: string | null;
  /** Commands reach the guest in the order the client sent them (mousePressed before mouseReleased). */
  order: Promise<void>;
  /** Browser.setDownloadBehavior as the client asked for it (Playwright: allowAndName + events). */
  downloads?: { downloadPath: string; eventsEnabled: boolean } };
const reservedGuests = new Set<string>();
const MAX_SESSIONS = 8;
const HOLD_IDLE_MS = 120_000;
const LAYOUT_SETTLE_MS = 400;
const PAINT_HOLDING_MS = 800;
async function firstContentfulPaint(guest: { wc: WebContents }): Promise<boolean> {
  try {
    const result = await guest.wc.debugger.sendCommand("Runtime.evaluate", {
      expression: "performance.getEntriesByName('first-contentful-paint').length > 0", returnByValue: true });
    return result?.result?.value === true;
  } catch { return false; }
}
/** Preserve host-owned capture diagnostics without leaking arbitrary CDP errors. */
export function nativeBrowserCommandFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // The tab-limit refusal carries its way out; the agent must be able to read it.
  if (message.startsWith("native-browser-tab-limit: ")) return message;
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

/** One page an agent is currently driving through this grant. URL is read from the guest itself. */
export interface LoginVerificationLease {
  reload: () => Promise<string | null>;
  current: () => boolean;
  release: () => void;
}
export interface NativeBrowserRelayPage {
  /** Stable native view identity; optional for older observers/mocks. */
  id?: string;
  url: string;
  /** Reload and resolve with the URL the page settled on (null if it went away). */
  reload: () => Promise<string | null>;
  /** Open a URL in the same guest (owner sign-in card). */
  navigate: (url: string) => Promise<void>;
  /** Main-only script evaluation in the page (vault autofill, structural checks). Never reachable by the agent. */
  evaluate?: (expression: string) => Promise<unknown>;
  /** Bring this page in front of the owner (human-check card). */
  present?: () => boolean | void | Promise<boolean | void>;
  /** Main-only, read-only exact guest verification; survives ordinary MCP grant release. */
  retainLoginVerification?: (signal: AbortSignal) => LoginVerificationLease;
}

/** Machine state of the relay for the fallback ladder (electron/browser/fallback-ladder.ts). */
export interface NativeBrowserRelayHealth {
  /** The grant still has its Main task lease and was not released. */
  current: boolean;
  /** The last refusal this relay answered, by our own code (never parsed prose). */
  lastRefusal: "session-ended" | "tab-limit" | "session-unavailable" | "grant-revoked" | null;
  leases: number;
  liveSockets: number;
  /** Sessions brought back after they had been dropped (see revive below). */
  revived: number;
  /** Connections are being served by the dedicated Agentlas Chrome (switch-surface rung). */
  failedOver: boolean;
}

export interface NativeBrowserRelayFailover {
  /** ws://127.0.0.1:<port>/devtools/browser/<id> of the dedicated Agentlas Chrome we own. */
  webSocketDebuggerUrl: string;
  /** Loopback CDP port of that Chrome, for /json/list. */
  port: number;
  /** Called once when this failover ends (grant released or replaced): frees the dedicated-browser lease. */
  release?: () => void;
}

export interface NativeBrowserRelayGrant {
  /** Opaque Main owner-action identity, valid only for this exact live grant. */
  ownerScopeId?: string;
  nativeComputerUse?: import("../computer-use/native-guest").NativeGuestComputerUseCapability;
  endpoint: string;
  token: string;
  release: () => void;
  /** Login recovery reads where the agent actually is — structurally, never from tool prose. */
  pages: () => NativeBrowserRelayPage[];
  /** Fallback ladder: measured relay state. */
  health?: () => NativeBrowserRelayHealth;
  /** Fallback ladder rung 1: drop dead sockets and clear the last refusal so the next connect starts clean. */
  reestablish?: () => NativeBrowserRelayHealth | Promise<NativeBrowserRelayHealth>;
  /** Remote Main broker refreshes its structural page/health snapshot. */
  refresh?: () => Promise<void>;
  /** Scoped Main broker recovery; the acquisition context owns its authority. */
  recoverLoginWalls?: (input: { nodeId?: string; onPrerequisiteRestored?: (prerequisite: import("./login-recovery").LoginPrerequisiteRef) => void }) => Promise<import("./login-recovery").LoginRecoveryOutcome[]>;
  /**
   * Fallback ladder rung 2 (switch surface): serve this run's CDP connects from the dedicated Agentlas Chrome.
   * The launcher's endpoint stays the same, so no MCP process is rebuilt; open agent sockets are closed so
   * Playwright reconnects through the relay to the other browser. null returns to the in-app browser.
   */
  failover?: (target: NativeBrowserRelayFailover | null) => void;
}

/** Live grants by endpoint, so Main-side observers (MCP bridge) can find the grant a launcher is bound to. */
const nativeInputOwners = new Map<WebContents, string>();
const liveGrants = new Map<string, NativeBrowserRelayGrant>();
export function nativeBrowserRelayGrantForEndpoint(endpoint: string | null | undefined): NativeBrowserRelayGrant | null {
  return endpoint ? liveGrants.get(endpoint) ?? null : null;
}

export { PAGE_FRAME_PROBE_SOURCE } from "./page-frame-probe";

export interface NativeBrowserRelayOwnerScope {
  ownerScopeId: string;
  chatId: string;
  runId: string;
  grant: NativeBrowserRelayGrant;
}
const liveOwnerScopes = new Map<string, NativeBrowserRelayOwnerScope>();
/** Main-only owner actions cannot select another session by an endpoint or profile path. */
export function nativeBrowserRelayOwnerScopeForId(id: string): NativeBrowserRelayOwnerScope | null {
  const scope = liveOwnerScopes.get(id);
  return scope && scope.grant.health?.().current ? scope : null;
}

/** Login restoration requires a successful main-frame load, not a timeout/stop-loading URL. */
export function settledLoginVerificationUrl(wc: WebContents, signal: AbortSignal, timeoutMs = 20_000): Promise<string | null> {
  return new Promise(resolve => {
    if (wc.isDestroyed() || signal.aborted) { resolve(null); return; }
    let done = false;
    const finish = (successful: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.removeListener("did-finish-load", loaded);
      wc.removeListener("did-fail-load", failed);
      wc.removeListener("destroyed", destroyed);
      signal.removeEventListener("abort", destroyed);
      resolve(successful && !signal.aborted && !wc.isDestroyed() ? wc.getURL() : null);
    };
    const loaded = () => finish(true);
    const failed = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame !== false) finish(false);
    };
    const destroyed = () => finish(false);
    const timer = setTimeout(destroyed, timeoutMs);
    wc.once("did-finish-load", loaded);
    wc.on("did-fail-load", failed);
    wc.once("destroyed", destroyed);
    signal.addEventListener("abort", destroyed, { once: true });
  });
}

function settledUrl(wc: WebContents, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    if (wc.isDestroyed()) { resolve(null); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.removeListener("did-stop-loading", finish);
      wc.removeListener("destroyed", finish);
      resolve(wc.isDestroyed() ? null : wc.getURL());
    };
    const timer = setTimeout(finish, timeoutMs);
    wc.once("did-stop-loading", finish);
    wc.once("destroyed", finish);
  });
}

export async function createNativeBrowserRelayGrant(input: CanonicalNativeBrowserGrantInput): Promise<NativeBrowserRelayGrant> {
  const taskLease = acquireNativeBrowserTask({ taskScopeId: input.chatId, runId: input.runId,
    permission: input.permission, signal: input.signal });
  const owner = { ownerId: taskLease.ownerId };
  const ownerScopeId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const leases = new Map<string, Lease>();
  const nativeInputGuests = new Map<string, WebContents>();
  let releaseNativeInput: (() => void) | null = null;
  const pdfStreams = new Map<string, { data: Buffer; offset: number }>();
  let closed = false;
  // Assigned below; addGuest's owner-input listener needs it before the helpers.
  let disarmFileChooser: (guest: Guest) => void = () => {};
  let port = 0;
  // One hold per run grant: tabs this run opens close when the grant is released.
  // ★A hold is live while its run can still use the browser: an open CDP socket,
  // or browser activity within HOLD_IDLE_MS. A grant whose release never ran
  // (a leaked worker lease, a resident bridge of an ended turn) used to count
  // as a live run forever, so its tabs could never be reclaimed and the next
  // run hit the tab limit.
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  // Fallback-ladder state. `issued` remembers every session id this grant handed out: a session that was
  // dropped while the grant is still current is brought back under the same id instead of answering 410 for
  // the rest of the run (production 2026-09-27..28: 45 calls in 17 runs failed on one dead session URL,
  // because the launcher's lease URL is fixed for its life).
  const issued = new Set<string>();
  let revived = 0;
  let lastRefusal: NativeBrowserRelayHealth["lastRefusal"] = null;
  let failoverTarget: NativeBrowserRelayFailover | null = null;
  const holdId = openAgentBrowserHold({ runId: input.runId, isLive: () => !closed && !input.signal.aborted
    && (Boolean(releaseNativeInput) || [...leases.values()].some((lease) => lease.socket?.readyState === 1 || lease.connecting) || Date.now() - lastActivity < HOLD_IDLE_MS) });
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const current = () => !closed && taskLease.current() && taskLease.taskScopeId === input.chatId
    && taskLease.runId === input.runId && taskLease.permission === input.permission;
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
  const targetInfo = (guest: Guest) => ({ targetId: guest.targetId, type: "page", title: guest.wc.getTitle(), ...(guest.openerId ? { openerId: guest.openerId } : {}),
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
  const resetLease = (lease: Lease) => {
    for (const guest of lease.guests.values()) { guest.detach(); reservedGuests.delete(`${owner.ownerId}:${guest.viewId}`); }
    lease.guests.clear();
    lease.socket = null;
    lease.connecting = false;
    lease.autoAttach = false;
    lease.current = null;
  };
  const addGuest = async (lease: Lease, viewId: string, openerId?: string): Promise<Guest> => {
    if (!current()) throw new Error("native-browser-grant-revoked");
    const reservation = `${owner.ownerId}:${viewId}`;
    const wc = nativeBrowserGuest(owner.ownerId, input.chatId, viewId);
    if (!wc || reservedGuests.has(reservation) || (nativeInputOwners.has(wc) && nativeInputOwners.get(wc) !== ownerScopeId)) throw new Error("native-browser-guest-busy");
    reservedGuests.add(reservation);
    claimNativeBrowserGuest(owner.ownerId, input.chatId, viewId, holdId);
    // The task already owns this guest. Coordinate recovery must survive a first CDP attach failure.
    nativeInputGuests.set(viewId, wc); nativeInputOwners.set(wc, ownerScopeId);
    if (wc.debugger.isAttached()) { reservedGuests.delete(reservation); throw new Error("native-browser-debugger-busy"); }
    try { wc.debugger.attach("1.3"); }
    catch { reservedGuests.delete(reservation); throw new Error("native-browser-debugger-unavailable"); }
    let relayAttached = true;
    // ★A guest's debugger detaching (its page closed itself, e.g. a sign-in
    // popup after posting its result) ends that target only. Releasing the
    // whole lease here closed the agent's CDP socket, so the opener page died
    // with its popup ("Target page, context or browser has been closed").
    let guestReady = false;
    /*
     * ★A lost debugger session on a page that is still alive (reason other than "target closed": DevTools took
     * the page, Chromium dropped the session) is re-attached under the same target and session ids, so the
     * agent keeps its page. Before, every such detach looked like the page closing ("Target page, context or
     * browser has been closed", 13 calls in 11 runs 09-26..29). Idea: ego-lite (MIT) browser-runtime.ts
     * ensureSession / retry-after-lost-session; reimplemented here, no code copied.
     */
    let reattaches = 0;
    const reattach = (): boolean => {
      if (wc.isDestroyed() || !current() || nativeBrowserGuest(owner.ownerId, input.chatId, viewId) !== wc || reattaches >= 3) return false;
      if (wc.debugger.isAttached()) return relayAttached;
      try { wc.debugger.attach("1.3"); } catch { return false; }
      reattaches += 1;
      relayAttached = true;
      // Child (iframe) sessions died with the old attach; the page-level session carries on.
      for (const child of guest.children) send(lease, { method: "Target.detachedFromTarget", params: { sessionId: child } });
      guest.children.clear();
      installDialogs("");
      if (lease.autoAttach) void wc.debugger.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      return true;
    };
    const debuggerDetached = (_event?: unknown, reason?: unknown) => {
      relayAttached = false;
      if (!guestReady) return;
      if (reason !== "target closed" && reattach()) return;
      dropGuest();
    };
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
      sessionId: randomUUID(), children: new Set(), detach: () => {}, reattach, chooser: { wants: new Map(), armedUntil: 0, real: new Set(), agentInput: 0, agentEchoUntil: 0 },
      dialogs: new Map(), lastAgentCommandAt: 0, navigatedAt: 0, ...(openerId ? { openerId } : {}) };
    const navigated = () => { guest.navigatedAt = Date.now(); };
    wc.on("did-navigate", navigated);
    const reportDialog = (sessionKey: string, type: AgentDialogType, message: string, defaultPrompt: string) => {
      const queue = guest.dialogs.get(sessionKey) ?? [];
      if (queue.length >= 16) queue.shift();
      queue.push(type); guest.dialogs.set(sessionKey, queue);
      send(lease, { method: "Page.javascriptDialogOpening", sessionId: sessionKey || guest.sessionId,
        params: { url: wc.getURL(), frameId: undefined, message, type, hasBrowserHandler: false, defaultPrompt } });
    };
    const installDialogs = (sessionKey: string) => {
      const session = sessionKey || undefined;
      void wc.debugger.sendCommand("Runtime.addBinding", { name: AGENT_DIALOG_BINDING }, session)
        .then(() => wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: agentDialogInstallSource, runImmediately: true }, session))
        .then(() => wc.debugger.sendCommand("Runtime.evaluate", { expression: agentDialogInstallSource }, session))
        .catch(() => undefined);
    };
    installDialogs("");
    // Agent-driven navigation away from a page with a beforeunload handler:
    // Electron would silently cancel it. Proceed, and report it as a dialog.
    const beforeUnload = (event: { preventDefault: () => void }) => {
      if (Date.now() - guest.lastAgentCommandAt > 5_000) return;
      event.preventDefault();
      reportDialog("", "beforeunload", "", "");
    };
    wc.on("will-prevent-unload", beforeUnload);
    const message = (_event: unknown, method: string, params: Record<string, unknown>, childSessionId?: string) => {
      if (!current() || nativeBrowserGuest(owner.ownerId, input.chatId, viewId) !== wc) return;
      // Electron decides beforeunload through will-prevent-unload (below);
      // Chromium's own event for it names a dialog nobody can handle.
      if (method === "Page.javascriptDialogOpening" && params.type === "beforeunload") return;
      if (method === "Runtime.bindingCalled" && params.name === AGENT_DIALOG_BINDING) {
        const report = parseAgentDialogReport(params.payload);
        if (report) reportDialog(childSessionId || "", report.type, report.message, report.defaultPrompt);
        return;
      }
      if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
        guest.children.add(params.sessionId);
        installDialogs(params.sessionId);
        // A frame attached while armed must not open an OS panel either.
        if (guest.chooser.real.size) void setRealInterception(guest, params.sessionId, true);
      }
      if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
        guest.children.delete(params.sessionId); guest.chooser.wants.delete(params.sessionId); guest.chooser.real.delete(params.sessionId);
      }
      // An intercepted chooser the agent did not ask for is dropped: nothing opens.
      if (method === "Page.fileChooserOpened" && !guest.chooser.wants.get(childSessionId || "")) return;
      send(lease, { method, params, sessionId: childSessionId || guest.sessionId });
    };
    // Owner input (mouse or key) outside an agent command ends the agent's
    // activation window at once, so the owner's click opens the normal chooser.
    const ownerInput = (_event: unknown, event: { type?: string }) => {
      if (guest.chooser.agentInput > 0 || Date.now() < guest.chooser.agentEchoUntil || !guest.chooser.real.size) return;
      if (event.type === "mouseDown" || event.type === "keyDown" || event.type === "rawKeyDown" || event.type === "touchStart") disarmFileChooser(guest);
    };
    wc.on("input-event", ownerInput);
    const destroyed = () => dropGuest();
    let dropped = false;
    function dropGuest() {
      if (dropped) return;
      dropped = true;
      if (lease.guests.get(guest.targetId) === guest) lease.guests.delete(guest.targetId);
      guest.detach();
      reservedGuests.delete(reservation);
      if (lease.current === guest.targetId) lease.current = lease.guests.keys().next().value ?? null;
      send(lease, { method: "Target.detachedFromTarget", params: { sessionId: guest.sessionId, targetId: guest.targetId } });
    }
    guestReady = true;
    wc.debugger.on("message", message);
    wc.once("destroyed", destroyed);
    guest.detach = () => {
      wc.debugger.removeListener("message", message); wc.removeListener("destroyed", destroyed);
      wc.removeListener("input-event", ownerInput);
      wc.removeListener("will-prevent-unload", beforeUnload);
      wc.removeListener("did-navigate", navigated);
      // Give the page its own dialogs back before the debugger goes.
      try {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) {
          for (const key of ["", ...guest.children]) void wc.debugger.sendCommand("Runtime.evaluate", { expression: agentDialogRestoreSource }, key || undefined).catch(() => undefined);
        }
      } catch { /* detached */ }
      if (guest.chooser.timer) clearTimeout(guest.chooser.timer);
      guest.chooser.real.clear(); guest.chooser.armedUntil = 0;
      // Detaching the debugger drops Chromium's interception with it.
      detachOwnedDebugger();
    };
    lease.guests.set(guest.targetId, guest);
    lease.current = guest.targetId;
    if (lease.autoAttach) announce(lease, guest);
    return guest;
  };
  const setRealInterception = (guest: Guest, sessionKey: string, enabled: boolean): Promise<unknown> => {
    if (enabled) guest.chooser.real.add(sessionKey); else guest.chooser.real.delete(sessionKey);
    try {
      if (!guest.wc.isDestroyed() && guest.wc.debugger.isAttached()) {
        // Issued synchronously so it is ordered before the next command.
        return guest.wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled }, sessionKey || undefined).catch(() => undefined);
      }
    } catch { /* A detached frame session has nothing to intercept. */ }
    return Promise.resolve();
  };
  const armFileChooser = async (guest: Guest): Promise<void> => {
    guest.chooser.armedUntil = Date.now() + FILE_CHOOSER_ACTIVATION_MS;
    if (guest.chooser.timer) clearTimeout(guest.chooser.timer);
    const disarmAt = () => {
      const left = guest.chooser.armedUntil - Date.now();
      if (left > 0) { guest.chooser.timer = setTimeout(disarmAt, left); guest.chooser.timer.unref?.(); return; }
      disarmFileChooser(guest);
    };
    guest.chooser.timer = setTimeout(disarmAt, FILE_CHOOSER_ACTIVATION_MS);
    guest.chooser.timer.unref?.();
    await Promise.all(["", ...guest.children].filter((key) => !guest.chooser.real.has(key)).map((key) => setRealInterception(guest, key, true)));
  };
  disarmFileChooser = (guest: Guest) => {
    guest.chooser.armedUntil = 0;
    if (guest.chooser.timer) clearTimeout(guest.chooser.timer);
    guest.chooser.timer = undefined;
    for (const key of [...guest.chooser.real]) void setRealInterception(guest, key, false);
  };
  const createGuest = async (lease: Lease, url = "about:blank") => {
    if (url !== "about:blank" && !sanitizeWorkLiveUrl(url)) throw new Error("native-browser-navigation-denied");
    const created = await createWorkBrowserTab(owner.ownerId, input.chatId, url, { holdId });
    if (!created.ok || !created.tab) {
      throw new Error(created.reason === "browser-tab-limit" && created.message
        ? `native-browser-tab-limit: ${created.message}` : created.reason ?? "native-browser-create-failed");
    }
    try {
      if (!current() || !leases.has(lease.id)) throw new Error("native-browser-grant-revoked");
      return await addGuest(lease, created.tab.viewId);
    } catch (error) {
      // A CDP attach failure does not end this Main-owned task. Keep its exact
      // guest for coordinate recovery; unclaimed/revoked creation still closes.
      if (!current() || !releaseNativeInput || !nativeInputGuests.has(created.tab.viewId)) {
        closeWorkLiveView(owner.ownerId, created.tab.viewId, input.chatId);
      }
      throw error;
    }
  };
  const createLease = async (reviveId?: string) => {
    if (leases.size >= MAX_SESSIONS) throw new Error("native-browser-session-limit");
    const lease: Lease = { id: reviveId ?? randomUUID(), guests: new Map(), socket: null, connecting: false, autoAttach: false, current: null, order: Promise.resolve() };
    leases.set(lease.id, lease);
    issued.add(lease.id);
    return lease;
  };
  /** A session this grant issued and later dropped comes back under its id while the grant is current. */
  const reviveLease = (id: string): Lease | undefined => {
    if (!issued.has(id) || !current() || leases.size >= MAX_SESSIONS) return undefined;
    const lease: Lease = { id, guests: new Map(), socket: null, connecting: false, autoAttach: false, current: null, order: Promise.resolve() };
    leases.set(id, lease);
    revived += 1;
    return lease;
  };
  const initializeLease = async (lease: Lease) => {
    const available = listWorkBrowserTabs(owner.ownerId, input.chatId).find((tab) => tab.visible === true && !reservedGuests.has(`${owner.ownerId}:${tab.viewId}`));
    // A reconnect (Playwright after a dropped socket) gets back the tab this run opened.
    const own = available ? undefined : agentBrowserTabsOfHold(owner.ownerId, input.chatId, holdId).find((viewId) => !reservedGuests.has(`${owner.ownerId}:${viewId}`));
    if (available) await addGuest(lease, available.viewId);
    else if (own) await addGuest(lease, own);
    else await createGuest(lease);
  };
  const presentAction = (guest: Pick<Guest, "wc" | "viewId" | "lastPresentationAt">) => {
    if (!current() || input.presentation === "background") return;
    const now = Date.now(), previous = guest.lastPresentationAt;
    guest.lastPresentationAt = now;
    // One gesture/type burst presents once; a later action resumes the panel.
    if (previous !== undefined && now - previous < 1000) return;
    presentNativeBrowserGuest(owner.ownerId, input.chatId, input.runId, guest.viewId);
  };
  const dispatch = async (lease: Lease, method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
    if (!current()) throw new Error("native-browser-grant-revoked");
    touch();
    if (!sessionId) {
      // ★The real user agent. Playwright derives the platform from it and only
      // on "Macintosh" sends the editing commands behind Cmd+A/C/V/X/Z; with
      // "AgentlasNativeBrowser/…" an agent's select-all, copy and paste did
      // nothing (measured 2026-09-29: pasted "" between two inputs).
      if (method === "Browser.getVersion") {
        const guest = [...lease.guests.values()][0];
        let userAgent = "";
        try { userAgent = guest && !guest.wc.isDestroyed() ? guest.wc.getUserAgent() : ""; } catch { userAgent = ""; }
        return { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome}`,
          revision: "", userAgent: userAgent || `Mozilla/5.0 (${process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36 AgentlasNativeBrowser/${process.versions.electron}`,
          jsVersion: process.versions.v8 };
      }
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
      // ★The client's request is still honoured for this lease alone: downloads
      // stay in the Agentlas download folder, and the client is told about them
      // with Browser.downloadWillBegin/downloadProgress and gets its own copy
      // named by guid in its downloadPath (what Playwright's download.path()
      // reads). Without this an agent never learned that a download happened.
      if (method === "Browser.setDownloadBehavior") {
        const downloadPath = typeof params.downloadPath === "string" ? params.downloadPath : "";
        let directory = false;
        try { directory = path.isAbsolute(downloadPath) && fs.statSync(downloadPath).isDirectory(); } catch { directory = false; }
        lease.downloads = (params.behavior === "allow" || params.behavior === "allowAndName") && directory
          ? { downloadPath, eventsEnabled: params.eventsEnabled === true } : undefined;
        return {};
      }
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
    // Streams this relay created (printToPDF ReturnAsStream); no other IO handle is reachable.
    if ((method === "IO.read" || method === "IO.close") && typeof params.handle === "string" && pdfStreams.has(params.handle)) {
      const stream = pdfStreams.get(params.handle)!;
      if (method === "IO.close") { pdfStreams.delete(params.handle); return {}; }
      const size = typeof params.size === "number" && params.size > 0 ? Math.min(params.size, 1 << 20) : 1 << 20;
      const start = typeof params.offset === "number" && params.offset >= 0 ? params.offset : stream.offset;
      const chunk = stream.data.subarray(start, start + size);
      stream.offset = start + chunk.length;
      return { base64Encoded: true, data: chunk.toString("base64"), eof: stream.offset >= stream.data.length };
    }
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
    const sessionKey = sessionId === guest.sessionId ? "" : sessionId!;
    guest.lastAgentCommandAt = Date.now();
    if (method === "Page.handleJavaScriptDialog") {
      const queue = guest.dialogs.get(sessionKey);
      const type = queue?.shift();
      // The page already continued (see agent-dialogs.ts); close it for the
      // client. Never forward: Electron does not implement this command and
      // answers "No dialog is showing" even while its own box is up.
      if (type) send(lease, { method: "Page.javascriptDialogClosed", sessionId: sessionId,
        params: { result: params.accept === true, userInput: typeof params.promptText === "string" ? params.promptText : "" } });
      return {};
    }
    if (method === "Page.setInterceptFileChooserDialog") {
      guest.chooser.wants.set(sessionKey, params.enabled === true);
      return {};
    }
    // Headful Chromium does not implement Page.printToPDF; Electron prints the
    // same document. Options map 1:1 (inches for paper and margins).
    if (method === "Page.printToPDF" && sessionId === guest.sessionId) {
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
      const width = number(params.paperWidth), height = number(params.paperHeight);
      const pdf = await guest.wc.printToPDF({
        landscape: params.landscape === true,
        displayHeaderFooter: params.displayHeaderFooter === true,
        printBackground: params.printBackground === true,
        ...(number(params.scale) ? { scale: number(params.scale) } : {}),
        ...(width && height ? { pageSize: { width, height } } : {}),
        margins: { top: number(params.marginTop) ?? 0.4, bottom: number(params.marginBottom) ?? 0.4, left: number(params.marginLeft) ?? 0.4, right: number(params.marginRight) ?? 0.4 },
        ...(typeof params.pageRanges === "string" && params.pageRanges ? { pageRanges: params.pageRanges } : {}),
        ...(typeof params.headerTemplate === "string" ? { headerTemplate: params.headerTemplate } : {}),
        ...(typeof params.footerTemplate === "string" ? { footerTemplate: params.footerTemplate } : {}),
        preferCSSPageSize: params.preferCSSPageSize === true,
      });
      if (params.transferMode === "ReturnAsStream") {
        const handle = `agentlas-pdf-${randomUUID()}`;
        pdfStreams.set(handle, { data: pdf, offset: 0 });
        if (pdfStreams.size > 8) pdfStreams.delete(pdfStreams.keys().next().value!);
        return { stream: handle };
      }
      return { data: pdf.toString("base64") };
    }

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
    const gesture = agentGestureInput(method, params);
    if (gesture) guest.chooser.agentInput += 1;
    let result: unknown;
    try {
      // Issue in client order. Anything awaited before the send (ending the
      // owner's picker) runs inside the lease's order chain, so a later
      // mouseReleased can never overtake this mousePressed.
      let sent!: Promise<unknown>;
      const step = lease.order.then(async () => {
        // The owner's element picker would swallow this agent's input (see annotation.ts).
        if (browserAnnotationActiveOn(guest.wc)) await endBrowserAnnotationsForAgent(guest.wc).catch(() => 0);
        // ★Chromium's paint holding drops input for a moment after a
        // cross-document navigation, until the page's first contentful paint
        // (or a timeout). An agent's first click on a page it just opened was
        // lost without a trace: no mousedown, while keys still arrived
        // (measured 2026-09-29; gone with --disable-features=PaintHolding).
        // Wait out that window before the press; a re-hosted or resized view
        // gets the same short settle.
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          const deadline = Date.now() + 1_500;
          while (Date.now() < deadline) {
            const layoutAge = nativeBrowserGuestLayoutAge(owner.ownerId, input.chatId, guest.viewId);
            const navigationAge = Date.now() - guest.navigatedAt;
            if (layoutAge >= LAYOUT_SETTLE_MS && navigationAge >= PAINT_HOLDING_MS) break;
            if (layoutAge >= LAYOUT_SETTLE_MS && await firstContentfulPaint(guest)) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
        // Await the enable: Blink holds the interception flag, and its DevTools
        // channel is not ordered with input. Sent back to back, the click won
        // the race about one time in three and the OS "Open" panel appeared.
        if (gesture) await armFileChooser(guest);
        const root = sessionId === guest.sessionId;
        sent = guest.wc.debugger.sendCommand(method, params, root ? undefined : sessionId).catch((error: unknown) => {
          // Lost session on a live page: re-attach and retry once (page-level commands only; Target.*/Browser.*
          // describe the session itself and are not replayed).
          if (!root || /^(Target|Browser)\./.test(method) || guest.wc.isDestroyed() || guest.wc.debugger.isAttached() || !guest.reattach()) throw error;
          return guest.wc.debugger.sendCommand(method, params);
        });
      });
      lease.order = step.catch(() => {});
      await step;
      result = await sent;
    } finally {
      if (gesture) {
        guest.chooser.agentInput -= 1;
        guest.chooser.agentEchoUntil = Date.now() + 500;
        // The activation window starts when the gesture has been delivered.
        guest.chooser.armedUntil = Math.max(guest.chooser.armedUntil, Date.now() + FILE_CHOOSER_ACTIVATION_MS);
      }
    }
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
        .catch(() => { lastRefusal = "session-unavailable"; reply(response, 409, { error: "native-browser-session-unavailable" }); });
      return;
    }
    const match = /^\/session\/([a-f0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
    let lease = match ? leases.get(match[1]) : undefined;
    // A dropped session this grant issued is revived (same id, fresh tabs) rather than answering 410 until the
    // run ends. DELETE never revives: that is the launcher ending its own session.
    if (!lease && match && request.method !== "DELETE") lease = reviveLease(match[1]);
    // 410, not 404: this session existed and ended. Playwright reports any
    // non-200 here as "does not look like a DevTools server"; the body says why.
    if (!lease) { lastRefusal = "session-ended"; return reply(response, 410, { error: "native-browser-session-ended: this browser session was released. Start the browser tool again." }); }
    touch();
    if (request.method === "DELETE") { releaseLease(lease); issued.delete(lease.id); return reply(response, 200, { ok: true }); }
    // Switch-surface rung: this run's connects are served by the dedicated Agentlas Chrome.
    if (failoverTarget && match?.[2]?.replace(/\/$/, "") === "json/version") return reply(response, 200, { Browser: "Agentlas dedicated Chrome",
      webSocketDebuggerUrl: failoverTarget.webSocketDebuggerUrl });
    if (failoverTarget && match?.[2]?.replace(/\/$/, "") === "json/list") {
      const target = failoverTarget;
      const upstream = http.get({ host: "127.0.0.1", port: target.port, path: "/json/list", timeout: 1_500 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { if (body.length < 1024 * 1024) body += chunk; });
        res.on("end", () => {
          let rows: unknown = [];
          try { rows = JSON.parse(body); } catch { rows = []; }
          const pages = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object" && (row as { type?: unknown }).type === "page")
            .map((row) => { const r = row as Record<string, unknown>; return { id: String(r.id ?? ""), type: "page", url: String(r.url ?? ""), title: String(r.title ?? "") }; }) : [];
          reply(response, 200, pages);
        });
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!response.headersSent) reply(response, 200, []); });
      return;
    }
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
    const lease = match ? leases.get(match[1]) ?? (authorized(request) ? reviveLease(match[1]) : undefined) : undefined;
    if (!authorized(request) || !lease || lease.socket || lease.connecting) { socket.destroy(); return; }
    lease.connecting = true;
    // MCP initialization/listing allocates only a lease; no tab or browser is
    // started until Playwright actually connects for a browser operation.
    void initializeLease(lease).then(() => {
      if (!current() || !leases.has(lease.id) || socket.destroyed) { releaseLease(lease); socket.destroy(); return; }
      websocket.handleUpgrade(request, socket, head, (ws) => {
      lease.socket = ws;
      lastRefusal = null;
      ws.on("message", (data) => {
        let value: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
        try { value = JSON.parse(String(data)); } catch { ws.close(1003); return; }
        if (!Number.isSafeInteger(value.id) || typeof value.method !== "string" || value.method.length > 128) { ws.close(1003); return; }
        const params = value.params && typeof value.params === "object" && !Array.isArray(value.params) ? value.params as Record<string, unknown> : {};
        const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
        void dispatch(lease, value.method, params, sessionId).then((result) => send(lease, { id: value.id, sessionId, result }))
          .catch((error) => send(lease, { id: value.id, sessionId, error: { code: -32000, message: nativeBrowserCommandFailure(error) } }));
      });
      // A closed socket frees the tabs, not the session: Playwright reconnects
      // to this same endpoint (the launcher's lease URL is fixed for its life).
      ws.once("close", () => { if (lease.socket === ws) resetLease(lease); });
      });
    }).catch((error: unknown) => {
      // ★Keep the lease. Releasing it here turned one tab-limit refusal into
      // every later connect answering 404 "does not look like a DevTools
      // server" on the same session (production 2026-09-28 14:14Z, three calls
      // in a row). The session stays; the next connect tries again once a tab
      // is free, and each refusal says why.
      resetLease(lease);
      if (!current()) releaseLease(lease);
      const message = error instanceof Error && error.message.startsWith("native-browser-tab-limit: ") ? error.message : "";
      lastRefusal = message ? "tab-limit" : !current() ? "grant-revoked" : lastRefusal;
      if (message && !socket.destroyed) {
        const body = JSON.stringify({ error: message });
        try { socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`); return; } catch {}
      }
      socket.destroy();
    });
  });
  const offDownloads = observeNativeBrowserDownloads((event) => {
    if (!current()) return;
    for (const lease of leases.values()) {
      const guest = [...lease.guests.values()].find((candidate) => !candidate.wc.isDestroyed() && candidate.wc.id === event.webContentsId);
      if (!guest || !lease.downloads?.eventsEnabled) continue;
      const guid = event.id;
      if (event.phase === "start") {
        send(lease, { method: "Browser.downloadWillBegin", params: { frameId: guest.targetId, guid, url: event.url, suggestedFilename: event.fileName } });
      } else if (event.phase === "progress") {
        send(lease, { method: "Browser.downloadProgress", params: { guid, totalBytes: event.totalBytes, receivedBytes: event.receivedBytes, state: "inProgress" } });
      } else {
        const target = path.join(lease.downloads.downloadPath, guid);
        const finish = (state: "completed" | "canceled") => send(lease, { method: "Browser.downloadProgress",
          params: { guid, totalBytes: event.totalBytes, receivedBytes: event.receivedBytes, state } });
        if (event.state !== "completed" || !event.savePath) { finish("canceled"); continue; }
        fs.promises.copyFile(event.savePath, target, fs.constants.COPYFILE_EXCL).then(() => finish("completed"), () => finish("canceled"));
      }
    }
  });
  // A popup opened by a page this run drives joins the same CDP session, so
  // the agent sees it as a new page (Playwright: context "page" / page "popup").
  const offPopup = onAgentBrowserPopup(holdId, (viewId, openerViewId) => {
    for (const lease of leases.values()) {
      const opener = lease.socket ? [...lease.guests.values()].find((guest) => guest.viewId === openerViewId) : undefined;
      if (opener) { void addGuest(lease, viewId, opener.targetId).catch(() => undefined); return; }
    }
  });
  let offTaskRevoke: () => void = () => {};
  let unregisterShutdown: () => void = () => {};
  const release = () => {
    if (closed) return;
    closed = true;
    releaseNativeInput?.(); releaseNativeInput = null;
    for (const wc of nativeInputGuests.values()) if (nativeInputOwners.get(wc) === ownerScopeId) nativeInputOwners.delete(wc);
    nativeInputGuests.clear();
    offPopup();
    offDownloads();
    input.signal.removeEventListener("abort", release);
    offTaskRevoke();
    unregisterShutdown();
    for (const lease of [...leases.values()]) releaseLease(lease);
    if (port) liveGrants.delete(`http://127.0.0.1:${port}`);
    liveOwnerScopes.delete(ownerScopeId);
    try { failoverTarget?.release?.(); } catch { /* lease already gone */ }
    failoverTarget = null;
    websocket.close();
    server.close();
    // The run settled (success, failure, cancel, interrupt, terminal task or host
    // shutdown all end here): close the tabs it opened unless the owner is
    // watching one right now.
    settleAgentBrowserHold(holdId);
    taskLease.release();
  };
  unregisterShutdown = onHostShutdown(release);
  input.signal.addEventListener("abort", release, { once: true });
  offTaskRevoke = taskLease.onRevoke(release);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  } catch { release(); throw new Error("native-browser-relay-unavailable"); }
  const address = server.address();
  if (!address || typeof address === "string" || !current()) { release(); server.close(); throw new Error("native-browser-relay-unavailable"); }
  port = address.port;
  const pages = (): NativeBrowserRelayPage[] => {
    if (!current()) return [];
    const seen = new Set<WebContents>();
    const out: NativeBrowserRelayPage[] = [];
    for (const [viewId, wc] of nativeInputGuests) {
        const guest = { viewId, wc };
        if (nativeInputOwners.get(wc) !== ownerScopeId || seen.has(wc) || wc.isDestroyed() || nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) !== wc) continue;
        seen.add(wc);
        out.push({
          id: guest.viewId,
          url: wc.getURL(),
          retainLoginVerification: (signal) => {
            if (!current() || signal.aborted || wc.isDestroyed()) throw new Error("native-browser-grant-revoked");
            const lease = acquireNativeBrowserTask({ taskScopeId: input.chatId, runId: input.runId, permission: "read", signal });
            let ended = false;
            const valid = () => !ended && !signal.aborted && lease.current() && lease.ownerId === owner.ownerId
              && !wc.isDestroyed() && nativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId) === wc;
            const verificationHold = openAgentBrowserHold({ runId: input.runId, isLive: valid });
            let offRevoke = () => {}, offShutdown = () => {};
            const timeout = setTimeout(() => cleanup(), 6 * 60 * 60 * 1000);
            timeout.unref?.();
            const cleanup = () => {
              if (ended) return;
              ended = true;
              clearTimeout(timeout);
              signal.removeEventListener("abort", cleanup);
              offRevoke(); offShutdown();
              settleAgentBrowserHold(verificationHold);
              reclaimOrphanAgentBrowserTabs(owner.ownerId);
              lease.release();
            };
            if (!claimNativeBrowserGuest(owner.ownerId, input.chatId, guest.viewId, verificationHold)) {
              cleanup(); throw new Error("native-browser-target-missing");
            }
            signal.addEventListener("abort", cleanup, { once: true });
            offRevoke = lease.onRevoke(cleanup);
            offShutdown = onHostShutdown(cleanup);
            return { current: valid, release: cleanup, reload: async () => {
              if (!valid()) return null;
              const settled = settledLoginVerificationUrl(wc, signal);
              wc.reload();
              const url = await settled;
              return valid() ? url : null;
            } };
          },
          reload: async () => {
            if (wc.isDestroyed()) return null;
            const settled = settledUrl(wc);
            wc.reload();
            return settled;
          },
          navigate: async (target: string) => {
            const safe = sanitizeWorkLiveUrl(target);
            if (!safe || wc.isDestroyed()) return;
            presentAction(guest);
            await wc.loadURL(safe.toString()).catch(() => undefined);
          },
          evaluate: async (expression: string) => {
            if (wc.isDestroyed() || !current()) return null;
            return wc.executeJavaScript(expression, true);
          },
          present: () => {
            if (wc.isDestroyed() || !current() || !focusNativeBrowserTask(input.chatId)) return false;
            // The owner asked to be shown this page: present even a background run's guest.
            presentNativeBrowserGuest(owner.ownerId, input.chatId, input.runId, guest.viewId);
            return current() && !wc.isDestroyed();
          },
        });
    }
    return out;
  };
  const health = (): NativeBrowserRelayHealth => ({
    current: current(),
    lastRefusal: !current() ? "grant-revoked" : lastRefusal,
    leases: leases.size,
    liveSockets: [...leases.values()].filter((lease) => lease.socket?.readyState === 1).length,
    revived,
    failedOver: failoverTarget !== null,
  });
  const reestablish = (): NativeBrowserRelayHealth => {
    if (current()) {
      for (const lease of leases.values()) {
        if (lease.socket && lease.socket.readyState !== 1) resetLease(lease);
      }
      lastRefusal = null;
    }
    return health();
  };
  const failover = (target: NativeBrowserRelayFailover | null) => {
    const refuse = () => { try { target?.release?.(); } catch { /* lease already gone */ } };
    if (!current()) { refuse(); return; }
    if (target && (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+$/.test(target.webSocketDebuggerUrl)
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)) { refuse(); return; }
    const previous = failoverTarget;
    failoverTarget = target;
    if (previous && previous !== target) { try { previous.release?.(); } catch { /* lease already gone */ } }
    lastRefusal = null;
    // Close the agent's open sockets: Playwright reconnects through /json/version, which now names the other browser.
    for (const lease of leases.values()) {
      const socket = lease.socket;
      resetLease(lease);
      try { socket?.close(); } catch { /* already closed */ }
    }
  };
  const grant: NativeBrowserRelayGrant = { ownerScopeId, endpoint: `http://127.0.0.1:${port}`, token: secret, release, pages, health, reestablish, failover };
  try {
    const [{ registerNativeGuestComputerUseScope }, { startComputerUseControlServer }] = await Promise.all([
      import("../computer-use/native-guest"), import("../computer-use/control-server"),
    ]);
    const controlPort = await startComputerUseControlServer();
    if (!controlPort || !current()) throw new Error("native-guest-host-unavailable");
    const native = registerNativeGuestComputerUseScope({ ownerId: owner.ownerId, chatId: input.chatId,
      runId: input.runId, permission: input.permission, signal: input.signal, current,
      pages: () => [...nativeInputGuests].filter(([id, wc]) => !wc.isDestroyed()
        && nativeInputOwners.get(wc) === ownerScopeId && nativeBrowserGuest(owner.ownerId, input.chatId, id) === wc).map(([id, wc]) => ({ id, wc })) });
    releaseNativeInput = native.release;
    grant.nativeComputerUse = { endpoint: `http://127.0.0.1:${controlPort}`, token: native.token, scopeId: native.scopeId };
  } catch { /* Browser tools remain available; this optional recovery path fails closed. */ }
  if (!current()) { release(); throw new Error("native-browser-grant-revoked"); }
  liveGrants.set(grant.endpoint, grant);
  liveOwnerScopes.set(ownerScopeId, { ownerScopeId, chatId: input.chatId, runId: input.runId, grant });
  return grant;
}
