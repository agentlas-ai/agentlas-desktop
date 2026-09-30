import { isProtectedBrowserSessionHost } from "../../shared/browser-session-transfer";
import { dedicatedGoogleSessionsQuarantined } from "./google-session-boundary";
/*
 * 로그인 복구 사다리의 실제 손발 — 저장소 측정, 겨냥 가져오기, 다시 읽기, 카드, 세션 감시.
 * 판정과 순서는 login-recovery.ts(순수)에 있고, 여기서는 그 결정을 실행만 한다.
 *
 * 값 경계: 측정은 쿠키 DB 사본에서 이름·도메인·만료만 고른다(readCookieStoreMetadata).
 * 가져오기는 기존 복호화 경로(decryptMacSourceCookies)를 그대로 쓰고 값은 메모리에서 브라우저로만
 * 간다. 로그·사건·알림에는 수치와 사유 코드만 실린다. Login Data·비밀번호는 읽지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { session as electronSession } from "electron";
import type { McpInvocationEvent } from "../../shared/types";
import { registrableDomain } from "../../shared/registrable-domain";
import type { NativeBrowserRelayGrant } from "./native-cdp-relay";
import type { BrowserCookieSurface, CookieMetadata } from "./login-wall";
import { detectLoginWall, sessionCookieNamesFor } from "./login-wall";
import { productionVaultSource, vaultFillSignIn } from "./vault-login";
import {
  createLoginRecoveryLadder,
  type LoginRecoveryContext,
  type LoginRecoveryDeps,
  type LoginRecoveryEvent,
  type LoginRecoveryLadder,
  type LoginRecoveryOutcome,
  type OwnerLoginCard,
  type TargetedImportReport,
} from "./login-recovery";

const { WebSocket } = require("ws") as { WebSocket: new (url: string, options?: { perMessageDeflate?: boolean; maxPayload?: number }) => {
  on(event: "open" | "close" | "error", listener: (...args: unknown[]) => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
} };

const NATIVE_PARTITION = "persist:agentlas-browser-default";
const WATCH_LIMIT_MS = 6 * 60 * 60 * 1000;

/** 목표 재개 — main 이 invocation 서비스를 알 때 한 번 등록한다. */
let resumeHandler: ((reason: "login-restored") => void) | null = null;
export function setLoginRecoveryResumeHandler(handler: ((reason: "login-restored") => void) | null): void {
  resumeHandler = handler;
}

function consentDomains(domains: readonly string[]): Promise<{ profileId: string; domains: string[] } | null> {
  return import("./credential-sync").then(({ getBrowserCredentialConsent }) => {
    const consent = getBrowserCredentialConsent();
    if (!consent.granted || !consent.profileId) return null;
    const allowed = new Set(consent.domains);
    const scoped = [...new Set(domains.map((d) => registrableDomain(d)).filter((d) => d && !isProtectedBrowserSessionHost(d) && allowed.has(d)))];
    return scoped.length ? { profileId: consent.profileId, domains: scoped } : null;
  });
}

function nativeCookieFile(): string | null {
  const storage = electronSession.fromPartition(NATIVE_PARTITION).storagePath;
  if (!storage) return null;
  for (const file of [path.join(storage, "Network", "Cookies"), path.join(storage, "Cookies")]) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function readStore(surface: BrowserCookieSurface, domains: readonly string[]): Promise<CookieMetadata[] | null> {
  const { readCookieStoreMetadata, dedicatedCookieStoreFile } = await import("./credential-import");
  if (surface === "native-partition") {
    // The partition writes its DB lazily; flush so the measurement sees what the guest sees.
    try { await electronSession.fromPartition(NATIVE_PARTITION).flushStorageData(); } catch { /* measure what is on disk */ }
    const file = nativeCookieFile();
    return file ? readCookieStoreMetadata(file, domains) : null;
  }
  const file = dedicatedCookieStoreFile();
  return file ? readCookieStoreMetadata(file, domains) : null;
}

async function readSource(domains: readonly string[]): Promise<CookieMetadata[] | null> {
  domains = domains.filter((domain) => !isProtectedBrowserSessionHost(domain));
  if (!domains.length) return null;
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

/** One CDP session: send commands, optionally wait for one event, then close. */
async function cdpSession<T>(wsUrl: string, work: (call: (method: string, params?: Record<string, unknown>) => Promise<unknown>, waitFor: (event: string, timeoutMs: number) => Promise<boolean>) => Promise<T>): Promise<T> {
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const isolated = () => dedicatedGoogleSessionsQuarantined(launcher.browserCdpProfilePath());
  // All recovery CDP commands (including evaluation, reload, and cookie feeds)
  // share this boundary. An existing answering port is never sufficient proof.
  if (!loopbackWs(wsUrl, launcher.browserCdpPort())
    || (await launcher.reconcileBrowserCdpOwnerWithRetry()).state !== "owned"
    || !isolated()) throw new Error("google-session-isolation-unconfirmed");
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const waiters = new Map<string, Set<() => void>>();
    let settled = false;
    const end = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      for (const entry of pending.values()) entry.reject(new Error("cdp-session-closed"));
      pending.clear();
      try { socket.close(); } catch { /* closed */ }
      if (error) reject(error); else resolve(value as T);
    };
    const call = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((res, rej) => {
      try {
        if (!isolated()) throw new Error("google-session-isolation-unconfirmed");
      } catch (error) { rej(error instanceof Error ? error : new Error("google-session-isolation-unconfirmed")); return; }
      const id = ++seq;
      pending.set(id, { resolve: res, reject: rej });
      try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { pending.delete(id); rej(error as Error); }
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
        else entry.resolve(message.result);
      } else if (typeof message.method === "string") {
        for (const waiter of [...(waiters.get(message.method) ?? [])]) waiter();
      }
    });
    socket.on("error", () => end(new Error("cdp-socket-error")));
    socket.on("close", () => end(new Error("cdp-socket-closed")));
    socket.on("open", () => { void work(call, waitFor).then((value) => end(null, value), (error) => end(error instanceof Error ? error : new Error(String(error)))); });
    setTimeout(() => end(new Error("cdp-session-timeout")), 45_000).unref?.();
  });
}

