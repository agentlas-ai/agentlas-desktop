// Is the process that holds the store migration boot lease still the one that took it?
//
// Windows audit 2026-10-24 (fs.md #10): the lease was reclaimed only when the recorded pid was dead.
// Windows reuses pids quickly, so after Agentlas was killed mid-migration (Task Manager, the
// installer's Stop-Process, power loss) any process that happened to get the same pid made every
// launch wait 30 s and fail with store_migration_lock_timeout until that process exited.
//
// The owner record now also carries the holder's process start time. On Windows a live pid whose
// start time differs from the recorded one is a different process: the lease is reclaimed. When the
// start time cannot be read the old rule holds (a live or unknown owner is never removed). macOS and
// Linux keep the pid-only rule.
//
// Plain Node, injectable: scripts/test-windows-fs-resilience.cjs drives every branch.
import { spawnSync } from "node:child_process";

export interface MigrationLockOwnerRecord { pid?: unknown; processStartedAt?: unknown }

/** Wall-clock start of this process, ms since epoch. */
export function currentProcessStartedAt(now = Date.now(), uptimeSeconds = process.uptime()): number {
  return Math.round(now - uptimeSeconds * 1000);
}

/** Start times within this distance are the same process (clock and rounding slack). */
export const PROCESS_START_TOLERANCE_MS = 5_000;

export type MigrationLockOwnerState = "alive" | "dead" | "reused";

export function migrationLockOwnerState(record: MigrationLockOwnerRecord, input: {
  platform: NodeJS.Platform;
  alive: (pid: number) => boolean;
  /** Start time of a live pid (ms since epoch), or null when it cannot be read. */
  startedAt: (pid: number) => number | null;
}): MigrationLockOwnerState | "unknown" {
  const pid = Number.isSafeInteger(record.pid) && Number(record.pid) > 1 ? Number(record.pid) : null;
  if (pid === null) return "unknown";
  if (!input.alive(pid)) return "dead";
  if (input.platform !== "win32") return "alive";
  const recorded = typeof record.processStartedAt === "number" && Number.isFinite(record.processStartedAt) ? record.processStartedAt : null;
  if (recorded === null) return "alive";
  const actual = input.startedAt(pid);
  if (actual === null) return "alive";
  return Math.abs(actual - recorded) > PROCESS_START_TOLERANCE_MS ? "reused" : "alive";
}

/** Windows: a pid's start time through PowerShell (UTF-8, hidden, 5 s cap). Null on any failure. */
export function windowsProcessStartedAt(pid: number, run: typeof spawnSync = spawnSync): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`],
    { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const value = Number(String(result.stdout ?? "").trim());
    return result.status === 0 && Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
