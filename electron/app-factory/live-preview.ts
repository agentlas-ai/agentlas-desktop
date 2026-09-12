// Main-owned live preview runtime for registered generated apps.
//
// A scaffold path is not a running app. This module serves the registered app's
// generated UI on an ephemeral loopback port. File changes compile immutable
// candidates; only build and native first-render evidence advances the ready revision. It never evaluates the generated server script
// in Electron and never inherits Desktop credentials into generated code.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AppFactoryAppRecord, AppFactoryLivePreviewResult } from "../../shared/types";
import { getAgentApp, isCloudAppRoot } from "../store/agent-apps";
import type { ArtifactReadyRevision } from "../../shared/artifact-build";
import { readAppArtifactSource, buildAppArtifact, loadReadyArtifact, publishReadyArtifact, recordArtifactBuildFailure, type ArtifactBundle } from "./artifact-build";
import { observeArtifactRender, ARTIFACT_PREVIEW_CSP } from "./artifact-render";
import { readArtifactPresentation, writeArtifactPresentation } from "../store/artifact-presentation";
import { artifactPresentationClient } from "./presentation-client";

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
  record: AppFactoryAppRecord;
  bundle: ArtifactBundle;
  ready: ArtifactReadyRevision;
  updateFailure?: string;
  controller: AbortController;
  refresh: Promise<void> | null;
  refreshAgain: boolean;
  lastFailureKey?: string;
  presentationToken: string;
  issuedBundles: Set<string>;
};

const activePreviews = new Map<string, ActivePreview>();
const previewEpochs = new Map<string, number>();
const previewViewLeases = new Map<string, Map<string, number>>();
const previewReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearPreviewRelease(appId: string): void {
  const timer = previewReleaseTimers.get(appId);
  if (timer) clearTimeout(timer);
  previewReleaseTimers.delete(appId);
}

/** Leases are presentation ownership only; they never dispatch app actions. */
export async function acquireAppFactoryPreviewView(appId: string, leaseId: string, ownerId: number): Promise<AppFactoryLivePreviewResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(leaseId) || !Number.isSafeInteger(ownerId)) throw new Error("invalid_preview_view_lease");
  const id = String(appId ?? "").trim();
  let leases = previewViewLeases.get(id);
  if (!leases) { leases = new Map(); previewViewLeases.set(id, leases); }
  if (leases.has(leaseId) && leases.get(leaseId) !== ownerId) throw new Error("preview_view_lease_owner_mismatch");
  if (!leases.has(leaseId) && leases.size >= 64) throw new Error("preview_view_lease_limit");
  leases.set(leaseId, ownerId);
  clearPreviewRelease(id);
  const result = await startAppFactoryLivePreview(id);
  if (!result.ok) releaseAppFactoryPreviewView(id, leaseId, ownerId);
  return result;
}

export function releaseAppFactoryPreviewView(appId: string, leaseId: string, ownerId: number): { ok: boolean } {
  const leases = previewViewLeases.get(appId);
  if (!leases?.has(leaseId)) return { ok: true };
  if (leases.get(leaseId) !== ownerId) return { ok: false };
  leases.delete(leaseId);
  if (leases.size === 0) {
    clearPreviewRelease(appId);
    const timer = setTimeout(() => {
      previewReleaseTimers.delete(appId);
      if (previewViewLeases.get(appId)?.size === 0) void stopAppFactoryLivePreview(appId);
    }, 3_500);
    timer.unref?.();
    previewReleaseTimers.set(appId, timer);
  }
  return { ok: true };
}

export function releaseAppFactoryPreviewViewsForOwner(ownerId: number): void {
  for (const [appId, leases] of previewViewLeases) {
    for (const [leaseId, owner] of leases) if (owner === ownerId) releaseAppFactoryPreviewView(appId, leaseId, ownerId);
  }
}

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


const PREVIEW_CSP = ARTIFACT_PREVIEW_CSP;

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

