/**
 * Defect reports (owner decision D5, 2026-09-28) — "like Claude's app".
 *
 * When AGI (or a failed run) classifies a blocker as our-defect it files a LOCAL record (actions.ts file_defect) and the
 * chat shows a small "결함 보고" chip. Pressing it opens a preview of exactly what will be sent, redaction already
 * applied; only the owner's Send press queues it. The generic "결함 보고" entry (help menu) uses the same sender.
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
import { AGI_BUG_REPORT_CATEGORIES, type AgiBugReportCategory, type AgiBugReportDraftInput, type AgiBugReportPayload,
  type AgiBugReportPreview, type AgiBugReportRow, type AgiDefectChip } from "../../shared/agi";

export const AGI_BUG_REPORT_LIMITS = {
  signedIn: { summary: 4_000, log: 32 * 1024 },
  anonymous: { summary: 1_500, log: 4 * 1024 },
  title: 140, steps: 20, step: 500,
} as const;
/** Retry backoff for 429/5xx/network: 1m → 5m → 30m → 2h → 6h (then stays at 6h). */
export const AGI_BUG_REPORT_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;

export interface AgiBugReportDeps {
  db: Database.Database;
  now(): number;
  appVersion(): string;
  platform: string;
  arch: string;
  locale(): string;
  /** The desktop session value (agentlas_session cookie value), or null when signed out. */
  sessionToken(): string | null;
  baseUrl(): string;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
  /** Redacted, allow-listed main.log lines for a defect family (read-tools main_log_slice), or null. */
  logExcerpt?(input: { goalId: string; family: string; sinceMs: number }): string | null;
  /** Run ids of this goal (long run + its invocation runs) — log lines must name one of them or the defect code. */
  goalRunIds?(goalId: string): string[];
}

