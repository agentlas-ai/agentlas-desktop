// Browser 기능 핸들러 (메인 프로세스).
//
// 범용 브라우저 조작(agentlas-browser CDP)을 위한: 사이트 목록, 전용 프로필 로그인,
// 세션 상태, 되돌릴 수 없는 행동 승인 게이트(경량 바텀시트), 날짜별 사용 로그.
//
// 보안: 사이트 비밀번호를 받거나 자동 입력하지 않는다. 로그인은 제공자 페이지에서 사용자가 직접 한다.
// 승인 게이트: 결제(payment)는 매번 확인. 그 외는 "한 번만 / 항상 승인 / 거부", always만 기억.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
  acquireBrowserCdpLease,
  browserCdpProfilePath,
  browserCdpPort,
  browserCdpPortReady,
  ensureBrowserCdpProfilePrivate,
  reconcileBrowserCdpOwnerWithRetry,
  releaseBrowserCdpLease,
  resolveChromeExe,
  scheduleBrowserCdpGuardian,
  scheduleBrowserCdpIdleShutdown,
  withBrowserCdpMaintenance,
  type BrowserCdpLease,
  type BrowserCdpOwnership,
} from "../mcp-tools/browser-cdp-launcher";
import { onHostShutdown } from "../host-lifecycle";
import {
  listBrowserSites,
  purgeLegacyBrowserPasswords,
  scrubLegacyBrowserCredentialRows,
  upsertBrowserSite,
  deleteBrowserSite,
  setBrowserSession,
  getBrowserPermission,
  setBrowserPermission,
  revokeBrowserPermission,
  listBrowserPermissions,
  logBrowserAction,
  listBrowserActionLogs,
  normalizeSite,
  type BrowserSiteRow,
  type BrowserActionLogRow,
  type BrowserPermissionDecision,
} from "../store/browser-vault";

export type {
  BrowserSiteRow,
  BrowserActionLogRow,
  BrowserPermissionDecision,
} from "../store/browser-vault";

const APPROVAL_CHANNEL = "browser:approvalRequest";
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

