import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { session, shell, type DownloadItem } from "electron";
import { userDataPath } from "../runtime-paths";
import type { BrowserDownloadState, BrowserDownloadSummary } from "../../shared/browser-ui";
import { browserDownloadPathIsOwned, normalizeBrowserDownloadFileName } from "./download-paths";
import { captureDownloadFile, hashDownloadFile, type DownloadFileIdentity } from "./download-file-hash";

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
  observedFileIdentity?: DownloadFileIdentity;
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
  signal?: AbortSignal;
  progress?: (phase: "transfer" | "hash", bytes: number) => void;
}
const agentTickets = new Map<number, AgentTicket>();

/** Main-only: a page download in a guest, as it starts, progresses and ends (the CDP relay reports it to the agent). */
export type NativeBrowserDownloadEvent = { webContentsId: number; id: string; url: string; fileName: string;
  phase: "start" | "progress" | "done"; state: "inProgress" | "completed" | "canceled"; receivedBytes: number; totalBytes: number; savePath: string | null };
const downloadObservers = new Set<(event: NativeBrowserDownloadEvent) => void>();
export function observeNativeBrowserDownloads(observer: (event: NativeBrowserDownloadEvent) => void): () => void {
  downloadObservers.add(observer);
  return () => { downloadObservers.delete(observer); };
}
function notifyDownload(event: NativeBrowserDownloadEvent): void {
  for (const observer of downloadObservers) { try { observer(event); } catch { /* an observer never breaks the download */ } }
}
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

/*
 * A progress tick schedules one write a second instead of rewriting up to 1,000 records synchronously on Main for
 * every tick (the history-registry sibling was fixed the same way). Start, done, remove and clear still write at
 * once. A scheduled write that fails runs the failure handlers of the downloads that were waiting on it, so a
 * ticketed (agent) download is cancelled with browser_download_receipt_failed exactly as before.
 */
const PERSIST_DEBOUNCE_MS = 1_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const persistFailures = new Map<string, () => void>();

