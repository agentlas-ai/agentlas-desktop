import Database from "better-sqlite3";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  BROWSER_PROFILE_IMPORT_SCHEMA_VERSION,
  type BrowserProfileDataImportInput,
  type BrowserProfileDataImportResult,
  type BrowserProfileDataScanResult,
  type BrowserProfileHistoryItem,
  type BrowserProfileImportReason,
  type BrowserProfilePasswordItem,
} from "../../shared/browser-profile-import";
import { developmentEffectsSuppressed } from "../development-effect-policy";
import {
  makeBrowserProfileImportWorkDir,
  removeBrowserProfileImportWorkDir,
  resolveDiscoveredBrowserProfile,
  snapshotBrowserSqlite,
} from "./credential-import";
import { importBrowserCredentialRecords, type ImportedBrowserCredential } from "./autofill-vault";
import { importBrowserHistory, sanitizeBrowserHistoryUrl } from "./history-registry";

const MAX_PASSWORD_ITEMS = 100;
const MAX_HISTORY_ITEMS = 500;
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const MAC_SAFE_STORAGE_SERVICE: Readonly<Record<string, string>> = {
  "Google Chrome": "Chrome Safe Storage",
  "Microsoft Edge": "Microsoft Edge Safe Storage",
  Brave: "Brave Safe Storage",
  Chromium: "Chromium Safe Storage",
};

interface PrivatePasswordItem extends BrowserProfilePasswordItem {
  username: string;
  encryptedValue: Buffer;
}

interface PrivateScan {
  public: BrowserProfileDataScanResult;
  passwords: PrivatePasswordItem[];
}

type PasswordDecryptResult =
  | { ok: true; plaintext: Buffer }
  | { ok: false; reason: "unsupported-platform" | "app-bound-encryption" | "decrypt-unavailable" };

export interface BrowserProfilePasswordDecryptBoundary {
  decrypt: (encryptedValue: Buffer) => PasswordDecryptResult;
  dispose: () => void;
}

export interface BrowserProfileImportDependencies {
  platform: NodeJS.Platform;
  resolveProfile: typeof resolveDiscoveredBrowserProfile;
  makeWorkDir: typeof makeBrowserProfileImportWorkDir;
  removeWorkDir: typeof removeBrowserProfileImportWorkDir;
  snapshotSqlite: typeof snapshotBrowserSqlite;
  createDecryptBoundary: (profile: { browser: string; path: string }) => BrowserProfilePasswordDecryptBoundary;
  persistCredentials: typeof importBrowserCredentialRecords;
  persistHistory: typeof importBrowserHistory;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
}

