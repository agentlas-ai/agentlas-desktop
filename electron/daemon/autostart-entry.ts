import fs from "node:fs";
import path from "node:path";
import { AUTOSTART_READY_KEY, readDaemonAutostartManifest } from "./autostart-manifest";
import { canonicalDaemonPath, daemonControlSocketPath } from "./service-identity";
import { callControlSocket } from "./control-socket";

/** OS login entry, never a migration/seed owner. The installed GUI must have
 * opened and seeded this exact DB before it may publish the manifest. */
export async function startAutostartDaemon(manifestPath: string): Promise<void> {
  const m = readDaemonAutostartManifest(manifestPath);
  if (canonicalDaemonPath(m.entry) !== canonicalDaemonPath(path.join(__dirname, "main.js"))) throw new Error("daemon_autostart_entry_mismatch");
  if (canonicalDaemonPath(process.execPath) !== canonicalDaemonPath(m.executable)) throw new Error("daemon_autostart_executable_mismatch");
  // Open read-only first, with fileMustExist. A login service must never create
  // an empty DB and then pretend recovery succeeded.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(m.storePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("user_version", { simple: true }) !== m.requiredSchemaVersion) throw new Error("daemon_autostart_schema_mismatch");
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(AUTOSTART_READY_KEY) as { value?: string } | undefined;
    const ready = row?.value ? JSON.parse(row.value) : null;
    if (ready?.token !== m.storeBootstrapToken || ready?.appVersion !== m.appVersion
      || ready?.schemaVersion !== m.requiredSchemaVersion) throw new Error("daemon_autostart_store_not_bootstrapped");
  } finally { db.close(); }
  Object.assign(process.env, {
    ELECTRON_RUN_AS_NODE: "1", AGENTLAS_USER_DATA: m.userDataDir, AGENTLAS_STORE_PATH: m.storePath,
    AGENTLAS_INSTALL_IDENTITY: JSON.stringify(m.installIdentity), AGENTLAS_RUNTIME_APP_METADATA: JSON.stringify(m.appMetadata),
    AGENTLAS_DAEMON_SERVICE_IDENTITY: m.serviceIdentity, AGENTLAS_STORE_MIGRATION_ROLE: "follower",
    AGENTLAS_DESKTOP_PARENT_PID: "", AGENTLAS_APP_INSTANCE_ID: "", AGENTLAS_EXPECTED_STORE_IDENTITY: "",
  });
  const { startDaemon } = await import("./main");
  await startDaemon();
  const address = daemonControlSocketPath(m.userDataDir);
  const ping = await callControlSocket(address, "daemon.ping", undefined, 5_000) as { pid?: number; bootId?: string; serviceIdentity?: string };
  if (ping.pid !== process.pid || ping.serviceIdentity !== m.serviceIdentity || typeof ping.bootId !== "string") throw new Error("daemon_autostart_owner_mismatch");
  // The whole Science host (recovery + Alive clock), not an OS timer that
  // impersonates a research turn. Disabled extensions remain disabled.
  await callControlSocket(address, "science.start", { serviceIdentity: m.serviceIdentity, bootId: ping.bootId }, 60_000);
}

if (require.main === module) {
  const file = process.argv[2] === "--manifest" ? process.argv[3] : null;
  void (file && path.isAbsolute(file) ? startAutostartDaemon(file) : Promise.reject(new Error("daemon_autostart_manifest_required")))
    .catch(error => {
      // Permanent stale definition/schema failures must not form a supervisor
      // respawn loop. Runtime crashes still use nonzero exit and are restarted.
      console.error("[agentlasd] autostart refused", error instanceof Error ? error.message : "unknown");
      if (file) {
        try { fs.writeFileSync(`${file}.failure.json`, JSON.stringify({ schema: "agentlas.daemon-autostart-failure.v1", at: new Date().toISOString(),
          code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "daemon_autostart_boot_failed" }), { mode: 0o600 }); }
        catch { /* A diagnostic cannot grant permission to start. */ }
      }
      if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
      else process.exit(0);
    });
}
