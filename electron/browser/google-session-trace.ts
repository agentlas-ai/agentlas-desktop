import { registrableDomain } from "../../shared/registrable-domain";

/*
 * Owner 2026-10-13: "Agentlas browser keeps losing its Google sign-in". Before changing any import rule, record exactly
 * when the Agentlas browser's Google/YouTube sign-in cookies change and by which path. One log line per change of a
 * sign-in or rotation cookie: name, host, cause (Chromium's: explicit / overwrite / expired / evicted /
 * expired-overwrite), removed, expiry, and whether an Agentlas import was writing at that moment. Never the value.
 *
 * Reading the log: an `agentlasWrite:true` line is our import; `explicit` without it is the site's own Set-Cookie
 * (a sign-out sets an expired cookie → `expired-overwrite` / removed); `overwrite` + removed right before a new
 * value is rotation. A sign-in that stops working while no line appears means the server ended the session.
 */
const TRACED_SITES = new Set(["google.com", "youtube.com"]);
// Sign-in cookies plus the short-lived rotation cookies whose refresh keeps the sign-in alive.
const TRACED_NAMES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "LOGIN_INFO", "__Host-GAPS",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-1PSIDRTS", "__Secure-3PSIDRTS",
]);

let agentlasWriteDepth = 0;

/** Wrap an Agentlas cookie import into the browser partition so its writes are told apart from the site's. */
export async function withAgentlasCookieWrite<T>(work: () => Promise<T>): Promise<T> {
  agentlasWriteDepth += 1;
  try { return await work(); } finally { agentlasWriteDepth -= 1; }
}

export interface TracedCookie { domain?: string; name: string; path?: string; expirationDate?: number; session?: boolean }

/** The log record for one cookie change, or null when the cookie is not a traced Google sign-in cookie. */
export function googleSessionTraceRecord(cookie: TracedCookie, cause: string, removed: boolean, nowMs = Date.now()): Record<string, unknown> | null {
  const host = String(cookie.domain ?? "").replace(/^\./u, "").toLowerCase();
  if (!TRACED_SITES.has(registrableDomain(host)) || !TRACED_NAMES.has(cookie.name)) return null;
  return {
    at: new Date(nowMs).toISOString(), name: cookie.name, host: cookie.domain ?? "", path: cookie.path ?? "/",
    cause, removed, agentlasWrite: agentlasWriteDepth > 0,
    expires: cookie.session || typeof cookie.expirationDate !== "number" ? null : new Date(cookie.expirationDate * 1000).toISOString(),
  };
}

let installed = false;

/** Attach the trace to the Agentlas browser partition (Main only, after app ready). */
export function installGoogleSessionTrace(partition: string): void {
  if (installed) return;
  installed = true;
  void import("electron").then(({ app, session }) => app.whenReady().then(() => {
    session.fromPartition(partition).cookies.on("changed", (_event, cookie, cause, removed) => {
      const record = googleSessionTraceRecord(cookie, cause, removed);
      if (record) console.info(`[google-session-trace] ${JSON.stringify(record)}`);
    });
  })).catch((error) => console.warn("[google-session-trace] not installed:", error instanceof Error ? error.message : error));
}
