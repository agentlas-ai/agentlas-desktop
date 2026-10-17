import { registrableDomain } from "../../shared/registrable-domain";

/*
 * Owner 2026-10-13: "Agentlas browser keeps losing its Google sign-in". Before changing any import rule, record exactly
 * when the Agentlas browser's Google/YouTube sign-in cookies change and by which path. One log line per change of a
 * sign-in or rotation cookie: name, host, cause (Chromium's: explicit / overwrite / expired / evicted /
 * expired-overwrite), removed, expiry, and whether an Agentlas import was writing at that moment. Never the value.
 *
 * Reading the log: an `agentlasWrite:true` line is our import; `explicit` without it is the site's own Set-Cookie
 * (a sign-out sets an expired cookie → `expired-overwrite` / removed); `overwrite` + removed right before a new
 * value is rotation, which since 10-17 shows as an hourly `rotations` count line (createGoogleSessionTraceFilter).
 * A sign-in that stops working while no line appears means the server ended the session.
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

/*
 * Perf review MP-09 (2026-10-17): 858 of 3,071 main.log lines (28%, ~48 an hour) were Google's routine rotation of
 * __Secure-1/3PSIDCC and __Secure-1/3PSIDTS: an `overwrite` removal followed at once by the insertion of the same cookie,
 * not an Agentlas write, the new one living as long as the old (within a second of clock skew). That pair is the refresh
 * that keeps the sign-in alive, not the loss being traced, and it pushed real diagnostics out of the 5 MB log. Such a pair
 * is now counted instead of logged, and the count is logged once an hour, so a stop in rotation stays visible. Every other
 * change is logged exactly as before: explicit / expired / evicted / expired-overwrite, a removal with no replacement, a
 * replacement that is session-only or expires more than ROTATION_EXPIRY_SLACK_MS earlier, and any Agentlas write.
 */
const ROTATION_HOLD_MS = 1_000;
const ROTATION_EXPIRY_SLACK_MS = 60 * 60_000;
const ROTATION_SUMMARY_EVERY_MS = 60 * 60_000;

export interface GoogleSessionTraceFilter { observe(record: Record<string, unknown>): void; flush(): void }

export function createGoogleSessionTraceFilter(emit: (record: Record<string, unknown>) => void, nowMs: () => number = Date.now): GoogleSessionTraceFilter {
  const key = (r: Record<string, unknown>) => `${String(r.name)}\0${String(r.host)}\0${String(r.path)}`;
  const pending = new Map<string, { record: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>();
  let rotations = 0;
  let names = new Set<string>();
  let since = nowMs();
  const flush = () => {
    for (const [k, held] of pending) { clearTimeout(held.timer); pending.delete(k); emit(held.record); }
  };
  const expiry = (r: Record<string, unknown>) => (typeof r.expires === "string" ? Date.parse(r.expires) : Number.NaN);
  return {
    flush,
    observe(record) {
      const k = key(record);
      if (record.cause === "overwrite" && record.removed === true && record.agentlasWrite === false) {
        const prior = pending.get(k);
        if (prior) { clearTimeout(prior.timer); pending.delete(k); emit(prior.record); }
        const timer = setTimeout(() => { if (pending.get(k)?.record === record) { pending.delete(k); emit(record); } }, ROTATION_HOLD_MS);
        timer.unref?.();
        pending.set(k, { record, timer });
        return;
      }
      const held = pending.get(k);
      const insertion = record.removed === false && record.agentlasWrite === false && (record.cause === "inserted" || record.cause === "explicit");
      if (held && insertion) {
        const before = expiry(held.record), after = expiry(record);
        if (Number.isFinite(after) && (!Number.isFinite(before) || after >= before - ROTATION_EXPIRY_SLACK_MS)) {
          clearTimeout(held.timer);
          pending.delete(k);
          rotations += 1;
          names.add(String(record.name));
          const now = nowMs();
          if (now - since >= ROTATION_SUMMARY_EVERY_MS) {
            flush();
            emit({ at: new Date(now).toISOString(), rotationsSince: new Date(since).toISOString(), rotations, names: [...names].sort() });
            rotations = 0; names = new Set(); since = now;
          }
          return;
        }
      }
      flush();
      emit(record);
    },
  };
}

let installed = false;

/** Attach the trace to the Agentlas browser partition (Main only, after app ready). */
export function installGoogleSessionTrace(partition: string): void {
  if (installed) return;
  installed = true;
  const filter = createGoogleSessionTraceFilter((record) => console.info(`[google-session-trace] ${JSON.stringify(record)}`));
  void import("electron").then(({ app, session }) => app.whenReady().then(() => {
    session.fromPartition(partition).cookies.on("changed", (_event, cookie, cause, removed) => {
      const record = googleSessionTraceRecord(cookie, cause, removed);
      if (record) filter.observe(record);
    });
  })).catch((error) => console.warn("[google-session-trace] not installed:", error instanceof Error ? error.message : error));
}
