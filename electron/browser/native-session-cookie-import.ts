import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { session as electronSession } from "electron";
import type { CookiesSetDetails, Session } from "electron";
import type { BrowserCdpHostFailureDiagnostic } from "../../shared/types";
import {
  acquireBrowserCdpLease,
  browserCdpHostFailureDiagnostic,
  browserCdpPort,
  browserCdpProfilePath,
  browserCdpPortReady,
  ensureBrowserCdpHost,
  reconcileBrowserCdpOwnerWithRetry,
  releaseBrowserCdpLease,
} from "../mcp-tools/browser-cdp-launcher";
import { NATIVE_BROWSER_PARTITION } from "../work-live-view";
import { browserCredentialConsentRevision } from "./credential-sync";
import { listBrowserSites } from "../store/browser-vault";
import { getMeta, setMeta } from "../store/meta";
import { getDb } from "../store/db";
import { BROWSER_CREDENTIAL_CONSENT_KEY, type BrowserCredentialConsent } from "../../shared/browser-credentials";

import type { NativeBrowserCookieImportResult, NativeBrowserCookieImportCode } from "../../shared/types";
export type { NativeBrowserCookieImportResult, NativeBrowserCookieImportCode } from "../../shared/types";

function logNativeSessionFailure(receipt: NativeBrowserCookieImportResult, requestedDomainCount: number): void {
  if (receipt.code === "imported" || receipt.code === "already-migrated") return;
  // Keep the diagnostic useful for QA while excluding domains, profiles, cookie
  // names/values, paths, and provider error text from the main log.
  console.warn("[browser-native-session] import failed", JSON.stringify({
    code: receipt.code,
    requestedDomainCount,
    observed: receipt.observed,
    imported: receipt.imported,
    preserved: receipt.preserved ?? 0,
    skipped: receipt.skipped,
    hostFailure: receipt.hostFailure ?? undefined,
  }));
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
  preserved?: number;
}

type NativeCookieSession = Pick<Session, "cookies" | "flushStorageData">;

class CookieImportError extends Error {
  constructor(readonly code: Exclude<NativeBrowserCookieImportCode, "imported" | "already-migrated" | "partial">, readonly counts?: CookieWriteSummary) {
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
    ok: code === "imported" || code === "already-migrated" || code === "partial",
    code,
    scope: "cookies-only",
    destinationPartition: NATIVE_BROWSER_PARTITION,
    observed: counts.observed,
    imported: counts.imported,
    ...(counts.preserved !== undefined ? { preserved: counts.preserved } : {}),
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
  connect?: { isCurrent: () => boolean | Promise<boolean>; beginMigration?: () => void },
): Promise<CookieWriteSummary> {
  const counts = emptyCounts();
  counts.observed = cookies.length;
  let begun = false;
  for (const cookie of cookies) {
    const converted = nativeCookieDetails(cookie, nowSeconds);
    if (converted.kind === "skip") {
      counts.skipped[converted.reason] += 1;
      continue;
    }
    try {
      if (connect) {
        if (!(await connect.isCurrent())) throw new CookieImportError("authorization-required", counts);
        const existing = await destination.cookies.get({ name: converted.details.name });
        if (!(await connect.isCurrent())) throw new CookieImportError("authorization-required", counts);
        const host = (value: string) => value.replace(/^\./u, "").toLowerCase();
        const domain = host(String(cookie.domain));
        if (existing.some((item) => host(item.domain ?? "") === domain && item.path === converted.details.path)) {
          counts.preserved = (counts.preserved ?? 0) + 1;
          continue;
        }
      }
      if (connect && !begun) {
        connect.beginMigration?.();
        begun = true;
      }
      await destination.cookies.set(converted.details);
      counts.imported += 1;
    } catch (error) {
      if (error instanceof CookieImportError) throw error;
      counts.skipped.writeFailed += 1;
    }
  }
  if (connect && !(await connect.isCurrent())) throw new CookieImportError("authorization-required", counts);
  if (counts.imported > 0) {
    try { await destination.flushStorageData(); }
    catch { counts.skipped.writeFailed += 1; }
  }
  return counts;
}

async function syncConnectBrowserCookiesOnce(
  connect: ConnectSessionScope,
): Promise<NativeBrowserCookieImportResult> {
  if (connect && !(await connect.isCurrent())) return result("authorization-required");
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
    const observedCookies = await readDedicatedBrowserCookies(port);
    if (connect && !(await connect.isCurrent())) return result("authorization-required");
    const cookies = connect ? observedCookies.filter((cookie) => typeof cookie.domain === "string"
      && connect.domains.some((domain) => {
        const host = String(cookie.domain).replace(/^\./u, "").toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
      })) : observedCookies;
    if (cookies.length === 0) return result("source-empty");
    const stillOwned = await reconcileBrowserCdpOwnerWithRetry();
    if (stillOwned.state !== "owned" || stillOwned.pid !== sourcePid) {
      return result("source-ownership-unverified");
    }
    const destination = electronSession.fromPartition(NATIVE_BROWSER_PARTITION);
    if (connect && !(await connect.isCurrent())) return result("authorization-required");
    const sourceCurrent = async () => {
      if (!(await connect.isCurrent())) return false;
      try {
        const marker = JSON.parse(await fs.promises.readFile(path.join(browserCdpProfilePath(), ".agentlas-cdp-owner.json"), "utf8"));
        return marker.pid === sourcePid && marker.port === port && typeof marker.profile === "string"
          && path.resolve(marker.profile) === path.resolve(browserCdpProfilePath()) && connect.hasCurrentGrant();
      } catch { return false; }
    };
    if (!(await sourceCurrent())) return result("source-ownership-unverified");
    const counts = await writeNativeBrowserCookies(cookies, destination, Date.now() / 1000,
      { isCurrent: sourceCurrent, beginMigration: connect.beginMigration });
    if (connect && !(await connect.isCurrent())) return result("authorization-required", counts);
    if (counts.imported === 0 && counts.skipped.writeFailed > 0) return result("destination-write-failed", counts);
    if (counts.imported === 0 && !counts.preserved) return result("no-transferable-cookies", counts);
    const incomplete = counts.skipped.partitioned > 0
      || counts.skipped.invalid > 0
      || counts.skipped.writeFailed > 0;
    return result(incomplete ? "partial" : "imported", counts);
  } catch (error) {
    return result(error instanceof CookieImportError ? error.code : "source-cookie-read-failed", error instanceof CookieImportError ? error.counts : undefined);
  } finally {
    releaseBrowserCdpLease(lease);
  }
}

