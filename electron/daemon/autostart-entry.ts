import fs from "node:fs";
import path from "node:path";
import { AUTOSTART_READY_KEY, readDaemonAutostartManifest } from "./autostart-manifest";
import { canonicalDaemonPath, daemonControlSocketPath, resolveDaemonServiceIdentity } from "./service-identity";
import { callControlSocket } from "./control-socket";

/** sysexits EX_TEMPFAIL: the start failed for a reason that can pass (a locked store, a service that was slow to come up). launchd
 * KeepAlive{SuccessfulExit:false} and systemd Restart=on-failure start the entry again on any non-zero status. */
export const AUTOSTART_TRANSIENT_EXIT_CODE = 75;
const STORE_LOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

/** A refusal no retry changes: a stale or foreign definition, a store this entry may not boot. The supervisor must not respawn it
 * (exit 0). Marked by the error's own typed code; the message is never read to decide. */
function permanentRefusal(code: string): never {
  throw Object.assign(new Error(code), { code, autostartRefusal: "permanent" });
}
export function classifyAutostartFailure(error: unknown): { code: string; permanent: boolean } {
  const own = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
  const marked = Boolean(error && typeof error === "object" && (error as { autostartRefusal?: unknown }).autostartRefusal === "permanent");
  return { code: own ?? "daemon_autostart_boot_failed", permanent: marked || (own !== null && own.startsWith("daemon_autostart_")) };
}

/** OS login entry, never a migration/seed owner. The installed GUI must have
 * opened and seeded this exact DB before it may publish the manifest. */
export async function startAutostartDaemon(manifestPath: string): Promise<void> {
  // Everything wrong with the definition itself (unreadable, stale, another install) is permanent, whatever raised it.
  const m = (() => {
    try { return readDaemonAutostartManifest(manifestPath); }
    catch (error) { return permanentRefusal(classifyAutostartFailure(error).code); }
  })();
  if (canonicalDaemonPath(m.entry) !== canonicalDaemonPath(path.join(__dirname, "main.js"))) permanentRefusal("daemon_autostart_entry_mismatch");
  if (canonicalDaemonPath(process.execPath) !== canonicalDaemonPath(m.executable)) permanentRefusal("daemon_autostart_executable_mismatch");
  // Open read-only first, with fileMustExist. A login service must never create
  // an empty DB and then pretend recovery succeeded.
  const Database = (await import("better-sqlite3")).default;
  const checkStore = () => {
    const db = new Database(m.storePath, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma("user_version", { simple: true }) !== m.requiredSchemaVersion) permanentRefusal("daemon_autostart_schema_mismatch");
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(AUTOSTART_READY_KEY) as { value?: string } | undefined;
      const ready = row?.value ? JSON.parse(row.value) : null;
      if (ready?.token !== m.storeBootstrapToken || ready?.appVersion !== m.appVersion
        || ready?.schemaVersion !== m.requiredSchemaVersion) permanentRefusal("daemon_autostart_store_not_bootstrapped");
    } finally { db.close(); }
  };
  // The GUI migrating or a login-time burst can hold the store for a moment. Wait a bounded while before calling that a failure, so
  // a login entry with no supervisor (Windows Run key) is not left without a service by one lock.
  for (let attempt = 0; ; attempt += 1) {
    try { checkStore(); break; }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const locked = typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
      if (!locked || attempt >= STORE_LOCK_RETRY_DELAYS_MS.length) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, STORE_LOCK_RETRY_DELAYS_MS[attempt]));
    }
  }
  // The identity the daemon will compute itself (daemon/main.ts refuses a different one). A manifest an earlier build published
  // validated under its own older formula, so its stored value is not what the service will report.
  const serviceIdentity = resolveDaemonServiceIdentity(m).serviceIdentity;
  Object.assign(process.env, {
    ELECTRON_RUN_AS_NODE: "1", AGENTLAS_USER_DATA: m.userDataDir, AGENTLAS_STORE_PATH: m.storePath,
    AGENTLAS_INSTALL_IDENTITY: JSON.stringify(m.installIdentity), AGENTLAS_RUNTIME_APP_METADATA: JSON.stringify(m.appMetadata),
    AGENTLAS_DAEMON_SERVICE_IDENTITY: serviceIdentity, AGENTLAS_STORE_MIGRATION_ROLE: "follower",
    AGENTLAS_DESKTOP_PARENT_PID: "", AGENTLAS_APP_INSTANCE_ID: "", AGENTLAS_EXPECTED_STORE_IDENTITY: "",
  });
  const { startDaemon } = await import("./main");
  await startDaemon();
  const address = daemonControlSocketPath(m.userDataDir);
  const ping = await callControlSocket(address, "daemon.ping", undefined, 5_000) as { pid?: number; bootId?: string; serviceIdentity?: string };
  if (ping.pid !== process.pid || ping.serviceIdentity !== serviceIdentity || typeof ping.bootId !== "string") permanentRefusal("daemon_autostart_owner_mismatch");
  // The whole Science host (recovery + Alive clock), not an OS timer that
  // impersonates a research turn. Disabled extensions remain disabled.
  await callControlSocket(address, "science.start", { serviceIdentity, bootId: ping.bootId }, 60_000);
  // Started: an earlier failure record no longer describes this login entry.
  try { fs.unlinkSync(`${manifestPath}.failure.json`); } catch { /* absent, or a diagnostic that cannot be removed */ }
}

if (require.main === module) {
  const file = process.argv[2] === "--manifest" ? process.argv[3] : null;
  void (file && path.isAbsolute(file) ? startAutostartDaemon(file) : Promise.reject(Object.assign(new Error("daemon_autostart_manifest_required"), { code: "daemon_autostart_manifest_required" })))
    .catch(error => {
      // A permanent stale definition/schema refusal must not form a supervisor respawn loop: exit 0. Anything that can pass
      // (a locked store, a Science start that failed or timed out, a service that did not come up) exits non-zero so launchd/systemd
      // start the entry again (throttled: ThrottleInterval 60, StartLimitBurst 3); exiting 0 left the login service gone until the
      // next login, with no supervisor to notice.
      const failure = classifyAutostartFailure(error);
      const exitCode = failure.permanent ? 0 : AUTOSTART_TRANSIENT_EXIT_CODE;
      console.error("[agentlasd] autostart refused", error instanceof Error ? error.message : "unknown", failure.permanent ? "permanent" : "transient");
      if (file) {
        try { fs.writeFileSync(`${file}.failure.json`, JSON.stringify({ schema: "agentlas.daemon-autostart-failure.v1", at: new Date().toISOString(),
          code: failure.code, transient: !failure.permanent, exitCode }), { mode: 0o600 }); }
        catch { /* A diagnostic cannot grant permission to start. */ }
      }
      // performShutdown ends in process.exit(0): carry the status through the exit event.
      if (exitCode !== 0) process.once("exit", () => { process.exitCode = exitCode; });
      if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
      else process.exit(exitCode);
    });
}
