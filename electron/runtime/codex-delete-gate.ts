/*
 * The `codex exec` fallback of a write run: the delete card for the shell.
 *
 * The app-server path asks the host about every command (approvalPolicy `untrusted`, codex.ts), but `codex exec` has no approval loop, so a write
 * run on that path (an older CLI, a custom CODEX_HOME, the app-server unavailable) ran `rm` unasked. codex runs PreToolUse hooks with the same wire
 * as Claude Code (measured with codex 0.169: stdin `tool_name Bash` + `tool_input.command`; stdout `hookSpecificOutput.permissionDecision deny`
 * blocks the call). The hook is given inline (`-c hooks.PreToolUse=[...]`, nothing is written into any CODEX_HOME) together with
 * `--dangerously-bypass-hook-trust`, which trusts only what this process is started with - the same shared script as every executor.
 */
import { shellDeleteGateScriptPath } from "./write-sandbox-launch-guard";
import { SHELL_GATE_CONTROL_ENV, SHELL_GATE_HANDLE_ENV } from "./shell-delete-gate";

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The exec arguments that gate a write run's shell deletes; empty where it cannot be built (Windows: the hook command would need the PowerShell form, not verified). */
export function codexExecDeleteGateArgs(input: { control: string; handle: string }): string[] {
  if (process.platform === "win32") return [];
  const command = ["env", "ELECTRON_RUN_AS_NODE=1", `${SHELL_GATE_CONTROL_ENV}=${input.control}`, `${SHELL_GATE_HANDLE_ENV}=${input.handle}`, quote(process.execPath), quote(shellDeleteGateScriptPath())]
    .map((part) => (part.startsWith("'") || /^[A-Za-z0-9_.=\/:-]+$/.test(part) ? part : quote(part))).join(" ");
  return ["-c", `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=340}]}]`, "--dangerously-bypass-hook-trust"];
}
