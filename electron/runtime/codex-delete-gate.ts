/*
 * The `codex exec` fallback of a write run: the delete card for the shell.
 *
 * The app-server path asks the host about every command (approvalPolicy `untrusted`, codex.ts), but `codex exec` has no approval loop, so a write
 * run on that path (an older CLI, a custom CODEX_HOME, the app-server unavailable) ran `rm` unasked. codex runs PreToolUse hooks with the same wire
 * as Claude Code (measured with codex 0.169: stdin `tool_name Bash` + `tool_input.command`; stdout `hookSpecificOutput.permissionDecision deny`
 * blocks the call). The hook is given inline (`-c hooks.PreToolUse=[...]`, nothing is written into any CODEX_HOME) together with
 * `--dangerously-bypass-hook-trust`, which trusts only what this process is started with - the same shared script as every executor.
 */
import fs from "node:fs";
import { osSchedulerGateScriptPath, shellDeleteGateScriptPath } from "./write-sandbox-launch-guard";
import { SHELL_GATE_CONTROL_ENV, SHELL_GATE_HANDLE_ENV } from "./shell-delete-gate";

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const hookArgs = (parts: string[], timeout: number): string[] => {
  const command = ["env", "ELECTRON_RUN_AS_NODE=1", ...parts].map((part) => (part.startsWith("'") || /^[A-Za-z0-9_.=\/:-]+$/.test(part) ? part : quote(part))).join(" ");
  return ["-c", `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`, "--dangerously-bypass-hook-trust"];
};

/** The exec arguments that gate a write run's shell deletes (and refuse an OS scheduler job: the same script); empty where it cannot be built (Windows: the hook command would need the PowerShell form, not verified). */
export function codexExecDeleteGateArgs(input: { control: string; handle: string }): string[] {
  if (process.platform === "win32") return [];
  return hookArgs([`${SHELL_GATE_CONTROL_ENV}=${input.control}`, `${SHELL_GATE_HANDLE_ENV}=${input.handle}`, quote(process.execPath), quote(shellDeleteGateScriptPath())], 340);
}

/**
 * The exec arguments of a full-access run (which has no delete gate:): the OS scheduler gate alone. `codex exec` has no approval loop, so this hook is the only place the
 * host can refuse a `launchctl load` / `crontab` / `schtasks /create` there. Empty where it cannot be built (Windows: the hook form is not verified; the script is missing).
 */
export function codexExecSchedulerGateArgs(): string[] {
  if (process.platform === "win32") return [];
  const script = osSchedulerGateScriptPath();
  if (!fs.existsSync(script)) return [];
  return hookArgs([quote(process.execPath), quote(script)], 10);
}
