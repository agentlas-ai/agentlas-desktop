// Browser 세션 · 권한 · 사용로그 접근자 (better-sqlite3, 동기).
//
// 보안 모델: Agentlas는 사이트 비밀번호를 받거나 자동 입력하지 않는다. 사용자가 제공자
// 페이지에 직접 로그인하고, 세션 쿠키는 Chrome 전용 프로필 안에만 남는다. DB에는
// 상태(valid|expired|none)와 표시용 username만 기록한다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { deleteSecret } from "../secrets/vault";

export type BrowserSessionStatus = "valid" | "expired" | "none";
export type BrowserPermissionDecision = "once" | "always" | "deny";

export interface BrowserSiteRow {
  id: string;
  site: string;
  label: string | null;
  username: string | null;
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

export interface LegacyBrowserCredentialScrubResult {
  siteRowsRemoved: number;
  sessionRowsRemoved: number;
  permissionRowsRemoved: number;
  auditRowsScrubbed: number;
  keychainCleanupFailures: number;
}

const REDACTED_USERINFO_URL = "[redacted-userinfo-url]";

function nowIso(): string {
  return new Date().toISOString();
}

function parseHttpUrl(input: string, allowBareHost: boolean): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw);
    if (!hasScheme && !allowBareHost) return null;
    const parsed = new URL(hasScheme ? raw : `https://${raw}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Detect URL credentials without returning or logging the credential-bearing value. */
function siteHasUrlUserinfo(input: string): boolean {
  const parsed = parseHttpUrl(input, true);
  if (parsed && (parsed.username || parsed.password)) return true;
  // Also fail closed for malformed legacy URLs that still visibly place an
  // `@` inside an explicit HTTP(S) authority.
  return /https?:\/\/[^\s/?#]*@[^\s/?#]+/iu.test(input);
}

/**
 * Audit targets may be free-form descriptions, so only explicit HTTP(S) URLs
 * are inspected. This avoids treating an ordinary email address as URL userinfo.
 */
function targetHasUrlUserinfo(input: string): boolean {
  // An `@` inside the authority portion of an explicit HTTP(S) URL denotes
  // userinfo. Stop at `/`, `?`, or `#` so ordinary email-like text in a path or
  // query does not trigger redaction; the regex can still find a nested URL.
  return /https?:\/\/[^\s/?#]*@[^\s/?#]+/iu.test(input);
}

function safeAuditTarget(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  return targetHasUrlUserinfo(input) ? REDACTED_USERINFO_URL : input;
}

/** 사이트 문자열 정규화 — 프로토콜/경로 제거, 소문자 호스트만(볼트 키 안정화). */
export function normalizeSite(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  const parsed = parseHttpUrl(raw, true);
  if (!parsed) return "";
  // Credentials belong only in the provider's own login page. Rejecting
  // userinfo here also prevents accidental password material from entering
  // site keys, activity targets, or diagnostic logs.
  if (parsed.username || parsed.password) return "";
  const host = parsed.host.toLowerCase().replace(/^www\./u, "");
  return host && !/\s/u.test(host) ? host : "";
}

function credKey(site: string): string {
  return `browser.cred:${site}`;
}

// ── 사이트 카드 ────────────────────────────────────────────────
export function listBrowserSites(): BrowserSiteRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.site, s.label, s.username,
              s.created_at, s.updated_at,
              se.status AS sess_status, se.captured_at AS sess_captured
       FROM browser_sites s
       LEFT JOIN browser_sessions se ON se.site = s.site
       ORDER BY s.updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .filter((r) => !siteHasUrlUserinfo(String(r.site)))
    .map((r) => ({
      id: String(r.id),
      site: String(r.site),
      label: (r.label as string | null) ?? null,
      username: (r.username as string | null) ?? null,
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

/** 사이트 카드 추가/수정. 자격증명은 받지 않으며 로그인은 제공자 페이지에서 직접 한다. */
export async function upsertBrowserSite(input: {
  site: string;
  label?: string | null;
  username?: string | null;
}): Promise<BrowserSiteRow> {
  const site = normalizeSite(input.site);
  if (!site) throw new Error("Site address is empty.");
  const db = getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM browser_sites WHERE site = ?").get(site) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE browser_sites
       SET label = COALESCE(?, label),
           username = COALESCE(?, username),
           updated_at = ?
       WHERE site = ?`,
    ).run(
      input.label ?? null,
      input.username ?? null,
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
      0,
      now,
      now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO browser_sessions (id, site, status, captured_at) VALUES (?, ?, 'none', NULL)`,
    ).run(randomUUID(), site);
  }
  return getBrowserSite(site)!;
}

/**
 * 구버전이 자동 재로그인을 표방하며 저장했던 사이트 비밀번호를 일회성 정리한다.
 * Keychain 삭제가 성공한 행만 DB 표식을 내리므로 실패를 성공처럼 숨기지 않는다.
 */
export async function purgeLegacyBrowserPasswords(): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare("SELECT site FROM browser_sites WHERE has_password = 1")
    .all() as Array<{ site: string }>;
  let purged = 0;
  for (const row of rows) {
    await deleteSecret(credKey(row.site));
    db.prepare("UPDATE browser_sites SET has_password = 0, updated_at = ? WHERE site = ?")
      .run(nowIso(), row.site);
    purged += 1;
  }
  return purged;
}

/**
 * One-time defense for rows written before normalizeSite rejected URL userinfo.
 *
 * Credential-bearing site identities are not converted to their host because
 * doing so could merge an untrusted legacy permission/session into a valid
 * site. Entity rows are deleted instead. Audit history is retained, but only
 * the credential-bearing field is replaced with an explicit redaction marker.
 * Normal site rows and normal audit fields are left byte-for-byte unchanged.
 */
export async function scrubLegacyBrowserCredentialRows(): Promise<LegacyBrowserCredentialScrubResult> {
  const db = getDb();
  const unsafeSiteRows = db
    .prepare("SELECT site FROM browser_sites")
    .all() as Array<{ site: string }>;
  let keychainCleanupFailures = 0;

  // Legacy builds may have used the raw site as the Keychain lookup key. Try
  // that cleanup before removing the DB locator, but never retain plaintext URL
  // credentials in SQLite merely because the OS Keychain is unavailable.
  for (const row of unsafeSiteRows) {
    if (!siteHasUrlUserinfo(row.site)) continue;
    try {
      await deleteSecret(credKey(row.site));
    } catch {
      keychainCleanupFailures += 1;
    }
  }

  const counts = db.transaction(() => {
    let siteRowsRemoved = 0;
    let sessionRowsRemoved = 0;
    let permissionRowsRemoved = 0;
    let auditRowsScrubbed = 0;

    const sessions = db
      .prepare("SELECT id, site FROM browser_sessions")
      .all() as Array<{ id: string; site: string }>;
    const deleteSession = db.prepare("DELETE FROM browser_sessions WHERE id = ?");
    for (const row of sessions) {
      if (siteHasUrlUserinfo(row.site)) sessionRowsRemoved += deleteSession.run(row.id).changes;
    }

    const permissions = db
      .prepare("SELECT id, site FROM browser_permissions")
      .all() as Array<{ id: string; site: string }>;
    const deletePermission = db.prepare("DELETE FROM browser_permissions WHERE id = ?");
    for (const row of permissions) {
      if (siteHasUrlUserinfo(row.site)) permissionRowsRemoved += deletePermission.run(row.id).changes;
    }

    const sites = db
      .prepare("SELECT id, site FROM browser_sites")
      .all() as Array<{ id: string; site: string }>;
    const deleteSite = db.prepare("DELETE FROM browser_sites WHERE id = ?");
    for (const row of sites) {
      if (siteHasUrlUserinfo(row.site)) siteRowsRemoved += deleteSite.run(row.id).changes;
    }

    const logs = db
      .prepare("SELECT id, site, target FROM browser_action_logs")
      .all() as Array<{ id: string; site: string | null; target: string | null }>;
    const updateLog = db.prepare(
      "UPDATE browser_action_logs SET site = ?, target = ? WHERE id = ?",
    );
    for (const row of logs) {
      const site = row.site && siteHasUrlUserinfo(row.site) ? REDACTED_USERINFO_URL : row.site;
      const target = row.target && targetHasUrlUserinfo(row.target)
        ? REDACTED_USERINFO_URL
        : row.target;
      if (site !== row.site || target !== row.target) {
        auditRowsScrubbed += updateLog.run(site, target, row.id).changes;
      }
    }

    return { siteRowsRemoved, sessionRowsRemoved, permissionRowsRemoved, auditRowsScrubbed };
  })();

  return { ...counts, keychainCleanupFailures };
}

export async function deleteBrowserSite(site: string): Promise<void> {
  const norm = normalizeSite(site);
  // 레거시 비밀번호 삭제가 실패했는데 사이트 행부터 지우면, 남은 Keychain
  // 항목을 다시 찾거나 정리할 근거가 사라진다. 비밀 정리를 먼저 확정하고
  // 실패 시 사이트/권한 행을 보존해 사용자가 재시도할 수 있게 한다.
  await deleteSecret(credKey(norm));
  const db = getDb();
  db.transaction(() => {
    // permissions에는 초기 스키마상 FK가 없으므로 사이트 카드 삭제 전에 명시 정리해야
    // 같은 호스트를 다시 추가했을 때 과거 always/deny가 부활하지 않는다.
    db.prepare("DELETE FROM browser_permissions WHERE site = ?").run(norm);
    db.prepare("DELETE FROM browser_sites WHERE site = ?").run(norm);
  })();
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
/**
 * 저장된 결정을 조회. 결제/임의코드는 **승인**을 절대 캐시하지 않는다(always여도 무시 → 매번 확인).
 * 다만 명시 "거부"는 돌려준다.
 *
 * WHY(2026-07-28 수리): browserRequestApproval이 payment/unsafe-code 외 전부 자동승인으로 바뀐 뒤
 * 시트에 도달하는 요청은 payment/unsafe-code뿐인데, 여기서 그 둘을 통째로 null 처리해 버려
 * "저장 가능한 액션"과 "시트에 도달하는 액션"의 교집합이 공집합이 됐다. 그 결과 browser_permissions는
 * 단 한 줄도 생길 수 없는 죽은 테이블이 되고, 오너 지시의 "사이트별 명시 deny는 존중"이 실행 불가였다.
 * 승인 캐시 금지(결제는 매번 확인)는 그대로 두고, deny만 살려 dead store를 되살린다.
 */
export function getBrowserPermission(
  site: string,
  actionType: string,
): BrowserPermissionDecision | null {
  const approvalCacheForbidden = actionType === "payment" || actionType === "unsafe-code";
  const norm = normalizeSite(site);
  if (!norm) return null;
  const row = getDb()
    .prepare("SELECT decision FROM browser_permissions WHERE site = ? AND action_type = ?")
    .get(norm, actionType) as { decision: string } | undefined;
  const stored = (row?.decision as BrowserPermissionDecision | undefined) ?? null;
  if (approvalCacheForbidden && stored !== "deny") return null;
  return stored;
}

/**
 * "항상 승인" / "거부"만 영속. "한 번만"(once)은 저장하지 않는다.
 * 결제/임의코드는 "거부"만 영속 — 승인(always)을 기억하면 결제가 조용히 통과하므로 금지하되,
 * 사용자가 명시적으로 막은 사이트를 매번 다시 묻는 일도 없앤다(getBrowserPermission의 WHY 참고).
 */
export function setBrowserPermission(
  site: string,
  actionType: string,
  decision: BrowserPermissionDecision,
): void {
  if (decision === "once") return;
  if ((actionType === "payment" || actionType === "unsafe-code") && decision !== "deny") return;
  const norm = normalizeSite(site);
  if (!norm) return;
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
  return rows
    .filter((r) => !siteHasUrlUserinfo(r.site))
    .map((r) => ({
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
  const site = input.site ? normalizeSite(input.site) : "";
  getDb()
    .prepare(
      `INSERT INTO browser_action_logs (id, ts, site, action, target, result, approval, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      nowIso(),
      site || null,
      input.action,
      safeAuditTarget(input.target),
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
    site: typeof r.site === "string" && siteHasUrlUserinfo(r.site)
      ? REDACTED_USERINFO_URL
      : (r.site as string | null) ?? null,
    action: String(r.action),
    target: safeAuditTarget((r.target as string | null) ?? null),
    result: (r.result as string | null) ?? null,
    approval: (r.approval as string | null) ?? null,
  }));
}
