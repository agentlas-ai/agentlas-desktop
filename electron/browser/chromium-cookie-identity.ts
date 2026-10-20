/**
 * Which login a Chromium cookie store row belongs to, on the platforms whose store is written by the SQL path (Windows).
 *
 * The partition and CDP paths already refresh a login group only when its sign-in cookies hold the same values on both
 * sides (cookie-merge.ts planSessionGroupFeed). The SQL store path decided row by row from the expiry alone, so a later
 * expiry on another account's cookie replaced the destination's cookie one row at a time. The cookie values are
 * encrypted there, so the same comparison needs the decrypted value of the few cookies that are fixed per sign-in.
 *
 * Windows format (Chromium os_crypt, what yt-dlp and browser_cookie3 read as well): a row starts with `v10`, then a
 * 12-byte nonce, then AES-256-GCM ciphertext and a 16-byte tag. The 32-byte key is in the browser's `Local State`
 * (`os_crypt.encrypted_key`, base64, prefixed `DPAPI`) wrapped by the user's DPAPI. The dedicated profile inherits the
 * source's key (credential-import.ts inheritEncryptionKeyIfNeeded), so one key reads both sides. From schema version 24
 * the plaintext starts with sha256(host_key). Rows with the `v20` prefix (app-bound encryption) cannot be read here and
 * never reach this path: the import registers those sites for a one-time sign-in instead.
 *
 * Nothing here logs, returns or stores a value except to the comparison in memory. This file does not import Electron.
 */
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { planSessionGroupFeed, type SessionGroupCookie } from "./cookie-merge";
import { sessionCookieGroupOf, sessionCookieIdentityNamesFor, sessionCookieNamesFor } from "./login-wall";

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HOST_HASH_SCHEMA_VERSION = 24;
const DPAPI_PREFIX = "DPAPI";
/** Seconds between the Chrome epoch (1601) and the Unix epoch. */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/** Decrypt one `v10` Windows cookie value; null on any failure (wrong key, a different format, a failed integrity check). */
export function decryptWindowsGcmCookie(encryptedValue: Buffer, hostKey: string, key: Buffer, schemaVersion: number): string | null {
  try {
    if (key.length !== 32 || encryptedValue.length < 3 + GCM_NONCE_BYTES + GCM_TAG_BYTES) return null;
    if (encryptedValue.subarray(0, 3).toString("ascii") !== "v10") return null;
    const nonce = encryptedValue.subarray(3, 3 + GCM_NONCE_BYTES);
    const sealed = encryptedValue.subarray(3 + GCM_NONCE_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
    let value = plaintext;
    if (schemaVersion >= HOST_HASH_SCHEMA_VERSION) {
      const expected = createHash("sha256").update(hostKey).digest();
      if (plaintext.length < expected.length || !timingSafeEqual(plaintext.subarray(0, expected.length), expected)) return null;
      value = plaintext.subarray(expected.length);
    }
    return value.toString("utf8");
  } catch {
    return null;
  }
}

/** The DPAPI-wrapped key bytes of a Local State file's text, or null when there is none in the expected form. */
export function windowsWrappedKeyFromLocalState(localStateText: string): Buffer | null {
  try {
    const parsed = JSON.parse(localStateText) as { os_crypt?: { encrypted_key?: unknown } };
    const encoded = parsed?.os_crypt?.encrypted_key;
    if (typeof encoded !== "string" || encoded === "") return null;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length <= DPAPI_PREFIX.length || bytes.subarray(0, DPAPI_PREFIX.length).toString("ascii") !== DPAPI_PREFIX) return null;
    return bytes.subarray(DPAPI_PREFIX.length);
  } catch {
    return null;
  }
}

export type DpapiUnprotect = (wrapped: Buffer) => Buffer | null | Promise<Buffer | null>;

/**
 * The cookie key of a Local State file: unwrap its DPAPI blob with the given function. Null when the blob is missing, cannot be
 * unwrapped, or is not a 32-byte key.
 */
