// Browser 기능 핸들러 (메인 프로세스).
//
// 범용 브라우저 조작(agentlas-browser CDP)을 위한: 사이트 자격증명 볼트, 전용 프로필 로그인,
// 세션 상태, 되돌릴 수 없는 행동 승인 게이트(경량 바텀시트), 날짜별 사용 로그.
//
// 보안: 비밀번호 평문은 keytar(secrets/vault.ts)에만. renderer 로는 has_password 만 나간다.
// 승인 게이트: 결제(payment)는 매번 확인. 그 외는 "한 번만 / 항상 승인 / 거부", always만 기억.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  browserCdpProfilePath,
  browserCdpPort,
  resolveChromeExe,
} from "../mcp-tools/browser-cdp-launcher";
import {
  listBrowserSites,
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
const APPROVAL_TIMEOUT_MS = 120_000;

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
export function browserListSites(): BrowserSiteRow[] {
  return listBrowserSites();
}

export async function browserSaveSite(input: {
  site: string;
  label?: string | null;
  username?: string | null;
  password?: string | null;
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
// 창을 닫으면 세션을 valid 로 기록(쿠키는 전용 프로필에 영속 → 이후 자동화가 재사용).
const openLoginChildren = new Map<string, ReturnType<typeof spawn>>();

export async function browserOpenLogin(site: string): Promise<{ ok: boolean; error?: string }> {
  const norm = normalizeSite(site);
  const exe = resolveChromeExe();
  if (!exe) return { ok: false, error: "Chrome or Edge executable could not be found." };
  const url = norm ? `https://${norm}` : "about:blank";
  const profile = browserCdpProfilePath();
  try {
    const child = spawn(
      exe,
      [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session=false",
        "--disable-session-crashed-bubble",
        url,
      ],
      { detached: true, stdio: "ignore" },
    );
    openLoginChildren.set(norm, child);
    setBrowserSession(norm, "none");
    child.on("exit", () => {
      // 창을 닫으면 로그인했다고 보고 세션 valid 로 기록(best-effort).
      setBrowserSession(norm, "valid");
      logBrowserAction({ site: norm, action: "session.capture", result: "valid" });
      openLoginChildren.delete(norm);
    });
    child.unref();
    logBrowserAction({ site: norm, action: "session.login_window", target: url, result: "opened" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 사용자가 UI에서 "로그인 완료"를 누르면 즉시 세션을 valid 로 확정(창 닫힘 이벤트 대기 없이). */
export function browserMarkSession(site: string, status: "valid" | "expired" | "none"): { ok: true } {
  setBrowserSession(site, status);
  logBrowserAction({ site, action: "session.mark", result: status });
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
export type BrowserApprovalResult = "approved" | "denied";

interface PendingApproval {
  resolve: (v: BrowserPermissionDecision) => void;
  timer: NodeJS.Timeout;
}
const pendingApprovals = new Map<string, PendingApproval>();

function emitToRenderer(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
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
 *  - 결제(payment): 저장 무시, 항상 물어봄.
 *  - always: 즉시 approved(스킵). deny: 즉시 denied.
 *  - once/신규: 바텀시트 → 결과. always/deny면 기억.
 */
export async function browserRequestApproval(
  req: BrowserApprovalRequest,
): Promise<BrowserApprovalResult> {
  const site = normalizeSite(req.site);
  const stored = getBrowserPermission(site, req.actionType);
  if (stored === "always") {
    logBrowserAction({ site, action: req.actionType, target: req.target, result: "auto", approval: "always" });
    return "approved";
  }
  if (stored === "deny") {
    logBrowserAction({ site, action: req.actionType, target: req.target, result: "blocked", approval: "deny" });
    return "denied";
  }

  const requestId = randomUUID();
  const decision = await new Promise<BrowserPermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve("deny"); // 응답 없으면 안전하게 거부
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(requestId, { resolve, timer });
    emitToRenderer(APPROVAL_CHANNEL, {
      requestId,
      site,
      actionType: req.actionType,
      summary: req.summary,
      target: req.target ?? null,
      // 결제는 "항상 승인" 옵션을 숨긴다(매번 확인 강제).
      allowAlways: req.actionType !== "payment",
    });
  });

  // 결정 기억(once/payment는 저장 안 됨 — store에서 가드).
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
  pending.resolve(decision); // 원본 once/always/deny 그대로 → requestApproval이 기억/판정
  return { ok: true };
}

// ── 로그 ───────────────────────────────────────────────────────
export function browserListLogs(limit?: number): BrowserActionLogRow[] {
  return listBrowserActionLogs(limit ?? 500);
}
