// Browser 자격증명 볼트 · 세션 · 권한 · 사용로그 접근자 (better-sqlite3, 동기).
//
// 보안 모델(secrets/vault.ts와 동일): 비밀번호 평문은 keytar(OS 키체인)에만 저장하고,
// DB/renderer 로는 절대 나가지 않는다. DB에는 has_password 불리언과 username 만 둔다.
// 세션 쿠키 자체는 크롬 전용 프로필 안에 있고, 여기엔 상태(valid|expired|none)만 기록한다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { setSecret, deleteSecret, readSecret } from "../secrets/vault";

export type BrowserSessionStatus = "valid" | "expired" | "none";
export type BrowserPermissionDecision = "once" | "always" | "deny";

export interface BrowserSiteRow {
  id: string;
  site: string;
  label: string | null;
  username: string | null;
  hasPassword: boolean;
  session: { status: BrowserSessionStatus; capturedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface BrowserActionLogRow {
  id: string;
  ts: string;
  site: string | null;
  action: string;
  target: string | null;
  result: string | null;
  approval: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 사이트 문자열 정규화 — 프로토콜/경로 제거, 소문자 호스트만(볼트 키 안정화). */
export function normalizeSite(input: string): string {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  return s;
}

function credKey(site: string): string {
  return `browser.cred:${site}`;
}

// ── 사이트 카드 ────────────────────────────────────────────────
export function listBrowserSites(): BrowserSiteRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.site, s.label, s.username, s.has_password,
              s.created_at, s.updated_at,
              se.status AS sess_status, se.captured_at AS sess_captured
       FROM browser_sites s
       LEFT JOIN browser_sessions se ON se.site = s.site
       ORDER BY s.updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    site: String(r.site),
    label: (r.label as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    hasPassword: Number(r.has_password) === 1,
    session: {
      status: ((r.sess_status as string | null) ?? "none") as BrowserSessionStatus,
      capturedAt: (r.sess_captured as string | null) ?? null,
    },
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function getBrowserSite(site: string): BrowserSiteRow | null {
  const norm = normalizeSite(site);
  return listBrowserSites().find((s) => s.site === norm) ?? null;
}

/** 사이트 카드 추가/수정. password 가 문자열이면 keytar 저장, null 이면 유지, "" 이면 삭제. */
export async function upsertBrowserSite(input: {
  site: string;
  label?: string | null;
  username?: string | null;
  password?: string | null;
}): Promise<BrowserSiteRow> {
  const site = normalizeSite(input.site);
  if (!site) throw new Error("Site address is empty.");
  const db = getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM browser_sites WHERE site = ?").get(site) as
    | { id: string }
    | undefined;

  // 비밀번호 처리(평문은 keytar 로만).
  let hasPassword: boolean | null = null;
  if (typeof input.password === "string") {
    if (input.password.length > 0) {
      await setSecret(credKey(site), input.password);
      hasPassword = true;
    } else {
      await deleteSecret(credKey(site));
      hasPassword = false;
    }
  }

  if (existing) {
    const current = db
      .prepare("SELECT has_password FROM browser_sites WHERE site = ?")
      .get(site) as { has_password: number };
    db.prepare(
      `UPDATE browser_sites
       SET label = COALESCE(?, label),
           username = COALESCE(?, username),
           has_password = ?,
           updated_at = ?
       WHERE site = ?`,
    ).run(
      input.label ?? null,
      input.username ?? null,
      hasPassword === null ? current.has_password : hasPassword ? 1 : 0,
      now,
      site,
    );
  } else {
    db.prepare(
      `INSERT INTO browser_sites (id, site, label, username, has_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      site,
      input.label ?? null,
      input.username ?? null,
      hasPassword ? 1 : 0,
      now,
      now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO browser_sessions (id, site, status, captured_at) VALUES (?, ?, 'none', NULL)`,
    ).run(randomUUID(), site);
  }
  return getBrowserSite(site)!;
}

export async function deleteBrowserSite(site: string): Promise<void> {
  const norm = normalizeSite(site);
  await deleteSecret(credKey(norm)).catch(() => {});
  getDb().prepare("DELETE FROM browser_sites WHERE site = ?").run(norm);
}

/** main 내부 전용 — 자동 재로그인 시 비번 주입. renderer 노출 금지. */
export async function readBrowserPassword(site: string): Promise<string | null> {
  return readSecret(credKey(normalizeSite(site)));
}

// ── 세션 ───────────────────────────────────────────────────────
export function setBrowserSession(site: string, status: BrowserSessionStatus): void {
  const norm = normalizeSite(site);
  const db = getDb();
  const captured = status === "valid" ? nowIso() : null;
  const existing = db.prepare("SELECT id FROM browser_sessions WHERE site = ?").get(norm) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare("UPDATE browser_sessions SET status = ?, captured_at = ? WHERE site = ?").run(
      status,
      captured,
      norm,
    );
  } else {
    db.prepare(
      "INSERT INTO browser_sessions (id, site, status, captured_at) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), norm, status, captured);
  }
}

// ── 권한(승인 기억) ────────────────────────────────────────────
/** 저장된 결정을 조회. 결제(payment)는 절대 캐시하지 않는다(항상 null → 매번 확인). */
export function getBrowserPermission(
  site: string,
  actionType: string,
): BrowserPermissionDecision | null {
  if (actionType === "payment") return null;
  const norm = normalizeSite(site);
  const row = getDb()
    .prepare("SELECT decision FROM browser_permissions WHERE site = ? AND action_type = ?")
    .get(norm, actionType) as { decision: string } | undefined;
  return (row?.decision as BrowserPermissionDecision | undefined) ?? null;
}

/** "항상 승인" / "거부"만 영속. "한 번만"(once)과 결제는 저장하지 않는다. */
export function setBrowserPermission(
  site: string,
  actionType: string,
  decision: BrowserPermissionDecision,
): void {
  if (actionType === "payment" || decision === "once") return;
  const norm = normalizeSite(site);
  getDb()
    .prepare(
      `INSERT INTO browser_permissions (id, site, action_type, decision, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(site, action_type) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
    )
    .run(randomUUID(), norm, actionType, decision, nowIso());
}

export function revokeBrowserPermission(site: string, actionType: string): void {
  getDb()
    .prepare("DELETE FROM browser_permissions WHERE site = ? AND action_type = ?")
    .run(normalizeSite(site), actionType);
}

export function listBrowserPermissions(): Array<{
  site: string;
  actionType: string;
  decision: BrowserPermissionDecision;
}> {
  const rows = getDb()
    .prepare("SELECT site, action_type, decision FROM browser_permissions ORDER BY created_at DESC")
    .all() as Array<{ site: string; action_type: string; decision: string }>;
  return rows.map((r) => ({
    site: r.site,
    actionType: r.action_type,
    decision: r.decision as BrowserPermissionDecision,
  }));
}

// ── 사용 로그 ──────────────────────────────────────────────────
export function logBrowserAction(input: {
  site?: string | null;
  action: string;
  target?: string | null;
  result?: string | null;
  approval?: string | null;
  meta?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO browser_action_logs (id, ts, site, action, target, result, approval, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      nowIso(),
      input.site ? normalizeSite(input.site) : null,
      input.action,
      input.target ?? null,
      input.result ?? null,
      input.approval ?? null,
      input.meta === undefined ? null : JSON.stringify(input.meta),
    );
}

export function listBrowserActionLogs(limit = 500): BrowserActionLogRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ts, site, action, target, result, approval
       FROM browser_action_logs ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    ts: String(r.ts),
    site: (r.site as string | null) ?? null,
    action: String(r.action),
    target: (r.target as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    approval: (r.approval as string | null) ?? null,
  }));
}
