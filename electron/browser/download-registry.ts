import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { session, shell, type DownloadItem } from "electron";
import { userDataPath } from "../runtime-paths";
import type { BrowserDownloadState, BrowserDownloadSummary } from "../../shared/browser-ui";
import { browserDownloadPathIsOwned, normalizeBrowserDownloadFileName } from "./download-paths";

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
  nativeSession.on("will-download", (event, item, webContents) => {
    const owner = resolveOwner(webContents.id);
    if (!owner) {
      event.preventDefault();
      return;
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
    };
    records.set(id, record);
    activeItems.set(id, item);
    persist();
    item.on("updated", (_downloadEvent, state) => {
      const current = records.get(id);
      if (!current) return;
      current.state = state === "interrupted" ? "interrupted" : "progressing";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      current.updatedAt = new Date().toISOString();
      persist();
    });
    item.once("done", (_downloadEvent, state) => {
      activeItems.delete(id);
      const current = records.get(id);
      if (!current) return;
      current.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      const savePath = item.getSavePath();
      current.savePath = browserDownloadPathIsOwned(downloadsRoot(), id, savePath) ? savePath : null;
      current.updatedAt = new Date().toISOString();
      persist();
    });
  });
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
