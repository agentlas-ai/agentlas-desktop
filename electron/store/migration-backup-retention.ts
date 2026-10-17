/**
 * Storage-pass step: keep at most three managed DB-upgrade copies
 * (agentlas.sqlite.migration-backup.v1.*), checked off the main thread.
 *
 * Why here and not in initStore: copies are only made on an update launch,
 * where the install journal stopped the old in-store prune, and every other
 * launch opens the store as a follower (daemon alive), which never pruned. The
 * cap of three therefore never held (owner Mac 2026-10-17: 7 copies, 8.3 GB).
 * Dropping those guards would have put ~29 s of synchronous integrity checks
 * before store-ready instead.
 *
 * - Main does one readdir. Three copies or fewer (the steady state) cost
 *   nothing more and start no process.
 * - Otherwise a short-lived child (migration-backup-check.ts, started like the
 *   daemon with ELECTRON_RUN_AS_NODE=1) runs pruneManagedMigrationBackups:
 *   the same identity rules, integrity checks only on the copies that stay,
 *   and the unlink under the store's write lock after a fingerprint re-check.
 * - Main only awaits the child's one-line verdict, with a 10-minute ceiling.
 *
 * Never touched: the live store, updater/recovery/*, and every other *.bak or
 * ad-hoc copy (.precover, .malformed, .recovered, .corrupt-backup); those
 * names never match the managed prefix and suffix rules.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { managedMigrationBackupsOverCap, type ManagedMigrationBackupSkip } from "./db";

export interface MigrationBackupRetention {
  removed: number;
  bytes: number;
  skipped: ManagedMigrationBackupSkip | "timeout";
}

const CHILD_TIMEOUT_MS = 10 * 60_000;
const SKIPS = new Set<string>(["none", "unverified", "integrity", "migration-lock", "changed", "busy", "error"]);

function parseVerdict(stdout: string): MigrationBackupRetention | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as Partial<MigrationBackupRetention>;
    if (!Number.isSafeInteger(value.removed) || Number(value.removed) < 0) return null;
    if (!Number.isFinite(value.bytes) || Number(value.bytes) < 0) return null;
    if (typeof value.skipped !== "string" || !SKIPS.has(value.skipped)) return null;
    return { removed: Number(value.removed), bytes: Number(value.bytes), skipped: value.skipped as ManagedMigrationBackupSkip };
  } catch {
    return null;
  }
}

export async function retireManagedMigrationBackups(options: {
  storePath: string;
  /** Test seam; production uses the compiled sibling entry and this executable. */
  childEntry?: string;
  execPath?: string;
  timeoutMs?: number;
}): Promise<MigrationBackupRetention> {
  const { storePath } = options;
  const none: MigrationBackupRetention = { removed: 0, bytes: 0, skipped: "none" };
  if (!storePath || storePath === ":memory:" || storePath.startsWith("file:")) return none;
  try {
    if (!managedMigrationBackupsOverCap(storePath)) return none;
  } catch {
    return { ...none, skipped: "error" };
  }
  // An owner running the ladder holds this lock. The child takes it atomically
  // before deleting; checking here only avoids a pointless child.
  if (fs.existsSync(`${storePath}.migration.lock`)) return { ...none, skipped: "migration-lock" };
  const entry = options.childEntry ?? path.join(__dirname, "migration-backup-check.js");
  return await new Promise<MigrationBackupRetention>((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawn(options.execPath ?? process.execPath, [entry, storePath], {
      stdio: ["ignore", "pipe", "ignore"],
      // Windows: no console window for a background helper.
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const stopChild = (): void => { try { child.kill(); } catch { /* already gone */ } };
    // The helper never outlives the app that started it.
    process.once("exit", stopChild);
    const finish = (value: MigrationBackupRetention): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("exit", stopChild);
      resolve(value);
    };
    const timer = setTimeout(() => { stopChild(); finish({ ...none, skipped: "timeout" }); }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length < 4096) stdout += chunk; });
    child.on("error", () => finish({ ...none, skipped: "error" }));
    child.on("close", () => finish(parseVerdict(stdout) ?? { ...none, skipped: "error" }));
  });
}
