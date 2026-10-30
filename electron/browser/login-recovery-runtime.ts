/*
 * 로그인 복구 사다리의 실제 손발 — 저장소 측정, 겨냥 가져오기, 다시 읽기, 카드, 세션 감시.
 * 판정과 순서는 login-recovery.ts(순수)에 있고, 여기서는 그 결정을 실행만 한다.
 *
 * 값 경계: 측정은 사용 중인 네이티브 세션 또는 쿠키 DB 사본에서 이름·도메인·만료만 고른다.
 * 가져오기는 기존 복호화 경로(decryptMacSourceCookies)를 그대로 쓰고 값은 메모리에서 브라우저로만
 * 간다. 로그·사건·알림에는 수치와 사유 코드만 실린다. Login Data·비밀번호는 읽지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Session } from "electron";
import type { McpInvocationEvent } from "../../shared/types";
import { registrableDomain } from "../../shared/registrable-domain";
import type { NativeBrowserRelayGrant } from "./native-cdp-relay";
import type { BrowserCookieSurface, CookieMetadata } from "./login-wall";
import { automaticRecoveryDestination, detectLoginWall, recoveryCookieDomains, sessionCookieNamesFor } from "./login-wall";
import { productionVaultSource, vaultFillSignIn } from "./vault-login";
import {
  createLoginRecoveryLadder,
  type LoginRecoveryContext,
  type LoginRecoveryDeps,
  type LoginRecoveryEvent,
  type LoginRecoveryLadder,
  type LoginRecoveryOutcome,
  type LoginPrerequisiteRef,
  type OwnerLoginCard,
  type TargetedImportReport,
} from "./login-recovery";

// Lazy on purpose: the background service runs the result-boundary login-wall check (mcp/client) and has no
// `electron` module. A top-level import failed every daemon-run browser and computer-use result with
// MODULE_NOT_FOUND (production 1.3.5, 2026-10-12, diagnostics/mcp-proxy.log result_withheld). Only Main reaches
// the session calls below; the daemon goes through the native grant's broker first.
const electronSession = {
  fromPartition: (partition: string): Session => (require("electron") as typeof import("electron")).session.fromPartition(partition),
};
const { WebSocket } = require("ws") as { WebSocket: new (url: string, options?: { perMessageDeflate?: boolean; maxPayload?: number }) => {
  on(event: "open" | "close" | "error", listener: (...args: unknown[]) => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
} };

const NATIVE_PARTITION = "persist:agentlas-browser-default";
const WATCH_LIMIT_MS = 6 * 60 * 60 * 1000;

function consentDomains(domains: readonly string[]): Promise<{ profileId: string; domains: string[] } | null> {
  return import("./credential-sync").then(({ getBrowserCredentialConsent }) => {
    const consent = getBrowserCredentialConsent();
    if (!consent.granted || !consent.profileId) return null;
    const allowed = new Set(consent.domains);
    const scoped = [...new Set(domains.map((d) => registrableDomain(d)).filter((d) => d && allowed.has(d)))];
    return scoped.length ? { profileId: consent.profileId, domains: scoped } : null;
  });
}

async function readStore(surface: BrowserCookieSurface, domains: readonly string[]): Promise<CookieMetadata[] | null> {
  const recoveryDomains = recoveryCookieDomains(domains);
  if (surface === "native-partition") {
    // The live session is authoritative, including an empty store which may not yet have a SQLite file.
    try {
      const rows = await electronSession.fromPartition(NATIVE_PARTITION).cookies.get({});
      if (rows.some((cookie) => !cookie.domain)) return null;
      const roots = new Set(recoveryDomains);
      return rows.filter((cookie) => roots.has(registrableDomain(cookie.domain!))).map((cookie) => ({
        domain: cookie.domain!, name: cookie.name,
        expires: cookie.session === true ? null : typeof cookie.expirationDate === "number" ? cookie.expirationDate : null,
      }));
    } catch { return null; }
  }
  const { readCookieStoreMetadata, dedicatedCookieStoreFile } = await import("./credential-import");
  const file = dedicatedCookieStoreFile();
  return file ? readCookieStoreMetadata(file, recoveryDomains) : null;
}

async function readSource(domains: readonly string[]): Promise<CookieMetadata[] | null> {
  const { getBrowserCredentialConsent } = await import("./credential-sync");
  const consent = getBrowserCredentialConsent();
  if (!consent.granted || !consent.profileId) return null;
  const { readCookieStoreMetadata, sourceCookieStoreForProfile } = await import("./credential-import");
  const file = sourceCookieStoreForProfile(consent.profileId);
  return file ? readCookieStoreMetadata(file, domains) : null;
}

// ── 전용 크롬(CDP) — 살아 있는 브라우저를 닫지 않고 그 자리에 넣는다 ─────────────────
type CdpPageTarget = { id: string; url: string; webSocketDebuggerUrl: string };

function loopbackWs(value: unknown, port: number): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && Number(url.port) === port ? url.toString() : null;
  } catch { return null; }
}

async function cdpPages(): Promise<CdpPageTarget[]> {
  const { browserCdpPort } = await import("../mcp-tools/browser-cdp-launcher");
  const { fetchCdpJson } = await import("./native-session-cookie-import");
  const port = browserCdpPort();
  const list = await fetchCdpJson(port, "/json/list");
  if (!Array.isArray(list)) return [];
  const out: CdpPageTarget[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    const ws = loopbackWs(entry?.webSocketDebuggerUrl, port);
    if (entry?.type !== "page" || typeof entry.id !== "string" || typeof entry.url !== "string" || !ws) continue;
    out.push({ id: entry.id, url: entry.url, webSocketDebuggerUrl: ws });
  }
  return out;
}

/** Main-only direct-import custody; never accepted from tool/model JSON. */
export interface LoginImportControl { signal: AbortSignal; assertCurrent(): void }
export interface GuardedLoginImportReport {
  state: TargetedImportReport["state"] | "cancelled" | "unknown";
  effect: "not-started" | "imported" | "unknown";
  /** Known acknowledgements, not total effects when effect is unknown. */
  acknowledgedWritten: number;
}
interface LoginImportScope {
  control: LoginImportControl;
  consentCurrent?: () => boolean;
  effect: GuardedLoginImportReport["effect"];
  acknowledgedWritten: number;
}
function assertLoginImportCurrent(scope?: LoginImportScope): void {
  if (!scope) return;
  if (scope.control.signal.aborted) throw scope.control.signal.reason ?? new Error("login-import-cancelled");
  scope.control.assertCurrent();
  if (scope.consentCurrent && !scope.consentCurrent()) throw new Error("login-import-consent-changed");
}
/** Guarded direct lane only; existing observer/maintenance callers keep their contracts. */
export async function guardedLoginTargetedImport(input: { domains: string[]; surface: BrowserCookieSurface }, control: LoginImportControl): Promise<GuardedLoginImportReport> {
  const scope: LoginImportScope = { control, effect: "not-started", acknowledgedWritten: 0 };
  try {
    assertLoginImportCurrent(scope);
    const report = await targetedImport(input, scope);
    assertLoginImportCurrent(scope);
    return { state: scope.effect === "unknown" ? "unknown" : report.state, effect: scope.effect, acknowledgedWritten: scope.acknowledgedWritten };
  } catch {
    let cancelled = false;
    try { assertLoginImportCurrent(scope); } catch { cancelled = true; }
    return { state: scope.effect === "unknown" ? "unknown" : cancelled ? "cancelled" : "unknown",
      effect: scope.effect, acknowledgedWritten: scope.acknowledgedWritten };
  }
}