async function reloadCdpPage(target: CdpPageTarget): Promise<string | null> {
  try {
    await cdpSession(target.webSocketDebuggerUrl, async (call, waitFor) => {
      await call("Page.enable");
      const loaded = waitFor("Page.loadEventFired", 20_000);
      await call("Page.reload", { ignoreCache: false });
      await loaded;
    });
  } catch { return null; }
  // Give same-page redirects (accounts → site) a beat, then read where the page actually is.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const page = (await cdpPages()).find((entry) => entry.id === target.id);
  return page?.url ?? null;
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

type CdpCookieParam = { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number };

/** Feed cookies into the running, owned dedicated browser without closing it. */
async function feedLiveDedicatedBrowser(cookies: CdpCookieParam[]): Promise<number | null> {
  cookies = cookies.filter((cookie) => !isProtectedBrowserSessionHost(cookie.domain));
  if (!cookies.length) return 0;
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  if (!(await launcher.browserCdpPortReady())) return null;
  const owned = await launcher.reconcileBrowserCdpOwnerWithRetry();
  if (owned.state !== "owned") return null;
  const lease = await launcher.acquireBrowserCdpLease("login-recovery").catch(() => null);
  if (!lease) return null;
  try {
    const { fetchCdpJson } = await import("./native-session-cookie-import");
    const port = launcher.browserCdpPort();
    const version = await fetchCdpJson(port, "/json/version") as { webSocketDebuggerUrl?: unknown } | null;
    const ws = loopbackWs(version?.webSocketDebuggerUrl, port);
    if (!ws) return null;
    await cdpSession(ws, async (call) => { await call("Storage.setCookies", { cookies }); });
    return cookies.length;
  } catch {
    return null;
  } finally {
    launcher.releaseBrowserCdpLease(lease);
  }
}

// ── 겨냥 가져오기: 원본 → 에이전트가 쓰는 저장소, 그 도메인만 원본이 이긴다 ──────────────
async function targetedImport(input: { domains: string[]; surface: BrowserCookieSurface }): Promise<TargetedImportReport> {
  const scope = await consentDomains(input.domains);
  if (!scope) return { state: "not-consented", written: 0 };
  const credential = await import("./credential-import");
  const source = credential.readSourceSessionCookies(scope.profileId, scope.domains);
  if (!source.ok) {
    if (source.reason !== "unsupported-platform") return { state: "failed", written: 0 };
    // Other platforms: the dedicated store keeps the maintenance-window importer (source wins,
    // explicit); the partition is fed from that store.
    if (input.surface === "cdp-profile") {
      const result = await credential.importBrowserCredentials(scope.profileId, scope.domains, { automatic: false });
      return result.ok ? { state: "imported", written: result.cookiesAdded + (result.cookiesUpdated ?? 0) } : { state: "failed", written: 0 };
    }
    return feedStore({ from: "cdp-profile", to: "native-partition", domains: scope.domains });
  }
  try {
    if (input.surface === "native-partition") {
      const { writeNativeBrowserCookies } = await import("./native-session-cookie-import");
      const counts = await writeNativeBrowserCookies(source.cookies.map((cookie) => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        expires: cookie.expires ?? -1, session: cookie.expires === undefined,
        httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
      })), electronSession.fromPartition(NATIVE_PARTITION), Date.now() / 1_000,
      { isCurrent: () => true, explicitImport: true });
      return counts.imported > 0 ? { state: "imported", written: counts.imported } : { state: "failed", written: 0 };
    }
    const params: CdpCookieParam[] = source.cookies.map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    }));
    const live = await feedLiveDedicatedBrowser(params);
    if (live !== null) return { state: "imported", written: live };
  } finally {
    source.wipe();
  }
  // Dedicated browser not running: nothing to close, so the maintenance import is safe here.
  const result = await credential.importBrowserCredentials(scope.profileId, scope.domains, { automatic: false });
  return result.ok ? { state: "imported", written: result.cookiesAdded + (result.cookiesUpdated ?? 0) } : { state: "failed", written: 0 };
}

