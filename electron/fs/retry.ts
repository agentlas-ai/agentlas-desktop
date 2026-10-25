// Folder swaps that survive a file being held for a moment.
//
// Windows audit 2026-10-24 (fs.md #6, #7, #15): Windows Defender scans a freshly written tree with
// executables, the search indexer opens new files, and a leftover child can still hold one. A rename
// or delete then fails with EPERM/EBUSY/EACCES for a few hundred milliseconds. The only retry helper
// lived privately in runtime/native-cli.ts, so every other folder swap failed outright. macOS/Linux
// rarely see these codes; the retry is a no-op there unless they do.
//
// Plain Node, no Electron import (daemon-safe). scripts/test-windows-fs-resilience.cjs drives it with
// a fake fs that throws the Windows codes.
import fs from "node:fs";
import fsp from "node:fs/promises";

/** Codes Windows returns while another process (AV scanner, indexer, a closing child) holds a path. */
export const TRANSIENT_LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isTransientLock(error: unknown): boolean {
  return TRANSIENT_LOCK_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  /** First backoff in ms; doubles up to maxDelayMs. */
  delayMs?: number;
  maxDelayMs?: number;
  /** Injected by private tests. */
  fsImpl?: Pick<typeof fs, "renameSync" | "rmSync">;
  sleepSync?: (ms: number) => void;
}

const DEFAULTS = { attempts: 12, delayMs: 25, maxDelayMs: 400 };

function backoff(attempt: number, options: RetryOptions): number {
  const base = options.delayMs ?? DEFAULTS.delayMs;
  return Math.min(options.maxDelayMs ?? DEFAULTS.maxDelayMs, base * 2 ** attempt);
}

function blockingSleep(ms: number): void {
  // Synchronous callers (startup materialization) cannot await; Atomics.wait blocks this thread only.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** renameSync, retried while the path is transiently locked. Any other error is thrown at once. */
export function renameSyncWithRetry(from: string, to: string, options: RetryOptions = {}): void {
  const impl = options.fsImpl ?? fs;
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  for (let attempt = 0; ; attempt += 1) {
    try { impl.renameSync(from, to); return; }
    catch (error) {
      if (!isTransientLock(error) || attempt >= attempts - 1) throw error;
      (options.sleepSync ?? blockingSleep)(backoff(attempt, options));
    }
  }
}

/** fs.promises.rename, retried while the path is transiently locked. */
export async function renameWithRetry(from: string, to: string, options: RetryOptions & {
  renameImpl?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<void> {
  const rename = options.renameImpl ?? ((a: string, b: string) => fsp.rename(a, b));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!isTransientLock(error) || attempt >= attempts - 1) throw error;
      await sleep(backoff(attempt, options));
    }
  }
}

/** rmSync with Node's own retry for EBUSY/EPERM/ENOTEMPTY (maxRetries applies to recursive removal). */
export function rmSyncWithRetry(target: string, options: RetryOptions = {}): void {
  (options.fsImpl ?? fs).rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
