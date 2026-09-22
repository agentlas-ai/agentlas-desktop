import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { OFFICIAL_INSTALL_IDENTITY, serializeInstallIdentity, type InstallIdentity } from "../install-identity";
import { defaultControlSocketPath } from "./control-socket";

export interface DaemonServiceOptions {
  userDataDir: string;
  /** The GUI's actual store path; also usable before the store is opened. */
  storePath?: string | null;
  installIdentity?: InstallIdentity;
}

export interface DaemonServiceIdentity {
  userDataDir: string;
  storePath: string;
  installIdentity: InstallIdentity;
  serviceIdentity: string;
}

/** Resolve existing ancestors too, so first boot and later reattachment use
 * the same identity even when userData is reached through a symlink. */
export function canonicalDaemonPath(value: string): string {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalDaemonPath(parent), path.basename(absolute));
  }
}

export function resolveDaemonServiceIdentity(options: DaemonServiceOptions): DaemonServiceIdentity {
  const userDataDir = canonicalDaemonPath(options.userDataDir);
  const storePath = canonicalDaemonPath(options.storePath?.trim()
    || process.env.AGENTLAS_STORE_PATH?.trim() || path.join(userDataDir, "agentlas.sqlite"));
  const installIdentity = options.installIdentity ?? OFFICIAL_INSTALL_IDENTITY;
  let storeFile: { dev: number; ino: number } | null = null;
  try { const stat = fs.statSync(storePath); storeFile = { dev: stat.dev, ino: stat.ino }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const serviceIdentity = createHash("sha256").update(JSON.stringify({
    schema: "agentlas.daemon-service-identity.v1",
    userDataDir,
    storePath,
    storeFile,
    install: serializeInstallIdentity(installIdentity.userDataOverride
      ? { ...installIdentity, userDataOverride: canonicalDaemonPath(installIdentity.userDataOverride) }
      : installIdentity),
  })).digest("hex");
  return { userDataDir, storePath, installIdentity, serviceIdentity };
}

export function daemonControlSocketPath(userDataDir: string): string {
  return defaultControlSocketPath(canonicalDaemonPath(userDataDir));
}

/** Local synchronous fence for a service which won exclusive publication.
 * Windows named-pipe exclusivity is held by the listening server handle. */
export function captureDaemonSocketFence(address: string): () => void {
  if (process.platform === "win32") return () => {};
  const original = fs.lstatSync(address);
  if (!original.isSocket()) throw new Error("daemon_service_ownership_lost");
  return () => {
    try {
      const current = fs.lstatSync(address);
      if (current.isSocket() && current.dev === original.dev && current.ino === original.ino) return;
    } catch { /* Missing or unreadable publication no longer proves ownership. */ }
    throw new Error("daemon_service_ownership_lost");
  };
}
