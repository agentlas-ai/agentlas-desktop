/*
 * Antigravity (agy) write runs: the delete card for the shell (the agy cell of defect 7).
 *
 * A write run uses `--dangerously-skip-permissions --sandbox`, so agy never asks the host before `run_command`. agy runs the PreToolUse hooks
 * of its plugins first (measured with agy 1.x: `toolCall.name run_command` + `toolCall.args.CommandLine` on stdin; `{decision:"deny", reason}` on
 * stdout blocks the call). The product runs agy in a mirrored HOME (antigravity-personal-context.ts), so the gate is one plugin written into that
 * mirror for a write run - never into the person's own ~/.gemini. The hook is the shared script (shell-delete-gate-hook.ts); a delete is asked about only when the
 * runner set AGENTLAS_SHELL_GATE_REQUIRED=1, so the same mirror serves read and full runs untouched. A full run gets the plugin too, for the one refusal that holds in
 * every mode: a command that registers a job in an OS scheduler (os-scheduler-gate-hook.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { nodeHookCommand } from "../workflow/tool-broker-runtime";
import { shellDeleteGateScriptPath } from "./write-sandbox-launch-guard";

export function agyWriteBoundaryScriptPath(): string {
  return path.join(__dirname, "agy-write-boundary-hook.js");
}
/** agy's file-changing tools, as a hook matcher (agy-write-boundary.ts holds the same names). */
export const AGY_WRITE_BOUNDARY_MATCHER = "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|delete_file";

export const AGY_DELETE_GATE_PLUGIN = "agentlas-delete-gate";

/** Writes the plugin into this mirror HOME and enables it. False when it cannot be installed (no script, Windows: agy runs hook commands through cmd.exe, which is not verified here). */
export function installAgyDeleteGatePlugin(home: string): boolean {
  if (process.platform === "win32") return false;
  const script = shellDeleteGateScriptPath();
  if (!fs.existsSync(script)) return false;
  try {
    const dir = path.join(home, ".gemini", "config", "plugins", AGY_DELETE_GATE_PLUGIN);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: AGY_DELETE_GATE_PLUGIN, version: "1.0.0", description: "Asks the owner before a shell command deletes files." }), "utf8");
    // agy names each hook at the top level (a `hooks` wrapper loads as one hook called "hooks"); the timeout outlasts an owner's card.
    // The second hook (agy-write-boundary-hook.ts) keeps a write run's file tools inside its folders; it acts only when the runner set AGENTLAS_AGY_WRITE_ROOTS.
    const boundary = agyWriteBoundaryScriptPath();
    const hooks: Record<string, unknown> = { gate: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: nodeHookCommand(script), timeout: 340 }] }] } };
    if (fs.existsSync(boundary)) hooks.boundary = { PreToolUse: [{ matcher: AGY_WRITE_BOUNDARY_MATCHER, hooks: [{ type: "command", command: nodeHookCommand(boundary), timeout: 20 }] }] };
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(hooks), "utf8");
    const configPath = path.join(home, ".gemini", "config", "config.json");
    let config: Record<string, unknown> = {};
    try { const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>; } catch { /* a missing file starts empty */ }
    const plugins = config.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins) ? config.plugins as Record<string, unknown> : {};
    if ((plugins[AGY_DELETE_GATE_PLUGIN] as { enabled?: unknown } | undefined)?.enabled !== true) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ ...config, plugins: { ...plugins, [AGY_DELETE_GATE_PLUGIN]: { enabled: true } } }, null, 2), "utf8");
    }
    return true;
  } catch {
    return false;
  }
}
