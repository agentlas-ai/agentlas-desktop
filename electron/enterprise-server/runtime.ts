/**
 * Process-wide company-server state for the Desktop main process. Inert unless a connection exists: a machine-level managed
 * file (MDM/GPO), or one this person entered in Settings and enrolled with a one-time code.
 * Token upkeep: enroll once (code from the managed config), then refresh every hour and read the server's license state;
 * failures are quiet retries that the Settings card shows as the last error.
 * Pure Node — the caller passes the state directory and app version. Nothing here hands the renderer a key or a token:
 * enterpriseServerStatus() is the only view and carries status and expiry only.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  readEnterpriseConnection, readUserEnterpriseConnection, usesCompanyUpdates, userConnectionFile, writeUserEnterpriseConnection,
  type EnterpriseServerConnection,
} from "./connection";
import { createSeatClient, SeatError, type SeatClient } from "./seat-token";
import {
  ENTERPRISE_LICENSE_STATES, ENTERPRISE_SERVER_STATUS_SCHEMA, isEnterpriseErrorCode,
  type EnterpriseErrorCode, type EnterpriseServerActionResult, type EnterpriseServerStatus,
} from "../../shared/enterprise-server";

const REFRESH_MS = 60 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;
/** Written by "disconnect this device" under a managed file: the file's code is not replayed until the person enrolls again. */
const MANUAL_ONLY_MARKER = "manual-enrollment";

/** `fetchImpl`: Main passes Electron net.fetch (os-trust-fetch.ts) so the OS trust store applies; tests pass their own. */
export interface EnterpriseHost { userDataDir: string; appVersion: string; log?: (m: string) => void; fetchImpl?: typeof fetch; now?: () => number }

let connection: EnterpriseServerConnection | null | undefined;
let ignoredManagedFile: string | null = null;
let host: EnterpriseHost | null = null;
let seat: SeatClient | null = null;
let seatKey: string | null = null;
let timer: NodeJS.Timeout | null = null;
let license: EnterpriseServerStatus["license"] = null;
let lastCheckAt: string | null = null;
let lastError: EnterpriseServerStatus["lastError"] = null;
let feed: { lastCheckAt: string | null; ok: boolean | null; version: string | null } = { lastCheckAt: null, ok: null, version: null };
let busy = false;

const now = () => (host?.now ?? Date.now)();
const isoNow = () => new Date(now()).toISOString();
const log = (m: string) => (host?.log ?? ((x: string) => console.log(x)))(m);
const stateDir = (): string | null => (host ? path.join(host.userDataDir, "enterprise-server") : null);

/** The managed connection, read once per process (IT changes take effect at next launch). */
export function enterpriseConnection(warn: (m: string) => void = console.warn): EnterpriseServerConnection | null {
  if (connection === undefined) connection = readEnterpriseConnection({ warn, onIgnored: (file) => { ignoredManagedFile = file; } });
  return connection;
}

/** Managed wins; otherwise the connection entered on this device (which never moves the update feed). */
export function activeEnterpriseConnection(): EnterpriseServerConnection | null {
  const managed = enterpriseConnection();
  if (managed) return managed;
  const dir = stateDir();
  return dir ? readUserEnterpriseConnection(dir) : null;
}

/** The seat client for a connection. Without `create`, a device that never enrolled gets no key made just by looking. */
function seatFor(conn: EnterpriseServerConnection, create: boolean): SeatClient | null {
  const dir = stateDir();
  if (!dir || !host) return null;
  const key = `${conn.serverUrl}|${conn.serverKeyFingerprint}`;
  if (seat && seatKey === key) return seat;
  if (!create && !fs.existsSync(path.join(dir, "device.json"))) return null;
  seat = createSeatClient({ connection: conn, stateDir: dir, appVersion: host.appVersion, fetchImpl: host.fetchImpl, now: host.now });
  seatKey = key;
  return seat;
}

/** `Authorization` header for company-server calls when a live seat token exists. */
export function enterpriseAuthorizationHeader(): Record<string, string> {
  const s = seat?.current();
  return s ? { Authorization: `Bearer ${s.token}` } : {};
}
export function enterpriseBusinessMode(): "full" | "readonly" | "off" | "personal" {
  const conn = activeEnterpriseConnection();
  if (!conn) return "personal";
  const s = seatFor(conn, false);
  return s ? s.businessMode() : "off";
}

/** Settings and the updater both point here; the first caller's folder and version win. */
export function configureEnterpriseServerHost(opts: EnterpriseHost): void { if (!host) host = opts; }

function errorCode(e: unknown): EnterpriseErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  if (isEnterpriseErrorCode(code)) return code;
  if (e instanceof SeatError) return "server_error"; // http_<n> or a code this Desktop does not show verbatim
  // Main's transport is Electron net.fetch (os-trust-fetch.ts): a refused connection, a DNS failure or a certificate the OS
  // does not trust rejects with Chromium's net error code as the message (net::ERR_CERT_AUTHORITY_INVALID, …).
  if (e instanceof Error && /^net::ERR_[A-Z0-9_]+$/.test(e.message)) return "server_unreachable";
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TypeError" || name === "AbortError" || name === "TimeoutError" ? "server_unreachable" : "server_error";
}
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

