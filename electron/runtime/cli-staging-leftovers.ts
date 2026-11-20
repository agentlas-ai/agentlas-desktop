// Claude Code's OS sandbox prepares an atomic-write staging folder, `<working folder>/.claude/.cc-writes/`, for every folder a write run may write
// to (the CLI's ensureAtomicWriteStagingDirs; a hidden, empty folder, mode 0700, left behind when the run ends).
// it showed up in the person's own folders (for example /tmp/work/todo). Nothing of the product's may stay in a person's folder,
// so a turn that created it removes it when it ends.
//
// Only what this process saw appear is removed: a `.cc-writes` or `.claude` that was there before the first run in the folder started is the
// person's (their own Claude Code uses the same folder) and stays. Only EMPTY folders are removed (rmdir, never recursive), so a staged write that
// is still in flight, or anything the person put there, is never touched. While more than one turn runs in a folder, the last one to end cleans.
import fs from "node:fs";
import path from "node:path";

interface FolderWatch { runs: number; claudeExisted: boolean; stagingExisted: boolean }
const watches = new Map<string, FolderWatch>();

const STAGING_NAME = ".cc-writes";

function realFolder(cwd: string | undefined | null): string | null {
  if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  try { const real = fs.realpathSync(cwd); return fs.statSync(real).isDirectory() ? real : null; } catch { return null; }
}

function isRealEmptyDir(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(target).length === 0;
  } catch { return false; }
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

/** Remove the staging leftovers a finished turn made in `folder` (see the file header); exported for the gate. */
export function removeCreatedStagingLeftovers(folder: string, before: { claudeExisted: boolean; stagingExisted: boolean }): string[] {
  const removed: string[] = [];
  const claudeDir = path.join(folder, ".claude");
  const staging = path.join(claudeDir, STAGING_NAME);
  try {
    if (!before.stagingExisted && isRealEmptyDir(staging)) { fs.rmdirSync(staging); removed.push(staging); }
    if (!before.claudeExisted && isRealEmptyDir(claudeDir)) { fs.rmdirSync(claudeDir); removed.push(claudeDir); }
  } catch { /* a folder that cannot be removed now (a write in flight, a permission) stays; nothing here decides the turn */ }
  return removed;
}

const watchedChildren = new WeakSet<object>();
/** What a folder held just before a run that may start a process there: the process is spawned (and makes the folders) after this is read. */
const armed = new Map<string, { claudeExisted: boolean; stagingExisted: boolean; at: number }>();
const ARMED_MAX_AGE_MS = 120_000;

/** Reads what `cwd` holds now. Call it before the process is started; watchCliStagingFolder uses it as the "before" (a stale one, or none, is read at that moment). */
export function armCliStagingFolder(cwd: string | undefined | null): void {
  const folder = realFolder(cwd);
  if (!folder || watches.has(folder)) return;
  const now = Date.now();
  for (const [key, value] of armed) if (now - value.at > ARMED_MAX_AGE_MS) armed.delete(key);
  armed.set(folder, { claudeExisted: exists(path.join(folder, ".claude")), stagingExisted: exists(path.join(folder, ".claude", STAGING_NAME)), at: now });
}
let exitHookInstalled = false;

/**
 * Called once for every Claude process (a resident one is called again on every turn it serves, and counted once). The folder's staging
 * folders are removed when the LAST process working in it has exited: while a resident process lives it may stage its next write there, so
 * removing the folder between two turns would make that write fail. The app's own exit removes what is left (the 12-hour idle sweep and
 * a crash that never reaches `close` leave it until then).
 */
export function watchCliStagingFolder(cwd: string | undefined | null, child: { once(event: "close", listener: () => void): unknown }): void {
  const folder = realFolder(cwd);
  if (!folder || watchedChildren.has(child)) return;
  watchedChildren.add(child);
  let watch = watches.get(folder);
  if (!watch) {
    const before = armed.get(folder);
    armed.delete(folder);
    watch = before && Date.now() - before.at <= ARMED_MAX_AGE_MS
      ? { runs: 0, claudeExisted: before.claudeExisted, stagingExisted: before.stagingExisted }
      : { runs: 0, claudeExisted: exists(path.join(folder, ".claude")), stagingExisted: exists(path.join(folder, ".claude", STAGING_NAME)) };
    watches.set(folder, watch);
  }
  watch.runs += 1;
  const own = watch;
  child.once("close", () => {
    own.runs -= 1;
    if (own.runs <= 0 && watches.get(folder) === own) {
      watches.delete(folder);
      removeCreatedStagingLeftovers(folder, own);
    }
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => { for (const [dir, w] of watches) removeCreatedStagingLeftovers(dir, w); });
  }
}
