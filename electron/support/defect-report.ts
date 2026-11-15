/**
 * Defect reports (decision D5) — "like Claude's app".
 *
 * A failed run's "결함 보고" button and the help menu entry open a preview of exactly what will be sent, redaction already
 * applied; only the owner's Send press queues it. Both use this sender.
 *
 * Wire (server 7ce5d720): POST {webBaseUrl}/api/bug-reports with x-agentlas-client: desktop, Origin, and the desktop
 * session as `Authorization: Bearer <agentlas_session value>` when signed in (anonymous is allowed but capped: summary
 * 1500, log 4 KB, 16 KB body). Body = exactly the contract fields. 201/200 (same clientReportId resent) = sent;
 * 400/409 = permanent (the reason is shown); 429/5xx/network = retry with backoff, same clientReportId.
 * GET /api/bug-reports/mine gives the server status ("수리됨(버전)").
 */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { DEFECT_REPORT_CATEGORIES, type DefectReportCategory, type DefectReportDraftInput, type DefectReportPayload,
  type DefectReportPreview, type DefectReportRow } from "../../shared/defect-report";

export const DEFECT_REPORT_LIMITS = {
  signedIn: { summary: 4_000, log: 32 * 1024 },
  anonymous: { summary: 1_500, log: 4 * 1024 },
  title: 140, steps: 20, step: 500,
} as const;
/** Retry backoff for 429/5xx/network: 1m → 5m → 30m → 2h → 6h (then stays at 6h). */
export const DEFECT_REPORT_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;
/**
 * Answers after which the report is never sent again (the same body would get the same answer): the server refused it (400 invalid,
 * 403 forbidden, 409 conflict, 413 too large) or the address / session / content cannot be accepted as it is (401 session rejected,
 * 404 no such endpoint, 422 unprocessable). The row becomes "failed" with the answer shown; pressing Send again queues it once more.
 * Anything else (429, 5xx, network) is retried with the backoff above. One list, so a code cannot be handled in one place only (#7:
 * 401, 404 and 422 were retried every six hours for ever).
 */
export const DEFECT_REPORT_PERMANENT_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 413, 422];
/**
 * How long a report row is kept: a draft nobody sent, a report waiting offline, a sent or a failed one. The rows are read by the report
 * list (list), the retry pass (flush) and the same-incident lookup (existing); after 30 days none of them has a reason to see the row.
 * Pruned by the sender itself, when a report is sent and once at the first retry pass after the app starts: no timer of its own.
 */
export const DEFECT_REPORT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DISPATCH_TIMEOUT_MS = 30_000;
const DISPATCH_LEASE_MS = 60_000;

