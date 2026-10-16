/**
 * File identity checks for managed migration backups (agentlas.sqlite.migration-backup.v1.*).
 *
 * st_dev is recorded but never compared. macOS numbers a volume each time it is
 * mounted, so the same file reports a different dev after every reboot
 * (measured 2026-10-16 on the owner's Mac: 16777229, 16777231, 16777233 across
 * the 10-05, 10-09 and 10-12 boots). While dev was compared, one backup made
 * before a reboot failed the fingerprint and retention stopped for the whole
 * set, so a cap of three grew to seven copies (8.3 GB) and kept growing by one
 * DB copy per schema upgrade. Within one directory the inode names the file;
 * size, mtime and ctime prove it was not rewritten.
 */

export interface MigrationBackupFingerprint {
  dev: string;
  ino: string;
  size: string;
  mtime: string;
  ctime: string;
}

const STABLE_KEYS = ["ino", "size", "mtime", "ctime"] as const;

/** The recorded fingerprint still describes this exact, unmodified file. */
export function sameMigrationBackupFile(recorded: unknown, live: MigrationBackupFingerprint): boolean {
  if (!recorded || typeof recorded !== "object") return false;
  const value = recorded as Record<string, unknown>;
  return STABLE_KEYS.every((key) => typeof value[key] === "string" && value[key] === live[key]);
}

/** The backup was taken from this database file (same inode in the same directory). */
export function sameMigrationBackupSource(recorded: unknown, live: Pick<MigrationBackupFingerprint, "ino">): boolean {
  if (!recorded || typeof recorded !== "object") return false;
  const ino = (recorded as Record<string, unknown>).ino;
  return typeof ino === "string" && ino === live.ino;
}
