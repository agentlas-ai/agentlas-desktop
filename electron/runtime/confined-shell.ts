/**














 */
import fs from "node:fs";
import os from "node:os";
import { ensureSandboxNpmCacheDir, sandboxNpmCacheExport } from "./sandbox-tool-cache";

export type ConfinedShell = (command: string) => { file: string; args: string[] };

export async function writeConfinedShell(cwd: string): Promise<ConfinedShell | null> {
  if (!cwd) return null;
  // Plus the product's sandbox npm cache, and npm pointed at it, so `npm install` works (sandbox-tool-cache.ts).
  const npmCache = ensureSandboxNpmCacheDir();
  const writable = [cwd, os.tmpdir(), "/dev/null", ...(npmCache ? [npmCache] : [])];
  const withNpmCache = (command: string): string => (npmCache ? `${sandboxNpmCacheExport(npmCache)}; ${command}` : command);
  if (process.platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!fs.existsSync(sandboxExec)) return null;
    const { buildSeatbeltProfile } = await import("../workflow/code-runner");
    const profile = buildSeatbeltProfile({ writable });
    return (command) => ({ file: sandboxExec, args: ["-p", profile, "/bin/bash", "-lc", withNpmCache(command)] });
  }
  if (process.platform === "linux") {
    const { buildBwrapArgs, linuxSandbox } = await import("../workflow/linux-sandbox");
    const bwrap = linuxSandbox();
    if (!bwrap) return null;
    return (command) => ({ file: bwrap.path, args: buildBwrapArgs({ writable }, "/bin/bash", ["-lc", withNpmCache(command)]) });
  }
  return null;
}
