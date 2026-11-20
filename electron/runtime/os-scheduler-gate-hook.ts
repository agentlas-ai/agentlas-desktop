/**
 * OS scheduler gate - the CLI starts this process right before its shell or file-edit tool runs (PreToolUse), in a write run and in a full-access run alike.
 * The judgment is approval-rule.ts askRegistersOsScheduler (the one function every executor uses). A call that registers a job in an OS scheduler (launchctl
 * load / bootstrap, crontab, at, a systemd timer, schtasks, a file put in LaunchAgents / cron / systemd folders) is refused with the product's one approval-refusal
 * line, which tells the model to make the schedule as an app automation; every other call leaves with no output (the usual permission flow). The decision is
 * local: no wire to Main, so full access, an unattended run and a missing approval server cannot change it. Input it cannot read is refused (a gate that is broken
 * and left open is the hole). Claude Code, codex and grok send `tool_name` + `tool_input`; Antigravity sends `toolCall.name` + `toolCall.args`.
 */
import { approvalRefusalResultText, askRegistersOsScheduler } from "./approval-rule";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

let agy = false;
function deny(reason: string): void {
  process.stdout.write(JSON.stringify(agy
    ? { decision: "deny", reason }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

const chunks: Buffer[] = [];
process.stdin.on("data", (d: Buffer) => chunks.push(d));
process.stdin.on("end", () => {
  let input: { tool_name?: string; tool_input?: Record<string, unknown>; toolCall?: { name?: string; args?: { CommandLine?: unknown } } };
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof input;
  } catch {
    deny("os_scheduler_gate_unreadable: the gate could not read this tool call, so it did not run.");
    return;
  }
  agy = Boolean(input.toolCall);
  let ask: { command?: string; kind?: string; detail?: string } | null = null;
  if (agy) {
    if (input.toolCall?.name !== "run_command") return;
    ask = { command: typeof input.toolCall.args?.CommandLine === "string" ? input.toolCall.args.CommandLine : "" };
  } else if (input.tool_name === "Bash" || input.tool_name === "PowerShell") {
    ask = { command: typeof input.tool_input?.command === "string" ? input.tool_input.command : "" };
  } else if (input.tool_name && FILE_TOOLS.has(input.tool_name)) {
    const key = FILE_PATH_KEYS.find((name) => typeof input.tool_input?.[name] === "string");
    ask = { kind: "edit", detail: key ? String(input.tool_input?.[key]) : "" };
  }
  if (!ask) return;
  if (askRegistersOsScheduler(ask)) deny(approvalRefusalResultText({ action: "os_scheduler", cause: "app_owns_schedules" }));
});