type LicenseView = NonNullable<EnterpriseServerStatus["license"]>;
/** GET /api/v1/status (no auth). A server whose key is not the pinned one is not believed. Reads only; callers decide what to keep. */
async function fetchServerStatus(conn: EnterpriseServerConnection): Promise<{ error: EnterpriseErrorCode | null; license: LicenseView | null }> {
  try {
    const res = await (host?.fetchImpl ?? fetch)(`${conn.serverUrl}/api/v1/status`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), redirect: "error" });
    const text = await res.text();
    if (res.status !== 200) return { error: "server_error", license: null };
    if (text.length > 64_000) return { error: "server_status_invalid", license: null };
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || j.schema !== "agentlas.enterprise-server-status.v1") return { error: "server_status_invalid", license: null };
    if (j.serverKeyFingerprint !== conn.serverKeyFingerprint) return { error: "server_key_mismatch", license: null };
    const l = j.license as Record<string, unknown> | null;
    if (!l || !(ENTERPRISE_LICENSE_STATES as readonly unknown[]).includes(l.state) || !["setup", "full", "readonly", "stopped"].includes(String(l.mode))) return { error: "server_status_invalid", license: null };
    return { error: null, license: { state: l.state as LicenseView["state"], mode: l.mode as LicenseView["mode"], termEndsAt: isoOrNull(l.termEndsAt), leaseUntil: isoOrNull(l.leaseUntil) } };
  } catch (e) {
    return { error: e instanceof SyntaxError ? "server_status_invalid" : "server_unreachable", license: null };
  }
}
/** Keep what the server said; an unreachable server leaves the last known state (with its time), a foreign key clears it. */
async function readServerStatus(conn: EnterpriseServerConnection): Promise<EnterpriseErrorCode | null> {
  const r = await fetchServerStatus(conn);
  if (r.license) license = r.license;
  else if (r.error !== "server_unreachable") license = null;
  return r.error;
}

function manualOnly(): boolean { const dir = stateDir(); return !!dir && fs.existsSync(path.join(dir, MANUAL_ONLY_MARKER)); }

/** One check: enroll with a managed code (once), else refresh the token by the device key; then read the license state. */
async function check(conn: EnterpriseServerConnection): Promise<void> {
  let first: EnterpriseErrorCode | null = null;
  const autoEnroll = !!conn.enrollmentCode && !manualOnly();
  const s = seatFor(conn, autoEnroll);
  try {
    if (s && !s.enrolled() && autoEnroll) await s.enroll();
    else if (s?.enrolled()) await s.refresh();
  } catch (e) { first = errorCode(e); }
  const statusError = await readServerStatus(conn);
  first = first ?? statusError;
  lastCheckAt = isoNow();
  lastError = first ? { code: first, at: lastCheckAt } : null;
  if (first) log(`[enterprise-server] check: ${first}`);
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => { const conn = activeEnterpriseConnection(); if (conn) void check(conn); }, REFRESH_MS);
  timer.unref?.();
}

export function startEnterpriseServerConnection(opts: EnterpriseHost): boolean {
  configureEnterpriseServerHost(opts);
  const conn = activeEnterpriseConnection();
  if (!conn || timer) return !!conn;
  void check(conn);
  ensureTimer();
  log(`[enterprise-server] company server ${conn.serverUrl} (updates: ${conn.updates}, config: ${conn.source})`);
  return true;
}
export function stopEnterpriseServerConnection(): void { if (timer) clearInterval(timer); timer = null; }

/** The updater reports each registry read (source, tag or failure); the card shows the last one. */
export function noteEnterpriseFeedCheck(tag: string | null): void {
  feed = { lastCheckAt: isoNow(), ok: tag !== null, version: tag ? tag.replace(/^v/, "") : null };
}

/** The Settings card's view. Status and expiry only — no key, no token, no managed enrollment code. */
export function enterpriseServerStatus(): EnterpriseServerStatus {
  const managed = enterpriseConnection();
  const conn = activeEnterpriseConnection();
  const s = conn ? seatFor(conn, false) : null;
  const cur = s?.current() ?? null;
  const enrolled = !!s?.enrolled();
  const updates = usesCompanyUpdates(managed) ? "company" : "agentlas";
  return {
    schema: ENTERPRISE_SERVER_STATUS_SCHEMA,
    connected: !!conn,
    source: conn ? (managed ? "managed" : "user") : null,
    managedFile: managed?.source ?? null,
    managedFileIgnored: managed ? null : ignoredManagedFile,
    serverUrl: conn?.serverUrl ?? null,
    serverKeyFingerprint: conn?.serverKeyFingerprint ?? null,
    updates,
    managedEnrollmentCode: !!managed?.enrollmentCode,
    enrolled,
    deviceId: enrolled && s ? s.deviceId : null,
    seat: { valid: !!cur, mode: cur?.claims.mode ?? null, expiresAt: cur ? new Date(cur.claims.exp * 1000).toISOString() : null },
    license: conn ? license : null,
    lastCheckAt: conn ? lastCheckAt : null,
    lastError,
    updateFeed: { source: updates, ...feed },
  };
}

