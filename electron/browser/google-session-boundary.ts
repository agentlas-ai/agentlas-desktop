import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { isProtectedBrowserSessionHost } from "../../shared/browser-session-transfer";

const MARKER = ".agentlas-google-session-isolation-v1.json";

/** Reject aliases before reading a marker or deleting anything. Only an exact owned root is eligible. */
export function ownedSessionDirectory(directory: string, expected: string): string {
  if (path.resolve(directory) !== path.resolve(expected)) throw new Error("google-session-relogin-required:ownership-unverified");
  const canonical = fs.realpathSync(directory);
  if (canonical !== path.resolve(directory)) throw new Error("google-session-relogin-required:profile-alias");
  const stat = fs.statSync(canonical);
  if (!stat.isDirectory()) throw new Error("google-session-relogin-required:ownership-unverified");
  return JSON.stringify({ schema: 1, directory: canonical, device: stat.dev, inode: stat.ino });
}

function markerCurrent(directory: string, identity: string): boolean {
  try {
    const file = path.join(directory, MARKER);
    return !fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, "utf8") === identity;
  } catch { return false; }
}

function writeMarker(directory: string, identity: string): void {
  const temporary = path.join(directory, `${MARKER}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, identity, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, path.join(directory, MARKER));
}

export function dedicatedGoogleSessionsQuarantined(profile: string): boolean {
  const expected = path.join(os.homedir(), ".agentlas", "chrome-cdp-profile");
  return markerCurrent(profile, ownedSessionDirectory(profile, expected));
}

type NativeSession = {
  storagePath: string | null;
  cookies: {
    get: (filter: object) => Promise<Array<{ domain?: string; name: string; secure?: boolean; path?: string }>>;
    remove: (url: string, name: string) => Promise<void>;
    flushStore: () => Promise<void>;
  };
};
const nativeFlights = new WeakMap<object, Promise<void>>();

/** Local cookie deletion only, before the first request. A durable marker preserves later independent logins. */
export function quarantineNativeGoogleSessions(session: NativeSession, expectedDirectory: string): Promise<void> {
  const active = nativeFlights.get(session);
  if (active) return active.then(() => {
    if (!session.storagePath || !markerCurrent(session.storagePath, ownedSessionDirectory(session.storagePath, expectedDirectory))) {
      throw new Error("google-session-relogin-required:profile-changed");
    }
  });
  const flight = (async () => {
    if (!session.storagePath) throw new Error("google-session-relogin-required:ownership-unverified");
    const directory = session.storagePath;
    const identity = ownedSessionDirectory(directory, expectedDirectory);
    if (markerCurrent(directory, identity)) return;
    const cookies = await session.cookies.get({});
    for (const cookie of cookies) {
      if (!isProtectedBrowserSessionHost(cookie.domain)) continue;
      if (ownedSessionDirectory(directory, expectedDirectory) !== identity) throw new Error("google-session-relogin-required:profile-changed");
      const host = cookie.domain!.replace(/^\./u, "");
      await session.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`, cookie.name);
    }
    await session.cookies.flushStore();
    if ((await session.cookies.get({})).some((cookie) => isProtectedBrowserSessionHost(cookie.domain))) {
      throw new Error("google-session-relogin-required:quarantine-incomplete");
    }
    if (ownedSessionDirectory(directory, expectedDirectory) !== identity) throw new Error("google-session-relogin-required:profile-changed");
    writeMarker(directory, identity);
  })();
  nativeFlights.set(session, flight);
  void flight.catch(() => { nativeFlights.delete(session); });
  return flight;
}

