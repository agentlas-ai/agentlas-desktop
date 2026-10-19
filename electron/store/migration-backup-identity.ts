/**










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