const result = (error: EnterpriseErrorCode | null): EnterpriseServerActionResult => ({ ok: error === null, error, status: enterpriseServerStatus() });
async function exclusive(fn: () => Promise<EnterpriseServerActionResult>): Promise<EnterpriseServerActionResult> {
  if (busy) return result("busy");
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

/**
 * Enroll this device with a one-time code. Under a managed file the server and pin come from that file only; otherwise the
 * person supplies them once. A fresh device key enrolls in a staging folder and only a success replaces this device's files,
 * so a mistyped code never costs an identity the server still knows.
 */
export function enrollEnterpriseDevice(input: { enrollmentCode: string; serverUrl: string | null; serverKeyFingerprint: string | null }): Promise<EnterpriseServerActionResult> {
  return exclusive(async () => {
    const dir = stateDir();
    if (!dir || !host) return result("not_connected");
    const managed = enterpriseConnection();
    let conn: EnterpriseServerConnection;
    if (managed) {
      if (input.serverUrl !== null || input.serverKeyFingerprint !== null) return result("managed_connection_locked");
      conn = managed;
    } else if (input.serverUrl !== null && input.serverKeyFingerprint !== null) {
      conn = { serverUrl: input.serverUrl, serverKeyFingerprint: input.serverKeyFingerprint, updates: "agentlas", enrollmentCode: null, source: "user" };
    } else {
      const existing = readUserEnterpriseConnection(dir);
      if (!existing) return result("not_connected");
      conn = existing;
    }
    const active = activeEnterpriseConnection();
    const activeSeat = active ? seatFor(active, false) : null;
    if (activeSeat?.current() && lastError?.code !== "device_revoked") return result("already_enrolled");
    // Ask the server who it is before the code leaves this machine: a one-time code sent to a server whose key is not the
    // pinned one would be spent for nothing (or handed to the wrong machine).
    const pre = await fetchServerStatus(conn);
    if (pre.error) { lastError = { code: pre.error, at: isoNow() }; return result(pre.error); }
    const staging = path.join(dir, `.enroll-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fresh = createSeatClient({ connection: { ...conn, enrollmentCode: null }, stateDir: staging, appVersion: host.appVersion, fetchImpl: host.fetchImpl, now: host.now });
      await fresh.enroll(input.enrollmentCode);
      for (const f of ["device.json", "seat.json"]) fs.renameSync(path.join(staging, f), path.join(dir, f));
      if (managed) fs.rmSync(path.join(dir, MANUAL_ONLY_MARKER), { force: true });
      else writeUserEnterpriseConnection(dir, conn);
    } catch (e) {
      const code = errorCode(e);
      lastError = { code, at: isoNow() };
      return result(code);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    seat = null; seatKey = null; license = null; lastError = null;
    const statusError = await readServerStatus(conn);
    lastCheckAt = isoNow();
    lastError = statusError ? { code: statusError, at: lastCheckAt } : null;
    ensureTimer();
    log(`[enterprise-server] enrolled with ${conn.serverUrl} (${managed ? "managed" : "user"})`);
    return result(null);
  });
}

/** "Re-check now": refresh the token by the device key and read the license state. */
export function recheckEnterpriseServer(): Promise<EnterpriseServerActionResult> {
  return exclusive(async () => {
    const conn = activeEnterpriseConnection();
    if (!conn) return result("not_connected");
    await check(conn);
    return result(lastError?.code ?? null);
  });
}

/**
 * "Disconnect this device": forget the device key, the seat token and a connection entered here. The company server keeps its
 * record of the device until the admin releases it (there is no device-side unenroll call). A managed file stays — it belongs
 * to IT — and its code is not replayed until the person enrolls again.
 */
export function disconnectEnterpriseDevice(): Promise<EnterpriseServerActionResult> {
  return exclusive(async () => {
    const dir = stateDir();
    if (!dir || !activeEnterpriseConnection()) return result("not_connected");
    stopEnterpriseServerConnection();
    seat = null; seatKey = null;
    for (const f of ["seat.json", "device.json", path.basename(userConnectionFile(dir))]) fs.rmSync(path.join(dir, f), { force: true });
    if (enterpriseConnection()) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, MANUAL_ONLY_MARKER), "1\n", { mode: 0o600 }); }
    license = null; lastError = null; lastCheckAt = null;
    log("[enterprise-server] this device was disconnected locally");
    return result(null);
  });
}

/** Forget all process state (tests; also safe at shutdown). Files on disk are untouched. */
export function resetEnterpriseServerRuntime(): void {
  stopEnterpriseServerConnection();
  connection = undefined; ignoredManagedFile = null; host = null; seat = null; seatKey = null;
  license = null; lastCheckAt = null; lastError = null; feed = { lastCheckAt: null, ok: null, version: null }; busy = false;
}