// This exact implementation is shared with the materialized Node launcher. Dependencies are supplied,
// so it neither imports Electron nor attaches to a user's ordinary browser.
export const GOOGLE_CDP_QUARANTINE_SOURCE = String.raw`
async function quarantineGoogleCdp(profile, port, verifyOwned) {
  const expected = path.join(os.homedir(), '.agentlas', 'chrome-cdp-profile');
  const identity = ownedSessionDirectory(profile, expected);
  if (markerCurrent(profile, identity)) return;
  const assertOwned = async () => {
    if (ownedSessionDirectory(profile, expected) !== identity || !(await verifyOwned()))
      throw new Error('google-session-relogin-required:ownership-unverified');
  };
  await assertOwned();
  const version = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2500 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(new Error('cdp-response-limit')); });
      response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('cdp-unavailable'); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      response.on('error', reject);
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('cdp-timeout')));
  });
  const endpoint = new URL(version.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port || endpoint.username || endpoint.password)
    throw new Error('google-session-relogin-required:ownership-unverified');
  const socket = new WebSocket(endpoint.href);
  const pending = new Map(); let sequence = 0; let cookieTarget = null;
  const onMessage = event => {
    try {
      const message = JSON.parse(String(event.data)); const waiter = pending.get(message.id);
      if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error('cdp-cookie-operation-failed')) : waiter.resolve(message.result);
    } catch (_) {}
  };
  socket.addEventListener('message', onMessage);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp-timeout')), 2500);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-unavailable')); }, { once: true });
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout')); }, 2500);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const stored = await call('Storage.getCookies');
    // Network.deleteCookies is a page-domain command, not a browser-root command.
    // Use a fresh internal target in the default context; it never visits a provider.
    await assertOwned();
    cookieTarget = (await call('Target.createTarget', { url: 'chrome://version/', background: true })).targetId;
    const cookieSession = (await call('Target.attachToTarget', { targetId: cookieTarget, flatten: true })).sessionId;
    for (const cookie of stored.cookies || []) {
      if (!isProtectedBrowserSessionHost(cookie.domain)) continue;
      await assertOwned();
      await call('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path,
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) }, cookieSession);
    }
    const remaining = await call('Storage.getCookies');
    if ((remaining.cookies || []).some(cookie => isProtectedBrowserSessionHost(cookie.domain))) throw new Error('google-session-relogin-required:quarantine-incomplete');
    await assertOwned();
    const closed = await call('Target.closeTarget', { targetId: cookieTarget });
    if (closed.success !== true) throw new Error('google-session-relogin-required:quarantine-incomplete');
    cookieTarget = null;
    writeMarker(profile, identity);
  } finally {
    socket.close(); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('cdp-closed')); }
  }
}
`;

export function googleCdpBoundaryRuntimeSource(): string {
  return `const MARKER = ${JSON.stringify(MARKER)};\n${isProtectedBrowserSessionHost.toString()}\n` + String.raw`
function ownedSessionDirectory(directory, expected) {
  if (path.resolve(directory) !== path.resolve(expected)) throw new Error('google-session-relogin-required:ownership-unverified');
  const canonical = fs.realpathSync(directory);
  if (canonical !== path.resolve(directory)) throw new Error('google-session-relogin-required:profile-alias');
  const stat = fs.statSync(canonical);
  if (!stat.isDirectory()) throw new Error('google-session-relogin-required:ownership-unverified');
  return JSON.stringify({ schema: 1, directory: canonical, device: stat.dev, inode: stat.ino });
}
function markerCurrent(directory, identity) {
  try { const file = path.join(directory, MARKER); return !fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, 'utf8') === identity; } catch (_) { return false; }
}
function writeMarker(directory, identity) {
  const temporary = path.join(directory, MARKER + '.' + process.pid + '.tmp');
  fs.writeFileSync(temporary, identity, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, path.join(directory, MARKER));
}
` + GOOGLE_CDP_QUARANTINE_SOURCE;
}

export async function quarantineDedicatedGoogleSessions(profile: string, port: number, verifyOwned: () => Promise<boolean>): Promise<void> {
  // The source is authored above, with no user text interpolated into executable code.
  const run = new Function("fs", "os", "path", "http", "WebSocket", `${googleCdpBoundaryRuntimeSource()}; return quarantineGoogleCdp;`);
  await run(fs, os, path, http, globalThis.WebSocket ?? require("ws"))(profile, port, verifyOwned);
}
