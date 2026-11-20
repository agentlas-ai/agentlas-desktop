/**
 * Delete gate for a write run's shell - the CLI starts this process right before its Bash / PowerShell tool runs (PreToolUse). It also refuses a command that
 * registers a job in an OS scheduler, in every mode this script runs in (os-scheduler-gate-hook.ts).
 * The judgment is approval-rule.ts shellCommandDeletes (the one function every executor uses). A command that deletes nothing leaves
 * with no output (the usual permission flow). A delete asks Main over the approval server's loopback wire and prints the owner's answer;
 * EVERY failure - no gate in the environment, no control file, no connection, a bad reply, a timeout - refuses the delete: a delete never
 * passes because Main could not be reached. The refusal text is the product's one approval-refusal line.
 */
import fs from "node:fs";
import http from "node:http";
import { approvalRefusalResultText, askRegistersOsScheduler, shellCommandDeletes } from "./approval-rule";

const ASK_TIMEOUT_MS = 320_000;

/** Which CLI is asking: Claude Code and grok send `tool_name` / `tool_input.command`; Antigravity sends `toolCall.name` / `toolCall.args.CommandLine` and reads `{decision, reason}`. */
let agy = false;
function deny(reason: string): void {
  process.stdout.write(JSON.stringify(agy
    ? { decision: "deny", reason }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}
const unreachable = (): string => approvalRefusalResultText({ action: "delete", cause: "nobody_to_ask" });

function ask(control: { port: number; token: string }, handle: string, command: string): Promise<{ decision?: unknown; refusal?: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ handle, command });
    const req = http.request({
      host: "127.0.0.1", port: control.port, path: "/shell-approve", method: "POST", timeout: ASK_TIMEOUT_MS,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${control.token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("status"));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const chunks: Buffer[] = [];
process.stdin.on("data", (d: Buffer) => chunks.push(d));
process.stdin.on("end", () => {
  let input: { tool_name?: string; tool_input?: { command?: unknown }; toolCall?: { name?: string; args?: { CommandLine?: unknown } } };
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof input;
  } catch {
    deny(unreachable());
    return;
  }
  agy = Boolean(input.toolCall);
  let command = "";
  if (agy) {
    if (input.toolCall?.name !== "run_command") return;
    command = typeof input.toolCall.args?.CommandLine === "string" ? input.toolCall.args.CommandLine : "";
  } else {
    if (input.tool_name !== "Bash" && input.tool_name !== "PowerShell") return;
    command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  }
  // A job in an OS scheduler is refused in every mode (os-scheduler-gate-hook.ts); the delete card below is a write run's alone.
  if (command && askRegistersOsScheduler({ command })) { deny(approvalRefusalResultText({ action: "os_scheduler", cause: "app_owns_schedules" })); return; }
  // Antigravity's plugin hook lives in the product mirror for every mode; only a write run (the runner sets REQUIRED) asks about a delete here.
  if (agy && process.env.AGENTLAS_SHELL_GATE_REQUIRED !== "1") return;
  if (!command || !shellCommandDeletes(command)) return;
  const controlFile = process.env.AGENTLAS_SHELL_GATE_CONTROL;
  const handle = process.env.AGENTLAS_SHELL_GATE_HANDLE;
  if (!controlFile || !handle) { deny(unreachable()); return; }
  let control: { port: number; token: string };
  try {
    const parsed = JSON.parse(fs.readFileSync(controlFile, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string" || !parsed.port || !parsed.token) throw new Error("control");
    control = { port: parsed.port, token: parsed.token };
  } catch {
    deny(unreachable());
    return;
  }
  ask(control, handle, command).then((answer) => {
    if (answer.decision === "allow") return; // no output: the usual permission flow (the shell is pre-allowed in a write run)
    deny(typeof answer.refusal === "string" && answer.refusal ? answer.refusal : unreachable());
  }, () => deny(unreachable()));
});
