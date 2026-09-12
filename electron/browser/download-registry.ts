import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { session, shell, type DownloadItem } from "electron";
import { userDataPath } from "../runtime-paths";
import type { BrowserDownloadState, BrowserDownloadSummary } from "../../shared/browser-ui";
import { browserDownloadPathIsOwned, normalizeBrowserDownloadFileName } from "./download-paths";
import { observeWorkspaceFile, FILE_OBSERVATION_MAX_BYTES } from "../../shared/file-observation";

const NATIVE_BROWSER_PARTITION = "persist:agentlas-browser-default";
const DOWNLOAD_SCHEMA_VERSION = "agentlas.browser-downloads.v1" as const;
const MAX_RECORDS = 1_000;
const MAX_STATE_BYTES = 1024 * 1024;

interface DownloadOwner {
  ownerId: number;
  taskScopeId: string;
  viewId: string;
}

interface DownloadRecord extends BrowserDownloadSummary, DownloadOwner {
  schemaVersion: typeof DOWNLOAD_SCHEMA_VERSION;
  savePath: string | null;
  agentSource?: AgentDownloadIdentity;
  observedSha256?: string;
}

export interface AgentDownloadIdentity {
  invocationRunId: string; chatId: string; goalId: string; goalRevision: number;
  attemptId: string; toolId: string; requestUrlDigest: string;
}
export interface AgentDownloadResult {
  id: string; fileName: string; savePath: string; receivedBytes: number; sha256: string;
  sourceOrigin: string | null; identity: AgentDownloadIdentity;
}
interface AgentTicket {
  owner: DownloadOwner; identity: AgentDownloadIdentity; url: string; current: () => boolean;
  acceptUrls: (urls: string[]) => boolean;
  finish: (result: AgentDownloadResult | null, reason?: string) => void;
  downloadId?: string; cancelled?: boolean;
}
const agentTickets = new Map<number, AgentTicket>();
const urlDigest = (url: string) => createHash("sha256").update(url).digest("hex");

/** Main-only registration for a private guest with no page/renderer input. A
 * task's ordinary guest never receives a ticket merely because a run is active. */
export function registerAgentDownloadTicket(webContentsId: number, ticket: AgentTicket): () => void {
  if (agentTickets.size >= 4) throw new Error("browser_download_busy");
  if (agentTickets.has(webContentsId) || ticket.identity.requestUrlDigest !== urlDigest(ticket.url)) throw new Error("browser_download_ticket_conflict");
  agentTickets.set(webContentsId, ticket);
  return () => {
    if (agentTickets.get(webContentsId) !== ticket) return;
    ticket.cancelled = true;
    agentTickets.delete(webContentsId);
    if (ticket.downloadId) {
      const item = activeItems.get(ticket.downloadId), record = records.get(ticket.downloadId);
      if (item && record) { record.state = "cancelled"; record.updatedAt = new Date().toISOString(); item.cancel(); persist(); }
    }
  };
}

interface DownloadStateFile {
  schemaVersion: typeof DOWNLOAD_SCHEMA_VERSION;
  records: DownloadRecord[];
}

const records = new Map<string, DownloadRecord>();
const activeItems = new Map<string, DownloadItem>();
let loaded = false;
let installed = false;

function statePath(): string {
  return userDataPath("browser", "downloads-v1.json");
}

function downloadsRoot(): string {
  return userDataPath("browser", "downloads");
}

function validRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DownloadRecord>;
  return row.schemaVersion === DOWNLOAD_SCHEMA_VERSION
    && typeof row.id === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(row.id)
    && typeof row.ownerId === "number" && Number.isSafeInteger(row.ownerId) && row.ownerId > 0
    && typeof row.taskScopeId === "string" && /^[A-Za-z0-9_:.-]{8,200}$/u.test(row.taskScopeId)
    && typeof row.viewId === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(row.viewId)
    && typeof row.fileName === "string" && row.fileName.length > 0 && row.fileName.length <= 512
    && ["progressing", "completed", "cancelled", "interrupted"].includes(String(row.state))
    && Number.isSafeInteger(row.receivedBytes) && Number(row.receivedBytes) >= 0
    && (row.totalBytes === null || (Number.isSafeInteger(row.totalBytes) && Number(row.totalBytes) >= 0))
    && typeof row.startedAt === "string" && typeof row.updatedAt === "string"
    && (row.savePath === null || browserDownloadPathIsOwned(downloadsRoot(), row.id, row.savePath));
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const bytes = fs.readFileSync(statePath());
    if (bytes.byteLength > MAX_STATE_BYTES) return;
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<DownloadStateFile>;
    if (parsed.schemaVersion !== DOWNLOAD_SCHEMA_VERSION || !Array.isArray(parsed.records)) return;
    let changed = false;
    for (const candidate of parsed.records.slice(-MAX_RECORDS)) {
      if (!validRecord(candidate)) continue;
      const record = { ...candidate };
      if (record.state === "progressing") {
        record.state = "interrupted";
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
      records.set(record.id, record);
    }
    if (changed) persist();
  } catch { /* no durable download history yet, or unreadable state remains untouched */ }
}

