import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { userDataPath } from "../runtime-paths";
import type { BrowserDurableHistoryEntry } from "../../shared/browser-ui";

const HISTORY_SCHEMA_VERSION = "agentlas.browser-history.v1" as const;
const MAX_RECORDS = 2_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2_048;
// SPAs fire did-navigate-in-page constantly; one write per window instead of a full sync rewrite per event.
const PERSIST_DEBOUNCE_MS = 1_000;

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
let persistTimer: NodeJS.Timeout | null = null;
let writeGeneration = 0;
let exitFlushInstalled = false;
const warnedPersistCodes = new Set<string>();

function statePath(): string {
  return userDataPath("browser", "history-v1.json");
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
}

// OAuth codes/state, signed-URL signatures (X-Amz-*) and API keys are single-use or secret too.
const SECRET_PARAMETER_KEY = /^(?:access_token|api_key|auth_token|authorization|code|credential|id_token|key|oauth_code|password|passwd|refresh_token|secret|session_token|sig|signature|state|token|x-amz-[a-z0-9-]+)$/iu;

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
  const safe = redactHistoryUrl(value);
  if (!safe || safe.url.length <= MAX_URL_LENGTH) return safe;
  // Over the cap: keep origin and path only. A path that alone exceeds the cap is not recorded.
  const parsed = new URL(safe.url);
  parsed.search = "";
  parsed.hash = "";
  const url = parsed.toString();
  return url.length <= MAX_URL_LENGTH ? { url, redactedQuery: true } : null;
}

function redactHistoryUrl(value: string): { url: string; redactedQuery: boolean } | null {
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
    // Older files were written under a narrower redaction rule; load() re-sanitizes each URL.
    && typeof row.url === "string" && redactHistoryUrl(row.url) !== null
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
    let rewritten = false;
    for (const record of parsed.records) {
      const safe = sanitizeBrowserHistoryUrl(record.url);
      if (!safe) { rewritten = true; continue; }
      if (safe.url === record.url) { mergeRecord(record); continue; }
      // A secret parameter or an over-long URL kept under the older rule is scrubbed, not trusted as is.
      rewritten = true;
      mergeRecord({ ...record, id: recordId(record.taskScopeId, safe.url), url: safe.url, redactedQuery: true });
    }
    if (rewritten) schedulePersist();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unavailable = true;
  }
}

function mergeRecord(record: HistoryRecord): void {
  const existing = records.get(record.id);
  if (!existing) { records.set(record.id, record); return; }
  const newer = existing.lastVisitedAt >= record.lastVisitedAt ? existing : record;
  records.set(record.id, {
    ...newer,
    visitCount: Math.min(Number.MAX_SAFE_INTEGER, existing.visitCount + record.visitCount),
    redactedQuery: existing.redactedQuery || record.redactedQuery,
  });
}

/** Trim to the record cap and the byte cap (newest kept) before serializing, so a write never overflows. */
function serializeState(): Buffer {
  const sorted = [...records.values()].sort((a, b) => a.lastVisitedAt.localeCompare(b.lastVisitedAt)).slice(-MAX_RECORDS);
  const budget = MAX_STATE_BYTES - 256;
  let used = 0;
  let start = sorted.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(sorted[start - 1]), "utf8") + 1;
    if (used + size > budget) break;
    used += size;
    start -= 1;
  }
  const all = sorted.slice(start);
  if (records.size > all.length) {
    records.clear();
    for (const record of all) records.set(record.id, record);
  }
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, records: all } satisfies HistoryStateFile)}\n`, "utf8");
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("browser_history_state_too_large");
  return bytes;
}

/** Owner actions (import, clear) are written at once and supersede any batched write still in flight. */
function persistNow(): void {
  if (unavailable) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  writeGeneration += 1;
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = serializeState();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

function schedulePersist(): void {
  if (unavailable || persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; void persistBatched(); }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
  if (!exitFlushInstalled) {
    exitFlushInstalled = true;
    process.once("exit", () => {
      if (!persistTimer) return;
      try { persistNow(); } catch { /* quitting: the last batch is best effort */ }
    });
  }
}

async function persistBatched(): Promise<void> {
  if (unavailable) return;
  const generation = ++writeGeneration;
  const file = statePath();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const bytes = serializeState();
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    // A newer write owns the file now; an older snapshot must never land over it (a clear would come back).
    if (generation !== writeGeneration) { await fs.promises.rm(temp, { force: true }); return; }
    fs.renameSync(temp, file);
  } catch (error) {
    void fs.promises.rm(temp, { force: true }).catch(() => undefined);
    warnPersistFailure(error);
  }
}

function warnPersistFailure(error: unknown): void {
  const code = String((error as NodeJS.ErrnoException)?.code || (error instanceof Error ? error.message : "unknown")).slice(0, 80);
  if (warnedPersistCodes.has(code)) return;
  warnedPersistCodes.add(code);
  console.warn(`[browser-history] persist failed: ${code}`);
}

function recordId(taskScopeId: string, url: string): string {
  return `history_${createHash("sha256").update(`${taskScopeId}\0${url}`).digest("hex").slice(0, 32)}`;
}

function recordVisit(taskScopeId: string, viewId: string, contents: WebContents, increment: boolean): void {
  // Runs inside webContents listeners: it must never throw into Electron's event dispatch.
  try { recordVisitUnsafe(taskScopeId, viewId, contents, increment); }
  catch (error) { warnPersistFailure(error); }
}

function recordVisitUnsafe(taskScopeId: string, viewId: string, contents: WebContents, increment: boolean): void {
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
  schedulePersist();
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
    try { persistNow(); }
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
  if (removed) persistNow();
  return removed;
}
