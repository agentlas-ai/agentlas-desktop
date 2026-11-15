/*
 * The delete card for a shell the CLI runs itself (defect 7 for claude-code write runs).
 *
 * claude-code runs Bash by its own permission mode; the host never receives an approval for it. The one place the host can stop a call is
 * the CLI's PreToolUse hook (a child process of the CLI), so the hook asks THIS module over the approval server's loopback wire
 * (mcp-tools/proxy-server.ts `/shell-approve`) and gets the owner's answer back.
 *
 * What the hook may and may not say (nothing a forged request could widen):
 *   - It sends only the command line and a handle. Main minted the handle for this run (openShellDeleteGate) and keeps who asks about
 *     what - chat, permission, working folder, agent, unattended - on its own side; a caller cannot name a chat or a permission.
 *   - The handle is derived from a per-process secret, so no other process can compute it; it is handed to the CLI in its environment.
 *   - The answer is the host arbiter's (approval-rule.ts classifies; the same card, "always allow" and money rules as every runner).
 *   - The gate is open only while a turn of that run is open: closed at the turn's end (also on error / Stop), a call outside a turn is refused.
 * The hook script treats every failure (no control file, no handle, no connection, a bad reply, a timeout) as a refusal of the delete.
 */
import { createHmac, randomBytes } from "node:crypto";
import { approvalRefusalResultText, shellCommandDeletes } from "./approval-rule";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  toolApprovalRefusalText,
  type RuntimeToolPermissionAsk,
} from "./tool-approval";

export const SHELL_GATE_CONTROL_ENV = "AGENTLAS_SHELL_GATE_CONTROL";
export const SHELL_GATE_HANDLE_ENV = "AGENTLAS_SHELL_GATE_HANDLE";

export interface ShellDeleteGate {
  runtime: string;
  sessionKey: string;
  chatId?: string;
  agentId?: string;
  cwd?: string;
  unattended?: boolean;
  signal?: AbortSignal;
}
interface Entry { gate: ShellDeleteGate; epoch: number }

const secret = randomBytes(32);
const MAX_GATES = 256;
const gates = new Map<string, Entry>();
let epochs = 0;

/** The handle of a run's gate: stable for the same run key (a resident CLI process keeps its environment across turns), unguessable without the secret. */
export function shellDeleteGateHandle(runKey: string): string {
  return createHmac("sha256", secret).update(runKey).digest("hex");
}

/** Opens the gate for one turn. `close()` ends it (idempotent; a later turn's opening is not closed by an earlier turn's close). */
export function openShellDeleteGate(runKey: string, gate: ShellDeleteGate): { handle: string; close: () => void } {
  const handle = shellDeleteGateHandle(runKey);
  const epoch = ++epochs;
  gates.delete(handle);
  gates.set(handle, { gate, epoch });
  while (gates.size > MAX_GATES) { const oldest = gates.keys().next(); if (oldest.done) break; gates.delete(oldest.value); }
  return {
    handle,
    close: () => { const entry = gates.get(handle); if (entry && entry.epoch === epoch) gates.delete(handle); },
  };
}

export type ShellDeleteDecision = { decision: "allow" } | { decision: "deny"; refusal: string };

const DENY_NO_GATE = approvalRefusalResultText({ action: "delete", cause: "nobody_to_ask" });

/**
 * One delete question from a hook. Anything that is not a delete by the shared rule is answered "allow" without a card (the hook only asks about
 * deletes; this is the second look). An unknown or closed handle, a missing arbiter that would refuse, or an arbiter that throws is a refusal.
 */
export async function decideShellDelete(handle: unknown, command: unknown, wireSignal?: AbortSignal): Promise<ShellDeleteDecision> {
  if (typeof handle !== "string" || typeof command !== "string" || !command) return { decision: "deny", refusal: DENY_NO_GATE };
  const entry = gates.get(handle);
  if (!entry) return { decision: "deny", refusal: DENY_NO_GATE };
  if (!shellCommandDeletes(command)) return { decision: "allow" };
  const { gate } = entry;
  const signals = [gate.signal, wireSignal].filter((value): value is AbortSignal => Boolean(value));
  const merged = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const ask: RuntimeToolPermissionAsk = {
    ...(merged ? { signal: merged } : {}),
    runtime: gate.runtime,
    sessionKey: gate.sessionKey,
    tool: "bash",
    kind: "execute",
    detail: command.slice(0, 500),
    command: command.slice(0, 20_000),
    ...(gate.cwd ? { cwd: gate.cwd } : {}),
    permission: "write",
    mutating: true,
    ...(gate.chatId ? { chatId: gate.chatId } : {}),
    ...(gate.agentId ? { agentId: gate.agentId } : {}),
    ...(gate.unattended ? { unattended: true as const } : {}),
  };
  const arbiter = getRuntimeToolPermissionArbiter();
  let verdict: string;
  try { verdict = arbiter ? await arbiter(ask) : defaultRuntimeToolPermission(ask); } catch { verdict = "deny"; }
  if (verdict !== "deny") return { decision: "allow" };
  return { decision: "deny", refusal: toolApprovalRefusalText(ask) || DENY_NO_GATE };
}