function resolveFile(preview: ActivePreview, pathname: string): {path: string; bytes: Buffer} | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.split("/").some(part => part === "..")) return null;
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const files = preview.bundle.snapshot.files;
  return files.find(file => file.path === relative)
    ?? (!path.extname(relative) ? files.find(file => file.path === `${relative}/index.html` || file.path === "index.html") ?? null : null);
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

function serveFile(request: IncomingMessage, response: ServerResponse, file: {path:string;bytes:Buffer}): void {
  const extension = path.extname(file.path).toLowerCase();
  const type = MIME_TYPES[extension] ?? "application/octet-stream";
  let bytes = file.bytes;
  if (extension === ".html") {
    const source = bytes.toString("utf8"), tag = '<script src="/__agentlas/live.js" defer></script>';
    bytes = Buffer.from(source.includes("/__agentlas/live.js") ? source : source.includes("</body>") ? source.replace("</body>",`${tag}</body>`) : `${source}${tag}`);
  }
  const range = byteRange(request.headers.range, bytes.length);
  if (request.headers.range && !range) {
    response.writeHead(416,{...commonHeaders(type),"Content-Range":`bytes */${bytes.length}`}).end(); return;
  }
  response.writeHead(range ? 206 : 200, {...commonHeaders(type),"Accept-Ranges":"bytes",
    "Content-Length":String(range ? range.end-range.start+1 : bytes.length),
    ...(range ? {"Content-Range":`bytes ${range.start}-${range.end}/${bytes.length}`} : {})});
  response.end(request.method === "HEAD" ? undefined : range ? bytes.subarray(range.start,range.end+1) : bytes);
}

function broadcastReload(preview: ActivePreview): void {
  preview.revision += 1;
  const packet = `event: reload\ndata: ${JSON.stringify({revision:preview.revision,bundleDigest:preview.ready.build.bundleDigest})}\n\n`;
  for (const client of preview.clients) {
    try { client.write(packet); } catch { preview.clients.delete(client); }
  }
}

async function prepareReadyArtifact(record: AppFactoryAppRecord, signal: AbortSignal): Promise<{bundle:ArtifactBundle;ready:ArtifactReadyRevision;updateFailure?:string}> {
  const prior = await loadReadyArtifact(record, signal);
  let sourceDigest: string | null = null;
  try {
    const input = await readAppArtifactSource(record, signal);
    if(prior && prior.build.sourceIdentityDigest !== input.identityDigest) throw new Error("artifact_source_identity_changed");
    sourceDigest = input.snapshot.digest;
    if (prior && prior.build.sourceDigest === sourceDigest) return {bundle:prior,ready:prior.ready};
    const bundle = await buildAppArtifact(record,input,signal);
    const render = await observeArtifactRender(bundle,signal);
    if ((await readAppArtifactSource(record,signal)).snapshot.digest !== sourceDigest) throw new Error("artifact_source_changed_before_publish");
    signal.throwIfAborted();
    return {bundle,ready:publishReadyArtifact(record,bundle,render)};
  } catch(error) {
    if(signal.aborted) throw error;
    const reason=error instanceof Error ? error.message : String(error);
    recordArtifactBuildFailure(record,sourceDigest,reason);
    if(prior) return {bundle:prior,ready:prior.ready,updateFailure:reason};
    throw error;
  }
}

