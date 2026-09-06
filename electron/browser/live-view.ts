import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  acquireBrowserCdpLease,
  browserCdpPort,
  browserCdpPortReady,
  ensureBrowserCdpHost,
  releaseBrowserCdpLease,
  scheduleBrowserCdpIdleShutdown,
} from "../mcp-tools/browser-cdp-launcher";
import { onHostShutdown } from "../host-lifecycle";
import { getBrowserStatus } from "./connect";
import type {
  BrowserLiveFrame,
  BrowserLiveInput,
  BrowserLiveDispatchResult,
  BrowserLiveSessionResult,
  BrowserLiveStreamFrame,
  BrowserLiveViewport,
} from "../../shared/types";

interface CdpTarget {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  webSocketDebuggerUrl?: unknown;
}

interface VerifiedCdpTarget {
  id: string;
  title: string;
  url: string;
  socketUrl: string;
}

type BrowserLiveFrameSink = (frame: BrowserLiveStreamFrame) => void;

interface LiveSessionRecord {
  ownerId: number;
  stream: CdpLiveStream;
  releaseLease: (scheduleShutdown?: boolean) => void;
}

const liveSessions = new Map<string, LiveSessionRecord>();
onHostShutdown(() => {
  for (const record of liveSessions.values()) record.releaseLease(false);
  liveSessions.clear();
  scheduleBrowserCdpIdleShutdown();
});
// Agent MCP processes are intentionally ephemeral and close the pages they
// created when a worker finishes. The output rail therefore owns one durable
// CDP target per observed task URL instead of borrowing the worker's tab.
const railTargetIdsByUrl = new Map<string, string>();
const railTargetFlights = new Map<string, Promise<VerifiedCdpTarget | null>>();
// 24fps is the lowest common cinematic cadence and stays visibly smoother than
// the old 15fps rail while CDP acknowledgements still provide backpressure.
const LIVE_FRAME_INTERVAL_MS = 1_000 / 24;
const CDP_CALL_TIMEOUT_MS = 5_000;
const INITIAL_DOCUMENT_READY_TIMEOUT_MS = 4_000;
const WEB_VIEWPORT = { width: 1_280, height: 800 } as const;
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

type LiveDiagnosticValue = string | number | boolean | null;
const liveDiagnosticCounts = new Map<string, number>();
const LIVE_DIAGNOSTIC_LIMIT = 8;

/**
 * Keep the live-view failure boundary observable without ever writing the
 * requested URL, query, cookies, or page content to the durable main log.
 * A bounded counter prevents a disconnected stream from flooding it.
 */
function logLiveDiagnostic(stage: string, fields: Record<string, LiveDiagnosticValue> = {}): void {
  const key = `${stage}:${String(fields.error ?? fields.outcome ?? "")}`;
  const count = liveDiagnosticCounts.get(key) ?? 0;
  if (count >= LIVE_DIAGNOSTIC_LIMIT) return;
  liveDiagnosticCounts.set(key, count + 1);
  try {
    console.info("[agentlas-browser-live]", JSON.stringify({ stage, ...fields }));
  } catch {
    // Diagnostics must never affect the browser stream.
  }
}

function unavailable(error: BrowserLiveFrame["error"], viewport: BrowserLiveViewport = "desktop"): BrowserLiveFrame {
  return {
    available: false,
    dataUrl: null,
    targetId: null,
    title: null,
    url: null,
    width: null,
    height: null,
    viewport,
    capturedAt: new Date().toISOString(),
    error,
  };
}

const SENSITIVE_URL_PARAMETER = /^(?:access_?token|auth|authorization|code|credential|key|password|refresh_?token|secret|signature|sig)$/iu;

/**
 * User-visible action identity. Normal query parameters and fragments are
 * significant (SPA routes and redirect intents depend on them), so they are
 * preserved. URL credentials and explicitly credential-shaped values are
 * removed before a frame or receipt crosses into the renderer.
 */
function displayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    parsed.hash = parsed.hash.replace(
      /([?&#](?:access_?token|auth|authorization|code|credential|key|password|refresh_?token|secret|signature|sig)=)[^&#]*/giu,
      "$1[redacted]",
    );
    return parsed.toString();
  } catch {
    return null;
  }
}

function actionUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function matchUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function fetchTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/list", timeout: 1_500 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve([]);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 2 * 1024 * 1024) body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.once("error", () => resolve([]));
    req.once("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

function verifiedTarget(target: CdpTarget, port: number): VerifiedCdpTarget | null {
  if (
    target.type !== "page" ||
    typeof target.id !== "string" ||
    typeof target.title !== "string" ||
    typeof target.url !== "string" ||
    typeof target.webSocketDebuggerUrl !== "string"
  ) return null;
  try {
    const socket = new URL(target.webSocketDebuggerUrl);
    const loopback = socket.hostname === "127.0.0.1" || socket.hostname === "localhost" || socket.hostname === "[::1]";
    if (socket.protocol !== "ws:" || !loopback || Number(socket.port) !== port) return null;
  } catch {
    return null;
  }
  return { id: target.id, title: target.title, url: target.url, socketUrl: target.webSocketDebuggerUrl };
}

function createRailTarget(port: number, normalizedUrl: string): Promise<VerifiedCdpTarget | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "PUT",
        path: `/json/new?${encodeURIComponent(normalizedUrl)}`,
        timeout: 2_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 1024 * 1024) body += chunk;
        });
        res.on("end", () => {
          try {
            const target = verifiedTarget(JSON.parse(body) as CdpTarget, port);
            // Chrome may report about:blank for a few milliseconds while the
            // requested navigation starts. The socket identity is already
            // authoritative; frameNavigated will replace this URL in-stream.
            resolve(target ? { ...target, url: normalizedUrl } : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.once("error", () => resolve(null));
    req.once("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function ensureRailTarget(port: number, normalizedUrl: string): Promise<VerifiedCdpTarget | null> {
  const active = railTargetFlights.get(normalizedUrl);
  if (active) return active;
  const flight = (async () => {
    const targets = await fetchTargets(port);
    const pages = targets.map((target) => verifiedTarget(target, port)).filter((target) => target !== null);
    const ownedId = railTargetIdsByUrl.get(normalizedUrl);
    const owned = ownedId ? pages.find((page) => page.id === ownedId) : undefined;
    if (owned) return owned;
    if (ownedId) railTargetIdsByUrl.delete(normalizedUrl);

    // Always create a rail-owned target. Reusing the matching worker tab looks
    // correct during execution but turns into an empty sidebar the instant the
    // MCP worker exits and closes its context.
    const created = await createRailTarget(port, normalizedUrl);
    if (created) {
      railTargetIdsByUrl.set(normalizedUrl, created.id);
      return created;
    }
    // Older Chrome builds can reject /json/new. Falling back to an existing
    // exact target keeps live rendering available while preserving strict URL
    // attribution; it simply cannot promise post-worker persistence.
    return pages.find((page) => matchUrl(page.url) === normalizedUrl) ?? null;
  })();
  railTargetFlights.set(normalizedUrl, flight);
  return flight.finally(() => {
    if (railTargetFlights.get(normalizedUrl) === flight) railTargetFlights.delete(normalizedUrl);
  });
}

function finiteBetween(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

/**
 * One persistent CDP connection per visible live rail. CDP's screencast API
 * supplies frame acknowledgements/backpressure, so a static page sends almost
 * no traffic while animation, scrolling, and video can update smoothly.
 */
class CdpLiveStream {
  private socket: WebSocket | null = null;
  private requestSequence = 0;
  private frameSequence = 0;
  private lastFrameAt = 0;
  private width = 1;
  private height = 1;
  private disposed = false;
  private closing = false;
  private closeNotified = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    readonly sessionId: string,
    readonly target: VerifiedCdpTarget,
    readonly viewport: BrowserLiveViewport,
    private readonly sink: BrowserLiveFrameSink,
    private readonly onClosed: () => void,
  ) {}

  private async waitForInitialDocument(): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + INITIAL_DOCUMENT_READY_TIMEOUT_MS;
    let latest: { readyState: string; bodyTextLength: number; bodyChildren: number } = {
      readyState: "unknown",
      bodyTextLength: 0,
      bodyChildren: 0,
    };
    while (Date.now() < deadline) {
      try {
        const evaluated = await this.call("Runtime.evaluate", {
          expression: `(() => {
            const body = document.body;
            const text = body?.innerText || "";
            return {
              readyState: document.readyState,
              bodyTextLength: text.length,
              bodyChildren: body?.children.length || 0,
            };
          })()`,
          returnByValue: true,
        }) as {
          result?: {
            value?: {
              readyState?: unknown;
              bodyTextLength?: unknown;
              bodyChildren?: unknown;
            };
          };
        };
        const value = evaluated.result?.value;
        latest = {
          readyState: typeof value?.readyState === "string" ? value.readyState : "unknown",
          bodyTextLength: Math.max(0, Math.trunc(Number(value?.bodyTextLength) || 0)),
          bodyChildren: Math.max(0, Math.trunc(Number(value?.bodyChildren) || 0)),
        };
        if (
          (latest.readyState === "interactive" || latest.readyState === "complete")
          && (latest.bodyTextLength > 0 || latest.bodyChildren > 0)
        ) {
          logLiveDiagnostic("document-ready", { ...latest, waitMs: Date.now() - startedAt });
          return;
        }
      } catch {
        // The execution context can be unavailable while the new document is swapping in.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    logLiveDiagnostic("document-ready-timeout", { ...latest, waitMs: Date.now() - startedAt });
  }

  async start(): Promise<BrowserLiveFrame> {
    logLiveDiagnostic("stream-start", {
      viewport: this.viewport,
      targetIdPresent: Boolean(this.target.id),
      urlPresent: Boolean(this.target.url),
    });
    const socket = new WebSocket(this.target.socketUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream-open-timeout")), CDP_CALL_TIMEOUT_MS);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("stream-open-failed"));
      };
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => this.handleSocketClose());
    socket.addEventListener("close", () => this.handleSocketClose());

    await this.call("Page.enable");
    await this.call("Runtime.enable");
    const phone = this.viewport === "phone";
    const viewport = phone ? PHONE_VIEWPORT : WEB_VIEWPORT;
    // The rail is a viewer, not the page's layout viewport. Web must keep a
    // real desktop canvas and scale it down inside a narrow rail; otherwise a
    // 500px rail silently turns the "Web" tab into another mobile breakpoint.
    await this.call("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: phone,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await this.call("Emulation.setTouchEmulationEnabled", phone
      ? { enabled: true, maxTouchPoints: 5 }
      : { enabled: false });

    const metrics = await this.call("Page.getLayoutMetrics") as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const measuredViewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    this.width = Math.max(1, Math.round(Number(measuredViewport?.clientWidth) || viewport.width));
    this.height = Math.max(1, Math.round(Number(measuredViewport?.clientHeight) || viewport.height));

    // /json/new returns the target before its navigation has committed. Wait for
    // the target's own document to become observable so the first frame cannot
    // replace a usable page with the transient white about:blank capture.
    await this.waitForInitialDocument();
    await this.call("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    // A still page does not always emit immediately. Seed the stream from the
    // exact same CDP target so the start result itself contains a real frame.
    const screenshot = await this.call("Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      fromSurface: true,
      captureBeyondViewport: false,
    }) as { data?: string };
    if (!screenshot.data) throw new Error("empty-stream-frame");
    const frame = this.frame(screenshot.data);
    logLiveDiagnostic("initial-frame", {
      width: this.width,
      height: this.height,
      bytes: screenshot.data.length,
    });
    this.sink(frame);
    return frame;
  }

  private async waitForHistoryEntry(index: number, entryId: number): Promise<void> {
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      const history = await this.call("Page.getNavigationHistory") as {
        currentIndex?: unknown;
        entries?: Array<{ id?: unknown }>;
      };
      if (
        Number(history.currentIndex) === index
        && Number(history.entries?.[index]?.id) === entryId
      ) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("navigation-history-did-not-settle");
  }

  private async captureNavigationFrame(options: {
    initialUrl?: string | null;
    requestedUrl?: string | null;
    allowSameUrl?: boolean;
  } = {}): Promise<BrowserLiveStreamFrame> {
    const deadline = Date.now() + 4_000;
    const initial = actionUrl(options.initialUrl ?? undefined);
    const requested = actionUrl(options.requestedUrl ?? undefined);
    // Give CDP a bounded chance to replace the old execution context. Without
    // this floor a redirecting navigation can capture the already-ready source
    // page before Page.frameNavigated arrives.
    const earliestCapture = Date.now() + 80;
    while (Date.now() < deadline) {
      try {
        const evaluated = await this.call("Runtime.evaluate", {
          expression: "({href:location.href,title:document.title,readyState:document.readyState})",
          returnByValue: true,
        }) as { result?: { value?: { href?: unknown; title?: unknown; readyState?: unknown } } };
        const value = evaluated.result?.value;
        const current = typeof value?.href === "string" ? actionUrl(value.href) : null;
        const ready = value?.readyState === "interactive" || value?.readyState === "complete";
        const changed = Boolean(current && current !== initial);
        const requestedReached = Boolean(current && requested && current === requested);
        if (
          current
          && ready
          && Date.now() >= earliestCapture
          && (options.allowSameUrl === true || changed || requestedReached)
        ) {
          this.target.url = current;
          if (typeof value?.title === "string") this.target.title = value.title;
          const screenshot = await this.call("Page.captureScreenshot", {
            format: "jpeg",
            quality: 72,
            fromSurface: true,
            captureBeyondViewport: false,
          }) as { data?: string };
          if (screenshot.data) {
            // History traversal can restore a static page from the back-forward
            // cache without emitting another screencast frame. Seed one exact
            // frame so the in-app viewport and address bar never stay stale.
            const frame = this.frame(screenshot.data);
            this.sink(frame);
            return frame;
          }
        }
      } catch {
        // The execution context is briefly unavailable while navigation swaps
        // documents. Retry within the bounded deadline.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("navigation-frame-did-not-settle");
  }

  async dispatch(input: BrowserLiveInput): Promise<{ sequence: number; finalUrl: string | null }> {
    if (input.kind === "navigation") {
      if (input.action === "navigate") {
        const target = actionUrl(input.url);
        if (!target) throw new Error("invalid-navigation-target");
        const initialUrl = this.target.url;
        const result = await this.call("Page.navigate", { url: target }) as { errorText?: unknown };
        if (typeof result.errorText === "string" && result.errorText) throw new Error("navigation-refused");
        const frame = await this.captureNavigationFrame({
          initialUrl,
          requestedUrl: target,
          allowSameUrl: initialUrl === target,
        });
        return { sequence: frame.sequence, finalUrl: frame.url };
      }
      if (input.action === "reload") {
        const initialUrl = this.target.url;
        await this.call("Page.reload", { ignoreCache: false });
        const frame = await this.captureNavigationFrame({ initialUrl, allowSameUrl: true });
        return { sequence: frame.sequence, finalUrl: frame.url };
      }
      const history = await this.call("Page.getNavigationHistory") as {
        currentIndex?: unknown;
        entries?: Array<{ id?: unknown; url?: unknown }>;
      };
      const currentIndex = Number(history.currentIndex);
      const targetIndex = input.action === "back" ? currentIndex - 1 : currentIndex + 1;
      const entryId = Number(history.entries?.[targetIndex]?.id);
      if (!Number.isFinite(entryId)) throw new Error("no-history");
      const initialUrl = this.target.url;
      await this.call("Page.navigateToHistoryEntry", { entryId });
      // CDP acknowledges before the history cursor always moves. Waiting for
      // that cursor prevents a quick Back → Forward sequence from resolving
      // Forward against the stale index and becoming a silent no-op.
      await this.waitForHistoryEntry(targetIndex, entryId);
      const expectedUrl = typeof history.entries?.[targetIndex]?.url === "string"
        ? history.entries[targetIndex].url as string
        : undefined;
      const frame = await this.captureNavigationFrame({
        initialUrl,
        requestedUrl: expectedUrl,
        allowSameUrl: initialUrl === expectedUrl,
      });
      return { sequence: frame.sequence, finalUrl: frame.url };
    }
    if (input.kind === "pointer") {
      const type = input.phase === "down" ? "mousePressed" : input.phase === "up" ? "mouseReleased" : "mouseMoved";
      await this.call("Input.dispatchMouseEvent", {
        type,
        x: finiteBetween(input.x, 0, 1) * this.width,
        y: finiteBetween(input.y, 0, 1) * this.height,
        button: input.phase === "move" ? "none" : input.button ?? "left",
        clickCount: Math.round(finiteBetween(input.clickCount ?? 1, 1, 3)),
      });
      return { sequence: this.frameSequence, finalUrl: displayUrl(this.target.url) };
    }
    if (input.kind === "wheel") {
      await this.call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: finiteBetween(input.x, 0, 1) * this.width,
        y: finiteBetween(input.y, 0, 1) * this.height,
        deltaX: finiteBetween(input.deltaX, -2_000, 2_000),
        deltaY: finiteBetween(input.deltaY, -2_000, 2_000),
      });
      return { sequence: this.frameSequence, finalUrl: displayUrl(this.target.url) };
    }
    if (input.kind === "text") {
      const text = input.text.slice(0, 4_096);
      if (text) await this.call("Input.insertText", { text });
      return { sequence: this.frameSequence, finalUrl: displayUrl(this.target.url) };
    }
    const key = input.key.slice(0, 64);
    const code = input.code?.slice(0, 64);
    const printable = input.phase === "down" && key.length === 1 ? key : undefined;
    await this.call("Input.dispatchKeyEvent", {
      type: input.phase === "down" ? "keyDown" : "keyUp",
      key,
      code,
      text: printable,
      unmodifiedText: printable,
      modifiers: Math.round(finiteBetween(input.modifiers ?? 0, 0, 15)),
    });
    return { sequence: this.frameSequence, finalUrl: displayUrl(this.target.url) };
  }

  async close(): Promise<void> {
    if (this.disposed || this.closing) return;
    this.closing = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      await this.call("Page.stopScreencast").catch(() => undefined);
      await this.call("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
      await this.call("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
    }
    this.disposed = true;
    this.rejectPending("stream-closed");
    this.socket?.close();
    this.notifyClosed();
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("stream-not-open"));
    }
    const id = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("cdp-call-timeout"));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("cdp-send-failed"));
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("cdp-error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Page.frameNavigated" && message.params) {
      const frame = message.params.frame;
      if (frame && typeof frame === "object") {
        const row = frame as { parentId?: unknown; url?: unknown };
        if (!row.parentId && typeof row.url === "string") this.target.url = row.url;
      }
      return;
    }
    if (message.method === "Page.loadEventFired") {
      void this.call("Runtime.evaluate", { expression: "document.title", returnByValue: true })
        .then((result) => {
          const value = (result as { result?: { value?: unknown } })?.result?.value;
          if (typeof value === "string") this.target.title = value;
        })
        .catch(() => undefined);
      return;
    }
    if (message.method !== "Page.screencastFrame" || !message.params || this.closing) return;
    const data = typeof message.params.data === "string" ? message.params.data : "";
    const cdpSessionId = Number(message.params.sessionId);
    if (Number.isFinite(cdpSessionId)) {
      void this.call("Page.screencastFrameAck", { sessionId: cdpSessionId }).catch(() => undefined);
    }
    if (!data) return;
    const now = Date.now();
    if (now - this.lastFrameAt < LIVE_FRAME_INTERVAL_MS) return;
    this.lastFrameAt = now;
    const metadata = message.params.metadata;
    if (metadata && typeof metadata === "object") {
      const row = metadata as { deviceWidth?: unknown; deviceHeight?: unknown };
      this.width = Math.max(1, Math.round(Number(row.deviceWidth) || this.width));
      this.height = Math.max(1, Math.round(Number(row.deviceHeight) || this.height));
    }
    const first = this.frameSequence === 0;
    this.sink(this.frame(data));
    if (first) logLiveDiagnostic("first-screencast-frame", { bytes: data.length, width: this.width, height: this.height });
  }

  private frame(data: string): BrowserLiveStreamFrame {
    return {
      available: true,
      dataUrl: `data:image/jpeg;base64,${data}`,
      targetId: this.target.id,
      title: this.target.title.slice(0, 200),
      url: displayUrl(this.target.url),
      width: this.width,
      height: this.height,
      viewport: this.viewport,
      capturedAt: new Date().toISOString(),
      error: null,
      sessionId: this.sessionId,
      sequence: ++this.frameSequence,
    };
  }

  private handleSocketClose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending("stream-disconnected");
    logLiveDiagnostic("stream-closed", { error: "browser-offline", viewport: this.viewport });
    // 마지막으로 "이제 볼 수 없다"는 프레임을 한 번 밀어 준다. 이것 없이는
    // 렌더러가 마지막 정상 프레임을 영원히 들고 있어, 죽은 페이지가 살아있는
    // 것처럼 보였다(U-D-1 범위 밖 3종 ①, 2026-08-25). 정상 종료(close())는
    // closing 플래그로 이 경로에 오기 전에 disposed 처리되므로 해당 없음.
    if (!this.closing) {
      try {
        this.sink({
          available: false,
          dataUrl: null,
          targetId: this.target.id,
          title: this.target.title.slice(0, 200),
          url: displayUrl(this.target.url),
          width: this.width,
          height: this.height,
          viewport: this.viewport,
          capturedAt: new Date().toISOString(),
          error: "browser-offline",
          sessionId: this.sessionId,
          sequence: ++this.frameSequence,
        });
      } catch { /* 알림 실패가 종료 자체를 막으면 안 된다 */ }
    }
    this.notifyClosed();
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClosed();
  }
}

