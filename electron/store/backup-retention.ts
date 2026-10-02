import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { isValidContinuitySnapshot } from "../updater/controller";

/** Only verified automatic migration copies enter this policy; other backups remain owner assets. */
export const LEGACY_BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const MAX_REFERENCE_ROWS = 2048;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_ROW_BYTES = 64 * 1024;
const MAX_REFERENCE_CANDIDATES = 16;
const attempted = new WeakSet<Database.Database>();
export interface LegacyBackupPruneResult { removed: string[]; bytes: number }

function fingerprint(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup_not_regular");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function hasSidecar(file: string): boolean {
  return SIDECARS.some(suffix => present(`${file}${suffix}`));
}
function quoted(value: string): string { return `"${value.replace(/"/g, '""')}"`; }

/** Called after the migration owner completed opening this DB. No candidates means no health scan.
 * Uncertain provenance, health, recovery ownership or a changing file preserves the entire batch.
 * Never removes a SQLite sidecar or the newest automatic legacy copy. */
export function pruneLegacyDatabaseBackups(input: {
  db: Database.Database;
  schemaVersion: number;
  recoveryProfilePaths: readonly string[];
  nowMs?: number;
}): LegacyBackupPruneResult {
  const result: LegacyBackupPruneResult = { removed: [], bytes: 0 };
  const { db } = input;
  if (attempted.has(db)) return result;
  try {
    const source = db.name;
    const now = input.nowMs ?? Date.now();
    if (!source || source === ":memory:" || !Number.isFinite(now)) return result;
    const directory = path.dirname(source), prefix = `${path.basename(source)}.`;
    if (fs.realpathSync(directory) !== path.resolve(directory)) return result;
    const copies: Array<{ name: string; file: string; stamp: number; version: number; exactVersion: boolean; identity: string; size: number; mtime: number }> = [];
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const match = /^(pre-upgrade-v([1-9]\d*)|v102-seats|v103-seat-session)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/.exec(name.slice(prefix.length));
      if (!match) continue;
      const iso = match[3].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z"), stamp = Date.parse(iso);
      if (!Number.isFinite(stamp) || new Date(stamp).toISOString().replace(/[:.]/g, "-") !== match[3]) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return result;
      const version = match[2] ? Number(match[2]) : match[1] === "v102-seats" ? 101 : 102;
      if (!Number.isSafeInteger(version)) return result;
      copies.push({ name, file, stamp, version, exactVersion: match[2] !== undefined, identity: fingerprint(file), size: stat.size, mtime: stat.mtimeMs });
    }
    copies.sort((a, b) => b.stamp - a.stamp || b.name.localeCompare(a.name));
    const candidates = copies.slice(1).filter(copy => now - copy.stamp >= LEGACY_BACKUP_MAX_AGE_MS
      && now - copy.mtime >= LEGACY_BACKUP_MAX_AGE_MS);
    if (!candidates.length) return result;
    if (candidates.length > MAX_REFERENCE_CANDIDATES || copies.length > MAX_REFERENCE_CANDIDATES + 1) return result;
    attempted.add(db); // At most one preflight per connection; recursive calls cannot enter deletion.
    const sourceIdentity = fingerprint(source);
    const profiles = new Set([directory, ...input.recoveryProfilePaths]);
    const recoveryUncertain = (): boolean => {
      for (const profile of profiles) {
        const updater = path.join(profile, "updater");
        if (present(path.join(updater, "install-journal.v1.json"))
          || present(path.join(updater, "install-journal-corrupt.v1.json"))) return true;
        const recovery = path.join(updater, "recovery");
        if (!present(recovery)) continue;
        if (fs.realpathSync(recovery) !== path.resolve(recovery)) return true;
        const entries = fs.readdirSync(recovery, { withFileTypes: true });
        if (entries.length > 32) return true;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
          const manifest = path.join(recovery, entry.name, "continuity.json"), stat = fs.lstatSync(manifest);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return true;
          const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
          if (!isValidContinuitySnapshot(parsed)) return true;
          const text = JSON.stringify(parsed);
          if (candidates.some(copy => text.includes(copy.name))) return true;
        }
      }
      return false;
    };
    if (hasSidecar(source) || copies.some(copy => hasSidecar(copy.file)) || recoveryUncertain()) return result;
    db.transaction(() => {
      if (Number(db.pragma("user_version", { simple: true })) !== input.schemaVersion
        || String(db.pragma("quick_check", { simple: true })) !== "ok"
        || (db.pragma("foreign_key_check") as unknown[]).length !== 0) return;
      for (const copy of copies) {
        if (copy.version >= input.schemaVersion) return;
        let backup: Database.Database | null = null;
        try {
          backup = new Database(copy.file, { readonly: true, fileMustExist: true });
          // Seat migrations can start on an older ladder: user_version is written only at its end.
          const backupVersion = Number(backup.pragma("user_version", { simple: true }));
          if (String(backup.pragma("quick_check", { simple: true })) !== "ok"
            || !Number.isSafeInteger(backupVersion) || backupVersion < 0
            || (copy.exactVersion ? backupVersion !== copy.version : backupVersion > copy.version)
            || (backup.pragma("foreign_key_check") as unknown[]).length !== 0) return;
        } finally { backup?.close(); }
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 257")
        .all() as Array<{ name: string }>;
      if (tables.length > 256) return;
      let referenceRows = 0, referenceBytes = 0;
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all() as Array<{ name: string }>;
        if (!columns.length || columns.length > 128) return;
        const bytes = columns.map(column => `coalesce(length(CAST(${quoted(column.name)} AS BLOB)), 0)`).join(" + ");
        const predicate = columns.flatMap(column => candidates.map(() => `instr(CAST(${quoted(column.name)} AS TEXT), ?) > 0`)).join(" OR ");
        // One bounded native pass per table, all candidates together. JS receives only size/match scalars,
        // never message/tool bodies; oversized rows and incomplete scans preserve the whole batch.
        const query = db.prepare(`SELECT ${bytes} AS bytes, CASE WHEN (${bytes}) <= ${MAX_REFERENCE_ROW_BYTES}
          THEN (${predicate}) ELSE NULL END AS matched FROM ${quoted(table.name)} LIMIT ${MAX_REFERENCE_ROWS + 1}`);
        for (const row of query.iterate(...columns.flatMap(() => candidates.map(copy => copy.name))) as Iterable<{ bytes: number; matched: number | null }>) {
          if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) return;
          referenceRows += 1;
          referenceBytes += row.bytes;
          if (referenceRows > MAX_REFERENCE_ROWS || referenceBytes > MAX_REFERENCE_BYTES
            || row.bytes > MAX_REFERENCE_ROW_BYTES || row.matched === null || row.matched !== 0) return;
        }
      }
      const unchanged = () => fingerprint(source) === sourceIdentity && !hasSidecar(source)
        && copies.every(copy => fingerprint(copy.file) === copy.identity && !hasSidecar(copy.file)) && !recoveryUncertain();
      if (!unchanged()) return;
      for (const copy of candidates) {
        if (!unchanged()) return;
        fs.unlinkSync(copy.file);
        result.removed.push(copy.name);
        result.bytes += copy.size;
        // Exclude files removed by this invocation from the subsequent race preflight.
        copies.splice(copies.indexOf(copy), 1);
      }
    }).immediate();
  } catch { /* Read/lock/health uncertainty preserves recovery material and never prevents startup. */ }
  return result;
}