export interface DefectReportDeps {
  db: Database.Database;
  now(): number;
  appVersion(): string;
  platform: string;
  arch: string;
  locale(): string;
  /** The desktop session value (agentlas_session cookie value), or null when signed out. */
  sessionToken(): string | null;
  baseUrl(): string;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export function ensureDefectReportSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_bug_report_queue (
    client_report_id TEXT PRIMARY KEY,
    defect_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    status TEXT NOT NULL CHECK(status IN ('draft','queued','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER,
    server_id TEXT,
    error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_bug_report_queue_due ON agi_bug_report_queue(status, next_attempt_at_ms)");
  db.transaction(() => {
    const columns = new Set((db.prepare("PRAGMA table_info(agi_bug_report_queue)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("dispatch_token")) db.exec("ALTER TABLE agi_bug_report_queue ADD COLUMN dispatch_token TEXT");
    if (!columns.has("dispatch_until_ms")) db.exec("ALTER TABLE agi_bug_report_queue ADD COLUMN dispatch_until_ms INTEGER");
  }).immediate();
}

/** Replace secrets, the home path/user name and e-mail addresses. Returns the text and how many spans changed. */
export function redactForReport(text: string, home = homedir()): { text: string; redactions: number } {
  let redactions = 0;
  let out = redactOperationalSecrets(text);
  redactions += (out.match(/\[redacted-secret\]/g) ?? []).length - (text.match(/\[redacted-secret\]/g) ?? []).length;
  if (home && home.length > 1) {
    const parts = out.split(home);
    redactions += parts.length - 1;
    out = parts.join("~");
    // Both separators: a Windows home (C:\Users\<name>) has no "/", so the whole path used to be taken for the user name.
    const user = home.split(/[\\/]+/).filter(Boolean).pop();
    if (user && user.length >= 3) {
      // \b never sits next to a Hangul syllable, so a Korean account name ("홍길동") was never redacted by name. The edges are
      // ASCII word characters on both sides, which is exactly what \b meant for an ASCII name ("mason" is still kept out of "masonry").
      const re = new RegExp(`(?<![A-Za-z0-9_])${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g");
      out = out.replace(re, () => { redactions += 1; return "[user]"; });
    }
  }
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => { redactions += 1; return "[email]"; });
  return { text: out, redactions: Math.max(0, redactions) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  let lines = text.split("\n");
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n"), "utf8") > bytes) lines = lines.slice(1);
  const joined = lines.join("\n");
  return Buffer.byteLength(joined, "utf8") <= bytes ? joined : Buffer.from(joined, "utf8").subarray(0, bytes - 4).toString("utf8").replace(/�+$/, "");
}

export function defectChatRef(chatId: string): string {
  return `chat_${createHash("sha256").update(`agentlas-chat-ref:${chatId}`).digest("hex").slice(0, 32)}`;
}

function reportIdentity(payload: DefectReportPayload): string {
  // One failed run can be previewed more than once. Those previews still describe the same incident and must retain its wire id.
  if (payload.runId && payload.failureCode) {
    return JSON.stringify(["incident", payload.runId, payload.failureCode, payload.chatRef ?? null]);
  }
  const { clientReportId: _id, ...content } = payload;
  return JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a.localeCompare(b))));
}

export class DefectReports {
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly deps: DefectReportDeps) { ensureDefectReportSchema(deps.db); }

  private existing(payload: DefectReportPayload): QueueRow | undefined {
    const identity = reportIdentity(payload);
    const candidates = this.deps.db.prepare(`SELECT * FROM agi_bug_report_queue
      WHERE (json_extract(payload_json, '$.runId') = ? AND json_extract(payload_json, '$.failureCode') = ?)
        OR (json_extract(payload_json, '$.source') = ? AND json_extract(payload_json, '$.title') = ? AND json_extract(payload_json, '$.category') = ?)
      ORDER BY CASE status WHEN 'sent' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
        created_at_ms, client_report_id`).all(payload.runId ?? null, payload.failureCode ?? null, payload.source,
          payload.title, payload.category) as QueueRow[];
    return candidates.find((row) => reportIdentity(JSON.parse(row.payload_json) as DefectReportPayload) === identity);
  }

  /** Build the exact payload, redacted, and keep it as a draft. Nothing is sent. */
  preview(input: DefectReportDraftInput): DefectReportPreview {
    const signedIn = Boolean(this.deps.sessionToken());
    const limits = signedIn ? DEFECT_REPORT_LIMITS.signedIn : DEFECT_REPORT_LIMITS.anonymous;
    let redactions = 0;
    const clean = (value: string, max: number): string => { const r = redactForReport(value); redactions += r.redactions; return clip(r.text.trim(), max); };
    const category: DefectReportCategory = (DEFECT_REPORT_CATEGORIES as readonly string[]).includes(String(input.category))
      ? String(input.category) as DefectReportCategory : "other";
    const title = clean(input.title?.trim() ?? "", DEFECT_REPORT_LIMITS.title);
    if (!title) throw new Error("agi.bug-report.title-required");
    const summary = clean(input.summary?.trim() ?? "", limits.summary);
    if (!summary) throw new Error("agi.bug-report.summary-required");
    const payload: DefectReportPayload = {
      schemaVersion: 1,
      source: "desktop-user",
      appVersion: this.deps.appVersion(),
      platform: this.deps.platform,
      arch: this.deps.arch,
      locale: this.deps.locale(),
      title,
      summary,
      category,
      clientReportId: randomUUID(),
    };
    if (input.failureCode) payload.failureCode = clean(input.failureCode, 160);
    if (input.runId) payload.runId = clip(input.runId, 160);
    if (input.chatId) payload.chatRef = defectChatRef(input.chatId);
    const steps = (input.steps ?? []).map((step) => clean(String(step), DEFECT_REPORT_LIMITS.step)).filter(Boolean).slice(0, DEFECT_REPORT_LIMITS.steps);
    // A report a person sends has a run but no cause: five "Reply failed" reports could not be told apart. The run's
    // own typed failure code goes along as a fact, not a classification; a code that is not a plain identifier is left out.
    if (input.runId && steps.length < DEFECT_REPORT_LIMITS.steps) {
      const failed = this.deps.db.prepare("SELECT json_extract(payload_json, '$.errorCode') AS code FROM run_events WHERE run_id = ? AND kind = 'invoke_failed' ORDER BY rowid DESC LIMIT 1")
        .get(input.runId) as { code?: unknown } | undefined;
      if (typeof failed?.code === "string" && /^[a-z][a-z0-9_.:-]{0,79}$/i.test(failed.code)) steps.push(`run failure code: ${failed.code}`);
    }
    if (steps.length) payload.steps = steps;
    const nowMs = this.deps.now();
    // Serialize lookup+insert across DB connections/processes, including previews
    // made before this update. Never mint another wire id for the same incident.
    return this.deps.db.transaction(() => {
      const existing = this.existing(payload);
      if (existing) return { clientReportId: existing.client_report_id,
        payload: JSON.parse(existing.payload_json) as DefectReportPayload, redactions, signedIn, report: toRow(existing) };
      this.deps.db.prepare(`INSERT INTO agi_bug_report_queue(client_report_id,payload_json,status,created_at_ms,updated_at_ms)
        VALUES (?,?,'draft',?,?)`).run(payload.clientReportId, JSON.stringify(payload), nowMs, nowMs);
      return { clientReportId: payload.clientReportId, payload, redactions, signedIn, report: this.row(payload.clientReportId)! };
    }).immediate();
  }

  /** Deletes the rows older than the retention window (a row some process is sending right now is left to finish). Never throws. */
  prune(): number {
    try {
      const nowMs = this.deps.now();
      return this.deps.db.prepare("DELETE FROM agi_bug_report_queue WHERE created_at_ms < ? AND (dispatch_until_ms IS NULL OR dispatch_until_ms <= ?)")
        .run(nowMs - DEFECT_REPORT_RETENTION_MS, nowMs).changes;
    } catch { return 0; }
  }
  private prunedAtStart = false;

  /** The owner pressed Send on this exact draft: queue it and try now. */
  async send(clientReportId: string): Promise<DefectReportRow> {
    this.prune();
    const stored = this.deps.db.prepare("SELECT * FROM agi_bug_report_queue WHERE client_report_id=?").get(clientReportId) as QueueRow | undefined;
    if (!stored) throw new Error("agi.bug-report.unknown");
    const canonical = this.existing(JSON.parse(stored.payload_json) as DefectReportPayload) ?? stored;
    clientReportId = canonical.client_report_id;
    const row = toRow(canonical);
    if (row.status === "draft" || row.status === "failed") {
      this.deps.db.prepare("UPDATE agi_bug_report_queue SET status='queued', error=NULL, next_attempt_at_ms=?, updated_at_ms=? WHERE client_report_id=? AND status IN ('draft','failed')")
        .run(this.deps.now(), this.deps.now(), clientReportId);
    }
    if (this.row(clientReportId)?.status === "queued") await this.attempt(clientReportId);
    return this.row(clientReportId)!;
  }

  /** Retry pass over pressed, due reports (offline queue). Never touches drafts. */
  async flush(): Promise<number> {
    if (!this.prunedAtStart) { this.prunedAtStart = true; this.prune(); }
    const due = this.deps.db.prepare(`SELECT client_report_id FROM agi_bug_report_queue WHERE status='queued' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
      ORDER BY created_at_ms LIMIT 10`).all(this.deps.now()) as Array<{ client_report_id: string }>;
    for (const { client_report_id } of due) await this.attempt(client_report_id);
    return due.length;
  }

  private async attempt(clientReportId: string): Promise<void> {
    const pending = this.inFlight.get(clientReportId);
    if (pending) return pending;
    const token = randomUUID();
    const nowMs = this.deps.now();
    // The persisted lease excludes Send/flush/other processes, and survives a
    // crash. Expired recovery always uses the same server-idempotent wire id.
    const record = this.deps.db.prepare(`UPDATE agi_bug_report_queue SET dispatch_token=?, dispatch_until_ms=?, attempts=attempts+1
      WHERE client_report_id=? AND status='queued' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms<=?)
        AND (dispatch_token IS NULL OR dispatch_until_ms<=?) RETURNING *`)
      .get(token, nowMs + DISPATCH_LEASE_MS, clientReportId, nowMs, nowMs) as QueueRow | undefined;
    if (!record) return;
    const canonical = this.existing(JSON.parse(record.payload_json) as DefectReportPayload);
    if (canonical && canonical.client_report_id !== clientReportId) {
      this.deps.db.prepare(`UPDATE agi_bug_report_queue SET status='failed', error=?, dispatch_token=NULL, dispatch_until_ms=NULL
        WHERE client_report_id=? AND dispatch_token=?`).run("agi.bug-report.duplicate-of:" + canonical.client_report_id, clientReportId, token);
      return;
    }
    const dispatch = this.dispatch(record, token).finally(() => { this.inFlight.delete(clientReportId); });
    this.inFlight.set(clientReportId, dispatch);
    return dispatch;
  }

  private async dispatch(record: QueueRow, dispatchToken: string): Promise<void> {
    const clientReportId = record.client_report_id;
    const payload = JSON.parse(record.payload_json) as DefectReportPayload;
    const token = this.deps.sessionToken();
    // Anonymous reports have tighter caps (server: summary 1500, log 4 KB); a draft made while signed in is trimmed.
    if (!token) {
      payload.summary = clip(payload.summary, DEFECT_REPORT_LIMITS.anonymous.summary);
      if (payload.logExcerpt) payload.logExcerpt = clipBytes(payload.logExcerpt, DEFECT_REPORT_LIMITS.anonymous.log);
    }
    const attempts = record.attempts;
    const retry = (error: string) => {
      const delay = DEFECT_REPORT_BACKOFF_MS[Math.min(DEFECT_REPORT_BACKOFF_MS.length - 1, attempts - 1)]!;
      this.deps.db.prepare(`UPDATE agi_bug_report_queue SET next_attempt_at_ms=?, error=?, updated_at_ms=?, dispatch_token=NULL, dispatch_until_ms=NULL
        WHERE client_report_id=? AND dispatch_token=? AND status='queued'`)
        .run(this.deps.now() + delay, error, this.deps.now(), clientReportId, dispatchToken);
    };
    let response: { status: number; json(): Promise<unknown> };
    let body: Record<string, unknown> = {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("agi.bug-report.send-timeout")), DISPATCH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      // Inside the try: an address that cannot be read is a failed attempt that backs off, not a thrown error that leaves the row due
      // (the retry timer woke every minute for it, #7).
      const base = this.deps.baseUrl();
      const headers: Record<string, string> = { "content-type": "application/json", "x-agentlas-client": "desktop", origin: base };
      if (token) headers.authorization = `Bearer ${token}`;
      response = await Promise.race([
        this.deps.fetch(`${base}/api/bug-reports`, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal }),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
      ]);
      try {
        body = (await Promise.race([
          response.json(),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
        ])) as Record<string, unknown> ?? {};
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
    } catch (error) {
      retry(`network:${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 200 || response.status === 201) {
      if (typeof body.id !== "string" || !body.id.trim()) {
        retry("agi.bug-report.acknowledgement-missing");
        return;
      }
      this.deps.db.prepare(`UPDATE agi_bug_report_queue SET status='sent', server_id=?, error=NULL, next_attempt_at_ms=NULL, updated_at_ms=?, dispatch_token=NULL, dispatch_until_ms=NULL
        WHERE client_report_id=? AND dispatch_token=? AND status='queued'`)
        .run(body.id, this.deps.now(), clientReportId, dispatchToken);
      return;
    }
    if (DEFECT_REPORT_PERMANENT_STATUSES.includes(response.status)) {
      const details = Array.isArray(body.details) ? `: ${(body.details as unknown[]).map(String).join("; ").slice(0, 300)}` : "";
      this.deps.db.prepare(`UPDATE agi_bug_report_queue SET status='failed', error=?, next_attempt_at_ms=NULL, updated_at_ms=?, dispatch_token=NULL, dispatch_until_ms=NULL
        WHERE client_report_id=? AND dispatch_token=? AND status='queued'`)
        .run(`${response.status} ${typeof body.code === "string" ? body.code : "refused"}${details}`, this.deps.now(), clientReportId, dispatchToken);
      return;
    }
    retry(`${response.status}`);
  }

  row(clientReportId: string): DefectReportRow | null {
    const row = this.deps.db.prepare("SELECT * FROM agi_bug_report_queue WHERE client_report_id = ?").get(clientReportId) as QueueRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Local queue (pressed reports only) merged with the server's view when signed in. */
  async list(): Promise<DefectReportRow[]> {
    const rows = (this.deps.db.prepare("SELECT * FROM agi_bug_report_queue WHERE status <> 'draft' ORDER BY created_at_ms DESC LIMIT 50").all() as QueueRow[]).map(toRow);
    const token = this.deps.sessionToken();
    if (!token || !rows.some((row) => row.serverId)) return rows;
    try {
      const base = this.deps.baseUrl();
      const response = await this.deps.fetch(`${base}/api/bug-reports/mine`, { method: "GET",
        headers: { "x-agentlas-client": "desktop", origin: base, authorization: `Bearer ${token}` } });
      if (response.status !== 200) return rows;
      const body = await response.json() as { reports?: Array<{ id: string; status?: string; fixedVersion?: string | null }> };
      const remote = new Map((body.reports ?? []).map((report) => [report.id, report]));
      return rows.map((row) => {
        const match = row.serverId ? remote.get(row.serverId) : undefined;
        return match ? { ...row, remoteStatus: match.status ?? null, fixedVersion: match.fixedVersion ?? null } : row;
      });
    } catch {
      return rows;
    }
  }
}

interface QueueRow {
  client_report_id: string; payload_json: string; status: DefectReportRow["status"]; attempts: number; next_attempt_at_ms: number | null;
  server_id: string | null; error: string | null; created_at_ms: number;
}
function toRow(row: QueueRow): DefectReportRow {
  const payload = JSON.parse(row.payload_json) as DefectReportPayload;
  return { clientReportId: row.client_report_id, title: payload.title, category: payload.category, status: row.status, serverId: row.server_id,
    error: row.error, attempts: row.attempts, nextAttemptAt: row.next_attempt_at_ms ? new Date(row.next_attempt_at_ms).toISOString() : null,
    createdAt: new Date(row.created_at_ms).toISOString() };
}
