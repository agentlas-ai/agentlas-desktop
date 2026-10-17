/**
 * Child-process entry for the managed migration-backup cap.
 *
 * The storage pass (migration-backup-retention.ts) starts this file with
 * ELECTRON_RUN_AS_NODE=1, the same way the daemon is started, so the
 * integrity checks of pruneManagedMigrationBackups (quick_check of the live
 * store and of every copy that stays, about 17-29 s on a 1.9 GB store) never
 * run on the Desktop main thread.
 *
 * argv[2] is the exact store file the caller has open. The connection here is
 * one more WAL participant: its checks read a snapshot without blocking
 * writers, and its only write lock is the short re-check and unlink step.
 * Prints exactly one JSON line: the ManagedMigrationBackupPruneOutcome.
 */
import Database from "better-sqlite3";
import { pruneManagedMigrationBackups, type ManagedMigrationBackupPruneOutcome } from "./db";

function run(storePath: string | undefined): ManagedMigrationBackupPruneOutcome {
  if (!storePath) return { removed: 0, bytes: 0, skipped: "error" };
  let db: Database.Database | null = null;
  try {
    db = new Database(storePath, { fileMustExist: true });
    // Off the main thread a writer's lock may be waited for, as other hosts do.
    db.pragma("busy_timeout = 15000");
    return pruneManagedMigrationBackups(db, null);
  } catch {
    return { removed: 0, bytes: 0, skipped: "error" };
  } finally {
    try { db?.close(); } catch { /* exiting */ }
  }
}

process.stdout.write(`${JSON.stringify(run(process.argv[2]))}\n`);
