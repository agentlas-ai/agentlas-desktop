import http from "node:http";
import { session as electronSession } from "electron";
import type { CookiesSetDetails, Session } from "electron";
import type { BrowserCdpHostFailureDiagnostic } from "../../shared/types";
import {
  acquireBrowserCdpLease,
  browserCdpHostFailureDiagnostic,
  browserCdpPort,
  browserCdpPortReady,
  ensureBrowserCdpHost,
  reconcileBrowserCdpOwnerWithRetry,
  releaseBrowserCdpLease,
} from "../mcp-tools/browser-cdp-launcher";
import { NATIVE_BROWSER_PARTITION } from "../work-live-view";

type CookieImportFailureCode =
  | "authorization-required"
  | "source-host-unavailable"
  | "source-ownership-unverified"
  | "source-reservation-failed"
  | "source-protocol-unavailable"
  | "source-cookie-read-failed"
  | "source-empty"
  | "no-transferable-cookies"
  | "destination-write-failed";

export type NativeBrowserCookieImportCode = "imported" | "partial" | CookieImportFailureCode;

export interface NativeBrowserCookieImportResult {
  ok: boolean;
  code: NativeBrowserCookieImportCode;
  /** This transfer intentionally excludes DOM storage, IndexedDB, cache, and service-worker state. */
  scope: "cookies-only";
  destinationPartition: typeof NATIVE_BROWSER_PARTITION;
  observed: number;
  imported: number;
  skipped: {
    expired: number;
    partitioned: number;
    invalid: number;
    writeFailed: number;
  };
  /** Present only for the bounded machine-readable browser-host failure contract. */
  hostFailure?: BrowserCdpHostFailureDiagnostic;
}

interface CdpCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  session?: unknown;
  sameSite?: unknown;
  partitionKey?: unknown;
  partitionKeyOpaque?: unknown;
}

interface CookieWriteSummary {
  observed: number;
  imported: number;
  skipped: NativeBrowserCookieImportResult["skipped"];
}

type NativeCookieSession = Pick<Session, "cookies" | "flushStorageData">;

class CookieImportError extends Error {
  constructor(readonly code: CookieImportFailureCode) {
    super(code);
    this.name = "CookieImportError";
  }
}

class CdpCallError extends Error {
  constructor(readonly protocolCode: number | null) {
    super("cdp-call-failed");
    this.name = "CdpCallError";
  }
}

function emptyCounts(): CookieWriteSummary {
  return {
    observed: 0,
    imported: 0,
    skipped: { expired: 0, partitioned: 0, invalid: 0, writeFailed: 0 },
  };
}

function result(
  code: NativeBrowserCookieImportCode,
  counts: CookieWriteSummary = emptyCounts(),
  hostFailure?: BrowserCdpHostFailureDiagnostic,
): NativeBrowserCookieImportResult {
  return {
    ok: code === "imported" || code === "partial",
    code,
    scope: "cookies-only",
    destinationPartition: NATIVE_BROWSER_PARTITION,
    observed: counts.observed,
    imported: counts.imported,
    skipped: counts.skipped,
    ...(hostFailure ? { hostFailure } : {}),
  };
}

function loopbackSocketUrl(value: unknown, port: number): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "[::1]";
    return parsed.protocol === "ws:" && loopback && Number(parsed.port) === port
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** Bounded loopback JSON fetch; exported only for the private transport contract. */
export function fetchCdpJson(port: number, pathname: "/json/version" | "/json/list"): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false;
    let responseRef: http.IncomingMessage | null = null;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      responseRef?.destroy();
      req.destroy();
      resolve(value);
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname },
      (response) => {
        responseRef = response;
        if (response.statusCode !== 200) {
          finish(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length + chunk.length > 1024 * 1024) {
            finish(null);
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          try { finish(JSON.parse(body)); }
          catch { finish(null); }
        });
        response.once("aborted", () => finish(null));
        response.once("error", () => finish(null));
      },
    );
    deadline = setTimeout(() => finish(null), 2_000);
    req.once("error", () => finish(null));
    req.setTimeout(1_500);
    req.once("timeout", () => {
      finish(null);
    });
  });
}

async function browserSocketUrl(port: number): Promise<string | null> {
  const value = await fetchCdpJson(port, "/json/version") as { webSocketDebuggerUrl?: unknown } | null;
  return loopbackSocketUrl(value?.webSocketDebuggerUrl, port);
}