function refreshManagedPreview(preview: ActivePreview): Promise<void> {
  preview.refreshAgain=true;
  if(preview.refresh) return preview.refresh;
  preview.refresh=(async()=>{
    while(preview.refreshAgain && !preview.controller.signal.aborted) {
      preview.refreshAgain=false;
      let digest:string|null=null;
      try {
        const input=await readAppArtifactSource(preview.record,preview.controller.signal);
        if(preview.ready.build.sourceIdentityDigest !== input.identityDigest) throw new Error("artifact_source_identity_changed");
        digest=input.snapshot.digest;
        if(digest===preview.ready.build.sourceDigest) {preview.updateFailure=undefined;continue;}
        if(digest===preview.lastFailureKey) continue;
        const bundle=await buildAppArtifact(preview.record,input,preview.controller.signal);
        const render=await observeArtifactRender(bundle,preview.controller.signal);
        if((await readAppArtifactSource(preview.record,preview.controller.signal)).snapshot.digest!==digest) {
          preview.refreshAgain=true;continue;
        }
        if(activePreviews.get(preview.appId)!==preview || preview.controller.signal.aborted) return;
        const ready=publishReadyArtifact(preview.record,bundle,render);
        preview.bundle=bundle;preview.ready=ready;preview.contentRoot=bundle.snapshot.root;
        preview.updateFailure=undefined;preview.lastFailureKey=undefined;
        broadcastReload(preview);
      } catch(error) {
        if(preview.controller.signal.aborted) return;
        const reason=error instanceof Error?error.message:String(error);
        preview.updateFailure=reason;
        const failureKey=digest??reason;
        if(preview.lastFailureKey!==failureKey) {
          preview.lastFailureKey=failureKey;
          try{recordArtifactBuildFailure(preview.record,digest,reason);}catch{}
          for(const client of preview.clients) {try{client.write(`event: build-failed\ndata: ${JSON.stringify({reason,sourceDigest:digest})}\n\n`);}catch{preview.clients.delete(client);}}
        }
      }
    }
  })().finally(()=>{preview.refresh=null;});
  return preview.refresh;
}

function watchFiles(preview: ActivePreview): fs.FSWatcher | null {
  const changed = () => {
    if (preview.reloadTimer) clearTimeout(preview.reloadTimer);
    preview.reloadTimer = setTimeout(() => {
      preview.reloadTimer = null;
      void refreshManagedPreview(preview);
    }, 160);
  };
  try {
    return fs.watch(preview.rootPath, { recursive: true }, changed);
  } catch {
    try { return fs.watch(preview.contentRoot, changed); } catch { return null; }
  }
}

async function handleRequest(preview: ActivePreview, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!loopbackAddress(request.socket.remoteAddress) || request.headers.host !== new URL(preview.url).host) {
    sendJson(response, 403, { ok: false, error: "loopback-required" });
    return;
  }
  const url = new URL(request.url ?? "/", preview.url);
  if (url.pathname === "/__agentlas/presentation") {
    const target = { appId: preview.appId, sourceIdentityDigest: preview.ready.build.sourceIdentityDigest };
    if (request.method === "GET" && request.headers["x-agentlas-presentation"] === preview.presentationToken) {
      sendJson(response, 200, { receipt: readArtifactPresentation(target) });
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== new URL(preview.url).origin
      || !String(request.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(response, 403, { error: "artifact_presentation_origin_refused" }); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 270_336) { sendJson(response, 413, { error: "artifact_presentation_too_large" }); return; }
      chunks.push(bytes);
    }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || input.token !== preview.presentationToken || !preview.issuedBundles.has(input.bundleDigest)) {
        sendJson(response, 403, { error: "artifact_presentation_capability_refused" }); return;
      }
      const result = writeArtifactPresentation(target, {
        originBundleDigest: input.bundleDigest, expectedRevision: input.expectedRevision, requestId: input.requestId, state: input.state,
      });
      sendJson(response, result.status === "conflict" ? 409 : 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "artifact_presentation_invalid" });
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (url.pathname === "/__agentlas/live") {
    sendJson(response, 200, { ok: true, appId: preview.appId, revision: preview.revision, readyRevision: preview.ready, updateFailure: preview.updateFailure });
    return;
  }
  if (url.pathname === "/__agentlas/live.js") {
    const bundleDigest = preview.ready.build.bundleDigest;
    preview.issuedBundles.add(bundleDigest);
    if (preview.issuedBundles.size > 32) preview.issuedBundles.delete(preview.issuedBundles.values().next().value!);
    const body = Buffer.from(artifactPresentationClient({ token: preview.presentationToken, bundleDigest }));
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
  const filePath = resolveFile(preview, url.pathname);
  if (!filePath) {
    sendJson(response, 404, { ok: false, error: "not-found" });
    return;
  }
  serveFile(request, response, filePath);
}

