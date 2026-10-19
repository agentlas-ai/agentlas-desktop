import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";




































/** Gate assertion only, never part of authenticity: the launch is a fixed loader and a path, independent of the source size. */
export const BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS = 4_096;
const PRUNE_UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_MTIME_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_AFTER_MS = 60 * 60 * 1000;
const SOURCE_FILE_RE = /^([0-9a-f]{64})\.cjs$/;
const TEMP_FILE_RE = /^\.[0-9a-f]{64}\.\d+\.[0-9a-f]{12}\.tmp$/;

const liveDigests = new Set<string>();
const prunedDirs = new Set<string>();
const warned = new Set<string>();

export interface BuiltinMcpLaunch {
  readonly sourceSha256: string;
  /** `["-e", LOADER, <canonical source file>]`. Writes the file when it is missing or altered; never throws. */
  launchArgs(): string[];
  /** Exact loader, canonical path, and a verified file there (restored if needed). Recomputed on every call. */
  isAuthenticArgs(args: readonly string[]): boolean;
  /** Where this source lives for the current home. */
  sourcePath(): string;
}

export function builtinMcpSourceDir(): string {
  return path.join(os.homedir(), ".agentlas", "mcp-builtins");
}

function loaderFor(filename: string): string {
  // `node -e LOADER <dir>/<sha256>.cjs`: process.argv[1] is the file, and its name is the pin. Read it once, hash those
  // bytes, run exactly those bytes only when the hash is the name. Single quotes only: on Windows this text is escaped
  // twice (a TOML string inside a codex `-c` flag, then cmd.exe for an npm .cmd shim), and each `"` becomes five chars.
  return `const f=require('fs'),p=process.argv[1],b=(()=>{try{return f.readFileSync(p)}catch{process.exit(78)}})();` +
    `require('crypto').createHash('sha256').update(b).digest('hex')===require('path').basename(p,'.cjs')` +
    `?require('vm').runInThisContext(b+'',{filename:${JSON.stringify(filename).replace(/"/g, "'")}}):process.exit(78)`;
}

function removeFile(file: string): void {
  // Windows refuses to unlink a read-only file; clear the bit first.
  try { fs.chmodSync(file, 0o600); } catch { /* absent */ }
  try { fs.unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function pruneOnce(dir: string): void {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  const now = Date.now();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const source = SOURCE_FILE_RE.exec(name);
    const temp = TEMP_FILE_RE.test(name);
    if ((!source && !temp) || (source && liveDigests.has(source[1]!))) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > (temp ? STALE_TEMP_AFTER_MS : PRUNE_UNUSED_AFTER_MS)) removeFile(file);
    } catch { /* another build is using or removing it */ }
  }
}

export function defineBuiltinMcpLaunch(name: string, source: string): BuiltinMcpLaunch {
  const bytes = Buffer.from(source, "utf8");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const loader = loaderFor(`${name}.cjs`);
  liveDigests.add(sourceSha256);
  const sourcePath = () => path.join(builtinMcpSourceDir(), `${sourceSha256}.cjs`);
  const holds = (file: string): boolean => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size !== bytes.length) return false;
      return createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sourceSha256;
    } catch { return false; }
  };
  const ensure = (): boolean => {
    const file = sourcePath();
    if (holds(file)) {
      // Keep a file this build still uses out of another build's 30-day pruning.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > REFRESH_MTIME_AFTER_MS) fs.utimesSync(file, new Date(), new Date());
      } catch { /* the content check above is what matters */ }
      pruneOnce(path.dirname(file));
      return true;
    }
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = path.join(dir, `.${sourceSha256}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        fs.chmodSync(temp, 0o444);
        try { fs.renameSync(temp, file); } catch {
          // A concurrent writer may have just placed the same bytes; otherwise Windows will not replace a read-only
          // (or altered) file in place, so the wrong one is removed first.
          if (!holds(file)) { removeFile(file); fs.renameSync(temp, file); }
        }
      } finally {
        removeFile(temp);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
      if (!warned.has(`${name}:${code}`)) {
        warned.add(`${name}:${code}`);
        console.warn("[builtin-mcp] source_file_unavailable", JSON.stringify({ server: name, code }));
      }
    }
    const ok = holds(file);
    if (ok) pruneOnce(path.dirname(file));
    return ok;
  };
  return {
    sourceSha256,
    sourcePath,
    launchArgs: () => { ensure(); return ["-e", loader, sourcePath()]; },
    isAuthenticArgs: (args) => args.length === 3 && args[0] === "-e" && args[1] === loader && args[2] === sourcePath() && ensure(),
  };
}