/** One CDP session: send commands, optionally wait for one event, then close. */
async function cdpSession<T>(wsUrl: string, work: (call: (method: string, params?: Record<string, unknown>) => Promise<unknown>, waitFor: (event: string, timeoutMs: number) => Promise<boolean>) => Promise<T>, scope?: LoginImportScope): Promise<T> {
  assertLoginImportCurrent(scope);
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  // All recovery CDP commands (including evaluation, reload, and cookie feeds)
  // share this boundary. An existing answering port is never sufficient proof.
  if (!loopbackWs(wsUrl, launcher.browserCdpPort())
    || (await launcher.reconcileBrowserCdpOwnerWithRetry()).state !== "owned") throw new Error("browser-ownership-unconfirmed");
  assertLoginImportCurrent(scope);
  return new Promise<T>((resolve, reject) => {
    assertLoginImportCurrent(scope);
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; acknowledged?: () => void }>();
    const waiters = new Map<string, Set<() => void>>();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => end(new Error("login-import-cancelled"));
    const end = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      scope?.control.signal.removeEventListener("abort", aborted);
      for (const entry of pending.values()) entry.reject(new Error("cdp-session-closed"));
      pending.clear();
      try { socket.close(); } catch { /* closed */ }
      if (error) reject(error); else resolve(value as T);
    };
    const call = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((res, rej) => {
      const id = ++seq;
      const acknowledged = scope && method === "Storage.setCookies" && Array.isArray(params.cookies)
        ? () => { scope.effect = "imported"; scope.acknowledgedWritten += (params.cookies as unknown[]).length; } : undefined;
      pending.set(id, { resolve: res, reject: rej, acknowledged });
      try {
        const message = JSON.stringify({ id, method, params });
        if (settled) throw new Error("cdp-session-closed");
        assertLoginImportCurrent(scope);
        if (scope && method === "Storage.setCookies") scope.effect = "unknown";
        socket.send(message);
      } catch (error) { pending.delete(id); rej(error as Error); }
    });
    const waitFor = (event: string, timeoutMs: number) => new Promise<boolean>((res) => {
      const set = waiters.get(event) ?? new Set<() => void>();
      waiters.set(event, set);
      const done = () => { clearTimeout(timer); set.delete(done); res(true); };
      const timer = setTimeout(() => { set.delete(done); res(false); }, timeoutMs);
      set.add(done);
    });
    socket.on("message", (data: unknown) => {
      let message: { id?: number; result?: unknown; error?: { code?: number }; method?: string };
      try { message = JSON.parse(String(data)); } catch { return; }
      if (typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(`cdp-error:${message.error.code ?? "unknown"}`));
        else { entry.acknowledged?.(); entry.resolve(message.result); }
      } else if (typeof message.method === "string") {
        for (const waiter of [...(waiters.get(message.method) ?? [])]) waiter();
      }
    });
    socket.on("error", () => end(new Error("cdp-socket-error")));
    socket.on("close", () => end(new Error("cdp-socket-closed")));
    socket.on("open", () => {
      if (settled) return;
      try {
        assertLoginImportCurrent(scope);
        void work(call, waitFor).then((value) => end(null, value), (error) => end(error instanceof Error ? error : new Error(String(error))));
      } catch (error) { end(error instanceof Error ? error : new Error(String(error))); }
    });
    timer = setTimeout(() => end(new Error("cdp-session-timeout")), 45_000);
    timer.unref?.();
    scope?.control.signal.addEventListener("abort", aborted, { once: true });
    try { assertLoginImportCurrent(scope); } catch (error) { end(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function reloadCdpPage(target: CdpPageTarget): Promise<string | null> {
  try {
    const completed = await cdpSession(target.webSocketDebuggerUrl, async (call, waitFor) => {
      await call("Page.enable");
      const loaded = waitFor("Page.loadEventFired", 20_000);
      await call("Page.reload", { ignoreCache: false });
      return loaded;
    });
    if (!completed) return null;
  } catch { return null; }
  // Give same-page redirects (accounts → site) a beat, then read where the page actually is.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const page = (await cdpPages()).find((entry) => entry.id === target.id);
  if (!page) return null;
  const status = await evaluateCdpPage(page,
    "(() => { const n = performance.getEntriesByType('navigation')[0]; return typeof n?.responseStatus === 'number' ? n.responseStatus : null; })()",
  ).catch(() => null);
  return typeof status === "number" && status >= 200 && status < 300 ? page.url : null;
}

/** Main-only evaluation in a dedicated-Chrome page (vault fill, structural probes). Returns the JSON value. */
export async function evaluateCdpPage(target: { webSocketDebuggerUrl: string }, expression: string): Promise<unknown> {
  return cdpSession(target.webSocketDebuggerUrl, async (call) => {
    const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (out?.exceptionDetails) throw new Error("cdp-evaluate-exception");
    return out?.result?.value ?? null;
  });
}

/** The dedicated Chrome's page targets (loopback only), for the fallback ladder's structural checks. */
export function dedicatedBrowserPages(): Promise<CdpPageTarget[]> {
  return cdpPages().catch(() => []);
}

/**
 * Screen rectangles of the dedicated Chrome's windows, measured from that browser itself (CDP
 * Browser.getWindowForTarget). Used to enforce "computer use on our Chrome window only" (window-scope.ts).
 */
export async function dedicatedBrowserWindowBounds(): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const { browserCdpPort } = await import("../mcp-tools/browser-cdp-launcher");
  const { fetchCdpJson } = await import("./native-session-cookie-import");
  const port = browserCdpPort();
  const version = await fetchCdpJson(port, "/json/version") as { webSocketDebuggerUrl?: unknown } | null;
  const ws = loopbackWs(version?.webSocketDebuggerUrl, port);
  if (!ws) return [];
  const pages = await cdpPages();
  return cdpSession(ws, async (call) => {
    const seen = new Set<number>();
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const page of pages) {
      const found = await call("Browser.getWindowForTarget", { targetId: page.id }).catch(() => null) as
        { windowId?: number; bounds?: { left?: number; top?: number; width?: number; height?: number; windowState?: string } } | null;
      const b = found?.bounds;
      if (!found || typeof found.windowId !== "number" || seen.has(found.windowId) || !b || b.windowState === "minimized") continue;
      if ([b.left, b.top, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v)) && (b.width ?? 0) > 0 && (b.height ?? 0) > 0) {
        seen.add(found.windowId);
        out.push({ x: b.left!, y: b.top!, width: b.width!, height: b.height! });
      }
    }
    return out;
  });
}