function masked(value: string): string | null {
  if (!value) return null;
  if (value.includes("@")) {
    const [local, domain] = value.split("@", 2);
    return `${local.slice(0, 1) || "•"}${"•".repeat(Math.min(6, Math.max(2, local.length - 1)))}@${domain}`;
  }
  const digits = value.replace(/\D/gu, "");
  if (digits.length >= 4) return `${"•".repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
  return "•".repeat(Math.min(8, Math.max(3, value.length)));
}

function validOrigin(input: unknown): string | null {
  try {
    const parsed = new URL(String(input ?? ""));
    const local = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !local)) return null;
    return parsed.origin;
  } catch { return null; }
}

function chromeTimeToIso(value: unknown): string | null {
  const microseconds = Number(value);
  if (!Number.isFinite(microseconds) || microseconds <= 0) return null;
  const milliseconds = Math.trunc(microseconds / 1_000 - CHROME_EPOCH_OFFSET_MS);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function itemId(prefix: "password" | "history", profileId: string, fields: Array<string | Buffer>): string {
  const hash = createHash("sha256").update(profileId);
  for (const field of fields) hash.update("\0").update(field);
  return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}

function readPasswordRows(
  profileId: string,
  profilePath: string,
  workDir: string,
  deps: BrowserProfileImportDependencies,
): { items: PrivatePasswordItem[]; state: "ready" | "empty" | "unsupported" | "unavailable" } {
  const source = path.join(profilePath, "Login Data");
  if (!fs.existsSync(source)) return { items: [], state: "empty" };
  const snapshot = deps.snapshotSqlite(source, workDir, "Login Data.snapshot");
  if (!snapshot) return { items: [], state: "unavailable" };
  try {
    const db = new Database(snapshot, { readonly: true });
    const columns = new Set((db.pragma("table_info(logins)") as Array<{ name: string }>).map((row) => row.name));
    if (!["origin_url", "username_value", "password_value"].every((column) => columns.has(column))) {
      db.close();
      return { items: [], state: "unavailable" };
    }
    const dateColumn = columns.has("date_password_modified") ? "date_password_modified"
      : columns.has("date_last_used") ? "date_last_used" : "0";
    const blocked = columns.has("blocked_by_user") ? "blocked_by_user = 0"
      : columns.has("blacklisted_by_user") ? "blacklisted_by_user = 0" : "1 = 1";
    const rows = db.prepare(
      `SELECT origin_url AS originUrl, username_value AS usernameValue,
              password_value AS passwordValue, ${dateColumn} AS updatedAt
         FROM logins WHERE ${blocked}
         ORDER BY ${dateColumn} DESC LIMIT ${MAX_PASSWORD_ITEMS}`,
    ).all() as Array<{ originUrl: string; usernameValue: string; passwordValue: Buffer; updatedAt: number }>;
    db.close();
    const items: PrivatePasswordItem[] = [];
    const seenIds = new Set<string>();
    for (const row of rows) {
      const origin = validOrigin(row.originUrl);
      const encryptedValue = Buffer.isBuffer(row.passwordValue) ? Buffer.from(row.passwordValue) : Buffer.alloc(0);
      if (!origin || encryptedValue.length === 0) continue;
      const capability = passwordCipherCapability(encryptedValue, deps.platform, profilePath);
      const id = itemId("password", profileId, [origin, String(row.usernameValue ?? ""), encryptedValue]);
      if (seenIds.has(id)) {
        encryptedValue.fill(0);
        continue;
      }
      seenIds.add(id);
      items.push({
        id,
        origin,
        label: new URL(origin).hostname,
        maskedUsername: masked(String(row.usernameValue ?? "")),
        updatedAt: chromeTimeToIso(row.updatedAt),
        importable: capability === null,
        ...(capability ? { reason: capability } : {}),
        username: String(row.usernameValue ?? ""),
        encryptedValue,
      });
    }
    const supported = items.some((item) => item.importable);
    return { items, state: items.length === 0 ? "empty" : supported ? "ready" : "unsupported" };
  } catch {
    return { items: [], state: "unavailable" };
  }
}

function readHistoryRows(
  profileId: string,
  profilePath: string,
  workDir: string,
  deps: BrowserProfileImportDependencies,
): { items: BrowserProfileHistoryItem[]; state: "ready" | "empty" | "unavailable" } {
  const source = path.join(profilePath, "History");
  if (!fs.existsSync(source)) return { items: [], state: "empty" };
  const snapshot = deps.snapshotSqlite(source, workDir, "History.profile-import.snapshot");
  if (!snapshot) return { items: [], state: "unavailable" };
  try {
    const db = new Database(snapshot, { readonly: true });
    const columns = new Set((db.pragma("table_info(urls)") as Array<{ name: string }>).map((row) => row.name));
    if (!["url", "title", "visit_count", "last_visit_time"].every((column) => columns.has(column))) {
      db.close();
      return { items: [], state: "unavailable" };
    }
    const rows = db.prepare(
      `SELECT url, title, visit_count AS visitCount, last_visit_time AS lastVisitTime
         FROM urls WHERE visit_count > 0
         ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY_ITEMS}`,
    ).all() as Array<{ url: string; title: string; visitCount: number; lastVisitTime: number }>;
    db.close();
    const items: BrowserProfileHistoryItem[] = [];
    const seenIds = new Set<string>();
    for (const row of rows) {
      const safe = sanitizeBrowserHistoryUrl(row.url);
      const lastVisitedAt = chromeTimeToIso(row.lastVisitTime);
      const visitCount = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(row.visitCount) || 1)));
      if (!safe || !lastVisitedAt) continue;
      const id = itemId("history", profileId, [safe.url, lastVisitedAt]);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({
        id,
        url: safe.url,
        title: clean(row.title, 512) || new URL(safe.url).hostname,
        lastVisitedAt,
        visitCount,
        redactedQuery: safe.redactedQuery,
      });
    }
    return { items, state: items.length > 0 ? "ready" : "empty" };
  } catch {
    return { items: [], state: "unavailable" };
  }
}

function readPrivateScan(profileId: string, deps: BrowserProfileImportDependencies): PrivateScan {
  const empty = (reason: BrowserProfileImportReason): PrivateScan => ({
    passwords: [],
    public: {
      schemaVersion: BROWSER_PROFILE_IMPORT_SCHEMA_VERSION,
      ok: false,
      profileId,
      passwords: [],
      history: [],
      capabilities: { passwords: "unavailable", history: "unavailable" },
      reason,
    },
  });
  if (!/^(Google Chrome|Microsoft Edge|Brave|Chromium)::(?:Default|Profile [0-9]+)$/u.test(profileId)) {
    return empty("invalid-request");
  }
  const profile = deps.resolveProfile(profileId);
  if (!profile) return empty("profile-not-found");
  const workDir = deps.makeWorkDir();
  try {
    const passwords = readPasswordRows(profileId, profile.path, workDir, deps);
    const history = readHistoryRows(profileId, profile.path, workDir, deps);
    return {
      passwords: passwords.items,
      public: {
        schemaVersion: BROWSER_PROFILE_IMPORT_SCHEMA_VERSION,
        ok: passwords.state !== "unavailable" || history.state !== "unavailable",
        profileId,
        passwords: passwords.items.map(({ username: _username, encryptedValue: _encryptedValue, ...item }) => item),
        history: history.items,
        capabilities: { passwords: passwords.state, history: history.state },
        ...(passwords.state === "unavailable" && history.state === "unavailable" ? { reason: "source-unavailable" as const } : {}),
      },
    };
  } finally {
    deps.removeWorkDir(workDir);
  }
}

function passwordCipherCapability(
  encryptedValue: Buffer,
  platform: NodeJS.Platform,
  profilePath: string,
): "unsupported-platform" | "app-bound-encryption" | "decrypt-unavailable" | null {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (platform === "darwin") return prefix === "v10" || prefix === "v11" ? null : "decrypt-unavailable";
  if (platform === "win32") {
    if (prefix === "v20") return "app-bound-encryption";
    if (prefix !== "v10" && prefix !== "v11") return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(path.dirname(profilePath), "Local State"), "utf8")) as {
        os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string };
      };
      const key = Buffer.from(parsed.os_crypt?.encrypted_key ?? "", "base64");
      const available = key.subarray(0, 5).toString("ascii") === "DPAPI";
      const bound = key.subarray(0, 4).toString("ascii") === "APPB";
      key.fill(0);
      return bound ? "app-bound-encryption" : available ? null : "decrypt-unavailable";
    } catch { return "decrypt-unavailable"; }
  }
  return "unsupported-platform";
}

function readMacSafeStorageKey(browser: string): Buffer | null {
  const service = MAC_SAFE_STORAGE_SERVICE[browser];
  if (!service) return null;
  let password: Buffer | null = null;
  try {
    password = execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", service], {
      encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    });
    let length = password.length;
    while (length > 0 && (password[length - 1] === 0x0a || password[length - 1] === 0x0d)) length -= 1;
    return length > 0 ? pbkdf2Sync(password.subarray(0, length), "saltysalt", 1_003, 16, "sha1") : null;
  } catch { return null; }
  finally { password?.fill(0); }
}

function windowsDpapiUnprotect(ciphertext: Buffer): Buffer | null {
  const script = [
    "$inputText=[Console]::In.ReadToEnd()",
    "$cipher=[Convert]::FromBase64String($inputText)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
    "[Array]::Clear($plain,0,$plain.Length);[Array]::Clear($cipher,0,$cipher.Length)",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: ciphertext.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    const output = Buffer.from(result.stdout.trim(), "base64");
    return output.length > 0 ? output : null;
  } catch { return null; }
}

export function decryptMacChromiumPasswordWithKey(encryptedValue: Buffer, key: Buffer): Buffer {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if ((prefix !== "v10" && prefix !== "v11") || key.length !== 16) throw new Error("chromium_mac_password_cipher_unsupported");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
}

export function decryptWindowsChromiumPasswordWithKey(encryptedValue: Buffer, key: Buffer): Buffer {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if ((prefix !== "v10" && prefix !== "v11") || key.length !== 32 || encryptedValue.length < 31) {
    throw new Error("chromium_windows_password_cipher_unsupported");
  }
  const tag = encryptedValue.subarray(encryptedValue.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, encryptedValue.subarray(3, 15));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedValue.subarray(15, encryptedValue.length - 16)), decipher.final()]);
}

export function createNativeBrowserProfilePasswordDecryptBoundary(
  profile: { browser: string; path: string },
  platform: NodeJS.Platform = process.platform,
): BrowserProfilePasswordDecryptBoundary {
  if (platform === "darwin") {
    const key = readMacSafeStorageKey(profile.browser);
    return {
      decrypt(encryptedValue) {
        if (!key) return { ok: false, reason: "decrypt-unavailable" };
        const prefix = encryptedValue.subarray(0, 3).toString("ascii");
        if (prefix !== "v10" && prefix !== "v11") return { ok: false, reason: "decrypt-unavailable" };
        try {
          return { ok: true, plaintext: decryptMacChromiumPasswordWithKey(encryptedValue, key) };
        } catch { return { ok: false, reason: "decrypt-unavailable" }; }
      },
      dispose() { key?.fill(0); },
    };
  }
  if (platform === "win32") {
    let key: Buffer | null = null;
    let keyReason: "app-bound-encryption" | "decrypt-unavailable" | null = null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(path.dirname(profile.path), "Local State"), "utf8")) as {
        os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string };
      };
      const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? "", "base64");
      if (wrapped.subarray(0, 4).toString("ascii") === "APPB") keyReason = "app-bound-encryption";
      else if (wrapped.subarray(0, 5).toString("ascii") === "DPAPI") {
        key = windowsDpapiUnprotect(wrapped.subarray(5));
        if (!key) keyReason = "decrypt-unavailable";
      } else keyReason = "decrypt-unavailable";
      wrapped.fill(0);
    } catch { keyReason = "decrypt-unavailable"; }
    return {
      decrypt(encryptedValue) {
        const prefix = encryptedValue.subarray(0, 3).toString("ascii");
        if (prefix === "v20") return { ok: false, reason: "app-bound-encryption" };
        if (prefix !== "v10" && prefix !== "v11") {
          const plaintext = windowsDpapiUnprotect(encryptedValue);
          return plaintext ? { ok: true, plaintext } : { ok: false, reason: "decrypt-unavailable" };
        }
        if (!key) return { ok: false, reason: keyReason ?? "decrypt-unavailable" };
        try {
          return { ok: true, plaintext: decryptWindowsChromiumPasswordWithKey(encryptedValue, key) };
        } catch { return { ok: false, reason: "decrypt-unavailable" }; }
      },
      dispose() { key?.fill(0); key = null; },
    };
  }
  return { decrypt: () => ({ ok: false, reason: "unsupported-platform" }), dispose() {} };
}

const DEFAULT_DEPENDENCIES: BrowserProfileImportDependencies = {
  platform: process.platform,
  resolveProfile: resolveDiscoveredBrowserProfile,
  makeWorkDir: makeBrowserProfileImportWorkDir,
  removeWorkDir: removeBrowserProfileImportWorkDir,
  snapshotSqlite: snapshotBrowserSqlite,
  createDecryptBoundary: (profile) => createNativeBrowserProfilePasswordDecryptBoundary(profile),
  persistCredentials: importBrowserCredentialRecords,
  persistHistory: importBrowserHistory,
};

export function scanBrowserProfileData(
  input: { profileId: string },
  deps: BrowserProfileImportDependencies = DEFAULT_DEPENDENCIES,
): BrowserProfileDataScanResult {
  const profileId = clean(input?.profileId, 160);
  if (developmentEffectsSuppressed()) {
    return {
      schemaVersion: BROWSER_PROFILE_IMPORT_SCHEMA_VERSION, ok: false, profileId,
      passwords: [], history: [], capabilities: { passwords: "unavailable", history: "unavailable" },
      reason: "source-unavailable",
    };
  }
  const scan = readPrivateScan(profileId, deps);
  for (const item of scan.passwords) item.encryptedValue.fill(0);
  return scan.public;
}

export async function importBrowserProfileData(
  input: BrowserProfileDataImportInput,
  deps: BrowserProfileImportDependencies = DEFAULT_DEPENDENCIES,
): Promise<BrowserProfileDataImportResult> {
  const base: BrowserProfileDataImportResult = {
    schemaVersion: BROWSER_PROFILE_IMPORT_SCHEMA_VERSION,
    ok: false,
    passwords: { imported: 0, updated: 0 },
    history: { imported: 0 },
    skipped: [],
  };
  if (developmentEffectsSuppressed()) return { ...base, reason: "source-unavailable" };
  const passwordIds = Array.isArray(input?.passwordIds) ? [...new Set(input.passwordIds.map(String))] : [];
  const historyIds = Array.isArray(input?.historyIds) ? [...new Set(input.historyIds.map(String))] : [];
  if (input?.userConfirmed !== true || passwordIds.length > MAX_PASSWORD_ITEMS || historyIds.length > MAX_HISTORY_ITEMS
    || passwordIds.some((id) => !/^password_[a-f0-9]{32}$/u.test(id))
    || historyIds.some((id) => !/^history_[a-f0-9]{32}$/u.test(id))) {
    return { ...base, reason: "invalid-request" };
  }
  if (historyIds.length > 0 && !input.taskScopeId) return { ...base, reason: "scope-required" };
  if (passwordIds.length === 0 && historyIds.length === 0) return { ...base, reason: "invalid-request" };

  const profileId = clean(input.profileId, 160);
  const profile = deps.resolveProfile(profileId);
  if (!profile) return { ...base, reason: "profile-not-found" };
  const scan = readPrivateScan(profileId, deps);
  if (!scan.public.ok) return { ...base, reason: scan.public.reason ?? "source-unavailable" };

  const passwordById = new Map(scan.passwords.map((item) => [item.id, item]));
  const historyById = new Map(scan.public.history.map((item) => [item.id, item]));
  const decrypted: ImportedBrowserCredential[] = [];
  const boundary = deps.createDecryptBoundary(profile);
  try {
    for (const id of passwordIds) {
      const item = passwordById.get(id);
      if (!item) { base.skipped.push({ kind: "password", id, reason: "item-changed" }); continue; }
      if (!item.importable) { base.skipped.push({ kind: "password", id, reason: item.reason ?? "decrypt-unavailable" }); continue; }
      const decryptedValue = boundary.decrypt(item.encryptedValue);
      if (!decryptedValue.ok) { base.skipped.push({ kind: "password", id, reason: decryptedValue.reason }); continue; }
      decrypted.push({ origin: item.origin, label: item.label, username: item.username, password: decryptedValue.plaintext });
    }
    if (decrypted.length > 0) {
      const stored = await deps.persistCredentials(decrypted);
      if (!stored.ok) {
        const reason = stored.reason === "vault-corrupt" ? "vault-corrupt" : "vault-unavailable";
        for (const id of passwordIds) {
          if (!base.skipped.some((row) => row.kind === "password" && row.id === id)) {
            base.skipped.push({ kind: "password", id, reason });
          }
        }
      } else base.passwords = { imported: stored.imported, updated: stored.updated };
    }
  } finally {
    for (const item of decrypted) item.password.fill(0);
    boundary.dispose();
    for (const item of scan.passwords) item.encryptedValue.fill(0);
  }

  if (historyIds.length > 0) {
    const selected = historyIds.map((id) => historyById.get(id)).filter((item): item is BrowserProfileHistoryItem => Boolean(item));
    for (const id of historyIds) if (!historyById.has(id)) base.skipped.push({ kind: "history", id, reason: "item-changed" });
    if (selected.length > 0) {
      const stored = deps.persistHistory(input.taskScopeId!, profileId, selected);
      if (!stored.ok) {
        for (const item of selected) base.skipped.push({ kind: "history", id: item.id, reason: stored.reason });
      } else base.history.imported = stored.imported;
    }
  }

  const handled = base.passwords.imported + base.passwords.updated + base.history.imported;
  return { ...base, ok: handled > 0 || base.skipped.length === 0, ...(handled === 0 && base.skipped.length > 0 ? { reason: "operation-failed" as const } : {}) };
}