/** Backward-compatible IPC name; Connect is the sole consent/source pipeline. */
export function importDedicatedBrowserCookies(input: {
  authorization: "explicit-user-action";
}): Promise<NativeBrowserCookieImportResult> {
  if (input?.authorization !== "explicit-user-action") return Promise.resolve(result("authorization-required"));
  return syncConnectBrowserSession();
}

type ConnectSessionScope = {
  identity: string; domains: string[]; markerKeys: Map<string, string>;
  isCurrent: () => Promise<boolean>; hasCurrentGrant: () => boolean; beginMigration?: () => void;
};
const CONNECT_MIGRATION_SCHEMA = "agentlas.native-connect-migration.v1";
function writeMigrationMarkers(keys: string[], state: "pending" | "completed", partial = false): void {
  getDb().transaction(() => {
    for (const key of keys) setMeta(key, JSON.stringify({ schema: CONNECT_MIGRATION_SCHEMA, state, partial }));
  })();
}

async function connectSessionScope(requestedDomains?: readonly string[]): Promise<ConnectSessionScope | null> {
  try {
    const raw = getMeta(BROWSER_CREDENTIAL_CONSENT_KEY);
    if (!raw) return null;
    const consent = JSON.parse(raw) as BrowserCredentialConsent;
    const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (consent.granted !== true || !iso(consent.grantedAt)
      || (consent.lastSyncedAt !== null && !iso(consent.lastSyncedAt))
      || typeof consent.profileId !== "string" || !/^(Google Chrome|Microsoft Edge|Brave|Chromium)::(Default|Profile [0-9]+)$/u.test(consent.profileId)
      || !Array.isArray(consent.domains) || !consent.domains.length || consent.domains.length > 256
      || !consent.domains.every((domain) => typeof domain === "string" && domain.length <= 253
        && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(domain))) return null;
    const sites = listBrowserSites();
    const domains = [...new Set(consent.domains.filter((domain) => (!requestedDomains || requestedDomains.includes(domain)) && /^[a-z0-9.-]+$/u.test(domain)
      && !domain.startsWith(".") && sites.some((site) => site.site === domain && site.session.status === "valid")))].sort();
    if (!domains.length) return null;
    const revision = browserCredentialConsentRevision(), port = browserCdpPort();
    const configuredProfile = path.resolve(browserCdpProfilePath());
    const stat = await fs.promises.stat(configuredProfile).catch(() => null);
    if (stat && !stat.isDirectory()) return null;
    const profile = stat ? await fs.promises.realpath(configuredProfile) : configuredProfile;
    const statusCount = getDb().prepare(`SELECT COUNT(*) AS count FROM browser_sessions WHERE status = 'valid' AND site IN (${domains.map(() => "?").join(",")})`);
    const consentCurrent = () => revision === browserCredentialConsentRevision() && getMeta(BROWSER_CREDENTIAL_CONSENT_KEY) === raw
      && (statusCount.get(...domains) as { count: number }).count === domains.length;
    const identity = JSON.stringify({ consent, revision, domains,
      configuredProfile, profile, device: stat?.dev ?? null, inode: stat?.ino ?? null, port });
    const hasCurrentGrant = () => consentCurrent() && path.resolve(browserCdpProfilePath()) === configuredProfile && browserCdpPort() === port;
    const isCurrent = async () => {
      if (!hasCurrentGrant()) return false;
      try {
        const [currentStat, currentPath] = await Promise.all([fs.promises.stat(configuredProfile), fs.promises.realpath(configuredProfile)]);
        return hasCurrentGrant() && currentStat.isDirectory() && currentStat.dev === stat?.dev && currentStat.ino === stat?.ino && currentPath === profile;
      } catch { return false; }
    };
    if (!consentCurrent()) return null;
    const destination = electronSession.fromPartition(NATIVE_BROWSER_PARTITION).storagePath;
    if (!destination) return null;
    const markerKeys = new Map(domains.map((domain) => [domain, "browser.nativeConnectMigration.v1." + createHash("sha256").update(JSON.stringify({
      destination, profile, device: stat?.dev ?? null, inode: stat?.ino ?? null,
      domain,
    })).digest("hex")]));
    return { identity, domains, markerKeys, isCurrent, hasCurrentGrant };
  } catch { return null; }
}