/** Wait (bounded) for a dedicated-Chrome page to settle after a submit, then read where it is. */
async function settledCdpPage(target: CdpPageTarget): Promise<string | null> {
  const deadline = Date.now() + 15_000;
  let last = target.url;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  while (Date.now() < deadline) {
    const page = (await cdpPages().catch(() => [] as CdpPageTarget[])).find((entry) => entry.id === target.id);
    if (!page) return null;
    const state = await evaluateCdpPage(page, "document.readyState").catch(() => null);
    if (page.url === last && state === "complete") return page.url;
    last = page.url;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return last;
}

/** Only an explicitly requested Studio channel can establish channel identity. */
function requestedStudioChannel(value: string | null | undefined, depth = 0): string | null {
  if (!value || depth > 4 || value.length > 8_192) return null;
  try {
    let candidate = value;
    let url: URL | null = null;
    for (let attempt = 0; attempt < 3 && !url; attempt += 1) {
      try { url = new URL(candidate); }
      catch { const decoded = decodeURIComponent(candidate); if (decoded === candidate) return null; candidate = decoded; }
    }
    if (!url) return null;
    if (url.hostname.toLowerCase() === "studio.youtube.com") {
      const match = /^\/channel\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(url.pathname);
      if (match) return match[1];
    }
    for (const key of ["continue", "followup", "next", "redirect_uri", "url"]) {
      const nested = requestedStudioChannel(url.searchParams.get(key), depth + 1);
      if (nested) return nested;
    }
  } catch { /* unknown target is not an account assertion */ }
  return null;
}

// This executes only in the already-authorized guest. It returns a boolean, never page text or credentials.
const GOOGLE_SESSION_EVIDENCE = String.raw`(() => {
  const host = location.hostname.toLowerCase();
  const visible = (element) => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const findVisible = (selectors) => selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(visible));
  const text = (document.body?.innerText || '').slice(0, 8000);
  const denied = /you (?:don't|do not) have (?:the )?(?:required )?(?:access|permission)|access (?:is )?denied|permission denied|접근\s*권한이?\s*없|권한이?\s*없/i.test(text);
  if (denied || document.querySelector('input[type="password"]')) return false;
  const account = findVisible(['ytcp-account-button', '#avatar-btn', 'a[href*="accounts.google.com/SignOutOptions"]',
    '[aria-label^="Google Account:" i]', '[aria-label^="Google 계정:"]', 'button[aria-label="Account" i]', 'button[aria-label="계정"]']);
  if (!account) return false;
  if (host === 'studio.youtube.com') {
    const nav = document.querySelector('ytcp-navigation-drawer, ytcp-sidebar, #left-menu, #navigation-drawer');
    if (!visible(nav)) return false;
    if (expectedChannel) {
      const markers = nav.querySelectorAll('[data-channel-id], a#channel-logo, a#channel-avatar, a[aria-label="Your channel" i], a[aria-label="내 채널"]');
      const matches = Array.from(markers).some((marker) => {
        if (!visible(marker)) return false;
        if (marker.getAttribute('data-channel-id') === expectedChannel) return true;
        try {
          const href = marker.getAttribute('href');
          if (!href) return false;
          const link = new URL(href, location.href);
          return (link.hostname === 'youtube.com' || link.hostname.endsWith('.youtube.com'))
            && link.pathname === '/channel/' + expectedChannel;
        } catch { return false; }
      });
      if (!matches) return false;
    }
    return true;
  }
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'google.com' || host.endsWith('.google.com') || host === 'google.co.kr' || host.endsWith('.google.co.kr');
})()`;

/** A URL or HTTP 200 is not evidence of a signed-in account or the requested Studio channel. */
export async function verifyGoogleBrowserSession(
  evaluate: (expression: string) => Promise<unknown>,
  input: { site: string; url: string; returnUrl?: string | null },
): Promise<boolean> {
  try {
    const url = new URL(input.url);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (input.site !== "youtube.com" && input.site !== "google.com") return false;
    if (input.site === "youtube.com" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return false;
    if (input.site === "google.com" && host !== "google.com" && !host.endsWith(".google.com")
      && host !== "google.co.kr" && !host.endsWith(".google.co.kr")) return false;
    const expectedChannel = requestedStudioChannel(input.returnUrl);
    if (expectedChannel && (host !== "studio.youtube.com"
      || !new RegExp(`^/channel/${expectedChannel}(?:/|$)`, "u").test(url.pathname))) return false;
    // Bind the DOM evidence to the exact page measured by reload, not a later navigation.
    const measuredUrl = JSON.stringify(url.href).replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
    return await evaluate(`(() => { if (location.href !== ${measuredUrl}) return false; const expectedChannel = ${JSON.stringify(expectedChannel)}; return ${GOOGLE_SESSION_EVIDENCE}; })()`) === true;
  } catch { return false; }
}

type CdpCookieParam = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number };

/** Feed cookies into the running, owned dedicated browser without closing it. */
async function feedLiveDedicatedBrowser(cookies: CdpCookieParam[], domains: readonly string[], scope?: LoginImportScope): Promise<TargetedImportReport | null> {
  assertLoginImportCurrent(scope);
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  assertLoginImportCurrent(scope);
  const ready = await launcher.browserCdpPortReady();
  assertLoginImportCurrent(scope);
  if (!ready) return null;
  const owned = await launcher.reconcileBrowserCdpOwnerWithRetry();
  assertLoginImportCurrent(scope);
  if (owned.state !== "owned") return { state: "destination-unreadable", written: 0 };
  const lease = await launcher.acquireBrowserCdpLease("login-recovery").catch(() => null);
  if (!lease) { assertLoginImportCurrent(scope); return null; }
  let writeDispatched = false;
  try {
    assertLoginImportCurrent(scope);
    const { fetchCdpJson } = await import("./native-session-cookie-import");
    assertLoginImportCurrent(scope);
    const port = launcher.browserCdpPort();
    const version = await fetchCdpJson(port, "/json/version") as { webSocketDebuggerUrl?: unknown } | null;
    assertLoginImportCurrent(scope);
    const ws = loopbackWs(version?.webSocketDebuggerUrl, port);
    if (!ws) return null;
    const report = await cdpSession(ws, async (call): Promise<TargetedImportReport> => {
      const result = await call("Storage.getCookies") as { cookies?: Array<{ domain?: string; name?: string; expires?: number }> } | null;
      if (!result || !Array.isArray(result.cookies) || result.cookies.some((cookie) => !cookie.domain || !cookie.name)) {
        return { state: "destination-unreadable", written: 0 };
      }
      const state = automaticRecoveryDestination(result.cookies.map((cookie) => ({
        domain: cookie.domain!, name: cookie.name!, expires: typeof cookie.expires === "number" && cookie.expires > 0 ? cookie.expires : null,
      })), domains, Date.now() / 1_000);
      if (state !== "empty") return { state: state === "protected" ? "destination-protected" : "destination-unreadable", written: 0 };
      assertLoginImportCurrent(scope);
      writeDispatched = true;
      await call("Storage.setCookies", { cookies });
      return { state: "imported", written: cookies.length };
    }, scope);
    assertLoginImportCurrent(scope);
    return report;
  } catch (error) {
    // A guarded transport failure/cancel is never permission for maintenance import.
    if (scope) throw error;
    return { state: writeDispatched ? "effect-unknown" : "destination-unreadable", written: 0 };
  } finally {
    launcher.releaseBrowserCdpLease(lease);
  }
}

// ── 겨냥 가져오기: 기존 로그인이 없는 실제 대상 저장소만 채운다 ──────────────────────────────
async function targetedImport(input: { domains: string[]; surface: BrowserCookieSurface; isCurrent?: () => boolean }, custody?: LoginImportScope): Promise<TargetedImportReport> {
  assertLoginImportCurrent(custody);
  const { browserCredentialConsentRevision, getBrowserCredentialConsent } = await import("./credential-sync");
  assertLoginImportCurrent(custody);
  const revision = browserCredentialConsentRevision();
  const scope = await consentDomains(input.domains);
  assertLoginImportCurrent(custody);
  if (!scope || input.domains.some((domain) => !scope.domains.includes(registrableDomain(domain)))) return { state: "not-consented", written: 0 };
  const isCurrent = () => {
    const consent = getBrowserCredentialConsent();
    return browserCredentialConsentRevision() === revision && (input.isCurrent?.() ?? true)
      && consent.granted && consent.profileId === scope.profileId
      && scope.domains.every((domain) => consent.domains.includes(domain));
  };
  if (custody) custody.consentCurrent = isCurrent;
  assertLoginImportCurrent(custody);
  if (!isCurrent()) return { state: "not-consented", written: 0 };
  const destinationState = automaticRecoveryDestination(await readStore(input.surface, input.domains), input.domains, Date.now() / 1_000);
  assertLoginImportCurrent(custody);
  if (destinationState !== "empty") return { state: destinationState === "protected" ? "destination-protected" : "destination-unreadable", written: 0 };
  const credential = await import("./credential-import");
  assertLoginImportCurrent(custody);
  if (!isCurrent()) return { state: "not-consented", written: 0 };
  const source = await credential.readSourceSessionCookies(scope.profileId, scope.domains);
  if (!source.ok) {
    if (source.reason === "unsupported-platform" && input.surface === "native-partition") {
      // Windows and Linux have no direct source reader, so this was the only way their login wall ever recovered. The
      // destination was just measured empty above, and the native partition is the app's own: nothing live is closed.
      // (The dedicated Chrome is left alone: the maintenance importer may close it under a running session.)
      assertLoginImportCurrent(custody);
      if (custody) custody.effect = "unknown";
      const result = await credential.importBrowserCredentials(scope.profileId, scope.domains, { automatic: false, destination: "native" });
      if (custody && result.ok) { custody.acknowledgedWritten += result.cookiesAdded + (result.cookiesUpdated ?? 0); custody.effect = "imported"; }
      assertLoginImportCurrent(custody);
      return result.ok ? { state: "imported", written: result.cookiesAdded + (result.cookiesUpdated ?? 0) } : { state: "failed", written: 0 };
    }
    // The maintenance importer may close the owned browser. An automatic recovery cannot
    // interrupt a user's live session merely because the direct reader is unavailable.
    return { state: source.reason === "unsupported-platform" ? "unsupported" : "failed", written: 0 };
  }
  try {
    if (input.surface === "native-partition") {
      const { writeNativeBrowserCookies } = await import("./native-session-cookie-import");
      assertLoginImportCurrent(custody);
      const nativeCurrent = () => { try { assertLoginImportCurrent(custody); return isCurrent(); } catch { return false; } };
      const nativeSession = electronSession.fromPartition(NATIVE_PARTITION);
      let unacknowledgedWrites = 0;
      // Observe the real destination ACK, even when the helper later throws after
      // Stop. Its private error/count shape is neither parsed nor treated as proof.
      const destination = custody ? {
        cookies: new Proxy(nativeSession.cookies, {
          get(target, key) {
            if (key === "set") return async (details: Parameters<typeof target.set>[0]) => {
              assertLoginImportCurrent(custody);
              unacknowledgedWrites += 1;
              custody.effect = "unknown";
              await target.set.call(target, details);
              unacknowledgedWrites -= 1;
              custody.acknowledgedWritten += 1;
              custody.effect = unacknowledgedWrites > 0 ? "unknown" : "imported";
            };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        flushStorageData: () => { assertLoginImportCurrent(custody); return nativeSession.flushStorageData(); },
      } : nativeSession;
      const counts = await writeNativeBrowserCookies(source.cookies.map((cookie) => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        expires: cookie.expires ?? -1, session: cookie.expires === undefined,
        httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
      })), destination, Date.now() / 1_000,
      { isCurrent: custody ? nativeCurrent : isCurrent, recoveryImport: true, recoveryDomains: input.domains });
      // Successful native sets were already counted by the adapter exactly once.
      if (custody && counts.skipped.writeFailed > 0) custody.effect = "unknown";
      assertLoginImportCurrent(custody);
      return counts.recoveryState ? { state: counts.recoveryState === "protected" ? "destination-protected" : "destination-unreadable", written: counts.imported }
        : counts.skipped.writeFailed > 0 ? { state: "effect-unknown", written: counts.imported }
        : counts.imported > 0 ? { state: "imported", written: counts.imported } : { state: "failed", written: 0 };
    }
    const params: CdpCookieParam[] = source.cookies.map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    }));
    const live = await feedLiveDedicatedBrowser(params, input.domains, custody);
    if (live !== null) return live;
  } finally {
    source.wipe();
  }
  // No live, owned destination: preserve it and wait for the ordinary sign-in/Connect flow.
  return { state: "destination-unreadable", written: 0 };
}