function captureTarget(socketUrl: string, viewportMode: BrowserLiveViewport): Promise<{ data: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("capture-timeout"));
    }, 5_000);

    const finishError = (reason: string) => {
      clearTimeout(timeout);
      for (const item of pending.values()) item.reject(new Error(reason));
      pending.clear();
      reject(new Error(reason));
    };
    const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const id = ++sequence;
      return new Promise((callResolve, callReject) => {
        pending.set(id, { resolve: callResolve, reject: callReject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
        if (!message.id) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.error) item.reject(new Error("cdp-error"));
        else item.resolve(message.result);
      } catch {
        finishError("invalid-cdp-response");
      }
    });
    socket.addEventListener("error", () => finishError("cdp-socket-error"), { once: true });
    socket.addEventListener("open", () => {
      void (async () => {
        const phone = viewportMode === "phone";
        let metrics: {
          cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
          cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
        };
        let screenshot: { data?: string };
        try {
          if (phone) {
            await call("Emulation.setDeviceMetricsOverride", {
              width: 390,
              height: 844,
              deviceScaleFactor: 1,
              mobile: true,
              screenWidth: 390,
              screenHeight: 844,
            });
            await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
          } else {
            // A prior interrupted phone capture must never strand the shared
            // browser tab at mobile dimensions. Desktop capture self-heals it.
            await call("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
            await call("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
            await call("Page.getLayoutMetrics").catch(() => undefined);
          }
          metrics = await call("Page.getLayoutMetrics") as typeof metrics;
          screenshot = await call("Page.captureScreenshot", {
            format: "jpeg",
            quality: 72,
            fromSurface: true,
            captureBeyondViewport: false,
          }) as typeof screenshot;
        } finally {
          if (phone) {
            // The live browser remains a normal desktop tab. Phone mode is a
            // momentary, real responsive capture rather than a lasting mutation.
            await call("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
            await call("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
            await call("Page.getLayoutMetrics").catch(() => undefined);
          }
        }
        if (!screenshot.data) throw new Error("empty-screenshot");
        const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
        const width = Math.max(1, Math.round(Number(viewport?.clientWidth) || 1));
        const height = Math.max(1, Math.round(Number(viewport?.clientHeight) || 1));
        clearTimeout(timeout);
        socket.close();
        resolve({ data: screenshot.data, width, height });
      })().catch(() => finishError("capture-failed"));
    }, { once: true });
  });
}

function bringTargetToFront(socketUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("focus-timeout"));
    }, 2_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener("error", () => finish(new Error("focus-socket-error")), { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (message.id !== 1) return;
        finish(message.error ? new Error("focus-cdp-error") : undefined);
      } catch {
        finish(new Error("focus-invalid-response"));
      }
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Page.bringToFront", params: {} }));
    }, { once: true });
  });
}