async function feedStore(input: { from: BrowserCookieSurface; to: BrowserCookieSurface; domains: string[] }): Promise<TargetedImportReport> {
  const scope = await consentDomains(input.domains);
  if (!scope) return { state: "not-consented", written: 0 };
  if (input.from === "cdp-profile" && input.to === "native-partition") {
    const { syncConnectBrowserSession } = await import("./native-session-cookie-import");
    const receipt = await syncConnectBrowserSession({ domains: scope.domains, reason: "connect-import" });
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
    const written = await feedLiveDedicatedBrowser(params);
    return written === null ? { state: "failed", written: 0 } : { state: "imported", written };
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
    tryRecordRunEvent({ runId: ctx.runId!, chatId: ctx.chatId ?? null, kind: "browser_login_recovery", payload: { ...event } });
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
  nativeGrant?: Pick<NativeBrowserRelayGrant, "pages" | "health">;
  notify?: (card: OwnerLoginCard) => void;
}): void {
  const leaf = input.toolName.startsWith("agentlas-browser.") ? input.toolName.slice("agentlas-browser.".length) : null;
  if (!leaf || !PAGE_CHANGING_TOOLS.has(leaf)) return;
  void recoverLoginWallsNow(input).catch((error: unknown) => {
    console.warn("[login-recovery] observe failed", error instanceof Error ? error.name : "unknown");
  });
}

/** Ask Main's resume path (blocked-goal sweep) to continue goals after a recovery. Best effort. */
export function triggerBrowserRecoveryResume(): void {
  try { resumeHandler?.("login-restored"); } catch { /* resume is best effort */ }
}

/**
 * The same ladder, awaited: the browser fallback ladder's login rung (fallback-ladder-runtime.ts) needs the
 * outcome. Reads the pages of the surface the run is actually on (a failed-over grant is on the dedicated Chrome).
 */
export async function recoverLoginWallsNow(input: {
  runId?: string;
  chatId?: string;
  nativeGrant?: Pick<NativeBrowserRelayGrant, "pages" | "health">;
  notify?: (card: OwnerLoginCard) => void;
}): Promise<LoginRecoveryOutcome[]> {
  const resume = triggerBrowserRecoveryResume;
  const outcomes: LoginRecoveryOutcome[] = [];
  if (input.nativeGrant && input.nativeGrant.health?.().failedOver !== true) {
    for (const page of input.nativeGrant.pages()) {
      if (detectLoginWall({ url: page.url }).kind !== "login-wall") continue;
      const evaluate = page.evaluate;
      outcomes.push(await sharedLadder().observe(page.url, {
        surface: "native-partition", reload: page.reload, runId: input.runId, chatId: input.chatId,
        notify: input.notify, resume, openSignIn: (card) => page.navigate(card.signInUrl),
        ...(evaluate ? { vaultFill: () => vaultFillSignIn({ url: async () => String(await evaluate("location.href") || "") || null, evaluate,
          settled: async () => { await new Promise((r) => setTimeout(r, 1_500)); return String(await evaluate("location.href").catch(() => "") || "") || null; } },
        productionVaultSource()) } : {}),
      }));
    }
    return outcomes;
  }
  for (const page of await cdpPages()) {
    if (detectLoginWall({ url: page.url }).kind !== "login-wall") continue;
    outcomes.push(await sharedLadder().observe(page.url, {
      surface: "cdp-profile", reload: () => reloadCdpPage(page), runId: input.runId, chatId: input.chatId,
      notify: input.notify, resume,
      vaultFill: () => vaultFillSignIn({ url: async () => String(await evaluateCdpPage(page, "location.href") || "") || null, evaluate: (expression) => evaluateCdpPage(page, expression),
        settled: () => settledCdpPage(page) }, productionVaultSource()),
    }));
  }
  return outcomes;
}
