// Main-owned live preview runtime for registered generated apps.
//
// A scaffold path is not a running app. This module serves the registered app's
// generated UI on an ephemeral loopback port, watches its files, and pushes a
// reload event when they change. It never evaluates the generated server script
// in Electron and never inherits Desktop credentials into generated code.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppFactoryAppRecord, AppFactoryLivePreviewResult } from "../../shared/types";
import { getAgentApp, isCloudAppRoot } from "../store/agent-apps";

type ActivePreview = {
  appId: string;
  rootPath: string;
  contentRoot: string;
  server: Server;
  url: string;
  revision: number;
  watcher: fs.FSWatcher | null;
  reloadTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout;
  clients: Set<ServerResponse>;
};

const activePreviews = new Map<string, ActivePreview>();

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

const LIVE_CLIENT = `(() => {
  if (window.__agentlasLiveReload) return;
  window.__agentlasLiveReload = true;
  let pending = false;
  const source = new EventSource('/__agentlas/events');
  source.addEventListener('reload', () => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => window.location.reload(), 60);
  });
})();`;

const PREVIEW_CSP = [
  "default-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "frame-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function loopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeExternalPreviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (url.username || url.password || !url.hostname) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
  } catch {
    // invalid declaration
  }
  return null;
}

function externalPreview(record: AppFactoryAppRecord): AppFactoryLivePreviewResult {
  const candidates = [
    record.scaffold.launchUrl,
    record.manifest.app?.deployment?.previewUrl,
    (record.scaffold as AppFactoryAppRecord["scaffold"] & { sourceUrl?: string }).sourceUrl,
  ];
  const url = candidates.map(safeExternalPreviewUrl).find((candidate): candidate is string => Boolean(candidate));
  return url
    ? { ok: true, appId: record.id, url, runtime: "external-web" }
    : {
        ok: false,
        appId: record.id,
        runtime: "unavailable",
        reason: "This app has no verified live web URL.",
      };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function directory(pathname: string): Promise<boolean> {
  try {
    return (await fsp.stat(pathname)).isDirectory();
  } catch {
    return false;
  }
}

async function contentRoot(record: AppFactoryAppRecord): Promise<{ rootPath: string; contentRoot: string }> {
  const declaredStat = await fsp.lstat(record.rootPath);
  if (!declaredStat.isDirectory() || declaredStat.isSymbolicLink()) {
    throw new Error("The generated app root is not a real directory.");
  }
  const rootPath = await fsp.realpath(record.rootPath);

  // A built Astryx app is the richest runnable artifact. Until it is built, the
  // deterministic generated service UI in src/ is still a real interactive app,
  // not the Workbench's former hand-drawn mock.
  const candidates = [path.join(rootPath, "astryx-app", "dist"), path.join(rootPath, "src")];
  for (const candidate of candidates) {
    if (await directory(candidate)) {
      const canonical = await fsp.realpath(candidate);
      if (inside(rootPath, canonical)) return { rootPath, contentRoot: canonical };
    }
  }
  throw new Error("The generated app has no runnable UI directory yet.");
}

function commonHeaders(contentType?: string): Record<string, string> {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    "Content-Security-Policy": PREVIEW_CSP,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...commonHeaders("application/json; charset=utf-8"),
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function resolveFile(preview: ActivePreview, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^\/+/, "");
  const requested = path.resolve(preview.contentRoot, relative || "index.html");
  if (!inside(preview.contentRoot, requested)) return null;

  const attempts = [requested];
  try {
    if ((await fsp.stat(requested)).isDirectory()) attempts.unshift(path.join(requested, "index.html"));
  } catch {
    if (!path.extname(requested)) {
      attempts.push(path.join(requested, "index.html"), path.join(preview.contentRoot, "index.html"));
    }
  }

  for (const candidate of attempts) {
    try {
      const canonical = await fsp.realpath(candidate);
      if (!inside(preview.contentRoot, canonical)) continue;
      const stat = await fsp.lstat(canonical);
      if (stat.isFile() && !stat.isSymbolicLink()) return canonical;
    } catch {
      // try the next route/static fallback
    }
  }
  return null;
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : Number.NaN;
  let end = match[2] ? Number(match[2]) : Number.NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) return null;
    if (!Number.isFinite(end)) end = size - 1;
  }
  start = Math.max(0, Math.floor(start));
  end = Math.min(size - 1, Math.floor(end));
  return start <= end && start < size ? { start, end } : null;
}