async function feedStore(input: { from: BrowserCookieSurface; to: BrowserCookieSurface; domains: string[] }): Promise<TargetedImportReport> {
  const scope = await consentDomains(input.domains);
  if (!scope) return { state: "not-consented", written: 0 };
  if (input.from === "cdp-profile" && input.to === "native-partition") {
    const { syncConnectBrowserSession } = await import("./native-session-cookie-import");
    const state = automaticRecoveryDestination(await readStore(input.to, input.domains), input.domains, Date.now() / 1_000);
    if (state !== "empty") return { state: state === "protected" ? "destination-protected" : "destination-unreadable", written: 0 };
    const receipt = await syncConnectBrowserSession({ domains: scope.domains, reason: "refresh" });
    return receipt.ok && receipt.imported > 0 ? { state: "imported", written: receipt.imported } : { state: "failed", written: 0 };
  }
  if (input.from === "native-partition" && input.to === "cdp-profile") {
    const partition = electronSession.fromPartition(NATIVE_PARTITION);
    const params: CdpCookieParam[] = [];
    for (const domain of scope.domains) {
      for (const cookie of await partition.cookies.get({ domain })) {
        if (!cookie.domain) continue;
        const sameSite = cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "lax" ? "Lax" : cookie.sameSite === "no_restriction" ? "None" : undefined;
        params.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path ?? "/",
          secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
          ...(sameSite ? { sameSite } : {}), ...(typeof cookie.expirationDate === "number" ? { expires: cookie.expirationDate } : {}) });
      }
    }
    if (params.length === 0) return { state: "failed", written: 0 };
    const written = await feedLiveDedicatedBrowser(params, input.domains);
    return written ?? { state: "failed", written: 0 };
  }
  return { state: "unsupported", written: 0 };
}

