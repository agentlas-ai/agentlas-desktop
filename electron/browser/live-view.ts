import http from "node:http";
import { execFile } from "node:child_process";
import { browserCdpPort } from "../mcp-tools/browser-cdp-launcher";
import { getBrowserStatus } from "./connect";
import type { BrowserLiveFrame, BrowserLiveViewport } from "../../shared/types";

interface CdpTarget {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  webSocketDebuggerUrl?: unknown;
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

function displayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
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

function verifiedTarget(target: CdpTarget, port: number): {
  id: string;
  title: string;
  url: string;
  socketUrl: string;
} | null {
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
  const port = browserCdpPort();
  const targets = await fetchTargets(port);
  if (targets.length === 0) return unavailable("browser-offline", viewportMode);
  const pages = targets.map((target) => verifiedTarget(target, port)).filter((target) => target !== null);
  const preferred = matchUrl(preferredUrl);
  const target = preferred
    ? pages.find((page) => matchUrl(page.url) === preferred)
    : pages.find((page) => page.url !== "about:blank") ?? pages[0];
  // A task-scoped request must fail empty instead of silently showing an
  // unrelated tab left over from another task.
  if (!target) return unavailable("no-page", viewportMode);
  try {
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
  }
}

export async function focusBrowserLiveTarget(targetId?: string): Promise<{ ok: boolean }> {
  const port = browserCdpPort();
  const targets = await fetchTargets(port);
  const pages = targets.map((target) => verifiedTarget(target, port)).filter((target) => target !== null);
  const target = pages.find((page) => page.id === targetId)
    ?? pages.find((page) => page.url !== "about:blank")
    ?? pages[0];
  if (!target) return { ok: false };
  try {
    await bringTargetToFront(target.socketUrl);
    await activateBrowserApplication();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