/**
 * PRD §4.28 — 시작은 비동기라, 존재 검사와 등록 사이에 **같은 앱에 대한 두 번째 시작**이
 * 끼어들 수 있었다(실행 시작/종료마다 렌더러 효과가 다시 걸린다). 그러면 나중 것이 지도를
 * 덮어쓰고, 먼저 만든 서버·15초 타이머·파일 감시는 닫히지 않은 채 참조를 잃는다.
 * 진행 중 시작을 앱마다 하나로 묶는다.
 */
const startingPreviews = new Map<string, Promise<AppFactoryLivePreviewResult>>();
const startingControllers = new Map<string, AbortController>();

async function startManagedPreview(record: AppFactoryAppRecord): Promise<AppFactoryLivePreviewResult> {
  const inFlight = startingPreviews.get(record.id);
  if (inFlight) return inFlight;
  const started = startManagedPreviewOnce(record).finally(() => {
    startingPreviews.delete(record.id);
    startingControllers.delete(record.id);
  });
  startingPreviews.set(record.id, started);
  return started;
}

async function startManagedPreviewOnce(record: AppFactoryAppRecord): Promise<AppFactoryLivePreviewResult> {
  const requestedEpoch = previewEpochs.get(record.id) ?? 0;
  const existing = activePreviews.get(record.id);
  if (existing) {
    return {
      ok: true,
      appId: record.id,
      url: existing.url,
      runtime: "managed-loopback",
      revision: existing.revision,
      readyRevision: existing.ready,
      updateFailure: existing.updateFailure,
    };
  }

  const controller = new AbortController();
  startingControllers.set(record.id, controller);
  const signal = controller.signal;
  const prepared = await prepareReadyArtifact(record, signal);
  if ((previewEpochs.get(record.id) ?? 0) !== requestedEpoch) throw new Error("artifact_preview_stopped");
  const roots = {rootPath:record.rootPath, contentRoot:prepared.bundle.snapshot.root};
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
    record, bundle: prepared.bundle, ready: prepared.ready, updateFailure: prepared.updateFailure,
    controller, refresh:null, refreshAgain:false,
    presentationToken: randomBytes(32).toString("hex"), issuedBundles: new Set(),
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
  if (!current || current.status === "archived" || (previewEpochs.get(record.id) ?? 0) !== requestedEpoch) {
    clearInterval(preview.heartbeat);
    server.close();
    return { ok: false, appId: record.id, runtime: "unavailable", reason: "The app preview was stopped or archived while starting." };
  }
  preview.watcher = watchFiles(preview);
  activePreviews.set(record.id, preview);
  void refreshManagedPreview(preview);
  server.once("close", () => {
    if (activePreviews.get(record.id) === preview) activePreviews.delete(record.id);
  });
  return {
    ok: true,
    appId: record.id,
    url: preview.url,
    runtime: "managed-loopback",
    revision: preview.revision,
    readyRevision: preview.ready,
    updateFailure: preview.updateFailure,
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
  const id = String(appId ?? "").trim();
  previewEpochs.set(id, (previewEpochs.get(id) ?? 0) + 1);
  startingControllers.get(id)?.abort();
  previewViewLeases.delete(id);
  clearPreviewRelease(id);
  const preview = activePreviews.get(id);
  if (!preview) return { ok: true, stopped: false };
  activePreviews.delete(preview.appId);
  preview.controller.abort();
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
  for (const id of new Set([...startingPreviews.keys(), ...activePreviews.keys()])) {
    previewEpochs.set(id, (previewEpochs.get(id) ?? 0) + 1);
  }
  for (const controller of startingControllers.values()) controller.abort();
  for (const timer of previewReleaseTimers.values()) clearTimeout(timer);
  previewReleaseTimers.clear();
  previewViewLeases.clear();
  for (const preview of activePreviews.values()) {
    preview.controller.abort();
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
