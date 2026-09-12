import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { userDataPath } from "../runtime-paths";
import type { BrowserDurableHistoryEntry } from "../../shared/browser-ui";

const HISTORY_SCHEMA_VERSION = "agentlas.browser-history.v1" as const;
const MAX_RECORDS = 2_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

interface HistoryRecord extends BrowserDurableHistoryEntry {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  taskScopeId: string;
  viewId: string;
}

interface HistoryStateFile {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  records: HistoryRecord[];
}

const records = new Map<string, HistoryRecord>();
const installed = new Set<number>();
let loaded = false;
let unavailable = false;

function statePath(): string {
  return userDataPath("browser", "history-v1.json");
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
}

const SECRET_PARAMETER_KEY = /^(?:access_token|auth_token|authorization|credential|id_token|oauth_code|password|passwd|refresh_token|secret|session_token|token)$/iu;

function safeParameters(input: string): { value: string; redacted: boolean } {
  const output = new URLSearchParams();
  let redacted = false;
  for (const [key, value] of new URLSearchParams(input)) {
    if (SECRET_PARAMETER_KEY.test(key)) redacted = true;
    else output.append(key, value);
  }
  return { value: output.toString(), redacted };
}

export function sanitizeBrowserHistoryUrl(value: string): { url: string; redactedQuery: boolean } | null {
  try {
    const parsed = new URL(value);
    const local = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !local) return null;
    let redactedQuery = Boolean(parsed.username || parsed.password);
    parsed.username = "";
    parsed.password = "";
    const query = safeParameters(parsed.search);
    parsed.search = query.value;
    redactedQuery ||= query.redacted;
    if (parsed.hash.startsWith("#/") || parsed.hash.startsWith("#!/")) {
      const marker = parsed.hash.startsWith("#!/") ? "#!/" : "#/";
      const route = parsed.hash.slice(marker.length);
      const split = route.indexOf("?");
      if (split >= 0) {
        const params = safeParameters(route.slice(split + 1));
        parsed.hash = `${marker}${route.slice(0, split)}${params.value ? `?${params.value}` : ""}`;
        redactedQuery ||= params.redacted;
      }
    } else {
      parsed.hash = "";
    }
    return { url: parsed.toString(), redactedQuery };
  } catch { return null; }
}

function validRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<HistoryRecord>;
  return row.schemaVersion === HISTORY_SCHEMA_VERSION
    && typeof row.id === "string" && /^history_[a-f0-9]{32}$/u.test(row.id)
    && typeof row.taskScopeId === "string" && /^[A-Za-z0-9_:.-]{8,200}$/u.test(row.taskScopeId)
    && typeof row.viewId === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(row.viewId)
    && sanitizeBrowserHistoryUrl(String(row.url ?? ""))?.url === row.url
    && typeof row.title === "string" && row.title.length <= 512
    && typeof row.redactedQuery === "boolean"
    && Number.isSafeInteger(row.visitCount) && Number(row.visitCount) > 0
    && typeof row.lastVisitedAt === "string" && Number.isFinite(Date.parse(row.lastVisitedAt));
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const bytes = fs.readFileSync(statePath());
    if (bytes.byteLength > MAX_STATE_BYTES) { unavailable = true; return; }
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<HistoryStateFile>;
    if (parsed.schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.records)
      || parsed.records.length > MAX_RECORDS || !parsed.records.every(validRecord)) {
      unavailable = true;
      return;
    }
    for (const record of parsed.records) records.set(record.id, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unavailable = true;
  }
}

