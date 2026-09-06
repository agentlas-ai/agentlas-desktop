import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type CliExecutableIdentity = {
  executable: string;
  realPath: string;
  fingerprint: string;
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
  const environmentValue = (name: string): string | undefined => process.platform === "win32"
    ? input.env[Object.keys(input.env).find((key) => key.toUpperCase() === name) ?? name] : input.env[name];
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
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
      executable, realPath, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    ])).digest("hex");
    const previous = generations.get(resource);
    const generation = previous?.fingerprint === fingerprint ? previous.generation : crypto.randomUUID();
    saveGeneration(resource, fingerprint, generation);
    return { executable, realPath, fingerprint, generation };
  } catch {
    // A transient unreadable state cannot regain an old resident generation.
    if (resource) saveGeneration(resource, null, crypto.randomUUID());
    throw new Error("cli_executable_identity_unavailable");
  }
}
