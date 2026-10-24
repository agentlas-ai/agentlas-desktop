import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Keyless built-in MCP servers launch from a content-addressed source file, never from source carried in argv.
 *
 * The seven built-ins (one-team, agent-mail, workspace-preview, agentlas-turn, agentlas-ui, agentlas-time, cua-driver)
 * used to ship their whole audited source as compressed base64 in argv: `<execPath> -e BOOTSTRAP PAYLOAD`. argv is a
 * shared channel with an OS cap. Codex receives every server of a run as `-c mcp_servers.<key>.args=[...]` on ONE
 * command line (exec, the turn-scoped app-server of browser and Science/Alive grants, Workforce observation, any
 * executable without thread rebind), and Grok's legacy driver runs `grok mcp add -- <command> <args>`. Windows caps a
 * whole command line at 32,767 UTF-16 units (CreateProcess) and at 8,191 when the CLI is an npm `.cmd` shim run by
 * cmd.exe (codex.cmd, grok.cmd).
 * Measured 2026-10-17 with the real config builder: the seven payloads together were 58,937 argv chars, and an ordinary
 * One room on Codex (one-team, agentlas-turn, agentlas-ui) put 36,927 chars of `-c` flags on one command line
 * (Windows: 37,210 of 32,767 for codex.exe, 37,553 of 8,191 through cmd.exe for codex.cmd). After this change: 2,419.
 *
 * Each server guarded this with its own budget (4k to 24k) folded into the authenticity predicate. A per-server budget
 * cannot protect a per-command-line limit, and exceeding it was silent: the launch stopped being authentic and
 * mcp-config.ts dropped the server from every lane with no log line. One Team stood at 11,831 of 12,000; the next tool
 * would have removed One's team tools from every room, on every runtime (measured with one extra tool: 12,095, gone
 * from the Codex, Claude Code and Kimi configs alike).
 *
 * Now argv carries a fixed loader and a path: `<execPath> -e LOADER <dir>/<sha256>.cjs`, about 400 chars whatever the
 * source grows to, so there is no budget and no cliff. The guarantee the argv form gave (PLUGIN-SPEC INV-1: no path
 * that can be swapped between validation and execution) is kept where it actually came from, the child: the file's
 * name is the sha256 of the audited source, and LOADER reads the file once into memory, hashes those bytes and runs
 * exactly those bytes only when the hash is the name, or exits 78. A file replaced after Main validated the launch is
 * refused by the child, never executed. Main's authenticity is recomputed on every call, never stored (INV-2): this
 * executable, this server's loader, the canonical path named by this source's digest, and a regular file there holding
 * exactly the source, rewritten from the signed bundle when it is missing or altered.
 *
 * The directory is `~/.agentlas/mcp-builtins` (os.homedir(), the same rule as the materialized browser launcher): Desktop
 * Main and the daemon derive the same path, so a row one wrote is authentic for the other (the Terminal engine reads the
 * same rows), and no Electron import is needed (the daemon loads these modules). Files are content-addressed and read-only; a file no
 * build has used for 30 days is pruned.
 */

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
