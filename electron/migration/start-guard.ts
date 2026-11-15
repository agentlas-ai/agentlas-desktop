// Whether the 2.0 first-run migration may start in THIS process, as one answer with a machine code (Agentlas 2.0 repair, defects 1 and 12).
//
// Light on purpose (the start chain and the One drawer's start-up decision both read it, and neither may pull the conductor in).
//  * `disabled`                   the switch is off (gate.ts): the app starts exactly as before the migration existed.
//  * `store_follower`             a live background service owns the app store, so this process is not its migration owner: the one conductor is the
//                                 owner-role Main (the service never conducts; it has no window, no notice, no view of Main's runs). The start-up
//                                 hand-over (daemon/first-run-handover.ts) makes Main the owner when the service is provably idle.
//  * `dev_build_real_location`    an unpackaged build whose memory root, agent home or userData is a real place of this account (under the account's home and not under the
//                                 OS temporary folder): it would move the owner's real memory, so it does not start. A test or QA run puts all three elsewhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRunMigrationEnabled } from "./gate";

export type StartRefusal = "disabled" | "store_follower" | "dev_build_real_location";

export interface StartGuardSeams {
  role?: () => string | null;
  isPackaged?: () => boolean | undefined;
  locations?: () => string[];
}
let seams: StartGuardSeams = {};
/** Test seam. `{}` restores the real ones. */
export function setStartGuardSeamsForTests(next: StartGuardSeams): void { seams = next; }

function real(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function under(child: string, parent: string): boolean {
  const c = real(child), p = real(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function locations(): string[] {
  if (seams.locations) return seams.locations();
  const out: string[] = [];
  /* eslint-disable @typescript-eslint/no-require-imports */
  try { out.push((require("../memory/database") as typeof import("../memory/database")).memoryRoot()); } catch { /* unknown: counted below */ }
  try { out.push((require("../agents/home") as typeof import("../agents/home")).agentlasHomeDir()); } catch { /* unknown */ }
  try { out.push((require("../runtime-paths") as typeof import("../runtime-paths")).userDataDir()); } catch { /* no userData here */ }
  /* eslint-enable @typescript-eslint/no-require-imports */
  return out;
}

function packaged(): boolean | undefined {
  if (seams.isPackaged) return seams.isPackaged();
  try { return (require("electron") as typeof import("electron")).app?.isPackaged; } catch { return undefined; } // eslint-disable-line @typescript-eslint/no-require-imports
}

function role(): string | null {
  if (seams.role) return seams.role();
  try { return (require("../store/db") as typeof import("../store/db")).openedStoreMigrationRole(); } catch { return null; } // eslint-disable-line @typescript-eslint/no-require-imports
}

/** A place is "real" when it is under the account's own home folder and not under the OS temporary folder (Windows keeps %TEMP% inside the home). */
function isRealLocation(location: string): boolean {
  if (!location) return true; // unknown: fail closed
  if (under(location, os.tmpdir())) return false;
  let home = os.homedir();
  try { home = os.userInfo().homedir || home; } catch { /* no passwd entry: HOME is the home */ }
  return under(location, home);
}

/** An unpackaged build starts only when the memory root, the agent home and userData are all known and none is a real place of this account. */
export function developmentBuildOnRealLocation(): boolean {
  if (packaged() === true) return false;   // only a build that says it is packaged is one; a process that cannot say (a plain Node run) is checked like a development build (defect 10)
  const found = locations();
  return found.length < 3 || found.some(isRealLocation);
}

/** `null` = may start. Reads only; never throws. */
export function firstRunStartRefusal(): StartRefusal | null {
  if (!firstRunMigrationEnabled()) return "disabled";
  if (role() !== "owner") return "store_follower";
  if (developmentBuildOnRealLocation()) return "dev_build_real_location";
  return null;
}

/**
 * Before the app store is opened (so before this process knows its role): has no account finished the migration yet? One read-only look at the store's meta
 * table, only while the switch is on and a compatible background service is alive. A second account on a device whose first account finished is not seen here
 * (its store opens as a follower while the service is busy; it starts at the next owner start).
 */
export function firstRunLikelyPending(storePath: string): boolean {
  if (!firstRunMigrationEnabled() || developmentBuildOnRealLocation()) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(storePath, { readonly: true, fileMustExist: true });
    // Nothing is left to do only when an end notice is written AND the conductor has not said 5b is still to do (defect 6; first-run.ts `OPEN_WORK_KEY`).
    try { return !db.prepare("SELECT 1 FROM meta WHERE key LIKE 'first-run-notice:v2:%' LIMIT 1").get() || !!db.prepare("SELECT 1 FROM meta WHERE key='first-run-open:v1'").get(); } finally { db.close(); }
  } catch { return false; }
}
