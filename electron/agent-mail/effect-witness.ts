import { createHash } from "node:crypto";
import { agentMailBareAddress, type AgentMailMessage } from "../../shared/agent-mail";
import type { AgentMailExecutionScope } from "./client";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const addresses = (value: readonly string[] | undefined): string[] => [...new Set((value ?? [])
  .map((address) => agentMailBareAddress(address).toLowerCase()).filter(Boolean))].sort();

export interface AgentMailEffectInput {
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
  inReplyTo?: string;
}

/** The exact normalized call payload, including Bcc; no raw message content enters the witness ledger. */
export function agentMailEffectInputDigest(input: AgentMailEffectInput): string {
  return hash([addresses(input.to), addresses(input.cc), addresses(input.bcc), input.subject, input.text,
    input.replyToMessageId ?? null, input.inReplyTo ?? null]);
}

/** Server-returned message bytes can include the saved signature; compare them again with a fresh first-party GET. */
export function agentMailEffectMessageDigest(message: Pick<AgentMailMessage, "from" | "to" | "cc" | "subject" | "text">): string {
  return hash([agentMailBareAddress(message.from), addresses(message.to), addresses(message.cc), message.subject, message.text]);
}

export function agentMailEffectAccountDigest(binding: { workspaceId: string; userId: string; sessionId: string }): string {
  return hash([binding.workspaceId, binding.userId, binding.sessionId]);
}

export function agentMailEffectScopeDigest(scope: AgentMailExecutionScope): string {
  return hash(scope.kind === "organization" ? [scope.kind, scope.key] : [scope.kind]);
}