// ── 세션 감시 — 이벤트 기반 ─────────────────────────────────────────────────
function watchSession(input: { surface: BrowserCookieSurface; domains: string[]; since: number; onRestored: () => void }): () => void {
  const matches = (domain: string, name: string) => input.domains.some((target) => {
    const names = sessionCookieNamesFor(target);
    const host = domain.replace(/^\./u, "").toLowerCase();
    return Boolean(names?.includes(name)) && registrableDomain(host) === registrableDomain(target);
  });
  let stopped = false;
  const cleanups: Array<() => void> = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* already gone */ } }
  };
  const restored = () => { if (!stopped) { stop(); input.onRestored(); } };
  const limit = setTimeout(stop, WATCH_LIMIT_MS);
  limit.unref?.();
  cleanups.push(() => clearTimeout(limit));

  if (input.surface === "native-partition") {
    const cookies = electronSession.fromPartition(NATIVE_PARTITION).cookies;
    const onChanged = (_event: unknown, cookie: { domain?: string; name: string }, _cause: string, removed: boolean) => {
      if (!removed && cookie.domain && matches(cookie.domain, cookie.name)) restored();
    };
    cookies.on("changed", onChanged);
    cleanups.push(() => cookies.removeListener("changed", onChanged));
    return stop;
  }

  // Dedicated Chrome persists cookies to its SQLite DB; watch that directory (no polling).
  void import("./credential-import").then(({ dedicatedCookieStoreFile, readCookieStoreMetadata }) => {
    if (stopped) return;
    const file = dedicatedCookieStoreFile();
    if (!file) return;
    let debounce: NodeJS.Timeout | null = null;
    const check = () => {
      debounce = null;
      const rows = readCookieStoreMetadata(file, input.domains) ?? [];
      if (rows.some((row) => matches(row.domain, row.name) && (row.updatedAt ?? 0) * 1_000 > input.since
        && (row.expires === null || row.expires * 1_000 > Date.now()))) restored();
    };
    try {
      const watcher = fs.watch(path.dirname(file), (_kind, name) => {
        if (stopped || (name && !String(name).startsWith(path.basename(file)))) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(check, 1_500);
      });
      cleanups.push(() => { watcher.close(); if (debounce) clearTimeout(debounce); });
    } catch { /* watch unavailable: the owner card still stands */ }
  }).catch(() => undefined);
  return stop;
}