export async function windowsCookieKeyFromLocalState(localStateText: string, unprotect: DpapiUnprotect): Promise<Buffer | null> {
  const wrapped = windowsWrappedKeyFromLocalState(localStateText);
  if (!wrapped) return null;
  try {
    const key = await unprotect(wrapped);
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * DPAPI unwrap for the current Windows user through PowerShell (System.Security.Cryptography.ProtectedData), the same call
 * Chromium's own os_crypt makes. Electron's safeStorage only opens blobs made with this app's own key, not another browser's.
 * Windows only; anything else, a missing PowerShell, a timeout or an error answers null.
 */
export function windowsDpapiUnprotect(wrapped: Buffer): Promise<Buffer | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;"
    + "$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());"
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
  // The full path: a bare name is looked up in the working directory before PATH. Async: the main process is not blocked while it runs.
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    try {
      const child = execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 15_000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(null); return; }
          const bytes = Buffer.from(String(stdout).trim(), "base64");
          resolve(bytes.length > 0 ? bytes : null);
        });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(wrapped.toString("base64"));
    } catch {
      resolve(null);
    }
  });
}

export type SqlStoreGroupVerdict = "keep" | "force" | "row";

export interface SqlStoreCookieRow {
  host_key: string;
  name: string;
  path?: string | null;
  expires_utc?: number | null;
  encrypted_value?: Buffer | null;
  value?: string | null;
}

/** Chrome-epoch microseconds -> seconds, the unit the group planner compares; null for a session cookie. */
function storeExpirySeconds(row: SqlStoreCookieRow): number | null {
  const micro = Number(row.expires_utc);
  return Number.isFinite(micro) && micro > 0 ? micro / 1_000_000 : null;
}

/**
 * Decide, for one automatic refresh through the SQL store, what happens to each login group of the incoming rows:
 *   keep  - the whole group stays as the destination has it (another login, no proof of the same login, or the destination is fresher)
 *   force - the whole group is written (the destination had no login of it, or it is the same login and the source is fresher)
 *   row   - the site has no known login cookies: the per-row expiry rule applies, as before
 * `key` is the cookie key both sides use (null: nothing can be read, so no group is ever proven the same login, which can only
 * keep a group, never swap one). Values are read only for the cookies fixed per sign-in.
 */
export function planSqlStoreCookieGroups(input: {
  incoming: readonly SqlStoreCookieRow[];
  existing: readonly SqlStoreCookieRow[];
  key: Buffer | null;
  schemaVersion: number;
  /** The destination store's own schema version (its rows are read with it); the source's when absent. */
  existingSchemaVersion?: number;
  groupOf: (host: string) => { group: string; site: string } | null;
  sessionNamesFor: (host: string) => readonly string[] | null;
  identityNamesFor: (host: string) => readonly string[] | null;
}): { verdictFor(hostKey: string): SqlStoreGroupVerdict; counts: { keptGroups: number; refreshedGroups: number; replacedGroups: number; otherLoginGroups: number; unprovenLoginGroups: number; conflictGroups: number } } {
  const host = (value: string) => value.replace(/^\./u, "").toLowerCase();
  const toCookie = (row: SqlStoreCookieRow, schemaVersion: number): SessionGroupCookie => {
    const base: SessionGroupCookie = { domain: row.host_key, name: row.name, path: row.path ?? "/", expires: storeExpirySeconds(row) };
    if (!input.key || !input.identityNamesFor(host(row.host_key))?.includes(row.name)) return base;
    const plain = typeof row.value === "string" && row.value !== "" ? row.value
      : row.encrypted_value && row.encrypted_value.length > 0 ? decryptWindowsGcmCookie(row.encrypted_value, row.host_key, input.key, schemaVersion) : null;
    return plain ? { ...base, value: plain } : base;
  };
  const incoming = input.incoming.map((row) => toCookie(row, input.schemaVersion));
  const plan = planSessionGroupFeed({
    explicitImport: false,
    incoming,
    existing: input.existing.map((row) => toCookie(row, input.existingSchemaVersion ?? input.schemaVersion)),
    groupOf: input.groupOf,
    sessionNamesFor: input.sessionNamesFor,
    identityNamesFor: input.identityNamesFor,
    // A cookie of a group the planner does not decide (a site without known login cookies) keeps the per-row rule.
    perCookie: () => "keep",
  });
  const verdicts = new Map<string, SqlStoreGroupVerdict>();
  for (const group of plan.keptGroups) verdicts.set(group, "keep");
  for (const group of [...plan.refreshedGroups, ...plan.replacedGroups]) verdicts.set(group, "force");
  return {
    verdictFor(hostKey: string): SqlStoreGroupVerdict {
      const group = input.groupOf(host(hostKey))?.group;
      return (group ? verdicts.get(group) : undefined) ?? "row";
    },
    counts: {
      keptGroups: plan.keptGroups.length, refreshedGroups: plan.refreshedGroups.length, replacedGroups: plan.replacedGroups.length,
      otherLoginGroups: plan.otherLoginGroups.length, unprovenLoginGroups: plan.unprovenLoginGroups.length, conflictGroups: plan.conflictGroups.length,
    },
  };
}

