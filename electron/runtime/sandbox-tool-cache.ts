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