function record(event: LoginRecoveryEvent, ctx: LoginRecoveryContext): void {
  // main.log line is machine-readable (schema + step + reason codes + counts; never values).
  console.info("[login-recovery]", JSON.stringify(event));
  if (!ctx.runId) return;
  void import("../store/run-events").then(({ tryRecordRunEvent }) => {
    tryRecordRunEvent({ runId: ctx.runId!, chatId: ctx.chatId ?? null, nodeId: ctx.nodeId ?? null,
      kind: "browser_login_recovery", payload: { ...event } });
  }).catch(() => undefined);
}

async function openSignInFallback(card: OwnerLoginCard): Promise<void> {
  if (card.surface !== "cdp-profile") return;
  // The dedicated browser is headless by default; this is the one intentional headful sign-in window.
  const { browserOpenLogin } = await import("./connect");
  await browserOpenLogin(card.site);
}

export function productionLoginRecoveryDeps(): LoginRecoveryDeps {
  return {
    now: () => Date.now(),
    readStore,
    readSource,
    targetedImport,
    feedStore,
    openSignIn: openSignInFallback,
    watchSession,
    record,
  };
}

let ladder: LoginRecoveryLadder | null = null;
function sharedLadder(): LoginRecoveryLadder {
  ladder ??= createLoginRecoveryLadder(productionLoginRecoveryDeps());
  return ladder;
}

