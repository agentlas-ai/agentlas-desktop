import path from "node:path";
import Database from "better-sqlite3";
import { getDb, openedStorePath } from "../store/db";
let savedStorePath: string | null = null;
function withStore<T>(fn: (db: Database.Database) => T): T {
  try { const db = getDb(); savedStorePath = openedStorePath() ?? savedStorePath; return fn(db); }
  catch (error) {
    // Only a closed shared store may use a short-lived existing handle. Do not
    // mask errors from SQL or create a database during shutdown recovery.
    if (!(error instanceof Error) || error.message !== "Store not initialized. Call initStore() in app.whenReady()." || !savedStorePath) throw error;
    const db = new Database(savedStorePath, { fileMustExist: true });
    try { db.pragma("busy_timeout = 5000"); return fn(db); } finally { db.close(); }
  }
}
let activeTransaction: Database.Database | null = null;
function getMeta(key: string): string | null { if (activeTransaction) return (activeTransaction.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null; return withStore(db => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null); }
function setMetaIn(db: Database.Database, key: string, value: string): void { db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value); }
import { acquireAgyMcpLease } from "../runtime/agy-mcp-lease";
import { DAEMON_AUTOSTART_META_KEY, DAEMON_AUTOSTART_PREFERENCE_KEY } from "../store/daemon-autostart";
import { reconcileDaemonAutostart } from "./app-launcher";
import type { AutostartCommand } from "./autostart";

function setMeta(key: string, value: string): void { if (!activeTransaction) throw new Error("daemon_autostart_transaction_required"); setMetaIn(activeTransaction, key, value); }
const GENERATION = "daemon_autostart_generation_v1";
const SUSPENDED = "daemon_autostart_update_owner_v1";
let tail: Promise<void> = Promise.resolve();
function mutate(fn: () => void): void {
  withStore(db => db.transaction(() => { activeTransaction = db; try { fn(); const n = Number(getMeta(GENERATION) ?? "0");
    setMeta(GENERATION, String(Number.isSafeInteger(n) && n >= 0 ? n + 1 : 1)); } finally { activeTransaction = null; } })());
}
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function setAutostartIntent(enabled: boolean): void {
  mutate(() => { setMeta(DAEMON_AUTOSTART_PREFERENCE_KEY, enabled ? "enabled" : "disabled"); setMeta(DAEMON_AUTOSTART_META_KEY, enabled ? "1" : "0"); });
}
export function observeAutostartDefault(eligible: boolean): void {
  mutate(() => { const preference = getMeta(DAEMON_AUTOSTART_PREFERENCE_KEY);
    if (eligible && preference !== "enabled" && preference !== "disabled") setMeta(DAEMON_AUTOSTART_META_KEY, "1"); });
}
export function setAutostartUpdateSuspended(suspended: boolean): void {
  mutate(() => {
    const owner = getMeta(SUSPENDED);
    if (owner && owner !== String(process.pid)) throw new Error("daemon_autostart_update_owned_elsewhere");
    setMeta(SUSPENDED, suspended ? String(process.pid) : "");
  });
}
/** Recover a suspension only when its owning process is known to have exited. */
export function recoverAutostartUpdateSuspension(): void {
  const raw = getMeta(SUSPENDED); if (!raw) return;
  const pid = Number(raw); if (Number.isSafeInteger(pid) && pid > 1 && !live(pid)) {
    mutate(() => { if (getMeta(SUSPENDED) === raw) setMeta(SUSPENDED, ""); });
  }
}
/** Serialize OS effects per installation. A generation change forces reapplication. */
export function reconcileAutostartIntent(command: AutostartCommand): Promise<ReturnType<typeof reconcileDaemonAutostart>> {
  if (typeof command.manifestPath !== "string" || !path.isAbsolute(command.manifestPath)) {
    return Promise.reject(new Error("daemon_autostart_manifest_required"));
  }
  const manifestPath = command.manifestPath;
  const run = tail.catch(() => {}).then(async () => {
    const lease = await acquireAgyMcpLease(path.join(path.dirname(manifestPath), "autostart-coordinator"));
    try {
      for (let i = 0; i < 64; i++) {
        await lease.assertOwned();
        const generation = getMeta(GENERATION);
        const enabled = getMeta(DAEMON_AUTOSTART_META_KEY) === "1" && !getMeta(SUSPENDED);
        const result = reconcileDaemonAutostart(enabled, command);
        await lease.assertOwned();
        if (generation === getMeta(GENERATION)) return result;
      }
      throw new Error("daemon_autostart_intent_unstable");
    } finally { await lease.release(); }
  });
  tail = run.then(() => {}, () => {}); return run;
}