function persist(): void {
  const file = statePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-MAX_RECORDS);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: DOWNLOAD_SCHEMA_VERSION, records: all } satisfies DownloadStateFile)}\n`, "utf8");
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("browser_download_state_too_large");
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : null;
  } catch { return null; }
}

function publicSummary(record: DownloadRecord): BrowserDownloadSummary {
  return {
    id: record.id,
    fileName: record.fileName,
    sourceOrigin: record.sourceOrigin,
    state: record.state,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
}

export function ensureBrowserDownloadRegistry(resolveOwner: (webContentsId: number) => DownloadOwner | null): void {
  load();
  if (installed) return;
  installed = true;
  const nativeSession = session.fromPartition(NATIVE_BROWSER_PARTITION);
  // This partition's request policy is scoped to Main's private download
  // guests. Check each redirect before transport; a completed URL chain alone
  // would be too late to prevent a request to an unsupported origin.
  nativeSession.webRequest.onBeforeRequest((details, callback) => {
    const ticket = details.webContentsId === undefined ? undefined : agentTickets.get(details.webContentsId);
    if (!ticket) { callback({}); return; }
    let permitted = false;
    try { permitted = !ticket.cancelled && ticket.current() && ticket.acceptUrls([details.url]); } catch { /* No authority. */ }
    callback({cancel: !permitted});
    if (!permitted) ticket.finish(null, "browser_download_origin_refused");
  });
  nativeSession.on("will-download", (event, item, webContents) => {
    // Chromium may deliver a retried/cancelled download after its initiating
    // guest is destroyed. An absent guest has no task authority.
    if (!webContents || webContents.isDestroyed()) { event.preventDefault(); return; }
    const ticket = agentTickets.get(webContents.id);
    const owner = ticket?.owner ?? resolveOwner(webContents.id);
    if (!owner) {
      event.preventDefault();
      return;
    }
    try {
    if (ticket && (ticket.cancelled || ticket.downloadId || !ticket.current()
      || item.getURLChain()[0] !== ticket.url || !ticket.acceptUrls(item.getURLChain()) || item.getTotalBytes() > FILE_OBSERVATION_MAX_BYTES)) {
      event.preventDefault(); ticket.finish(null, "browser_download_admission_refused"); return;
    }
    const now = new Date().toISOString();
    const id = `download_${randomUUID().replace(/-/gu, "")}`;
    const total = item.getTotalBytes();
    const fileName = normalizeBrowserDownloadFileName(item.getFilename());
    const downloadDir = path.join(downloadsRoot(), id);
    fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
    const savePath = path.join(downloadDir, fileName);
    item.setSavePath(savePath);
    const record: DownloadRecord = {
      schemaVersion: DOWNLOAD_SCHEMA_VERSION,
      id,
      ...owner,
      fileName,
      sourceOrigin: safeOrigin(item.getURL()),
      state: "progressing",
      receivedBytes: Math.max(0, item.getReceivedBytes()),
      totalBytes: Number.isSafeInteger(total) && total >= 0 ? total : null,
      savePath,
      startedAt: now,
      updatedAt: now,
      ...(ticket ? {agentSource: {...ticket.identity}} : {}),
    };
    if (ticket) ticket.downloadId = id;
    records.set(id, record);
    activeItems.set(id, item);
    persist();
    item.on("updated", (_downloadEvent, state) => {
      const current = records.get(id);
      if (!current || !activeItems.has(id)) return;
      if (ticket && (ticket.cancelled || !ticket.current() || item.getReceivedBytes() > FILE_OBSERVATION_MAX_BYTES)) {
        ticket.cancelled = true; item.cancel(); return;
      }
      current.state = state === "interrupted" ? "interrupted" : "progressing";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      current.updatedAt = new Date().toISOString();
      try { persist(); } catch {
        if (ticket) { ticket.cancelled = true; item.cancel(); ticket.finish(null,"browser_download_receipt_failed"); }
      }
    });
    item.once("done", (_downloadEvent, state) => {
      activeItems.delete(id);
      const current = records.get(id);
      if (!current) return;
      current.state = ticket?.cancelled ? "cancelled" : state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      const savePath = item.getSavePath();
      current.savePath = browserDownloadPathIsOwned(downloadsRoot(), id, savePath) ? savePath : null;
      current.updatedAt = new Date().toISOString();
      if (ticket) {
        try {
          const observation = current.state === "completed" && ticket.current() && current.savePath
            ? observeWorkspaceFile(downloadsRoot(), path.relative(downloadsRoot(),current.savePath), "write") : null;
          if (observation && observation.bytes === current.receivedBytes
            && (current.totalBytes === null || current.totalBytes === 0 || current.totalBytes === current.receivedBytes)) current.observedSha256 = observation.sha256;
          persist();
          ticket.finish(readAgentBrowserDownload(id,ticket.identity), "browser_download_incomplete");
        } catch { ticket.finish(null, "browser_download_receipt_failed"); }
      } else persist();
    });
    } catch {
      if (ticket) { ticket.cancelled = true; try { item.cancel(); } catch {} ticket.finish(null,"browser_download_receipt_failed"); }
      else { try { event.preventDefault(); } catch {} }
    }
  });
}

/** Private immutable identity lookup; public UI summaries omit all run IDs and
 * paths. File bytes are re-read inside this operation's app-owned directory. */
export function readAgentBrowserDownload(id: string, identity: AgentDownloadIdentity): AgentDownloadResult | null {
  load();
  const record = records.get(id);
  if (!record || record.state !== "completed" || !record.savePath || !record.observedSha256
    || JSON.stringify(record.agentSource) !== JSON.stringify(identity)
    || (record.totalBytes !== null && record.totalBytes !== 0 && record.totalBytes !== record.receivedBytes)
    || record.taskScopeId !== identity.chatId || !browserDownloadPathIsOwned(downloadsRoot(),id,record.savePath)) return null;
  const observed = observeWorkspaceFile(downloadsRoot(),path.relative(downloadsRoot(),record.savePath),"write");
  if (!observed || observed.bytes !== record.receivedBytes || observed.sha256 !== record.observedSha256) return null;
  return {id:record.id,fileName:record.fileName,savePath:record.savePath,receivedBytes:record.receivedBytes,
    sha256:record.observedSha256,sourceOrigin:record.sourceOrigin,identity:{...identity}};
}

export function listBrowserDownloads(ownerId: number, taskScopeId: string, limit = 50): BrowserDownloadSummary[] {
  load();
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  let rebound = false;
  const scoped = [...records.values()].filter((record) => {
    if (record.taskScopeId !== taskScopeId) return false;
    if (record.ownerId !== ownerId) {
      if (activeItems.has(record.id)) return false;
      // BrowserWindow/webContents IDs are process-local. A completed or
      // interrupted record follows its stable task scope after an app restart.
      record.ownerId = ownerId;
      rebound = true;
    }
    return true;
  });
  if (rebound) persist();
  return scoped
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, bounded)
    .map(publicSummary);
}

export async function browserDownloadAction(ownerId: number, taskScopeId: string, id: string,
  action: "cancel" | "open" | "show-in-folder" | "remove",
): Promise<{ ok: boolean; reason?: "download-not-found" | "download-action-unavailable" }> {
  load();
  const record = records.get(id);
  if (!record || record.taskScopeId !== taskScopeId) return { ok: false, reason: "download-not-found" };
  if (record.ownerId !== ownerId) {
    if (activeItems.has(id)) return { ok: false, reason: "download-not-found" };
    record.ownerId = ownerId;
    persist();
  }
  if (action === "cancel") {
    const item = activeItems.get(id);
    if (!item || record.state !== "progressing") return { ok: false, reason: "download-action-unavailable" };
    item.cancel();
    return { ok: true };
  }
  if (action === "remove") {
    activeItems.get(id)?.cancel();
    activeItems.delete(id);
    records.delete(id);
    persist();
    return { ok: true };
  }
  if (record.state !== "completed" || !record.savePath || !fs.existsSync(record.savePath)) {
    return { ok: false, reason: "download-action-unavailable" };
  }
  if (action === "show-in-folder") {
    shell.showItemInFolder(record.savePath);
    return { ok: true };
  }
  return (await shell.openPath(record.savePath)) ? { ok: false, reason: "download-action-unavailable" } : { ok: true };
}

export function clearBrowserDownloadHistory(ownerId: number, taskScopeId: string): number {
  load();
  let removed = 0;
  for (const [id, record] of records) {
    if (record.taskScopeId !== taskScopeId || (record.ownerId !== ownerId && activeItems.has(id))) continue;
    activeItems.get(id)?.cancel();
    activeItems.delete(id);
    records.delete(id);
    removed += 1;
  }
  if (removed) persist();
  return removed;
}