let connectSessionFlight: Promise<NativeBrowserCookieImportResult> | null = null;
const connectedScopes = new Map<string, NativeBrowserCookieImportResult>();

/** Reuses only Connect's already imported dedicated profile. No personal-browser discovery. */
export function syncConnectBrowserSession(input?: { domains: readonly string[]; reason?: "connect-import" | "refresh" }): Promise<NativeBrowserCookieImportResult> {
  const requestedDomains = input?.domains.slice();
  const previous = connectSessionFlight ?? Promise.resolve();
  const flight = previous.catch(() => undefined).then(async () => {
    const scope = await connectSessionScope(requestedDomains);
    if (!scope) return result("authorization-required");
    const profile = browserCdpProfilePath();
    let hasImportedStore = false;
    try {
      const files = [path.join(profile, "Default", "Network", "Cookies"), path.join(profile, "Default", "Cookies")];
      hasImportedStore = (await Promise.all(files.map((file) => fs.promises.stat(file).catch(() => null)))).some((stat) => stat?.isFile());
    } catch { return result("source-ownership-unverified"); }
    if (!hasImportedStore) return result("source-empty");
    if (!(await scope.isCurrent())) return result("authorization-required");
    const explicitImport = input?.reason === "connect-import";
    const pendingDomains: string[] = [];
    let previousPartial = false;
    for (const domain of scope.domains) {
      const saved = getMeta(scope.markerKeys.get(domain)!);
      if (explicitImport || !saved) { pendingDomains.push(domain); continue; }
      try {
        const marker = JSON.parse(saved);
        if (marker.schema !== CONNECT_MIGRATION_SCHEMA || marker.state !== "completed" || typeof marker.partial !== "boolean") return result("migration-requires-connect");
        previousPartial ||= marker.partial;
      } catch { return result("migration-requires-connect"); }
    }
    if (!pendingDomains.length) return result(previousPartial ? "partial" : "already-migrated");
    const prior = connectedScopes.get(scope.identity);
    if (!explicitImport && prior && await scope.isCurrent()) return prior;
    const counts = emptyCounts();
    let failure: NativeBrowserCookieImportResult | undefined;
    let partial = previousPartial;
    for (const domain of pendingDomains) {
      const markerKeys = [scope.markerKeys.get(domain)!];
      const receipt = await syncConnectBrowserCookiesOnce({ ...scope, domains: [domain],
        beginMigration: () => writeMigrationMarkers(markerKeys, "pending"),
      });
      counts.observed += receipt.observed;
      counts.imported += receipt.imported;
      counts.preserved = (counts.preserved ?? 0) + (receipt.preserved ?? 0);
      for (const kind of ["expired", "partitioned", "invalid", "writeFailed"] as const) counts.skipped[kind] += receipt.skipped[kind];
      if (receipt.ok && await scope.isCurrent()) {
        writeMigrationMarkers(markerKeys, "completed", receipt.code === "partial");
        partial ||= receipt.code === "partial";
      } else {
        failure ??= receipt.ok ? result("authorization-required") : receipt;
        if (!(await scope.isCurrent())) break;
      }
    }
    const receipt = failure ? result(failure.code, counts, failure.hostFailure) : result(partial ? "partial" : "imported", counts);
    if (receipt.ok && await scope.isCurrent()) {
      // Only successful exact-scope reuse is cached. Each durable marker records
      // its own site's result, never the aggregate outcome of another site.
      connectedScopes.clear();
      connectedScopes.set(scope.identity, receipt);
    }
    return receipt;
  }).catch(() => result("source-cookie-read-failed"));
  const tracedFlight = flight.then((receipt) => {
    logNativeSessionFailure(receipt, requestedDomains?.length ?? 0);
    return receipt;
  });
  connectSessionFlight = tracedFlight;
  void tracedFlight.finally(() => { if (connectSessionFlight === tracedFlight) connectSessionFlight = null; }).catch(() => undefined);
  return tracedFlight;
}

/** Synchronize every consented site, retaining independent receipts for native tabs. */
export async function syncConnectBrowserSessionsByDomain(): Promise<Map<string, NativeBrowserCookieImportResult>> {
  const scope = await connectSessionScope();
  const receipts = new Map<string, NativeBrowserCookieImportResult>();
  if (!scope) return receipts;
  for (const domain of scope.domains) {
    receipts.set(domain, await syncConnectBrowserSession({ domains: [domain] }));
  }
  return receipts;
}