function persist(): void {
  if (unavailable) return;
  const file = statePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = [...records.values()].sort((a, b) => a.lastVisitedAt.localeCompare(b.lastVisitedAt)).slice(-MAX_RECORDS);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, records: all } satisfies HistoryStateFile)}\n`, "utf8");
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("browser_history_state_too_large");
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
  if (records.size > all.length) {
    records.clear();
    for (const record of all) records.set(record.id, record);
  }
}

function recordId(taskScopeId: string, url: string): string {
  return `history_${createHash("sha256").update(`${taskScopeId}\0${url}`).digest("hex").slice(0, 32)}`;
}

function recordVisit(taskScopeId: string, viewId: string, contents: WebContents, increment: boolean): void {
  load();
  if (unavailable || contents.isDestroyed()) return;
  const safe = sanitizeBrowserHistoryUrl(contents.getURL());
  if (!safe) return;
  const id = recordId(taskScopeId, safe.url);
  const prior = records.get(id);
  const now = new Date().toISOString();
  records.set(id, {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id,
    taskScopeId,
    viewId,
    url: safe.url,
    title: clean(contents.getTitle(), 512),
    lastVisitedAt: now,
    visitCount: Math.min(Number.MAX_SAFE_INTEGER, (prior?.visitCount ?? 0) + (increment || !prior ? 1 : 0)),
    redactedQuery: Boolean(prior?.redactedQuery || safe.redactedQuery),
  });
  persist();
}

export function ensureBrowserHistoryForGuest(taskScopeId: string, viewId: string, contents: WebContents): void {
  load();
  if (installed.has(contents.id)) return;
  installed.add(contents.id);
  contents.on("did-finish-load", () => recordVisit(taskScopeId, viewId, contents, true));
  contents.on("did-navigate-in-page", () => recordVisit(taskScopeId, viewId, contents, true));
  contents.once("destroyed", () => installed.delete(contents.id));
}

export function listBrowserHistory(taskScopeId: string, query = "", limit = 100): BrowserDurableHistoryEntry[] | null {
  load();
  if (unavailable) return null;
  const needle = clean(query, 256).toLocaleLowerCase();
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  return [...records.values()]
    .filter((record) => record.taskScopeId === taskScopeId
      && (!needle || `${record.title}\n${record.url}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => b.lastVisitedAt.localeCompare(a.lastVisitedAt))
    .slice(0, bounded)
    .map(({ id, url, title, lastVisitedAt, visitCount, redactedQuery }) => ({ id, url, title, lastVisitedAt, visitCount, redactedQuery }));
}

export interface ImportedBrowserHistoryEntry {
  url: string;
  title: string;
  lastVisitedAt: string;
  visitCount: number;
  redactedQuery: boolean;
}

/**
 * Adds an explicit browser-profile selection to the same task-scoped history
 * authority as native tab visits. Re-importing the same source is idempotent:
 * it keeps the newest timestamp and largest source visit count.
 */
export function importBrowserHistory(
  taskScopeId: string,
  sourceProfileId: string,
  entries: ImportedBrowserHistoryEntry[],
): { ok: true; imported: number } | { ok: false; reason: "invalid-request" | "history-unavailable" } {
  load();
  if (unavailable) return { ok: false, reason: "history-unavailable" };
  if (!/^[A-Za-z0-9_:.-]{8,200}$/u.test(taskScopeId)
    || !sourceProfileId || entries.length > 500) return { ok: false, reason: "invalid-request" };

  const sourceViewId = `imported_${createHash("sha256").update(sourceProfileId).digest("hex").slice(0, 24)}`;
  const prior = new Map<string, HistoryRecord | undefined>();
  const changedIds = new Set<string>();
  for (const entry of entries) {
    const safe = sanitizeBrowserHistoryUrl(entry.url);
    const visitedAt = new Date(entry.lastVisitedAt);
    if (!safe || safe.url !== entry.url || safe.redactedQuery !== entry.redactedQuery
      || !Number.isFinite(visitedAt.valueOf())
      || !Number.isSafeInteger(entry.visitCount) || entry.visitCount < 1) {
      for (const [id, row] of prior) row ? records.set(id, row) : records.delete(id);
      return { ok: false, reason: "invalid-request" };
    }
    const id = recordId(taskScopeId, safe.url);
    if (!prior.has(id)) prior.set(id, records.get(id));
    const existing = records.get(id);
    const next: HistoryRecord = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id,
      taskScopeId,
      viewId: existing?.viewId ?? sourceViewId,
      url: safe.url,
      title: clean(entry.title, 512) || existing?.title || safe.url,
      lastVisitedAt: existing && existing.lastVisitedAt > entry.lastVisitedAt
        ? existing.lastVisitedAt : entry.lastVisitedAt,
      visitCount: Math.max(existing?.visitCount ?? 0, entry.visitCount),
      redactedQuery: Boolean(existing?.redactedQuery || entry.redactedQuery),
    };
    if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
      records.set(id, next);
      changedIds.add(id);
    }
  }
  if (changedIds.size > 0) {
    try { persist(); }
    catch {
      for (const [id, row] of prior) row ? records.set(id, row) : records.delete(id);
      return { ok: false, reason: "history-unavailable" };
    }
  }
  return { ok: true, imported: [...changedIds].filter((id) => records.has(id)).length };
}

export function clearBrowserHistory(taskScopeId: string): number | null {
  load();
  if (unavailable) return null;
  let removed = 0;
  for (const [id, record] of records) {
    if (record.taskScopeId !== taskScopeId) continue;
    records.delete(id);
    removed += 1;
  }
  if (removed) persist();
  return removed;
}