export function ensureAgiBugReportSchema(db: Database.Database): void {
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
    const user = home.split("/").filter(Boolean).pop();
    if (user && user.length >= 3) {
      const re = new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
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

export function agiChatRef(chatId: string): string {
  return `chat_${createHash("sha256").update(`agentlas-chat-ref:${chatId}`).digest("hex").slice(0, 32)}`;
}

const DEFECT_FAMILY: Array<[RegExp, string]> = [[/browser|cdp/, "cdp"], [/login/, "login"], [/wait|effect|observation|sweep/, "wait"],
  [/blender|metal/, "blender"], [/update/, "updater"], [/run_failed|runtime|crash/, "runtime"]];

export class AgiBugReports {
  constructor(private readonly deps: AgiBugReportDeps) { ensureAgiBugReportSchema(deps.db); }

  /** Defects AGI filed for this chat (the chip), with the local state of any report the owner sent. */
  defectsForChat(chatId: string): AgiDefectChip[] {
    const hasTable = this.deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agi_defect_reports'").get();
    if (!hasTable) return [];
    const rows = this.deps.db.prepare(`SELECT d.id, d.code, d.category, d.goal_id, d.created_at_ms,
        (SELECT q.status FROM agi_bug_report_queue q WHERE q.defect_id = d.id AND q.status <> 'draft' ORDER BY q.updated_at_ms DESC LIMIT 1) AS report_status
      FROM agi_defect_reports d WHERE d.chat_id = ? ORDER BY d.created_at_ms DESC LIMIT 5`).all(chatId) as Array<{ id: string; code: string;
      category: string; goal_id: string; created_at_ms: number; report_status: AgiBugReportRow["status"] | null }>;
    return rows.map((row) => ({ defectId: row.id, code: row.code, goalId: row.goal_id, createdAt: new Date(row.created_at_ms).toISOString(),
      category: (AGI_BUG_REPORT_CATEGORIES as readonly string[]).includes(row.category) ? row.category as AgiBugReportCategory : "other",
      reportStatus: row.report_status ?? null }));
  }

  /** Build the exact payload, redacted, and keep it as a draft. Nothing is sent. */
  preview(input: AgiBugReportDraftInput): AgiBugReportPreview {
    const signedIn = Boolean(this.deps.sessionToken());
    const limits = signedIn ? AGI_BUG_REPORT_LIMITS.signedIn : AGI_BUG_REPORT_LIMITS.anonymous;
    let redactions = 0;
    const clean = (value: string, max: number): string => { const r = redactForReport(value); redactions += r.redactions; return clip(r.text.trim(), max); };
    let defect: { id: string; goal_id: string; chat_id: string | null; incident_id: string | null; code: string; category: string; evidence_json: string;
      workaround: string | null; created_at_ms: number } | undefined;
    if (input.defectId) {
      defect = this.deps.db.prepare("SELECT * FROM agi_defect_reports WHERE id = ?").get(input.defectId) as typeof defect;
      if (!defect) throw new Error("agi.bug-report.defect-unknown");
    }
    const incident = defect?.incident_id ? this.deps.db.prepare("SELECT cause_kind, owner_class FROM agi_incidents WHERE id = ?")
      .get(defect.incident_id) as { cause_kind: string; owner_class: string } | undefined : undefined;
    const evidence: string[] = (() => { try { return defect ? (JSON.parse(defect.evidence_json) as string[]).slice(0, 12) : []; } catch { return []; } })();
    const category: AgiBugReportCategory = (AGI_BUG_REPORT_CATEGORIES as readonly string[]).includes(String(input.category ?? defect?.category))
      ? String(input.category ?? defect?.category) as AgiBugReportCategory : "other";
    const title = clean(input.title?.trim() || (defect ? `[AGI] ${defect.code}` : ""), AGI_BUG_REPORT_LIMITS.title);
    if (!title) throw new Error("agi.bug-report.title-required");
    const summaryText = input.summary?.trim() || (defect
      ? [`AGI classified a stuck goal as an app defect: ${defect.code}.`,
        defect.workaround ? `Workaround used: ${defect.workaround}.` : "",
        incident ? `Cause: ${incident.cause_kind}.` : "",
        evidence.length ? `Evidence: ${evidence.join(", ")}.` : ""].filter(Boolean).join(" ")
      : "");
    const summary = clean(summaryText, limits.summary);
    if (!summary) throw new Error("agi.bug-report.summary-required");
    const chatId = input.chatId ?? defect?.chat_id ?? null;
    const payload: AgiBugReportPayload = {
      schemaVersion: 1,
      source: defect ? "desktop-agi" : "desktop-user",
      appVersion: this.deps.appVersion(),
      platform: this.deps.platform,
      arch: this.deps.arch,
      locale: this.deps.locale(),
      title,
      summary,
      category,
      clientReportId: randomUUID(),
    };
    const failureCode = input.failureCode ?? defect?.code;
    if (failureCode) payload.failureCode = clean(failureCode, 160);
    const runId = input.runId ?? (defect ? (this.deps.db.prepare("SELECT id FROM long_runs WHERE goal_id = ?").get(defect.goal_id) as { id: string } | undefined)?.id : undefined);
    if (runId) payload.runId = clip(runId, 160);
    if (chatId) payload.chatRef = agiChatRef(chatId);
    const steps = (input.steps ?? []).map((step) => clean(String(step), AGI_BUG_REPORT_LIMITS.step)).filter(Boolean).slice(0, AGI_BUG_REPORT_LIMITS.steps);
    if (steps.length) payload.steps = steps;
    if (defect && this.deps.logExcerpt) {
      const family = DEFECT_FAMILY.find(([pattern]) => pattern.test(defect!.code))?.[1] ?? "runtime";
      const all = this.deps.logExcerpt({ goalId: defect.goal_id, family, sinceMs: defect.created_at_ms - 6 * 60 * 60_000 });
      // Only lines about THIS goal: a family slice of main.log also carries other goals' runs (isolated smoke
      // 2026-09-28 previewed another run's "[long-run] paused" lines). No matching line = no log excerpt.
      const terms = [defect.code.split(":").pop() ?? defect.code, ...(this.deps.goalRunIds?.(defect.goal_id) ?? [])].filter((term) => term.length >= 6);
      const raw = all ? all.split("\n").filter((line) => terms.some((term) => line.includes(term))).join("\n") : null;
      if (raw) {
        const r = redactForReport(raw);
        redactions += r.redactions;
        const log = clipBytes(r.text, limits.log);
        if (log.trim()) payload.logExcerpt = log;
      }
    }
    if (defect) {
      payload.diagnosis = { cause: clip(incident?.cause_kind ?? defect.code, 160), classification: "our-defect",
        evidence: evidence.map((ref) => clean(ref, 200)).filter(Boolean) };
    }
    const nowMs = this.deps.now();
    this.deps.db.prepare(`INSERT INTO agi_bug_report_queue(client_report_id,defect_id,payload_json,status,created_at_ms,updated_at_ms)
      VALUES (?,?,?,'draft',?,?)`).run(payload.clientReportId, defect?.id ?? null, JSON.stringify(payload), nowMs, nowMs);
    return { clientReportId: payload.clientReportId, payload, redactions, signedIn };
  }

  /** The owner pressed Send on this exact draft: queue it and try now. */
  async send(clientReportId: string): Promise<AgiBugReportRow> {
    const row = this.row(clientReportId);
    if (!row) throw new Error("agi.bug-report.unknown");
    if (row.status === "draft" || row.status === "failed") {
      this.deps.db.prepare("UPDATE agi_bug_report_queue SET status='queued', error=NULL, next_attempt_at_ms=?, updated_at_ms=? WHERE client_report_id=?")
        .run(this.deps.now(), this.deps.now(), clientReportId);
    }
    if (this.row(clientReportId)?.status === "queued") await this.attempt(clientReportId);
    return this.row(clientReportId)!;
  }

  /** Retry pass over pressed, due reports (offline queue). Never touches drafts. */
  async flush(): Promise<number> {
    const due = this.deps.db.prepare(`SELECT client_report_id FROM agi_bug_report_queue WHERE status='queued' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
      ORDER BY created_at_ms LIMIT 10`).all(this.deps.now()) as Array<{ client_report_id: string }>;
    for (const { client_report_id } of due) await this.attempt(client_report_id);
    return due.length;
  }

  private async attempt(clientReportId: string): Promise<void> {
    const record = this.deps.db.prepare("SELECT payload_json, attempts FROM agi_bug_report_queue WHERE client_report_id = ? AND status = 'queued'")
      .get(clientReportId) as { payload_json: string; attempts: number } | undefined;
    if (!record) return;
    const payload = JSON.parse(record.payload_json) as AgiBugReportPayload;
    const token = this.deps.sessionToken();
    // Anonymous reports have tighter caps (server: summary 1500, log 4 KB); a draft made while signed in is trimmed.
    if (!token) {
      payload.summary = clip(payload.summary, AGI_BUG_REPORT_LIMITS.anonymous.summary);
      if (payload.logExcerpt) payload.logExcerpt = clipBytes(payload.logExcerpt, AGI_BUG_REPORT_LIMITS.anonymous.log);
    }
    const base = this.deps.baseUrl();
    const headers: Record<string, string> = { "content-type": "application/json", "x-agentlas-client": "desktop", origin: base };
    if (token) headers.authorization = `Bearer ${token}`;
    const nowMs = this.deps.now();
    const attempts = record.attempts + 1;
    const retry = (error: string) => {
      const delay = AGI_BUG_REPORT_BACKOFF_MS[Math.min(AGI_BUG_REPORT_BACKOFF_MS.length - 1, attempts - 1)]!;
      this.deps.db.prepare("UPDATE agi_bug_report_queue SET attempts=?, next_attempt_at_ms=?, error=?, updated_at_ms=? WHERE client_report_id=?")
        .run(attempts, nowMs + delay, error, nowMs, clientReportId);
    };
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.deps.fetch(`${base}/api/bug-reports`, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (error) {
      retry(`network:${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = (await response.json()) as Record<string, unknown> ?? {}; } catch { body = {}; }
    if (response.status === 200 || response.status === 201) {
      this.deps.db.prepare("UPDATE agi_bug_report_queue SET status='sent', attempts=?, server_id=?, error=NULL, next_attempt_at_ms=NULL, updated_at_ms=? WHERE client_report_id=?")
        .run(attempts, typeof body.id === "string" ? body.id : null, nowMs, clientReportId);
      return;
    }
    if (response.status === 400 || response.status === 409 || response.status === 413 || response.status === 403) {
      const details = Array.isArray(body.details) ? `: ${(body.details as unknown[]).map(String).join("; ").slice(0, 300)}` : "";
      this.deps.db.prepare("UPDATE agi_bug_report_queue SET status='failed', attempts=?, error=?, next_attempt_at_ms=NULL, updated_at_ms=? WHERE client_report_id=?")
        .run(attempts, `${response.status} ${typeof body.code === "string" ? body.code : "refused"}${details}`, nowMs, clientReportId);
      return;
    }
    retry(`${response.status}`);
  }

  row(clientReportId: string): AgiBugReportRow | null {
    const row = this.deps.db.prepare("SELECT * FROM agi_bug_report_queue WHERE client_report_id = ?").get(clientReportId) as QueueRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Local queue (pressed reports only) merged with the server's view when signed in. */
  async list(): Promise<AgiBugReportRow[]> {
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
  client_report_id: string; payload_json: string; status: AgiBugReportRow["status"]; attempts: number; next_attempt_at_ms: number | null;
  server_id: string | null; error: string | null; created_at_ms: number;
}
function toRow(row: QueueRow): AgiBugReportRow {
  const payload = JSON.parse(row.payload_json) as AgiBugReportPayload;
  return { clientReportId: row.client_report_id, title: payload.title, category: payload.category, status: row.status, serverId: row.server_id,
    error: row.error, attempts: row.attempts, nextAttemptAt: row.next_attempt_at_ms ? new Date(row.next_attempt_at_ms).toISOString() : null,
    createdAt: new Date(row.created_at_ms).toISOString() };
}