function activateBrowserApplication(): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const chromePath = getBrowserStatus().chromePath;
  if (!chromePath) return Promise.resolve();
  const match = chromePath.match(/^(.+?\.app)(?:\/|$)/u);
  const application = match?.[1] ?? chromePath;
  return new Promise((resolve) => {
    execFile("/usr/bin/open", ["-a", application], { timeout: 2_000 }, () => resolve());
  });
}

export async function captureBrowserLiveFrame(
  preferredUrl?: string,
  viewportMode: BrowserLiveViewport = "desktop",
): Promise<BrowserLiveFrame> {
  const preferred = matchUrl(preferredUrl);
  // Capture is always scoped by the calling Taskforce/thread. An unscoped
  // request must never turn into "show the most recently open browser tab".
  if (!preferred) return unavailable("no-page", viewportMode);
  const lease = await acquireBrowserCdpLease("capture").catch(() => null);
  if (!lease) return unavailable("browser-offline", viewportMode);
  try {
    const port = browserCdpPort();
    const targets = await fetchTargets(port);
    if (targets.length === 0) return unavailable("browser-offline", viewportMode);
    const pages = targets.map((target) => verifiedTarget(target, port)).filter((target) => target !== null);
    const target = pages.find((page) => matchUrl(page.url) === preferred);
    // A task-scoped request must fail empty instead of silently showing an
    // unrelated tab left over from another task.
    if (!target) return unavailable("no-page", viewportMode);
    const screenshot = await captureTarget(target.socketUrl, viewportMode);
    return {
      available: true,
      dataUrl: `data:image/jpeg;base64,${screenshot.data}`,
      targetId: target.id,
      title: target.title.slice(0, 200),
      url: displayUrl(target.url),
      width: screenshot.width,
      height: screenshot.height,
      viewport: viewportMode,
      capturedAt: new Date().toISOString(),
      error: null,
    };
  } catch {
    return unavailable("capture-failed", viewportMode);
  } finally {
    releaseBrowserCdpLease(lease);
  }
}