function schedulePersist(id: string, onFailure: () => void): void {
  persistFailures.set(id, onFailure);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { persist(); } catch { /* the waiting downloads' failure handlers ran; the next write retries */ }
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** A record's files live only in downloads/<id>/; once the record is gone nothing can open them. An active item is
 * cancelled by its caller and Chromium removes its partial file. */
function removeDownloadFiles(ids: Iterable<string>): void {
  for (const id of ids) {
    if (activeItems.has(id) || !/^[A-Za-z0-9_-]{8,80}$/u.test(id)) continue;
    void fs.promises.rm(path.join(downloadsRoot(), id), { recursive: true, force: true }).catch(() => {});
  }
}

function persist(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  const failures = [...persistFailures.values()];
  persistFailures.clear();
  try { writeState(); }
  catch (error) { for (const fail of failures) { try { fail(); } catch { /* one handler never blocks another */ } } throw error; }
}

function writeState(): void {
  const file = statePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rows = [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((record) => ({ record, json: JSON.stringify(record) }));
  // Newest records win under both caps (count and bytes, like history-registry); a running download is always kept
  // because its handlers need the record. Without the byte trim the file stopped accepting writes once it neared 1 MiB,
  // which refused every later download until the owner cleared old task histories by hand.
  const budget = MAX_STATE_BYTES - 256;
  const sizeOf = (json: string) => Buffer.byteLength(json, "utf8") + 1;
  let used = 0, count = 0;
  for (const row of rows) if (activeItems.has(row.record.id)) { used += sizeOf(row.json); count += 1; }
  const kept = new Set<DownloadRecord>();
  let full = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const { record, json } = rows[index]!;
    if (activeItems.has(record.id)) { kept.add(record); continue; }
    if (full) continue;
    const size = sizeOf(json);
    if (count >= MAX_RECORDS || used + size > budget) { full = true; continue; }
    used += size; count += 1; kept.add(record);
  }
  const all = rows.filter((row) => kept.has(row.record));
  const bytes = Buffer.from(`{"schemaVersion":${JSON.stringify(DOWNLOAD_SCHEMA_VERSION)},"records":[${all.map((row) => row.json).join(",")}]}\n`, "utf8");
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("browser_download_state_too_large");
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
  // Records trimmed from the file are gone from memory too; their downloaded files go with them.
  const dropped = rows.filter((row) => !kept.has(row.record)).map((row) => row.record.id);
  for (const id of dropped) records.delete(id);
  removeDownloadFiles(dropped);
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
      || item.getURLChain()[0] !== ticket.url || !ticket.acceptUrls(item.getURLChain()))) {
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
    const sourceContentsId = webContents.id;
    const observed = (phase: NativeBrowserDownloadEvent["phase"], state: NativeBrowserDownloadEvent["state"]) => notifyDownload({
      webContentsId: sourceContentsId, id, url: item.getURL(), fileName, phase, state,
      receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: Math.max(0, item.getTotalBytes()), savePath: records.get(id)?.savePath ?? null });
    if (!ticket) {
      observed("start", "inProgress");
      item.on("updated", () => observed("progress", "inProgress"));
      item.once("done", (_doneEvent, state) => setImmediate(() => observed("done", state === "completed" ? "completed" : "canceled")));
    }
    item.on("updated", (_downloadEvent, state) => {
      const current = records.get(id);
      if (!current || !activeItems.has(id)) return;
      if (ticket && (ticket.cancelled || !ticket.current())) {
        ticket.cancelled = true; item.cancel(); return;
      }
      current.state = state === "interrupted" ? "interrupted" : "progressing";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      ticket?.progress?.("transfer",current.receivedBytes);
      current.updatedAt = new Date().toISOString();
      schedulePersist(id, () => {
        if (ticket) { ticket.cancelled = true; item.cancel(); ticket.finish(null,"browser_download_receipt_failed"); }
      });
    });
    item.once("done", (_downloadEvent, state) => {
      // done writes at once and handles its own write failure below.
      persistFailures.delete(id);
      activeItems.delete(id);
      const current = records.get(id);
      if (!current) return;
      current.state = ticket?.cancelled ? "cancelled" : state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      current.receivedBytes = Math.max(0, item.getReceivedBytes());
      const savePath = item.getSavePath();
      current.savePath = browserDownloadPathIsOwned(downloadsRoot(), id, savePath) ? savePath : null;
      current.updatedAt = new Date().toISOString();
      if (ticket) {
        // Capture final filesystem identity before the first asynchronous read.
        // A replacement while hashing cannot become this DownloadItem's proof.
        let captured: ReturnType<typeof captureDownloadFile> | null = null;
        try {
          if (current.state === "completed" && ticket.current() && current.savePath) {
            captured = captureDownloadFile(downloadsRoot(),path.relative(downloadsRoot(),current.savePath));
          }
          persist();
        } catch { ticket.finish(null,"browser_download_receipt_failed"); return; }
        if (!captured || !current.savePath) { ticket.finish(null,"browser_download_incomplete"); return; }
        const savePath = current.savePath;
        void hashDownloadFile(downloadsRoot(),path.relative(downloadsRoot(),savePath),{
          expectedIdentity:captured.identity,signal:ticket.signal,
          current:()=>!ticket.cancelled && ticket.current() && records.get(id) === current && current.state === "completed",
          onProgress:bytes=>ticket.progress?.("hash",bytes),
        }).then(observed=>{
          if (ticket.cancelled || !ticket.current() || records.get(id) !== current || current.state !== "completed"
            || observed.bytes !== current.receivedBytes
            || (current.totalBytes !== null && current.totalBytes !== 0 && current.totalBytes !== current.receivedBytes)) {
            ticket.finish(null,"browser_download_incomplete"); return;
          }
          current.observedSha256 = observed.sha256; current.observedFileIdentity = observed.identity;
          persist();
          ticket.finish({id:current.id,fileName:current.fileName,savePath,receivedBytes:current.receivedBytes,
            sha256:observed.sha256,sourceOrigin:current.sourceOrigin,identity:{...ticket.identity}});
        }).catch(()=>ticket.finish(null,"browser_download_receipt_failed"));
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
export async function readAgentBrowserDownload(id: string, identity: AgentDownloadIdentity, signal?: AbortSignal): Promise<AgentDownloadResult | null> {
  load();
  const record = records.get(id);
  if (!record || record.state !== "completed" || !record.savePath || !record.observedSha256
    || JSON.stringify(record.agentSource) !== JSON.stringify(identity)
    || (record.totalBytes !== null && record.totalBytes !== 0 && record.totalBytes !== record.receivedBytes)
    || record.taskScopeId !== identity.chatId || !browserDownloadPathIsOwned(downloadsRoot(),id,record.savePath)) return null;
  const captured = JSON.stringify([record.agentSource,record.observedSha256,record.observedFileIdentity,record.savePath,record.receivedBytes]);
  for (let attempt=0;attempt<2;attempt++) try {
    if (signal?.aborted) return null;
    const relativePath = path.relative(downloadsRoot(),record.savePath);
    const reading = captureDownloadFile(downloadsRoot(),relativePath).identity, pinned = record.observedFileIdentity;
    // OS download metadata may change ctime after completion without changing
    // bytes. Pin ctime for this whole read, while immutable inode/mtime/size and
    // the complete SHA bind separate reads to the completed download. The pin is
    // persisted with the record and read after restarts, so the device number is
    // not compared: macOS renumbers the volume at every boot, which made every
    // download from before a reboot unreadable to its agent.
    if (pinned && (reading.ino !== pinned.ino || reading.bytes !== pinned.bytes || reading.mtimeNs !== pinned.mtimeNs)) return null;
    const observed = await hashDownloadFile(downloadsRoot(),relativePath,{
      signal,expectedIdentity:reading,
      current:()=>records.get(id) === record && record.state === "completed",
    });
    if (signal?.aborted || records.get(id) !== record || record.state !== "completed"
      || captured !== JSON.stringify([record.agentSource,record.observedSha256,record.observedFileIdentity,record.savePath,record.receivedBytes])
      || observed.bytes !== record.receivedBytes || observed.sha256 !== record.observedSha256) return null;
    return {id:record.id,fileName:record.fileName,savePath:record.savePath,receivedBytes:record.receivedBytes,
      sha256:record.observedSha256,sourceOrigin:record.sourceOrigin,identity:{...identity}};
  } catch (error) {
    // Only a previously persisted Main SHA permits one full re-read. This is
    // never a retry of an unverified initial observation or a partial digest.
    if (signal?.aborted || attempt !== 0 || !(error instanceof Error) || error.message !== "download_file_changed") return null;
  }
  return null;
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
    const wasActive = activeItems.has(id);
    activeItems.get(id)?.cancel();
    activeItems.delete(id);
    persistFailures.delete(id);
    records.delete(id);
    persist();
    if (!wasActive) removeDownloadFiles([id]);
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
  const finished: string[] = [];
  for (const [id, record] of records) {
    if (record.taskScopeId !== taskScopeId || (record.ownerId !== ownerId && activeItems.has(id))) continue;
    if (!activeItems.has(id)) finished.push(id);
    activeItems.get(id)?.cancel();
    activeItems.delete(id);
    persistFailures.delete(id);
    records.delete(id);
    removed += 1;
  }
  if (removed) persist();
  removeDownloadFiles(finished);
  return removed;
}
