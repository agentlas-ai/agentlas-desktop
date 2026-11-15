// The name a Windows path is handed to SQLite under.
//
// SQLite's Windows file layer does not use long paths: a database whose path is 252 characters or more cannot be opened (SQLITE_CANTOPEN),
// or opens and then cannot make its `-wal`/`-journal` file, because those names are 4 and 8 characters longer than the file (win-vm-3 on a real
// Windows 11 guest: 251 characters open, 252 do not; with the `\\?\` prefix 256, 260, 271 and 301 all open and write). The pre-migration backup
// (`VACUUM INTO`, store/db.ts backupDatabaseFile) is opened by SQLite too, under a name 87 characters longer than the store, so from 173 characters
// on it silently failed ("upgrading without it"): the prefix starts where the longest of those names would reach MAX_PATH. Node's own fs adds the
// prefix itself, so only the SQLite handle needs it. Plain Node, no Electron import (the background service opens the store too).
import path from "node:path";

/** Windows MAX_PATH, counting the terminating NUL. */
const WINDOWS_MAX_PATH = 260;
/**
 * The longest name SQLite itself opens next to a store file: the managed pre-migration backup `<store>.migration-backup.v1.<tag>.<uuid>.bak`
 * (tag at most `v103-seat-session`, 17 characters; db.ts MIGRATION_BACKUP_TAG_RE) and that copy's `-journal`.
 */
const LONGEST_SIDECAR_SUFFIX = ".migration-backup.v1.".length + "v103-seat-session".length + ".".length + 36 + ".bak".length + "-journal".length;
/** Windows' own limits: one name inside a path, and a whole extended-length path. */
const WINDOWS_MAX_COMPONENT = 255;
const WINDOWS_MAX_EXTENDED_PATH = 32_767;

function isSpecialName(file: string): boolean {
  return file === "" || file === ":memory:" || file.startsWith("file:");
}

/**
 * The path to give `new Database(...)`. Unchanged everywhere except an absolute Windows path whose longest sibling file would reach MAX_PATH:
 * that one gets the extended-length prefix (`\\?\C:\...`, `\\?\UNC\server\share\...`). A short path, another OS and a name that is not a file
 * path come back exactly as given.
 */
export function sqliteOpenPath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || isSpecialName(file)) return file;
  if (!path.win32.isAbsolute(file)) return file;
  const full = path.win32.resolve(file);
  if (full.startsWith("\\\\?\\") || full.startsWith("\\\\.\\")) return file;   // already a device or extended-length path (also spelled with forward slashes)
  if (full.length + LONGEST_SIDECAR_SUFFIX < WINDOWS_MAX_PATH) return file;
  return full.startsWith("\\\\") ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}

/** Why Windows cannot hold this database path even with the prefix; null when it can, and always null on another OS. A closed word, never parsed from an error text. */
export function storePathLimit(file: string, platform: NodeJS.Platform = process.platform): "path_too_long" | "name_too_long" | null {
  if (platform !== "win32" || isSpecialName(file) || !path.win32.isAbsolute(file)) return null;
  const full = path.win32.resolve(file);
  if (full.length + LONGEST_SIDECAR_SUFFIX >= WINDOWS_MAX_EXTENDED_PATH) return "path_too_long";
  const parts = full.split("\\");
  const fileName = parts.pop() ?? "";
  if (parts.some((part) => part.length > WINDOWS_MAX_COMPONENT) || fileName.length + LONGEST_SIDECAR_SUFFIX > WINDOWS_MAX_COMPONENT) return "name_too_long";
  return null;
}

/** Thrown before the store is opened when `storePathLimit` names a limit. `code` is the closed word callers branch on. */
export function storePathLimitError(file: string, limit: "path_too_long" | "name_too_long"): Error {
  const error = new Error(
    `Agentlas cannot open ${path.win32.basename(file)}: its ${limit === "path_too_long" ? "path is longer" : "folder or file name is longer"} than Windows allows. `
    + "Choose a shorter data folder.",
  ) as Error & { code?: string };
  error.code = `store_${limit}`;
  return error;
}
