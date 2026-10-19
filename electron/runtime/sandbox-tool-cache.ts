import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @playwright









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