async function pageSocketUrl(port: number): Promise<string | null> {
  const value = await fetchCdpJson(port, "/json/list");
  if (!Array.isArray(value)) return null;
  for (const row of value) {
    if (!row || typeof row !== "object" || (row as { type?: unknown }).type !== "page") continue;
    const socket = loopbackSocketUrl((row as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl, port);
    if (socket) return socket;
  }
  return null;
}

async function callCdp(socketUrl: string, method: string): Promise<unknown> {
  if (typeof WebSocket !== "function") throw new CookieImportError("source-protocol-unavailable");
  const socket = new WebSocket(socketUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* best-effort */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new CookieImportError("source-cookie-read-failed")), 5_000);
    socket.addEventListener("open", () => {
      try { socket.send(JSON.stringify({ id: 1, method, params: {} })); }
      catch { finish(new CookieImportError("source-cookie-read-failed")); }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          id?: unknown;
          result?: unknown;
          error?: { code?: unknown };
        };
        if (message.id !== 1) return;
        if (message.error) {
          const code = Number(message.error.code);
          finish(new CdpCallError(Number.isInteger(code) ? code : null));
          return;
        }
        finish(null, message.result);
      } catch {
        finish(new CookieImportError("source-cookie-read-failed"));
      }
    });
    socket.addEventListener("error", () => finish(new CookieImportError("source-cookie-read-failed")), { once: true });
    socket.addEventListener("close", () => finish(new CookieImportError("source-cookie-read-failed")), { once: true });
  });
}

async function readDedicatedBrowserCookies(port: number): Promise<CdpCookie[]> {
  const browserSocket = await browserSocketUrl(port);
  if (!browserSocket) throw new CookieImportError("source-protocol-unavailable");
  try {
    const storage = await callCdp(browserSocket, "Storage.getCookies") as { cookies?: unknown } | null;
    if (!Array.isArray(storage?.cookies)) throw new CookieImportError("source-cookie-read-failed");
    return storage.cookies as CdpCookie[];
  } catch (error) {
    if (!(error instanceof CdpCallError) || error.protocolCode !== -32601) throw error;
  }

  // Older Chromium versions expose only the page-scoped Network method.
  const pageSocket = await pageSocketUrl(port);
  if (!pageSocket) throw new CookieImportError("source-protocol-unavailable");
  const network = await callCdp(pageSocket, "Network.getAllCookies") as { cookies?: unknown } | null;
  if (!Array.isArray(network?.cookies)) throw new CookieImportError("source-cookie-read-failed");
  return network.cookies as CdpCookie[];
}

function normalizedSameSite(value: unknown): CookiesSetDetails["sameSite"] | null {
  if (value === undefined) return "unspecified";
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "no_restriction";
  return null;
}

/** Pure conversion used by the private cross-platform cookie contract. */
export function nativeCookieDetails(
  input: CdpCookie,
  nowSeconds = Date.now() / 1_000,
): { kind: "write"; details: CookiesSetDetails } | { kind: "skip"; reason: "expired" | "partitioned" | "invalid" } {
  if (input.partitionKey !== undefined || input.partitionKeyOpaque === true) {
    return { kind: "skip", reason: "partitioned" };
  }
  if (typeof input.name !== "string" || typeof input.value !== "string"
    || typeof input.domain !== "string" || typeof input.path !== "string") {
    return { kind: "skip", reason: "invalid" };
  }
  if (!input.name || input.name.length > 512 || /[\u0000-\u001f\u007f;]/u.test(input.name)
    || input.value.length > 16 * 1024 || /[\u0000\r\n]/u.test(input.value)
    || !input.path.startsWith("/") || input.path.length > 2_048 || /[\u0000\r\n]/u.test(input.path)) {
    return { kind: "skip", reason: "invalid" };
  }
  const domainCookie = input.domain.startsWith(".");
  const hostname = input.domain.replace(/^\./u, "").toLowerCase();
  if (!hostname || hostname.length > 253 || /[\u0000\s/@]/u.test(hostname)) {
    return { kind: "skip", reason: "invalid" };
  }
  const secure = input.secure === true;
  const httpOnly = input.httpOnly === true;
  const sameSite = normalizedSameSite(input.sameSite);
  if (!sameSite || (sameSite === "no_restriction" && !secure)
    || (input.name.startsWith("__Secure-") && !secure)
    || (input.name.startsWith("__Host-") && (!secure || domainCookie || input.path !== "/"))) {
    return { kind: "skip", reason: "invalid" };
  }
  const urlHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  let url: URL;
  try {
    url = new URL(`${secure ? "https" : "http"}://${urlHostname}${input.path}`);
    const parsedHost = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (parsedHost !== hostname) return { kind: "skip", reason: "invalid" };
  } catch {
    return { kind: "skip", reason: "invalid" };
  }

  const expires = Number(input.expires);
  const persistent = input.session !== true && Number.isFinite(expires) && expires > 0;
  if (persistent && expires <= nowSeconds) return { kind: "skip", reason: "expired" };
  const details: CookiesSetDetails = {
    url: url.toString(),
    name: input.name,
    value: input.value,
    path: input.path,
    secure,
    httpOnly,
    sameSite,
    ...(domainCookie ? { domain: input.domain.toLowerCase() } : {}),
    ...(persistent ? { expirationDate: expires } : {}),
  };
  return { kind: "write", details };
}