async function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string): Promise<void> {
  const stat = await fsp.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[extension] ?? "application/octet-stream";

  if (extension === ".html") {
    const source = await fsp.readFile(filePath, "utf8");
    const tag = '<script src="/__agentlas/live.js" defer></script>';
    const body = Buffer.from(source.includes("/__agentlas/live.js")
      ? source
      : source.includes("</body>")
        ? source.replace("</body>", `${tag}</body>`)
        : `${source}${tag}`);
    response.writeHead(200, { ...commonHeaders(type), "Content-Length": String(body.length) });
    if (request.method === "HEAD") response.end(); else response.end(body);
    return;
  }

  const range = byteRange(request.headers.range, stat.size);
  if (request.headers.range && !range) {
    response.writeHead(416, { ...commonHeaders(type), "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  if (range) {
    response.writeHead(206, {
      ...commonHeaders(type),
      "Accept-Ranges": "bytes",
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    ...commonHeaders(type),
    "Accept-Ranges": "bytes",
    "Content-Length": String(stat.size),
  });
  if (request.method === "HEAD") response.end(); else fs.createReadStream(filePath).pipe(response);
}

function broadcastReload(preview: ActivePreview): void {
  preview.revision += 1;
  const packet = `event: reload\ndata: ${preview.revision}\n\n`;
  for (const client of preview.clients) {
    try { client.write(packet); } catch { preview.clients.delete(client); }
  }
}

function watchFiles(preview: ActivePreview): fs.FSWatcher | null {
  const changed = () => {
    if (preview.reloadTimer) clearTimeout(preview.reloadTimer);
    preview.reloadTimer = setTimeout(() => {
      preview.reloadTimer = null;
      broadcastReload(preview);
    }, 160);
  };
  try {
    return fs.watch(preview.rootPath, { recursive: true }, changed);
  } catch {
    try { return fs.watch(preview.contentRoot, changed); } catch { return null; }
  }
}

async function handleRequest(preview: ActivePreview, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!loopbackAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { ok: false, error: "loopback-required" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  const url = new URL(request.url ?? "/", preview.url);
  if (url.pathname === "/__agentlas/live") {
    sendJson(response, 200, { ok: true, appId: preview.appId, revision: preview.revision });
    return;
  }
  if (url.pathname === "/__agentlas/live.js") {
    const body = Buffer.from(LIVE_CLIENT);
    response.writeHead(200, { ...commonHeaders("text/javascript; charset=utf-8"), "Content-Length": String(body.length) });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  if (url.pathname === "/__agentlas/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: connected\ndata: ${preview.revision}\n\n`);
    preview.clients.add(response);
    request.once("close", () => preview.clients.delete(response));
    return;
  }
  const filePath = await resolveFile(preview, url.pathname);
  if (!filePath) {
    sendJson(response, 404, { ok: false, error: "not-found" });
    return;
  }
  await serveFile(request, response, filePath);
}

/**
 * PRD §4.28 — 시작은 비동기라, 존재 검사와 등록 사이에 **같은 앱에 대한 두 번째 시작**이
 * 끼어들 수 있었다(실행 시작/종료마다 렌더러 효과가 다시 걸린다). 그러면 나중 것이 지도를
 * 덮어쓰고, 먼저 만든 서버·15초 타이머·파일 감시는 닫히지 않은 채 참조를 잃는다.
 * 진행 중 시작을 앱마다 하나로 묶는다.
 */
const startingPreviews = new Map<string, Promise<AppFactoryLivePreviewResult>>();

async function startManagedPreview(record: AppFactoryAppRecord): Promise<AppFactoryLivePreviewResult> {
  const inFlight = startingPreviews.get(record.id);
  if (inFlight) return inFlight;
  const started = startManagedPreviewOnce(record).finally(() => {
    startingPreviews.delete(record.id);
  });
  startingPreviews.set(record.id, started);
  return started;
}

async function startManagedPreviewOnce(record: AppFactoryAppRecord): Promise<AppFactoryLivePreviewResult> {
  const existing = activePreviews.get(record.id);
  if (existing) {
    return {
      ok: true,
      appId: record.id,
      url: existing.url,
      runtime: "managed-loopback",
      revision: existing.revision,
    };
  }

  const roots = await contentRoot(record);
  let preview: ActivePreview;
  const server = http.createServer((request, response) => {
    void handleRequest(preview, request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "preview-read-failed" });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback preview port.");
  }
  preview = {
    appId: record.id,
    ...roots,
    server,
    url: `http://127.0.0.1:${address.port}/`,
    revision: 1,
    watcher: null,
    reloadTimer: null,
    heartbeat: setInterval(() => undefined, 60_000),
    clients: new Set(),
  };
  clearInterval(preview.heartbeat);
  preview.heartbeat = setInterval(() => {
    for (const client of preview.clients) {
      try { client.write(": heartbeat\n\n"); } catch { preview.clients.delete(client); }
    }
  }, 15_000);
  // 준비하는 사이에 앱이 보관됐을 수 있다. 그 경우 방금 연 서버를 그대로 닫는다 —
  // 폐기된 앱의 서버가 남는 것이 §4.28 의 다른 절반이다.
  const current = getAgentApp(record.id);
  if (!current || current.status === "archived") {
    clearInterval(preview.heartbeat);
    server.close();
    return { ok: false, appId: record.id, runtime: "unavailable", reason: "The app was archived while its preview was starting." };
  }
  preview.watcher = watchFiles(preview);
  activePreviews.set(record.id, preview);
  server.once("close", () => {
    if (activePreviews.get(record.id) === preview) activePreviews.delete(record.id);
  });
  return {
    ok: true,
    appId: record.id,
    url: preview.url,
    runtime: "managed-loopback",
    revision: preview.revision,
  };
}

export async function startAppFactoryLivePreview(appId: string): Promise<AppFactoryLivePreviewResult> {
  const id = String(appId ?? "").trim();
  const record = id ? getAgentApp(id) : null;
  if (!record) return { ok: false, appId: id, runtime: "unavailable", reason: "Registered app not found." };
  if (record.status === "archived") {
    return { ok: false, appId: id, runtime: "unavailable", reason: "This generated app is archived." };
  }
  if (isCloudAppRoot(record.rootPath)) return externalPreview(record);
  try {
    return await startManagedPreview(record);
  } catch (error) {
    return {
      ok: false,
      appId: id,
      runtime: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopAppFactoryLivePreview(appId: string): Promise<{ ok: true; stopped: boolean }> {
  const preview = activePreviews.get(String(appId ?? "").trim());
  if (!preview) return { ok: true, stopped: false };
  activePreviews.delete(preview.appId);
  if (preview.reloadTimer) clearTimeout(preview.reloadTimer);
  clearInterval(preview.heartbeat);
  try { preview.watcher?.close(); } catch {}
  for (const client of preview.clients) {
    try { client.end(); } catch {}
  }
  preview.clients.clear();
  await new Promise<void>((resolve) => preview.server.close(() => resolve()));
  return { ok: true, stopped: true };
}

export function disposeAppFactoryLivePreviews(): void {
  for (const preview of activePreviews.values()) {
    if (preview.reloadTimer) clearTimeout(preview.reloadTimer);
    clearInterval(preview.heartbeat);
    try { preview.watcher?.close(); } catch {}
    for (const client of preview.clients) {
      try { client.end(); } catch {}
    }
    try { preview.server.close(); } catch {}
  }
  activePreviews.clear();
}
