import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The package cache a write-sandboxed shell may write: one product-owned folder for every runtime, never the person's
 * ~/.npm and never the cache install-cli.ts installs the vendor CLIs from (a worker that can write that cache could
 * plant code in the next CLI install).
 *
 * Measured 2026-10-17 (A/B W1, codex gpt-6.1-sol, room fc53939f): a codex write worker's
 * `npm install --save-dev @playwright/test` failed EPERM on ~/.npm/_cacache (npm then wrongly blames root-owned files),
 * because workspace-write grants only the working folder. Claude write runs (cwd + temp) and the API-lane confined shell
 * (cwd + temp) have the same wall. Each sandbox now also grants this folder, and each shell gets NPM_CONFIG_CACHE pointing
 * at it: codex through shell_environment_policy.set (shell commands only, never its MCP servers), Claude through
 * CLAUDE_ENV_FILE (sourced before each Bash command only; measured on 2.1.302), the confined shell in its command.
 */
export function sandboxNpmCacheDir(home: string = os.homedir()): string {
  return path.join(home, ".agentlas", "cache", "sandbox-npm");
}

/** Creates the folder (0700) and returns it; null when it cannot be created (the run keeps the old wall, never fails). */
export function ensureSandboxNpmCacheDir(home: string = os.homedir()): string | null {
  const dir = sandboxNpmCacheDir(home);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** One shell line that points npm at the folder (POSIX quoting). */
export function sandboxNpmCacheExport(dir: string): string {
  return `export NPM_CONFIG_CACHE='${dir.replace(/'/g, `'\\''`)}'`;
}

/**
 * The CLAUDE_ENV_FILE for a Claude write run: the person's own env file first (when they set one), then the npm line.
 * Written once per distinct content under the product's cache root; null when it cannot be written.
 */
export function claudeSandboxEnvFile(dir: string, personalEnvFile: string | undefined, home: string = os.homedir()): string | null {
  const lines = ["# Agentlas write sandbox: npm writes its cache inside the sandbox (sandbox-tool-cache.ts)."];
  if (personalEnvFile && path.isAbsolute(personalEnvFile) && personalEnvFile !== path.join(path.dirname(dir), "claude-sandbox-env.sh")) {
    lines.push(`[ -f '${personalEnvFile.replace(/'/g, `'\\''`)}' ] && . '${personalEnvFile.replace(/'/g, `'\\''`)}'`);
  }
  lines.push(sandboxNpmCacheExport(dir), "");
  const file = path.join(home, ".agentlas", "cache", "claude-sandbox-env.sh");
  const content = lines.join("\n");
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content, { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return file;
  } catch {
    return null;
  }
}

/*
 * The temp folder a write-sandboxed shell may write.
 *
 * A codex write run turns both default temp grants off (excludeTmpdirEnvVar, excludeSlashTmp: a project below TMPDIR must
 * not make its siblings and parents writable, scripts/verify-one-team-permission-boundary.mjs), so the shell's TMPDIR still
 * names the person's real per-user temp folder and every tool that needs a temp file is refused there. Measured offline
 * against the real codex seatbelt (r4-step-sandbox/measure-tmpdir.cjs): `mktemp`, Node's fs.mkdtemp(os.tmpdir()) and
 * `ffmpeg ... -y "$TMPDIR/frame.jpg"` fail with "Operation not permitted"; Blender prints "Could not generate a temp file
 * name" before it dies. Observed in use: 17 tool failures of this shape in the owner store.
 *
 * The fix grants one product-owned root (never /tmp, never the real TMPDIR, never a sibling of the project) and points the
 * shell's TMPDIR/TMP/TEMP at a folder inside it. The folder is scoped to the chat, not to a single run: the shell
 * environment rides the resident app-server's spawn arguments, which are part of the process identity (codex.ts
 * residentIdentity), and a per-run value would give every turn a new identity (production 10-13..16: 374 spawns, 4 reuses).
 * A literal "/tmp/x" path still fails by design; the room reads that refusal as the permission boundary
 * (sandbox-death.ts detectSandboxWriteDenial) and lifts the step to what the owner's chip covers.
 */