/** Writes only synthetic/private-test input or CDP-verified cookies; no values leave this function. */
export async function writeNativeBrowserCookies(
  cookies: readonly CdpCookie[],
  destination: NativeCookieSession,
  nowSeconds = Date.now() / 1_000,
): Promise<CookieWriteSummary> {
  const counts = emptyCounts();
  counts.observed = cookies.length;
  for (const cookie of cookies) {
    const converted = nativeCookieDetails(cookie, nowSeconds);
    if (converted.kind === "skip") {
      counts.skipped[converted.reason] += 1;
      continue;
    }
    try {
      await destination.cookies.set(converted.details);
      counts.imported += 1;
    } catch {
      counts.skipped.writeFailed += 1;
    }
  }
  if (counts.imported > 0) {
    try { await destination.flushStorageData(); }
    catch { counts.skipped.writeFailed += 1; }
  }
  return counts;
}

async function importDedicatedBrowserCookiesOnce(
  authorization: "explicit-user-action",
): Promise<NativeBrowserCookieImportResult> {
  if (authorization !== "explicit-user-action") return result("authorization-required");
  const port = browserCdpPort();
  let sourcePid: number | null = null;
  let lease: Awaited<ReturnType<typeof acquireBrowserCdpLease>> | null = null;
  try {
    if (await browserCdpPortReady()) {
      const existing = await reconcileBrowserCdpOwnerWithRetry();
      if (existing.state !== "owned" || !existing.pid) return result("source-ownership-unverified");
      sourcePid = existing.pid;
    } else {
      try { sourcePid = (await ensureBrowserCdpHost()).pid; }
      catch (error) {
        return result("source-host-unavailable", emptyCounts(), browserCdpHostFailureDiagnostic(error));
      }
    }
    lease = await acquireBrowserCdpLease("native-cookie-import").catch(() => null);
    if (!lease) return result("source-reservation-failed");
    const owned = await reconcileBrowserCdpOwnerWithRetry();
    if (owned.state !== "owned" || !owned.pid || owned.pid !== sourcePid) {
      return result("source-ownership-unverified");
    }
    const cookies = await readDedicatedBrowserCookies(port);
    if (cookies.length === 0) return result("source-empty");
    const stillOwned = await reconcileBrowserCdpOwnerWithRetry();
    if (stillOwned.state !== "owned" || stillOwned.pid !== sourcePid) {
      return result("source-ownership-unverified");
    }
    const destination = electronSession.fromPartition(NATIVE_BROWSER_PARTITION);
    const counts = await writeNativeBrowserCookies(cookies, destination);
    if (counts.imported === 0 && counts.skipped.writeFailed > 0) return result("destination-write-failed", counts);
    if (counts.imported === 0) return result("no-transferable-cookies", counts);
    const incomplete = counts.skipped.partitioned > 0
      || counts.skipped.invalid > 0
      || counts.skipped.writeFailed > 0;
    return result(incomplete ? "partial" : "imported", counts);
  } catch (error) {
    return result(error instanceof CookieImportError ? error.code : "source-cookie-read-failed");
  } finally {
    releaseBrowserCdpLease(lease);
  }
}

let nativeCookieImportFlight: Promise<NativeBrowserCookieImportResult> | null = null;

/** Explicit Main-only bridge from the owned CDP profile into the native browser partition. */
export function importDedicatedBrowserCookies(input: {
  authorization: "explicit-user-action";
}): Promise<NativeBrowserCookieImportResult> {
  if (input?.authorization !== "explicit-user-action") return Promise.resolve(result("authorization-required"));
  if (nativeCookieImportFlight) return nativeCookieImportFlight;
  const flight = importDedicatedBrowserCookiesOnce(input.authorization);
  nativeCookieImportFlight = flight;
  void flight.finally(() => {
    if (nativeCookieImportFlight === flight) nativeCookieImportFlight = null;
  });
  return flight;
}