/**
 * The verdict function of one automatic refresh through the Windows SQL store: reads the destination's rows of the job domains,
 * unwraps the shared cookie key from the source's Local State text, and plans the groups. A Local State that cannot be read or
 * unwrapped gives no key, so a group the destination already holds a login of is kept (never swapped).
 */
export async function planSqlStoreGroupVerdicts(input: {
  jobs: ReadonlyArray<{ domain: string; rows: ReadonlyArray<Record<string, unknown>> }>;
  dest: { prepare(sql: string): { all(...args: unknown[]): unknown[]; get?(...args: unknown[]): unknown } };
  localStateText: string | null;
  schemaVersion: number;
  unprotect: DpapiUnprotect;
  /** Wall clock in milliseconds; destination rows whose expiry has passed are not a login the destination holds. */
  nowMs?: number;
}): Promise<(hostKey: string) => SqlStoreGroupVerdict> {
  const nowMicro = ((input.nowMs ?? Date.now()) / 1000 + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000;
  const existing: SqlStoreCookieRow[] = [];
  const select = (withValue: boolean) => input.dest.prepare(
    `SELECT host_key, name, path, expires_utc, encrypted_value${withValue ? ", value" : ""} FROM cookies
      WHERE (host_key = ? OR host_key = ? OR host_key LIKE ?) AND (expires_utc IS NULL OR expires_utc <= 0 OR expires_utc > ?)`);
  let statement: ReturnType<typeof select>;
  try { statement = select(true); } catch { statement = select(false); }
  for (const job of input.jobs) existing.push(...(statement.all(job.domain, `.${job.domain}`, `%.${job.domain}`, nowMicro) as SqlStoreCookieRow[]));
  const incoming = input.jobs.flatMap((job) => job.rows) as unknown as SqlStoreCookieRow[];
  // The destination's own schema version decides how ITS rows are read; a missing table or value falls back to the source's.
  let existingSchemaVersion = input.schemaVersion;
  try {
    const row = input.dest.prepare("SELECT value FROM meta WHERE key = 'version'").get?.() as { value?: unknown } | undefined;
    const version = Number(row?.value);
    if (Number.isFinite(version) && version > 0) existingSchemaVersion = version;
  } catch { /* the source's version stays */ }
  // The key (and with it a PowerShell call) is needed only when a fixed sign-in cookie sits on BOTH sides.
  const fixedNames = (row: SqlStoreCookieRow) => sessionCookieIdentityNamesFor(row.host_key.replace(/^\./u, "").toLowerCase())?.includes(row.name) === true;
  const needsKey = incoming.some(fixedNames) && existing.some(fixedNames);
  const key = needsKey && input.localStateText ? await windowsCookieKeyFromLocalState(input.localStateText, input.unprotect) : null;
  const plan = planSqlStoreCookieGroups({
    incoming, existing, key, schemaVersion: input.schemaVersion, existingSchemaVersion,
    groupOf: sessionCookieGroupOf, sessionNamesFor: sessionCookieNamesFor, identityNamesFor: sessionCookieIdentityNamesFor,
  });
  // Counts only: no domain, cookie name or value reaches the log.
  console.info("[browser-credentials] login group freshness (sql store)", JSON.stringify(plan.counts));
  return (hostKey) => plan.verdictFor(hostKey);
}
