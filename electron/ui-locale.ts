// Main-process UI locale snapshot without importing the Electron bootstrap.
// Utility modules and tests can read this state without starting main.ts.
import fs from "node:fs";
import { userDataPath } from "./runtime-paths";

let locale: "ko" | "en" = "en";
let saved: { checkedAt: number; mtimeMs: number; value: "ko" | "en" } | null = null;
const FILE = "ui-locale.json";
const RECHECK_MS = 2_000;

/**



 */
export function currentUiLocale(): "ko" | "en" {
  const now = Date.now();
  if (saved && now - saved.checkedAt < RECHECK_MS) return saved.value;
  try {
    const file = userDataPath(FILE);
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (!saved || saved.mtimeMs !== mtimeMs) {
      const value = (JSON.parse(fs.readFileSync(file, "utf8")) as { locale?: unknown }).locale === "ko" ? "ko" : "en";
      saved = { checkedAt: now, mtimeMs, value };
    } else saved.checkedAt = now;
    return saved.value;
  } catch {
    return locale;
  }
}

export type UiLocalePref = "ko" | "en" | "system";
export interface UiLocaleCore { locale: "ko" | "en"; pref: UiLocalePref; revision: number; updatedAt: string | null }

/** The core language setting (one source of truth for the screen, the menu, the daemon and every SDK caller). Uncached. */
export function readUiLocaleCore(): UiLocaleCore | null {
  try {
    const raw = JSON.parse(fs.readFileSync(userDataPath(FILE), "utf8")) as { locale?: unknown; pref?: unknown; revision?: unknown; updatedAt?: unknown };
    const loc = raw.locale === "ko" ? "ko" : "en";
    const pref: UiLocalePref = raw.pref === "system" || raw.pref === "ko" || raw.pref === "en" ? raw.pref : loc;
    const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    return { locale: loc, pref, revision, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
  } catch {
    return null;
  }
}

/**
 * Persist the core setting. The revision moves only when the effective choice (resolved locale + preference) changes, so
 * the renderer echoing back a value it just applied (menu:setLocale) never bumps it and never starts a loop.
 */
export function writeUiLocaleCore(next: "ko" | "en", pref?: UiLocalePref): UiLocaleCore {
  const result = persistUiLocaleCore(next, pref);
  if (result.ok) return result.core;
  // Legacy menu/screen setter: without a user data directory (tests, tools) the in-process value still applies. The SDK
  // port (settings.language.set) never reports this as saved; it uses persistUiLocaleCore directly.
  locale = next;
  return result.attempted ?? { locale: next, pref: pref ?? next, revision: (result.current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
}

export type UiLocalePersistResult =
  | { ok: true; core: UiLocaleCore; changed: boolean }
  | { ok: false; code: "stale_revision" | "persist_failed"; message: string; current: UiLocaleCore | null; attempted?: UiLocaleCore };

const LOCK_WAIT_MS = 2_000;
interface UiLocaleMutexConnection { exec(sql: string): unknown; close(): unknown }
type UiLocaleMutexConstructor = new (filename: string, options?: { timeout?: number }) => UiLocaleMutexConnection;

/** A persistent, dedicated SQLite file is only a kernel-lock namespace; locale data stays in JSON.
 * Never unlink this file: all participating Main/daemon/Terminal writers must open the same inode.
 * Driver discovery follows Terminal's memory-probe pattern; real file/lock failures never select another driver.
 */
function acquireUiLocaleMutex(file: string): () => void {
  let Native: UiLocaleMutexConstructor | null = null;
  try {
    const Candidate = require("better-sqlite3") as UiLocaleMutexConstructor;
    const probe = new Candidate(":memory:");
    probe.close();
    Native = Candidate;
  } catch { /* missing native package or incompatible ABI: use the host's built-in SQLite */ }
  const db: UiLocaleMutexConnection = Native
    ? new Native(`${file}.mutex.sqlite`, { timeout: LOCK_WAIT_MS })
    : new (require("node:sqlite") as { DatabaseSync: new (filename: string) => UiLocaleMutexConnection }).DatabaseSync(`${file}.mutex.sqlite`);
  try {
    db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    try { db.close(); } catch { /* preserve lock/open failure */ }
    throw error;
  }
  return () => {
    try { db.exec("ROLLBACK"); } catch { /* close also releases an active transaction */ }
    try { db.close(); } catch { /* best effort connection cleanup */ }
  };
}

/**
 * Durable compare-and-set of the core setting. Main and the background service both write it, so the read–increment–write
 * runs under SQLite's process-owned writer lock and is confirmed by reading the file back. A failed write is a typed failure, never a
 * new revision: the old code swallowed ENOSPC and returned the next revision, so the SDK reported "saved" for a language
 * that came back as the old one after a restart (native-harness notyet NH17).
 */
export function persistUiLocaleCore(next: "ko" | "en", pref?: UiLocalePref, expectedRevision?: number): UiLocalePersistResult {
  let file: string;
  try { file = userDataPath(FILE); }
  catch (e) { return { ok: false, code: "persist_failed", message: `no user data directory: ${(e as Error).message}`, current: null }; }
  let release: () => void;
  try { release = acquireUiLocaleMutex(file); }
  catch (e) {
    const error = e as NodeJS.ErrnoException;
    return { ok: false, code: "persist_failed", message: `lock: ${error.code ?? error.message}`, current: readUiLocaleCore() };
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const before = readUiLocaleCore();
    if (expectedRevision !== undefined && (before?.revision ?? 0) !== expectedRevision) {
      return { ok: false, code: "stale_revision", message: `current revision is ${before?.revision ?? 0}`, current: before };
    }
    const nextPref: UiLocalePref = pref ?? (before && before.pref === "system" && before.locale === next ? "system" : next);
    const changed = !before || before.locale !== next || before.pref !== nextPref;
    const core: UiLocaleCore = {
      locale: next,
      pref: nextPref,
      revision: changed ? (before?.revision ?? 0) + 1 : before.revision,
      updatedAt: changed || !before?.updatedAt ? new Date().toISOString() : before.updatedAt,
    };
    if (!changed) { locale = next; return { ok: true, core, changed: false }; }
    try {
      fs.writeFileSync(temp, JSON.stringify(core), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (e) {
      try { fs.unlinkSync(temp); } catch { /* never created */ }
      return { ok: false, code: "persist_failed", message: (e as NodeJS.ErrnoException).code ?? (e as Error).message, current: before, attempted: core };
    }
    saved = null;
    const readback = readUiLocaleCore();
    if (!readback || readback.revision !== core.revision || readback.locale !== core.locale || readback.pref !== core.pref) {
      return { ok: false, code: "persist_failed", message: "the saved file does not read back as written", current: readback, attempted: core };
    }
    locale = next;
    return { ok: true, core: readback, changed: true };
  } finally {
    release();
  }
}

export function setCurrentUiLocale(next: "ko" | "en", pref?: UiLocalePref): void {
  writeUiLocaleCore(next, pref);
}
