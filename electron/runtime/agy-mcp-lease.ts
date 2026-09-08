import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const lockfile = require("proper-lockfile") as {
  lock(file: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};
const STALE_MS = 30_000;
const leases = new Map<string, { refs: number; generation: string; compromised: boolean; unlock: () => Promise<void> }>();

/** EPERM and a reused live PID are deliberately not evidence of a dead owner. */
export function agyLeaseOwnerIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return true;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A kernel-atomic mkdir lease is shared across Desktop profiles by real path.
 * Held for the whole run, not just its write. Never reclaim a live or unknown
 * owner merely because a suspended process missed its heartbeat. */
async function acquireAgyMcpLeaseInternal(configPath: string): Promise<{
  generation: string; assertOwned: () => Promise<void>; release: () => Promise<void>;
}> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const real = await fsp.realpath(configPath).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await fsp.realpath(path.dirname(configPath)), path.basename(configPath));
  });
  const ownerPath = `${real}.agentlas-owner.json`;
  let lease = leases.get(real);
  if (!lease) {
    const generation = randomUUID();
    let compromised = false;
    const guardedFs = { ...fs, stat: (file: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void) => {
      fs.stat(file, (error, stat) => {
        if (error || !stat || Date.now() - stat.mtimeMs <= STALE_MS) return callback(error, stat);
        // proper-lockfile uses this stat only to consider stale reclamation.
        // Its own normal heartbeat still sees the actual filesystem timestamp.
        let alive = true;
        try { alive = agyLeaseOwnerIsAlive(JSON.parse(fs.readFileSync(ownerPath, "utf8")).pid); } catch { /* unknown owner stays locked */ }
        if (alive) { stat.mtime = new Date(); stat.mtimeMs = Date.now(); }
        callback(null, stat);
      });
    } };
    const unlock = await lockfile.lock(real, { realpath: false, stale: STALE_MS, update: 10_000, retries: 0, fs: guardedFs,
      onCompromised: () => { compromised = true; const current = leases.get(real); if (current) current.compromised = true; } });
    try {
      await fsp.writeFile(ownerPath, JSON.stringify({ pid: process.pid, generation }), { mode: 0o600 });
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
    if (owner.pid !== process.pid || owner.generation !== held.generation) throw new Error("agy_mcp_lease_lost");
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
export async function acquireAgyMcpLease(configPath: string): ReturnType<typeof acquireAgyMcpLeaseInternal> {
  let release!: () => void;
  const previous = acquisitionTail;
  acquisitionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await acquireAgyMcpLeaseInternal(configPath); }
  finally { release(); }
}