function isBrowserLiveInput(value: unknown): value is BrowserLiveInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (typeof input.sessionId !== "string" || input.sessionId.length > 128) return false;
  if (input.kind === "pointer") {
    return ["move", "down", "up"].includes(String(input.phase))
      && Number.isFinite(input.x)
      && Number.isFinite(input.y)
      && (input.button === undefined || ["left", "middle", "right"].includes(String(input.button)));
  }
  if (input.kind === "wheel") {
    return Number.isFinite(input.x)
      && Number.isFinite(input.y)
      && Number.isFinite(input.deltaX)
      && Number.isFinite(input.deltaY);
  }
  if (input.kind === "key") {
    return ["down", "up"].includes(String(input.phase))
      && typeof input.key === "string"
      && input.key.length <= 64
      && (input.code === undefined || (typeof input.code === "string" && input.code.length <= 64));
  }
  if (input.kind === "navigation") {
    if (["back", "forward", "reload"].includes(String(input.action))) return true;
    return input.action === "navigate"
      && typeof input.url === "string"
      && input.url.length <= 2_048
      && matchUrl(input.url) !== null;
  }
  return input.kind === "text" && typeof input.text === "string" && input.text.length <= 4_096;
}

export async function startBrowserLiveSession(
  ownerId: number,
  preferredUrl: string,
  viewportMode: BrowserLiveViewport,
  sink: BrowserLiveFrameSink,
): Promise<BrowserLiveSessionResult> {
  const port = browserCdpPort();
  const preferred = matchUrl(preferredUrl);
  logLiveDiagnostic("start-request", {
    ownerId,
    viewport: viewportMode,
    urlPresent: Boolean(preferred),
  });
  if (!preferred) {
    logLiveDiagnostic("start-rejected", { error: "no-page", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("no-page", viewportMode) };
  }
  const lease = await acquireBrowserCdpLease("live-view").catch(() => null);
  if (!lease) {
    logLiveDiagnostic("lease-unavailable", { error: "browser-offline", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("browser-offline", viewportMode) };
  }
  try {
    const host = await ensureBrowserCdpHost();
    logLiveDiagnostic("cdp-host-ready", { started: host.started, pidPresent: host.pid > 0, viewport: viewportMode });
  } catch {
    releaseBrowserCdpLease(lease);
    logLiveDiagnostic("cdp-unavailable", { error: "browser-offline", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("browser-offline", viewportMode) };
  }
  if (!(await browserCdpPortReady())) {
    releaseBrowserCdpLease(lease);
    logLiveDiagnostic("cdp-unavailable-after-ensure", { error: "browser-offline", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("browser-offline", viewportMode) };
  }
  logLiveDiagnostic("cdp-ready", { viewport: viewportMode, port });
  let leaseReleased = false;
  const releaseLease = (scheduleShutdown = true) => {
    if (leaseReleased) return;
    leaseReleased = true;
    releaseBrowserCdpLease(lease, { scheduleShutdown });
  };
  let target: VerifiedCdpTarget | null = null;
  try {
    await stopBrowserLiveSessionsForOwner(ownerId);
    target = await ensureRailTarget(port, preferred);
  } catch {
    releaseLease();
    logLiveDiagnostic("target-resolution-failed", { error: "capture-failed", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("capture-failed", viewportMode) };
  }
  if (!target) {
    releaseLease();
    logLiveDiagnostic("target-missing", { error: "no-page", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("no-page", viewportMode) };
  }
  logLiveDiagnostic("target-ready", {
    viewport: viewportMode,
    targetIdPresent: Boolean(target.id),
    urlPresent: Boolean(target.url),
  });

  const sessionId = randomUUID();
  let stream!: CdpLiveStream;
  stream = new CdpLiveStream(sessionId, target, viewportMode, sink, () => {
    const current = liveSessions.get(sessionId);
    if (current?.stream === stream) liveSessions.delete(sessionId);
    releaseLease();
  });
  liveSessions.set(sessionId, { ownerId, stream, releaseLease });
  try {
    const frame = await stream.start();
    logLiveDiagnostic("session-ready", {
      viewport: viewportMode,
      width: frame.width ?? 0,
      height: frame.height ?? 0,
    });
    return { sessionId, interactive: true, frame };
  } catch {
    liveSessions.delete(sessionId);
    await stream.close().catch(() => undefined);
    logLiveDiagnostic("session-failed", { error: "capture-failed", viewport: viewportMode });
    return { sessionId: null, interactive: false, frame: unavailable("capture-failed", viewportMode) };
  }
}

export async function stopBrowserLiveSession(ownerId: number, sessionId: string): Promise<{ ok: boolean }> {
  const record = liveSessions.get(sessionId);
  if (!record || record.ownerId !== ownerId) return { ok: false };
  liveSessions.delete(sessionId);
  await record.stream.close().catch(() => undefined);
  return { ok: true };
}

export async function stopBrowserLiveSessionsForOwner(ownerId: number): Promise<void> {
  const matches = [...liveSessions.entries()].filter(([, record]) => record.ownerId === ownerId);
  await Promise.all(matches.map(async ([sessionId, record]) => {
    liveSessions.delete(sessionId);
    await record.stream.close().catch(() => undefined);
  }));
}

export async function dispatchBrowserLiveInput(
  ownerId: number,
  value: unknown,
): Promise<BrowserLiveDispatchResult> {
  if (!isBrowserLiveInput(value)) return { ok: false, code: "invalid_input" };
  const record = liveSessions.get(value.sessionId);
  if (!record || record.ownerId !== ownerId) return { ok: false, code: "session_missing" };
  try {
    const result = await record.stream.dispatch(value);
    return { ok: true, sessionId: value.sessionId, ...result };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && error.message === "no-history"
        ? "no_history"
        : "dispatch_failed",
    };
  }
}

export async function focusBrowserLiveTarget(targetId?: string): Promise<{ ok: boolean }> {
  const lease = await acquireBrowserCdpLease("focus").catch(() => null);
  if (!lease) return { ok: false };
  try {
    const port = browserCdpPort();
    const targets = await fetchTargets(port);
    const pages = targets.map((target) => verifiedTarget(target, port)).filter((target) => target !== null);
    const target = pages.find((page) => page.id === targetId)
      ?? pages.find((page) => page.url !== "about:blank")
      ?? pages[0];
    if (!target) return { ok: false };
    await bringTargetToFront(target.socketUrl);
    await activateBrowserApplication();
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    releaseBrowserCdpLease(lease);
  }
}