function approvalTimeoutMs(): number {
  const configured = Number(process.env.AGENTLAS_BROWSER_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 10 ? configured : DEFAULT_APPROVAL_TIMEOUT_MS;
}

// ── 상태 ───────────────────────────────────────────────────────
export interface BrowserStatus {
  chromeFound: boolean;
  chromePath: string | null;
  profilePath: string;
  cdpPort: number;
}

export function getBrowserStatus(): BrowserStatus {
  const exe = resolveChromeExe();
  return {
    chromeFound: Boolean(exe),
    chromePath: exe,
    profilePath: browserCdpProfilePath(),
    cdpPort: browserCdpPort(),
  };
}

// ── 볼트 CRUD ──────────────────────────────────────────────────
export async function browserListSites(): Promise<BrowserSiteRow[]> {
  try {
    const scrubbed = await scrubLegacyBrowserCredentialRows();
    const scrubbedRows = scrubbed.siteRowsRemoved
      + scrubbed.sessionRowsRemoved
      + scrubbed.permissionRowsRemoved
      + scrubbed.auditRowsScrubbed;
    if (scrubbedRows > 0 || scrubbed.keychainCleanupFailures > 0) {
      logBrowserAction({
        action: "vault.legacy_credential_rows_scrubbed",
        result: scrubbed.keychainCleanupFailures > 0 ? "partial" : "ok",
        meta: {
          rows: scrubbedRows,
          keychainCleanupFailures: scrubbed.keychainCleanupFailures,
        },
      });
    }
    const purged = await purgeLegacyBrowserPasswords();
    if (purged > 0) {
      logBrowserAction({ action: "vault.legacy_passwords_purged", result: `ok:${purged}` });
    }
  } catch {
    logBrowserAction({
      action: "vault.legacy_passwords_purge_failed",
      result: "cleanup-failed",
      meta: { reasonCode: "legacy-browser-cleanup-failed" },
    });
  }
  return listBrowserSites();
}

export async function browserSaveSite(input: {
  site: string;
  label?: string | null;
  username?: string | null;
}): Promise<BrowserSiteRow> {
  const row = await upsertBrowserSite(input);
  logBrowserAction({ site: row.site, action: "vault.save", result: "ok" });
  return row;
}

export async function browserDeleteSite(site: string): Promise<{ ok: true }> {
  await deleteBrowserSite(site);
  logBrowserAction({ site, action: "vault.delete", result: "ok" });
  return { ok: true };
}

// ── 전용 프로필 로그인 창 ───────────────────────────────────────
// 전용 CDP 프로필로 크롬 창을 headful 로 열어(MCP 없이) 사용자가 직접 로그인하게 한다.
// 사용자가 명시적으로 세션 저장을 누르면 valid 로 기록(쿠키는 전용 프로필에 영속 → 이후 자동화가 재사용).
const openLoginChildren = new Map<string, ReturnType<typeof spawn>>();
type BrowserOpenLoginResult = { ok: boolean; error?: string };
const openLoginFlights = new Map<string, Promise<BrowserOpenLoginResult>>();
const openLoginLeases = new Map<string, { lease: BrowserCdpLease; timer: NodeJS.Timeout }>();
let openLoginQueue: Promise<void> = Promise.resolve();

function releaseBrowserLoginLease(site: string): void {
  const active = openLoginLeases.get(site);
  if (!active) return;
  openLoginLeases.delete(site);
  clearTimeout(active.timer);
  releaseBrowserCdpLease(active.lease);
}

function holdBrowserLoginLease(site: string, lease: BrowserCdpLease): void {
  releaseBrowserLoginLease(site);
  const configured = Number(process.env.AGENTLAS_BROWSER_LOGIN_LEASE_MS);
  const timeoutMs = Number.isFinite(configured)
    ? Math.max(30_000, Math.min(30 * 60_000, Math.trunc(configured)))
    : 15 * 60_000;
  const timer = setTimeout(() => releaseBrowserLoginLease(site), timeoutMs);
  timer.unref();
  openLoginLeases.set(site, { lease, timer });
}

onHostShutdown(() => {
  for (const active of openLoginLeases.values()) {
    clearTimeout(active.timer);
    releaseBrowserCdpLease(active.lease, { scheduleShutdown: false });
  }
  openLoginLeases.clear();
  scheduleBrowserCdpIdleShutdown();
});

function ownershipReasonCode(reason: string): string {
  const known = new Set([
    "no-listener",
    "ambiguous-listeners",
    "listener-command-mismatch",
    "verified-dedicated-listener",
    "listener-and-marker-match",
    "not-inspected",
    "listener-not-ready",
  ]);
  if (known.has(reason)) return reason;
  if (reason.startsWith("adoption-race:")) {
    const nested = reason.slice("adoption-race:".length);
    return known.has(nested) ? `adoption-race:${nested}` : "adoption-race:inspection-error";
  }
  return "inspection-error";
}

function stopUnverifiedLoginChild(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid && !child.killed) child.kill("SIGTERM");
  } catch {
    // The transient Chrome process may already have handed off and exited.
  }
}

export function browserLoginArgs(profile: string, url: string): string[] {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${browserCdpPort()}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // Same stability flags as the CDP launcher so a login window opened on the
    // shared dedicated profile does not later crash the automation's browser.
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--new-window",
    url,
  ];
}

/**
 * Keep profile ownership inspection and Chrome hand-off serial. Repeated clicks
 * for the same site share one result; different sites wait a few milliseconds
 * instead of racing lsof/marker snapshots and spawning overlapping windows.
 */
