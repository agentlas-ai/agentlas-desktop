/*
 * The same two doors harness app.call passes (harness/tool-isolation.ts, harness/app-call-approval.ts), for the personal agent's one_app_call
 * (D1 and D2). It throws a coded error, like every other refusal of that tool: `not_allowed_for_actor`, `owner_turn_required`
 * (the description of one_app_call says a destructive or consent action needs a turn the owner wrote; now the host enforces it) or
 * `approval_refused` (the card for a delete or a send was answered no, or nobody could answer it).
 */
import { ISOLATION_REFUSAL_NEXT } from "./tool-isolation";

function coded(code: string, sentence: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${sentence}`), { code });
}

export async function guardOneAppCall(binding: { chatId?: string | null; supervisorReplyRunId?: string; turnRunId?: string; permission?: "read" | "write" | "full"; unattended?: boolean },
  operation: unknown, args: unknown): Promise<void> {
  if (typeof operation !== "string" || !operation.trim() || !binding.chatId) return;
  const path = operation.trim();
  const runId = binding.supervisorReplyRunId ?? binding.turnRunId ?? "";
  const isolation = await import("./tool-isolation");
  const named = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const denied = await isolation.gateAppOperation({ chatId: binding.chatId, runId }, path, named);
  if (denied) throw coded(denied.reason!, ISOLATION_REFUSAL_NEXT[denied.reason!]);
  // The owner may take longer than the tool's own wire allows (a request that ends first leaves the model an unclassified timeout and no word on the card): the wait
  // answers inside the call window. Still waiting = the card's "no answer yet" sentence (the same call asked again joins this card and passes once it is allowed).
  const pending = await import("../app-control/pending-calls");
  const waiting = Symbol("approval-pending");
  const chatId = binding.chatId;
  const approval = await pending.answerAppCallWithin<Awaited<ReturnType<typeof import("./app-call-approval").approveAppOperation>> | typeof waiting>(
    pending.appCallKey({ via: "one-approval", chatId, operation: path, args: named, permission: binding.permission ?? "read" }),
    async () => (await import("./app-call-approval")).approveAppOperation({ operation: path, chatId, permission: binding.permission ?? "read", unattended: binding.unattended === true }),
    pending.APP_CALL_ANSWER_WINDOW_MS, () => waiting);
  if (approval === waiting) {
    const { approvalRefusalResultText, classifyHostOperation } = await import("../runtime/approval-rule");
    const action = classifyHostOperation(path);
    throw coded("approval_refused", action === "other" ? "nobody answered the approval card yet" : approvalRefusalResultText({ action, cause: "no_answer" }));
  }
  if (!approval.ok) throw coded(approval.reason, approval.text);
}