/** Called when the invocation/node settles, independently of login success. */
export function releaseLoginRecoveryScope(scope: { runId: string; nodeId?: string }): void {
  ladder?.releaseScope(scope);
}

type RecoveryBrowserGrant = Pick<NativeBrowserRelayGrant, "pages" | "health"> & {
  refresh?: () => Promise<void>;
  recoverLoginWalls?: (input: { nodeId?: string; onPrerequisiteRestored?: (prerequisite: LoginPrerequisiteRef) => void }) => Promise<LoginRecoveryOutcome[]>;
};
const grantIds = new WeakMap<object, number>();
let nextGrantId = 0;
function grantSlotId(grant: object): number {
  let id = grantIds.get(grant);
  if (id === undefined) { id = ++nextGrantId; grantIds.set(grant, id); }
  return id;
}
const opaqueProfileId = (value: string) => createHash("sha256").update(value).digest("hex");

function pendingReleaseBatch(slots: string[], released?: () => void) {
  const pending = new Set(slots);
  let finished = false, handed = false, notified = false;
  const check = () => {
    if (!finished || !handed || notified || pending.size > 0) return;
    notified = true;
    try { released?.(); } catch { /* host cleanup must not fail recovery */ }
  };
  return {
    callback: (slot: string) => released ? () => { pending.delete(slot); check(); } : undefined,
    outcome: (slot: string, outcome: LoginRecoveryOutcome) => {
      if (outcome.state === "awaiting-owner" || outcome.state === "in-flight") handed = true;
      else pending.delete(slot);
    },
    finish: () => { finished = true; check(); },
  };
}

/** Tools after which the agent may be standing on a new page. */
const PAGE_CHANGING_TOOLS = new Set(["browser_navigate", "browser_navigate_back", "browser_tabs", "browser_click",
  "browser_snapshot", "browser_wait_for", "browser_press_key"]);

export function ownerLoginCardNotice(card: OwnerLoginCard, locale: "ko" | "en"): NonNullable<McpInvocationEvent["notice"]> {
  return {
    level: "warning",
    code: "browser-login-owner-needed",
    message: locale === "ko" ? card.message.ko : card.message.en,
    i18n: { ko: card.message.ko, en: card.message.en },
  };
}

/**
 * Called from the run's single event sink after an agentlas-browser tool result. Reads the page URL
 * from the browser surface the run actually used (native guest or dedicated Chrome target list) —
 * never from the tool's text. Fire-and-forget: recovery never blocks or fails the run.
 */
export function observeBrowserToolForLoginWall(input: {
  toolName: string;
  runId?: string;
  chatId?: string;
  nodeId?: string;
  signal?: AbortSignal;
  nativeGrant?: RecoveryBrowserGrant;
  notify?: (card: OwnerLoginCard) => void;
  onPrerequisiteRestored?: (prerequisite: LoginPrerequisiteRef) => void;
}): Promise<LoginRecoveryOutcome[]> {
  const leaf = input.toolName.startsWith("agentlas-browser.") ? input.toolName.slice("agentlas-browser.".length) : null;
  if (!leaf || !PAGE_CHANGING_TOOLS.has(leaf)) return Promise.resolve([]);
  return recoverLoginWallsNow(input).catch((error: unknown) => {
    console.warn("[login-recovery] observe failed", error instanceof Error ? error.name : "unknown");
    return [];
  });
}

/**
 * The same ladder, awaited: the browser fallback ladder's login rung (fallback-ladder-runtime.ts) needs the
 * outcome. Reads the pages of the surface the run is actually on (a failed-over grant is on the dedicated Chrome).
 */
