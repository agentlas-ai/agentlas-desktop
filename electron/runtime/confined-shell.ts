/**
 * The write-permission shell for runtimes without a vendor CLI: BYOK, Agentlas serving and local models.
 *
 * A CLI worker at "write" runs its commands inside its own workspace-write sandbox (codex: writableRoots = the working
 * folder). An API worker at "write" had no shell at all: shared/builtin-tools.ts `bash` was a full-permission tool, and a
 * firm delegate worker is granted "write" by design (firm-orchestrator.ts firmNodePermission: a full parent mints only a
 * write worker). Measured 2026-10-17 (A/B4 dev, firm on BYOK Haiku, chip full): the Backend worker wrote the app and then
 * reported that no connected tool could run a shell, and verification failed because it could not run npm test, start the
 * server or make an HTTP call. The same request on codex built and tested the app.
 *
 * This is the same boundary for API workers. Writes are allowed only inside the working folder and the temp folder (plus
 * /dev/null). Secret folders are unreadable. The network stays allowed, as for the graph code runner (code-runner.ts).
 * A command that would start a process outside the sandbox through an OS launcher is refused before it runs
 * (shared/write-sandbox-launch-guard.ts, the rule Claude Code write runs already use). Windows has no such boundary without
 * administrator rights, so there is none here, and `bash` stays a full-permission tool there.
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
