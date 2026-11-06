import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { observeLocalProcessIdentity } from '../local-model-hub/platform';

const lockfile = require('proper-lockfile') as { lock(target: string, options: unknown): Promise<() => Promise<void>> };
/** "This monitor is running" is a fact only while its holder lives; a holder that was killed leaves the lock until it goes stale. */
const OPTIONS = { realpath: false, stale: 240000, retries: 0 };
const INSTANCE = randomUUID();
interface Owner { pid: number; instance: string; startedAt: string | null; lockId: string }

/** The OS's start time of a process as text (ps prints it in the caller's time zone, so the zone is pinned: the Main app and the daemon, or the same app after a zone change, must read one process alike): `ps -o lstart=` on macOS and Linux, Win32_Process.CreationDate on Windows. Null when it cannot be read. */
export async function processStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return (await observeLocalProcessIdentity(pid))?.createdAt ?? null;
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!fs.existsSync(ps)) continue;
    const text = await new Promise<string>(resolve => execFile(ps, ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => resolve(error ? '' : String(stdout))));
    return text.trim() || null;
  }
  return null;
}
let ownStart: Promise<string | null> | undefined;
const ownStartTime = () => (ownStart ??= processStartTime(process.pid).catch(() => null));

const ownerFile = (directory: string) => `${directory}.owner.json`;
const lockDirectory = (directory: string) => `${directory}.lock`;
/** Which lock directory this is: a lock taken and released again is another directory, so an owner record of the old one never describes the new one. */
function lockId(directory: string): string | null {
  try { const stat = fs.statSync(lockDirectory(directory), { bigint: true }); return `${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}`; } catch { return null; }
}
function readOwner(directory: string): Owner | null {
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile(directory), 'utf8')) as Owner;
    return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.instance === 'string' && typeof value.lockId === 'string' && (value.startedAt === null || typeof value.startedAt === 'string') ? value : null;
  } catch { return null; }
}
function writeOwner(directory: string, owner: Owner): void {
  const temporary = `${ownerFile(directory)}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, ownerFile(directory)); }
  finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
}
/** True only when the recorded holder is certainly gone. Anything that cannot be told counts as alive. */
async function holderIsGone(directory: string, owner: Owner): Promise<boolean> {
  if (owner.pid === process.pid) return owner.instance !== INSTANCE;
  try { process.kill(owner.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  // The pid answers: on Windows (and after a long uptime anywhere) it may belong to a newer process. Compare start times.
  if (!owner.startedAt) return false;
  const now = await processStartTime(owner.pid).catch(() => null);
  return now !== null && now !== owner.startedAt;
}

/**
 * The monitor-run lock. A held lock refuses at once (ELOCKED): that is "already running". When the holder recorded in the owner file is gone, the lock
 * is released and taken once more, so a killed app does not leave "already running" for minutes. A lock with no matching owner record is never reclaimed
 * (it may be one whose owner is still writing its record); it ends by going stale as before.
 */
export async function lockMonitorRun(directory: string): Promise<() => Promise<void>> {
  let release: (() => Promise<void>) | undefined;
  try { release = await lockfile.lock(directory, OPTIONS); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ELOCKED') throw error;
    const owner = readOwner(directory), current = lockId(directory);
    if (!owner || !current || owner.lockId !== current || !(await holderIsGone(directory, owner))) throw error;
    // Two runs may find the same dead lock at once. Reclaiming is serialised, and what was seen is checked again inside: only the first reclaimer
    // still finds the dead holder's lock; the second finds the first one's new lock (another identity) and is refused as "running".
    let guard: (() => Promise<void>) | undefined;
    try { guard = await lockfile.lock(`${directory}.reclaim`, { realpath: false, stale: 10000, retries: { retries: 50, minTimeout: 20, maxTimeout: 200 }, onCompromised: () => undefined }); }
    catch (guardError) { if ((guardError as NodeJS.ErrnoException)?.code === 'ELOCKED') throw error; throw guardError; }
    try {
      const again = readOwner(directory);
      if (!again || lockId(directory) !== current || again.lockId !== current || !(await holderIsGone(directory, again))) throw error;
      // proper-lockfile's own unlock only releases locks this process took, and a lock is an empty directory: remove the dead holder's.
      try { fs.rmdirSync(lockDirectory(directory)); } catch { /* someone else released it */ }
      release = await lockfile.lock(directory, OPTIONS);
    } finally { try { await guard(); } catch { /* the guard goes stale by itself */ } }
  }
  const id = lockId(directory);
  try { if (id) writeOwner(directory, { pid: process.pid, instance: INSTANCE, startedAt: await ownStartTime(), lockId: id }); } catch { /* without a record the lock only ends by staleness, as before */ }
  const held = release!;
  return async () => {
    const owner = readOwner(directory);
    if (owner && owner.instance === INSTANCE && owner.pid === process.pid) { try { fs.unlinkSync(ownerFile(directory)); } catch { /* gone already */ } }
    try { await held(); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ERELEASED') throw error; }
  };
}
