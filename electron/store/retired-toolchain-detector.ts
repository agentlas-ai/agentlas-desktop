import type Database from "better-sqlite3";

/**
 * One-time cleanup of the rows the removed Toolchain detector and trial path left in `meta`. Nobody reads them any more
 * (the writers are gone); this deletes them at store open (owner role only) and does nothing once they are gone.
 * Draft and owner Toolchain assets are never touched. Returns the number of rows deleted.
 */
const PREFIXES = ["toolchain.detector.", "toolchain.trial.v1:"] as const;

export function purgeRetiredToolchainDetector(db: Database.Database): number {
  try {
    return db.transaction(() => PREFIXES.reduce((n, p) => n + db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(p, `${p}￿`).changes, 0)).immediate();
  } catch (error) {
    console.warn("[toolchain-detector-cleanup] skipped:", error instanceof Error ? error.message : error);
    return 0;
  }
}
