import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withCliPath } from "./exec";

export type CliExecutableIdentity = {
  executable: string;
  realPath: string;
  /** Persisted inside runtime-session fingerprints, so it must survive a reboot: no device number (see below). */
  fingerprint: string;
  /** The pre-2026-10-16 formula, which also hashed st_dev. Read-only compatibility: a session saved by an older build
   * with no reboot since still resumes once and is then re-saved under `fingerprint`. Never written. */
  legacyFingerprint: string;
  generation: string;
};

const generations = new Map<string, { fingerprint: string | null; generation: string }>();
const observedScopes = new Map<string, string>();
function saveGeneration(resource: string, fingerprint: string | null, generation: string): void {
  generations.delete(resource);
  generations.set(resource, { fingerprint, generation });
  if (generations.size > 128) generations.delete(generations.keys().next().value!);
}

/** Filesystem observation only; never executes the CLI or reads credentials.
 * Uses the same realpath/stat axes as Codex localLaunchState. This detects
 * ordinary CLI replacement, not executable integrity or semantic version.
 */
export function observeCliExecutableIdentity(input: {
  bin: string; cwd: string; env: NodeJS.ProcessEnv;
}): CliExecutableIdentity | null {
  // Resolve against the exact PATH the launch will use. A packaged GUI app
  // inherits a minimal PATH, so resolving a bare command against the raw caller
  // environment reports "missing" for a CLI that spawnCli would have launched.
  const env = withCliPath(input.env);
  const environmentValue = (name: string): string | undefined => process.platform === "win32"
    ? env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name] : env[name];
  const searchPath = environmentValue("PATH");
  const pathExtensions = environmentValue("PATHEXT");
  const scope = JSON.stringify([path.resolve(input.cwd), input.bin, searchPath, pathExtensions]);
  let resource = observedScopes.get(scope);
  try {
    const explicit = path.isAbsolute(input.bin) || input.bin.includes(path.sep);
    const bases = explicit ? [path.resolve(input.cwd, input.bin)]
      : (searchPath ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(input.cwd, dir, input.bin));
    const extensions = process.platform === "win32" && !path.extname(input.bin)
      ? ["", ...(pathExtensions ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
    let executable: string | undefined;
    for (const base of bases) {
      for (const extension of extensions) {
        const candidate = base + extension;
        try {
          fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) { executable = candidate; break; }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR"
            && (explicit || (code !== "EACCES" && code !== "EPERM"))) throw error;
        }
      }
      if (executable) break;
    }
    if (!executable) {
      if (resource) saveGeneration(resource, null, crypto.randomUUID());
      return null;
    }
    if (resource && resource !== executable) saveGeneration(resource, null, crypto.randomUUID());
    resource = executable;
    observedScopes.delete(scope);
    observedScopes.set(scope, resource);
    if (observedScopes.size > 128) observedScopes.delete(observedScopes.keys().next().value!);
    const realPath = fs.realpathSync(executable);
    const stat = fs.statSync(realPath, { bigint: true });
    // st_dev is left out: macOS gives the volume a new device number at every boot (owner Mac 16777229 -> 16777231
    // -> 16777233 across three boots), Linux renumbers NFS/FUSE/btrfs and hot-plugged disks per mount. This
    // fingerprint is stored in each runtime session, and with st_dev in it every saved Claude Code, ACP (Copilot,
    // Cursor, Grok, Kimi) and Antigravity session was refused after a reboot. A real replacement still changes the
    // inode, size, mtime or ctime (user space cannot set ctime).
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
      executable, realPath, ...[stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    ])).digest("hex");
    const legacyFingerprint = crypto.createHash("sha256").update(JSON.stringify([
      executable, realPath, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    ])).digest("hex");
    const previous = generations.get(resource);
    const generation = previous?.fingerprint === fingerprint ? previous.generation : crypto.randomUUID();
    saveGeneration(resource, fingerprint, generation);
    return { executable, realPath, fingerprint, legacyFingerprint, generation };
  } catch {
    // A transient unreadable state cannot regain an old resident generation.
    if (resource) saveGeneration(resource, null, crypto.randomUUID());
    throw new Error("cli_executable_identity_unavailable");
  }
}