export function browserOpenLogin(site: string): Promise<BrowserOpenLoginResult> {
  const norm = normalizeSite(site);
  if (!norm) {
    return Promise.resolve({ ok: false, error: "A valid HTTP(S) site address is required." });
  }
  const active = openLoginFlights.get(norm);
  if (active) return active;
  const flight = openLoginQueue.then(() => browserOpenLoginOnce(norm));
  openLoginQueue = flight.then(() => undefined, () => undefined);
  openLoginFlights.set(norm, flight);
  void flight.then(
    () => { if (openLoginFlights.get(norm) === flight) openLoginFlights.delete(norm); },
    () => { if (openLoginFlights.get(norm) === flight) openLoginFlights.delete(norm); },
  );
  return flight;
}

async function browserOpenLoginOnce(site: string): Promise<BrowserOpenLoginResult> {
  const norm = normalizeSite(site);
  const exe = resolveChromeExe();
  if (!exe) return { ok: false, error: "Agentlas 전용 브라우저 런타임이 없습니다. Agentlas를 다시 설치해 주세요." };
  let browserLease: BrowserCdpLease | null = null;
  let leaseRetained = false;
  const url = `https://${norm}`;
  const profile = ensureBrowserCdpProfilePrivate();
  let observedOwnership: BrowserCdpOwnership | null = null;
  try {
    await withBrowserCdpMaintenance(async () => {
    const portInUse = await browserCdpPortReady();
    const existingOwnership = portInUse ? await reconcileBrowserCdpOwnerWithRetry() : null;
    observedOwnership = existingOwnership;
    if (existingOwnership && existingOwnership.state !== "owned") {
      logBrowserAction({
        site: norm,
        action: "session.login_window_blocked",
        target: url,
        result: "blocked",
        meta: {
          state: existingOwnership.state,
          reasonCode: ownershipReasonCode(existingOwnership.reason),
          pid: existingOwnership.pid,
          port: browserCdpPort(),
        },
      });
      throw new Error(existingOwnership.state === "foreign"
        ? `CDP port ${browserCdpPort()} is occupied by a browser outside the Agentlas dedicated profile (${existingOwnership.reason}).`
        : `Agentlas could not verify the dedicated browser on CDP port ${browserCdpPort()} yet (${existingOwnership.reason}). Please try again.`);
    }
    const child = spawn(
      exe,
      browserLoginArgs(profile, url),
      { detached: true, stdio: "ignore" },
    );
    let spawnError: Error | null = null;
    openLoginChildren.set(norm, child);
    setBrowserSession(norm, "none");
    child.on("error", (error) => {
      spawnError = error;
      openLoginChildren.delete(norm);
      releaseBrowserLoginLease(norm);
    });
    child.on("exit", (code, signal) => {
      // Chrome can hand the URL to an already-running shared-profile process
      // and immediately exit. Process exit is therefore never login proof.
      // Only browserMarkSession(), triggered by the explicit UI button, may
      // mark the session valid.
      logBrowserAction({
        site: norm,
        action: "session.login_window_closed",
        result: code === 0 ? "closed" : `closed:${code ?? signal ?? "unknown"}`,
      });
      openLoginChildren.delete(norm);
    });
    child.unref();
    if (!portInUse) {
      let ready = false;
      let lastOwnershipReason = "listener-not-ready";
      for (let attempt = 0; attempt < 40 && !spawnError; attempt += 1) {
        if (await browserCdpPortReady()) {
          const ownership = await reconcileBrowserCdpOwnerWithRetry({ attempts: 2, delayMs: 50 });
          observedOwnership = ownership;
          lastOwnershipReason = ownership.reason;
          if (ownership.state === "owned") {
            ready = true;
            break;
          }
          if (ownership.state === "foreign") {
            stopUnverifiedLoginChild(child);
            throw new Error(`Chrome CDP listener ownership could not be verified (${ownership.reason}).`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (spawnError) throw spawnError;
      if (!ready) {
        stopUnverifiedLoginChild(child);
        throw new Error(`Chrome CDP listener ownership could not be verified (${lastOwnershipReason}).`);
      }
    }
    });
    const ownershipAfterOpen = observedOwnership as BrowserCdpOwnership | null;
    if (ownershipAfterOpen?.state === "owned" && ownershipAfterOpen.pid) {
      scheduleBrowserCdpGuardian(ownershipAfterOpen.pid);
    }
    browserLease = await acquireBrowserCdpLease("login").catch(() => null);
    if (!browserLease) {
      return { ok: false, error: "Agentlas could not reserve the dedicated browser." };
    }
    logBrowserAction({ site: norm, action: "session.login_window", target: url, result: "opened" });
    holdBrowserLoginLease(norm, browserLease);
    leaseRetained = true;
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const ownershipForLog = observedOwnership as BrowserCdpOwnership | null;
    logBrowserAction({
      site: norm,
      action: "session.login_window_failed",
      target: url,
      result: "blocked",
      meta: {
        state: ownershipForLog?.state ?? "spawn-error",
        reasonCode: ownershipForLog
          ? ownershipReasonCode(ownershipForLog.reason)
          : "spawn-error",
        pid: ownershipForLog?.pid ?? null,
        port: browserCdpPort(),
      },
    });
    return { ok: false, error };
  } finally {
    if (!leaseRetained) releaseBrowserCdpLease(browserLease);
  }
}

async function verifyXSession(): Promise<boolean> {
  if (!(await browserCdpPortReady())) return false;
  const ownership = await reconcileBrowserCdpOwnerWithRetry();
  if (ownership.state !== "owned") return false;
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${browserCdpPort()}`);
  try {
    const context = connection.contexts()[0];
    if (!context) return false;
    const cookies = await context.cookies(["https://x.com/", "https://twitter.com/"]);
    const names = new Set(cookies.map((cookie) => cookie.name));
    if (!names.has("auth_token") || !names.has("ct0")) return false;
    const page = await context.newPage();
    try {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (/\/i\/flow\/login|\/login(?:[/?#]|$)/i.test(page.url())) return false;
      return await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="primaryColumn"] [aria-label="Home timeline"]').first().isVisible({ timeout: 8_000 }).catch(() => false);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** 사용자가 UI에서 저장을 눌러도 X는 실제 전용 프로필에서 로그인된 경우에만 valid다. */
export async function browserMarkSession(site: string, status: "valid" | "expired" | "none"): Promise<{ ok: boolean; error?: string }> {
  const norm = normalizeSite(site);
  if (status === "valid" && norm === "x.com") {
    const verified = await verifyXSession().catch(() => false);
    if (!verified) {
      setBrowserSession(norm, "none");
      logBrowserAction({ site: norm, action: "session.verify", result: "not-signed-in" });
      return { ok: false, error: "X 로그인을 실제 전용 브라우저에서 확인하지 못했습니다. 열린 창에서 로그인한 뒤 다시 저장해 주세요." };
    }
  }
  setBrowserSession(norm, status);
  logBrowserAction({ site: norm, action: "session.mark", result: status });
  releaseBrowserLoginLease(norm);
  return { ok: true };
}

// ── 권한(승인 기억) ────────────────────────────────────────────
export function browserListPermissions() {
  return listBrowserPermissions();
}

export function browserRevokePermission(site: string, actionType: string): { ok: true } {
  revokeBrowserPermission(site, actionType);
  return { ok: true };
}

// ── 승인 게이트 ────────────────────────────────────────────────
export interface BrowserApprovalRequest {
  site: string;
  actionType: string; // "send" | "publish" | "delete" | "payment" | ...
  summary: string; // 사람이 읽을 한 줄(무엇을 하려는지)
  target?: string;
}
export interface BrowserApprovalOptions {
  signal?: AbortSignal;
}
export type BrowserApprovalResult = "approved" | "denied" | "cancelled" | "expired";

interface PendingApproval {
  resolve: (v: BrowserPermissionDecision | "timeout" | "cancelled") => void;
  timer: NodeJS.Timeout;
  request: BrowserApprovalLifecycleRequest;
}
const pendingApprovals = new Map<string, PendingApproval>();

export interface BrowserApprovalLifecycleRequest {
  requestId: string;
  site: string;
  actionType: string;
  summary: string;
  target: string | null;
  allowAlways: boolean;
  createdAt: number;
  expiresAt: number;
}

export type BrowserApprovalLifecycleEvent =
  | ({ status: "pending" } & BrowserApprovalLifecycleRequest)
  | {
      status: "resolved" | "expired" | "cancelled";
      requestId: string;
      decision?: BrowserPermissionDecision;
    };

const approvalLifecycleListeners = new Set<(event: BrowserApprovalLifecycleEvent) => void>();

/** DESKTOP_MOBILE_BRIDGE: renderer and authenticated phones observe one approval lifecycle. */
export function onBrowserApprovalLifecycle(
  listener: (event: BrowserApprovalLifecycleEvent) => void,
): () => void {
  approvalLifecycleListeners.add(listener);
  return () => approvalLifecycleListeners.delete(listener);
}

/**
 * Reconnect baseline for trusted projections. Returns copies so a consumer
 * cannot mutate the fail-closed approval queue or its timers.
 */
export function listPendingBrowserApprovals(now = Date.now()): BrowserApprovalLifecycleRequest[] {
  return [...pendingApprovals.values()]
    .map((pending) => pending.request)
    .filter((request) => request.expiresAt > now)
    .map((request) => ({ ...request }));
}

function emitApprovalLifecycle(event: BrowserApprovalLifecycleEvent): void {
  for (const listener of approvalLifecycleListeners) {
    try {
      listener(event);
    } catch {
      // Approval authority must remain fail-closed even if a projection drops.
    }
  }
}

function emitToRenderer(channel: string, payload: unknown): void {
  let windows: Array<{
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, payload: unknown) => void };
  }>;
  try {
    // The packaged daemon projects browser approvals to trusted phones but has
    // no Electron renderer. Delay the optional desktop surface lookup so that
    // importing the shared approval registry remains headless-safe.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as {
      BrowserWindow?: { getAllWindows?: () => typeof windows };
    };
    windows = electron.BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    return;
  }
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * 되돌릴 수 없는 브라우저 행동 전에 호출. 저장된 권한을 먼저 보고, 없으면 경량 바텀시트를
 * renderer 로 띄워 사용자 결정을 기다린다.
 *  - 결제(payment)/임의코드(unsafe-code): 승인은 절대 기억하지 않고 항상 물어봄. 단 명시 "거부"는 기억.
 *  - always: 즉시 approved(스킵). deny: 즉시 denied.
 *  - once/신규: 바텀시트 → 결과. always/deny면 기억.
 */
export async function browserRequestApproval(
  req: BrowserApprovalRequest,
  options: BrowserApprovalOptions = {},
): Promise<BrowserApprovalResult> {
  const site = normalizeSite(req.site);
  if (!site) {
    logBrowserAction({
      action: req.actionType,
      target: req.target,
      result: "denied",
      approval: "invalid-site",
    });
    return "denied";
  }
  if (options.signal?.aborted) {
    logBrowserAction({
      site,
      action: req.actionType,
      target: req.target,
      result: "cancelled",
      approval: "caller-cancelled",
    });
    return "cancelled";
  }
  const stored = getBrowserPermission(site, req.actionType);
  if (stored === "always") {
    logBrowserAction({ site, action: req.actionType, target: req.target, result: "auto", approval: "always" });
    return "approved";
  }
  if (stored === "deny") {
    logBrowserAction({ site, action: req.actionType, target: req.target, result: "blocked", approval: "deny" });
    return "denied";
  }

  // The person is driving this desktop and asked for the action. Ordinary
  // browser control (navigate/click/type/read) auto-approves so automation never
  // dead-ends waiting on an approval sheet that may not even be on screen. Only
  // genuinely irreversible external actions — a payment, or browser-run unsafe
  // code — still ask for an explicit nod.
  if (req.actionType !== "payment" && req.actionType !== "unsafe-code") {
    logBrowserAction({ site, action: req.actionType, target: req.target, result: "auto", approval: "user-driven" });
    return "approved";
  }

  const requestId = randomUUID();
  const timeoutMs = approvalTimeoutMs();
  let abortListener: (() => void) | null = null;
  const decision = await new Promise<BrowserPermissionDecision | "timeout" | "cancelled">((resolve) => {
    const createdAt = Date.now();
    const request: BrowserApprovalLifecycleRequest = {
      requestId,
      site,
      actionType: req.actionType,
      summary: req.summary,
      target: req.target ?? null,
      createdAt,
      expiresAt: createdAt + timeoutMs,
      // 위 자동승인 가드를 통과해 여기 오는 건 payment/unsafe-code 뿐이다. 그래서 예전의
      // `actionType !== "payment" && !== "unsafe-code"` 식은 항상 false인 죽은 조건이었다.
      // 이 둘은 승인을 기억해선 안 되므로(결제는 매번 확인) "항상 승인"을 제공하지 않는다 —
      // 시트에는 [한 번만]/[거부]만 뜬다. 거부는 store에 남아 다음부터 존중된다.
      allowAlways: false,
    };
    const cancel = () => {
      const pending = pendingApprovals.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingApprovals.delete(requestId);
      // Reuse the existing renderer channel with an already-expired request so
      // the sheet removes the matching queue item without widening preload IPC.
      emitToRenderer(APPROVAL_CHANNEL, { ...request, expiresAt: 0 });
      emitApprovalLifecycle({ status: "cancelled", requestId });
      resolve("cancelled");
    };
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      emitApprovalLifecycle({ status: "expired", requestId });
      resolve("timeout"); // 이번 요청만 fail-closed; 영구 deny로 저장하지 않는다.
    }, timeoutMs);
    pendingApprovals.set(requestId, { resolve, timer, request });
    emitToRenderer(APPROVAL_CHANNEL, request);
    emitApprovalLifecycle({ status: "pending", ...request });
    abortListener = cancel;
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
  if (abortListener) options.signal?.removeEventListener("abort", abortListener);

  if (decision === "timeout") {
    logBrowserAction({
      site,
      action: req.actionType,
      target: req.target,
      result: "denied",
      approval: "timeout",
    });
    return "expired";
  }
  if (decision === "cancelled") {
    logBrowserAction({
      site,
      action: req.actionType,
      target: req.target,
      result: "cancelled",
      approval: "caller-cancelled",
    });
    return "cancelled";
  }

  // 명시적 결정만 기억(once는 저장 안 됨 — store에서 가드).
  // payment/unsafe-code는 "거부"만 영속된다: 승인 캐시는 금지지만, 사용자가 막은 사이트를
  // 매번 다시 묻지 않기 위해 deny는 남긴다. 취소는 browser:revokePermission.
  setBrowserPermission(site, req.actionType, decision);
  const approved = decision === "always" || decision === "once";
  logBrowserAction({
    site,
    action: req.actionType,
    target: req.target,
    result: approved ? "approved" : "denied",
    approval: decision,
  });
  return approved ? "approved" : "denied";
}

/** renderer 바텀시트가 사용자의 선택(once/always/deny)을 돌려준다. */
export function browserResolveApproval(
  requestId: string,
  decision: BrowserPermissionDecision,
): { ok: boolean } {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return { ok: false };
  clearTimeout(pending.timer);
  pendingApprovals.delete(requestId);
  emitApprovalLifecycle({ status: "resolved", requestId, decision });
  pending.resolve(decision); // 원본 once/always/deny 그대로 → requestApproval이 기억/판정
  return { ok: true };
}

// ── 로그 ───────────────────────────────────────────────────────
export function browserListLogs(limit?: number): BrowserActionLogRow[] {
  return listBrowserActionLogs(limit ?? 500);
}
