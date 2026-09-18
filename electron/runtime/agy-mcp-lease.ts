import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const lockfile = require("proper-lockfile") as {
  lock(file: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};
const STALE_MS = 30_000;
const RETRY_MS = 250;
const OWNER_PUBLICATION_GRACE_MS = 1_000;
const leases = new Map<string, { refs: number; generation: string; compromised: boolean; unlock: () => Promise<void> }>();

type OwnerState = "alive" | "dead" | "unknown";
export interface AgyMcpLeaseOptions {
  signal?: AbortSignal;
  onWait?: () => void;
}

function ownerState(value: unknown): OwnerState {
  const owner = value as { pid?: unknown; generation?: unknown } | null;
  if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 1
    || typeof owner.generation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.generation)) return "unknown";
  try { process.kill(Number(owner.pid), 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

/** Heartbeats change mtime, never lock creation identity. Retained metadata
 * from an older generation must not identify a newly created lock's owner. */
function boundOwnerState(ownerPath: string, lock: fs.Stats): OwnerState {
  try {
    const metadata = fs.statSync(ownerPath);
    if (!metadata.isFile() || metadata.size > 4096 || !Number.isFinite(lock.birthtimeMs) || lock.birthtimeMs < 0) return "unknown";
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.lockIdentity !== undefined) {
      const identity = owner.lockIdentity;
      if (!identity || !Number.isFinite(lock.dev) || !Number.isFinite(lock.ino) || lock.ino <= 0
        || identity.dev !== lock.dev || identity.ino !== lock.ino || identity.birthtimeMs !== lock.birthtimeMs) return "unknown";
    } else {
      // Legacy metadata is usable only if it was written after this lock was
      // born. Equal/unknown timestamp resolution is not positive ownership.
      if (lock.birthtimeMs <= 0 || metadata.mtimeMs <= lock.birthtimeMs) return "unknown";
    }
    return ownerState(owner);
  } catch { return "unknown"; }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("agy_mcp_lease_cancelled"), { code: "ABORT_ERR" });
}

/** Cancellation only stops this waiter, never the lock holder or its heartbeat. */
function cancellable<T>(pending: Promise<T>, signal?: AbortSignal, disposeCancelledValue?: (value: T) => Promise<void>): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? Object.assign(new Error("agy_mcp_lease_cancelled"), { code: "ABORT_ERR" }));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(async value => {
      if (signal.aborted && disposeCancelledValue) await disposeCancelledValue(value);
      else resolve(value);
    }, reject).catch(reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function waitForRetry(signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await cancellable(new Promise<void>(resolve => { timer = setTimeout(resolve, RETRY_MS); }), signal); }
  finally { if (timer) clearTimeout(timer); }
}

/** EPERM and a reused live PID are deliberately not evidence of a dead owner. */
export function agyLeaseOwnerIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return true;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A kernel-atomic mkdir lease is shared across Desktop profiles by real path.
 * Held for the whole run, not just its write. Never reclaim a live or unknown
 * owner merely because a suspended process missed its heartbeat. */
async function acquireAgyMcpLeaseInternal(configPath: string, options: AgyMcpLeaseOptions): Promise<{
  generation: string; assertOwned: () => Promise<void>; release: () => Promise<void>;
}> {
  throwIfCancelled(options.signal);
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const real = await fsp.realpath(configPath).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await fsp.realpath(path.dirname(configPath)), path.basename(configPath));
  });
  const ownerPath = `${real}.agentlas-owner.json`;
  throwIfCancelled(options.signal);
  let lease = leases.get(real);
  if (!lease) {
    const generation = randomUUID();
    let compromised = false;
    let acquiring = true;
    const guardedFs = { ...fs, stat: (file: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void) => {
      fs.stat(file, (error, stat) => {
        if (!acquiring || error || !stat || Date.now() - stat.mtimeMs <= STALE_MS) return callback(error, stat);
        // proper-lockfile uses this stat only to consider stale reclamation.
        // Its own normal heartbeat still sees the actual filesystem timestamp.
        const state = boundOwnerState(ownerPath, stat);
        if (state !== "dead") { stat.mtime = new Date(); stat.mtimeMs = Date.now(); }
        callback(null, stat);
      });
    } };
    let unlock!: () => Promise<void>;
    const waitStartedAt = Date.now();
    let lastWaitNotice = 0;
    for (;;) {
      throwIfCancelled(options.signal);
      try {
        unlock = await lockfile.lock(real, { realpath: false, stale: STALE_MS, update: 10_000, retries: 0, fs: guardedFs,
          onCompromised: () => { compromised = true; const current = leases.get(real); if (current) current.compromised = true; } });
        acquiring = false;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        throwIfCancelled(options.signal);
        let state: OwnerState = "unknown";
        try { state = boundOwnerState(ownerPath, await fsp.stat(`${real}.lock`)); } catch { /* fail closed after publication grace */ }
        // mkdir and owner publication are separate operations. Briefly allow a
        // new holder to publish; missing/malformed/unverifiable ownership never
        // authorizes reclaiming its lock or waiting indefinitely as if known.
        if (state === "unknown" && Date.now() - waitStartedAt >= OWNER_PUBLICATION_GRACE_MS) {
          throw new Error("agy_mcp_lease_owner_unverified");
        }
        if (state !== "unknown" && Date.now() - lastWaitNotice >= 10_000) {
          lastWaitNotice = Date.now();
          try { options.onWait?.(); } catch { /* status observers do not own admission */ }
        }
        // A proven dead owner is reclaimed ONLY by the existing stale-lock
        // protocol, never by deleting a fresh lock or signalling its PID.
        await waitForRetry(options.signal);
      }
    }
    try {
      throwIfCancelled(options.signal);
      const lock = await fsp.stat(`${real}.lock`);
      const lockIdentity = { dev: lock.dev, ino: lock.ino, birthtimeMs: lock.birthtimeMs };
      await fsp.writeFile(ownerPath, JSON.stringify({ pid: process.pid, generation, lockIdentity }), { mode: 0o600 });
    } catch (error) { await unlock(); throw error; }
    lease = { refs: 0, generation, compromised, unlock };
    leases.set(real, lease);
  }
  lease.refs += 1;
  const held = lease;
  let released = false;
  const assertOwned = async () => {
    if (released || held.compromised) throw new Error("agy_mcp_lease_lost");
    const owner = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
    if (owner.pid !== process.pid || owner.generation !== held.generation
      || boundOwnerState(ownerPath, await fsp.stat(`${real}.lock`)) !== "alive") throw new Error("agy_mcp_lease_lost");
  };
  return { generation: held.generation, assertOwned, release: async () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0) return;
    leases.delete(real);
    // The lock library removes only its own lock. Keep owner metadata so a
    // crash/compromise cannot erase a later owner's identity in a cleanup race.
    await held.unlock();
  } };
}

let acquisitionTail: Promise<void> = Promise.resolve();
export async function acquireAgyMcpLease(configPath: string, options: AgyMcpLeaseOptions = {}): ReturnType<typeof acquireAgyMcpLeaseInternal> {
  throwIfCancelled(options.signal);
  const previous = acquisitionTail;
  const pending = previous.then(async () => {
    throwIfCancelled(options.signal);
    const lease = await acquireAgyMcpLeaseInternal(configPath, options);
    if (options.signal?.aborted) { await lease.release(); throwIfCancelled(options.signal); }
    return lease;
  });
  acquisitionTail = pending.then(() => {}, () => {});
  // A queued waiter can cancel promptly without opening the serialization gate
  // early or leaving an eventual acquisition unobserved/unreleased.
  return cancellable(pending, options.signal, lease => lease.release());
}
