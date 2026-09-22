import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserializeInstallIdentity, serializeInstallIdentity, type InstallIdentity } from "../install-identity";
import { canonicalDaemonPath, resolveDaemonServiceIdentity } from "./service-identity";

export const AUTOSTART_READY_KEY = "daemon_autostart_store_ready_v1";
export interface DaemonAutostartManifest {
  schema: "agentlas.daemon-autostart.v1";
  executable: string;
  entry: string;
  entrySha256: string;
  userDataDir: string;
  storePath: string;
  serviceIdentity: string;
  installIdentity: InstallIdentity;
  appVersion: string;
  requiredSchemaVersion: number;
  storeBootstrapToken: string;
  appMetadata: { version: string; isPackaged: boolean; appPath: string; resourcesPath: string | null };
}
function invalid(code: string): never { throw Object.assign(new Error(code), { code }); }
export function daemonAutostartLabel(input: Pick<DaemonAutostartManifest, "userDataDir" | "storePath" | "installIdentity">): string {
  // Stable across updates/store inode replacement, separate across QA/dev and
  // official installations. The manifest itself fences the exact store inode.
  const digest = createHash("sha256").update(JSON.stringify([canonicalDaemonPath(input.userDataDir),
    canonicalDaemonPath(input.storePath), serializeInstallIdentity(input.installIdentity)])).digest("hex").slice(0, 24);
  return `cloud.agentlas.daemon.${digest}`;
}
export function entryDigest(entry: string): string {
  const stat = fs.statSync(entry);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) invalid("daemon_autostart_entry_invalid");
  return createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
}

/** Reads no writable DB and never guesses a production identity/path. */
export function validateDaemonAutostartManifest(value: unknown): DaemonAutostartManifest {
  const m = value as DaemonAutostartManifest;
  if (!m || m.schema !== "agentlas.daemon-autostart.v1"
    || ![m.executable, m.entry, m.userDataDir, m.storePath, m.appMetadata?.appPath].every(p => typeof p === "string" && path.isAbsolute(p) && !/[\r\n\0]/.test(p))
    || !Number.isSafeInteger(m.requiredSchemaVersion) || m.requiredSchemaVersion < 1
    || typeof m.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(m.appVersion)
    || typeof m.storeBootstrapToken !== "string" || !/^[a-f0-9-]{36}$/i.test(m.storeBootstrapToken)
    || m.appMetadata.version !== m.appVersion || typeof m.appMetadata.isPackaged !== "boolean"
    || !(m.appMetadata.resourcesPath === null || (typeof m.appMetadata.resourcesPath === "string" && path.isAbsolute(m.appMetadata.resourcesPath)))) invalid("daemon_autostart_manifest_invalid");
  const install = deserializeInstallIdentity(JSON.stringify(m.installIdentity));
  if (install.channel === "qa" && canonicalDaemonPath(install.userDataOverride!) !== canonicalDaemonPath(m.userDataDir)) invalid("daemon_autostart_qa_identity_mismatch");
  if (!fs.statSync(m.storePath).isFile() || !fs.statSync(m.executable).isFile()) invalid("daemon_autostart_target_unavailable");
  const identity = resolveDaemonServiceIdentity(m);
  if (identity.serviceIdentity !== m.serviceIdentity) invalid("daemon_autostart_store_identity_mismatch");
  if (entryDigest(m.entry) !== m.entrySha256) invalid("daemon_autostart_entry_changed");
  const metadata = JSON.parse(fs.readFileSync(path.join(m.appMetadata.appPath, "package.json"), "utf8"));
  if (metadata.version !== m.appVersion) invalid("daemon_autostart_app_version_changed");
  // Official-shaped launchers may not borrow a QA/candidate bundle identity.
  if (m.appMetadata.isPackaged) {
    const marker = metadata.agentlasInstallIdentity;
    if (!marker || marker.schemaVersion !== 1 || marker.channel !== install.channel
      || marker.appName !== install.appName || marker.userDataNamespace !== install.userDataNamespace
      || marker.keychainService !== install.keychainService) invalid("daemon_autostart_package_identity_mismatch");
  }
  return m;
}

export function readDaemonAutostartManifest(file: string): DaemonAutostartManifest {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024
    || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) invalid("daemon_autostart_manifest_permissions_invalid");
  return validateDaemonAutostartManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}