export async function recoverLoginWallsNow(input: {
  runId?: string;
  chatId?: string;
  nodeId?: string;
  signal?: AbortSignal;
  onPendingScopeReleased?: () => void;
  onPrerequisiteRestored?: (prerequisite: LoginPrerequisiteRef) => void;
  nativeGrant?: RecoveryBrowserGrant;
  notify?: (card: OwnerLoginCard) => void;
}): Promise<LoginRecoveryOutcome[]> {
  // Restoration reaches the waiting run only through its exact handle (onPrerequisiteRestored). The global
  // "resume goals" handler this used to pass was removed in 1.2.53 (3a60b734) and had done nothing since.
  const verificationSignal = input.signal ?? new AbortController().signal;
  const outcomes: LoginRecoveryOutcome[] = [];
  if (input.signal?.aborted) return outcomes;
  // A daemon cannot access Electron's session or vault. Its broker fixes Main's
  // run/chat/abort authority and performs recovery against the actual native guest.
  if (typeof input.nativeGrant?.recoverLoginWalls === "function") {
    const remote = await input.nativeGrant.recoverLoginWalls({ nodeId: input.nodeId, onPrerequisiteRestored: input.onPrerequisiteRestored });
    for (const outcome of remote) {
      if (outcome.state === "awaiting-owner" && outcome.newCard && !input.signal?.aborted) {
        try { input.notify?.(outcome.card); } catch { /* notification cannot invalidate recovery */ }
      }
    }
    return remote;
  }
  const { browserCredentialConsentRevision, getBrowserCredentialConsent } = await import("./credential-sync");
  const revision = browserCredentialConsentRevision();
  const consent = getBrowserCredentialConsent();
  const consentGeneration = `${revision}:${opaqueProfileId(JSON.stringify([consent.granted,
    consent.profileId, [...consent.domains].sort()]))}`;
  const consentCurrent = () => browserCredentialConsentRevision() === revision && !input.signal?.aborted;
  if (!consentCurrent()) return outcomes;
  if (input.nativeGrant) {
    await input.nativeGrant.refresh?.();
    const grant = input.nativeGrant;
    const health = grant.health?.();
    if (!consentCurrent() || health?.current === false || health?.failedOver === true) {
      return outcomes;
    }
    const pages = grant.pages().map((page, index) => ({ page,
      slotId: (page as { id?: string }).id ?? `grant-${grantSlotId(grant)}-page-${index}` }));
    const batch = pendingReleaseBatch(pages.map(({ slotId }) => slotId), input.onPendingScopeReleased);
    for (const { page, slotId } of pages) {
      const evaluate = page.evaluate;
      const outcome = await sharedLadder().observe(page.url, {
        surface: "native-partition", reload: page.reload, runId: input.runId, chatId: input.chatId,
        ...(evaluate ? { verifyAuthenticated: (evidence) => verifyGoogleBrowserSession(evaluate, evidence) } : {}),
        nodeId: input.nodeId, signal: input.signal, slotId, profileId: opaqueProfileId(NATIVE_PARTITION),
        onPendingScopeReleased: batch.callback(slotId), onPrerequisiteRestored: input.onPrerequisiteRestored,
        consentGeneration, isCurrent: () => {
          const state = grant.health?.();
          return consentCurrent() && state?.current !== false && state?.failedOver !== true;
        },
        isPendingCurrent: consentCurrent,
        canonicalSession: true,
        ...(page.retainLoginVerification ? { retainVerification: () => {
          const lease = page.retainLoginVerification!(verificationSignal);
          return { ...lease, ...(lease.evaluate ? { verifyAuthenticated: (evidence: { site: string; url: string; returnUrl?: string | null }) =>
            verifyGoogleBrowserSession(lease.evaluate!, evidence) } : {}) };
        } } : {}),
        notify: input.notify, openSignIn: (card) => page.navigate(card.signInUrl),
        ...(evaluate ? { vaultFill: () => vaultFillSignIn({ url: async () => String(await evaluate("location.href") || "") || null, evaluate,
          settled: async () => { await new Promise((r) => setTimeout(r, 1_500)); return String(await evaluate("location.href").catch(() => "") || "") || null; } },
        productionVaultSource()) } : {}),
      });
      outcomes.push(outcome);
      batch.outcome(slotId, outcome);
    }
    batch.finish();
    return outcomes;
  }
  const { browserCdpProfilePath } = await import("../mcp-tools/browser-cdp-launcher");
  const profileId = opaqueProfileId(browserCdpProfilePath());
  const pages = await cdpPages();
  const batch = pendingReleaseBatch(pages.map((page) => page.id), input.onPendingScopeReleased);
  for (const page of pages) {
    const outcome = await sharedLadder().observe(page.url, {
      surface: "cdp-profile", reload: () => reloadCdpPage(page), runId: input.runId, chatId: input.chatId,
      verifyAuthenticated: (evidence) => verifyGoogleBrowserSession((expression) => evaluateCdpPage(page, expression), evidence),
      nodeId: input.nodeId, signal: input.signal, slotId: page.id, profileId,
      onPendingScopeReleased: batch.callback(page.id), onPrerequisiteRestored: input.onPrerequisiteRestored,
      consentGeneration, isCurrent: consentCurrent,
      notify: input.notify,
      vaultFill: () => vaultFillSignIn({ url: async () => String(await evaluateCdpPage(page, "location.href") || "") || null, evaluate: (expression) => evaluateCdpPage(page, expression),
        settled: () => settledCdpPage(page) }, productionVaultSource()),
    });
    outcomes.push(outcome);
    batch.outcome(page.id, outcome);
  }
  batch.finish();
  return outcomes;
}