export function sandboxTmpRoot(home: string = os.homedir()): string {
  return path.join(home, ".agentlas", "cache", "sandbox-tmp");
}

/** The folder name for one chat: a hash (a chat id is never a path), or "shared" for a run that has no chat. */
export function sandboxTmpScope(chatId?: string | null): string {
  const id = typeof chatId === "string" ? chatId.trim() : "";
  return id ? `c-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 16)}` : "shared";
}

const SANDBOX_TMP_SCOPE_NAME = /^(?:c-[0-9a-f]{16}|shared)$/;
/** The OS cleans its own temp folder of files untouched for three days; this folder keeps to the same promise. */
export const SANDBOX_TMP_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SANDBOX_TMP_SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSandboxTmpSweepAt = 0;

/**
 * When a scope folder last saw activity: the newest mtime of the folder, its entries and their entries (a directory's mtime
 * moves when an entry is added or removed, which is what a tool working in a temp folder does). Links are not followed.
 * `complete` is false when the walk hit its budget: the answer is then only what was seen.
 */
function lastActivityMs(dir: string, budget = 5000): { newest: number; complete: boolean } {
  let newest = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st: fs.Stats;
    try { st = fs.lstatSync(current.path); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory() || current.depth >= 2) continue;
    let names: string[];
    try { names = fs.readdirSync(current.path); } catch { continue; }
    budget -= names.length;
    if (budget < 0) return { newest, complete: false };
    for (const name of names) stack.push({ path: path.join(current.path, name), depth: current.depth + 1 });
  }
  return { newest, complete: true };
}

/**
 * Removes the scope folders nobody has touched for the TTL. Only our own scope names directly under the root, only real
 * directories (never a link), never the folder in use. A folder too big to walk is judged by its own mtime and kept until
 * that is four TTLs old, so a busy one is never taken and an abandoned giant is not kept forever. Returns what it removed.
 */
export function reapStaleSandboxTmp(root: string, keepScope: string, now: number = Date.now(), ttlMs: number = SANDBOX_TMP_TTL_MS): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (name === keepScope || !SANDBOX_TMP_SCOPE_NAME.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const own = fs.lstatSync(dir);
      if (!own.isDirectory()) continue;
      const { newest, complete } = lastActivityMs(dir);
      const idleFor = now - newest;
      if (idleFor < ttlMs || (!complete && now - own.mtimeMs < 4 * ttlMs)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch { /* a folder we cannot judge or remove stays */ }
  }
  return removed;
}

/**
 * Creates the chat's temp folder (0700) and returns its real path; null when it cannot be created (the run keeps the old
 * wall, never fails). At most once an hour per process it also reaps folders of chats that went quiet.
 */
export function ensureSandboxRunTmpDir(scope: string, home: string = os.homedir(), now: number = Date.now()): string | null {
  if (!SANDBOX_TMP_SCOPE_NAME.test(scope)) return null;
  try {
    const root = sandboxTmpRoot(home);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const realRoot = fs.realpathSync(root);
    const dir = path.join(realRoot, scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) return null;
    // Touch it: a chat that is in use is never the one a sweep calls quiet.
    fs.utimesSync(dir, new Date(now), new Date(now));
    if (now - lastSandboxTmpSweepAt >= SANDBOX_TMP_SWEEP_EVERY_MS) {
      lastSandboxTmpSweepAt = now;
      reapStaleSandboxTmp(realRoot, scope, now);
    }
    return dir;
  } catch {
    return null;
  }
}

/** `-c` pairs that point a codex shell's temp variables at the folder (shell commands only, never its MCP servers). */
export function sandboxTmpEnvConfigArgs(dir: string): string[] {
  const value = JSON.stringify(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);
  return ["TMPDIR", "TMP", "TEMP"].flatMap((name) => ["-c", `shell_environment_policy.set.${name}=${value}`]);
}
