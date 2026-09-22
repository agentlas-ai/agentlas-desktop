import type { AgentlasIpc, RuntimeSelection } from "../../shared/types";
import type { PrepareOneTeamPreflightInput, PrepareOneTeamPreflightResult } from "../../shared/one-team-preflight";

export interface OneSubmitTaskBinding {
  chatId: string;
  taskId: string | null;
  taskVersion: number | null;
  taskIntent: "task" | "conversation";
}

/**
 * A Taskforce may stay on its stable conversation URL even after Main has
 * materialized a canonical Task for that chat. Resolve that independent
 * execution binding immediately before team admission so the renderer never
 * weakens Main's stale-binding guard just to preserve the conversation route.
 */
export async function resolveOneSubmitTaskBinding(
  api: Pick<AgentlasIpc, "tasks">,
  binding: OneSubmitTaskBinding,
): Promise<OneSubmitTaskBinding> {
  if (binding.taskId !== null) return binding;
  const task = await api.tasks.findForChat(binding.chatId);
  if (!task) return binding;
  return {
    ...binding,
    taskId: task.id,
    taskVersion: task.version,
    taskIntent: "task",
  };
}

export class OneSubmitPreflightError extends Error {
  constructor(readonly code: string) {
    super("One team preflight refused the current binding");
    this.name = "OneSubmitPreflightError";
  }
}

function sameRuntimeSelection(left: RuntimeSelection | null | undefined, right: RuntimeSelection | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.kind === right.kind
    && (left.backend ?? null) === (right.backend ?? null)
    && (left.source ?? null) === (right.source ?? null)
    && (left.acpAgentId ?? null) === (right.acpAgentId ?? null)
    && (left.model ?? null) === (right.model ?? null)
    && (left.effort ?? null) === (right.effort ?? null)
    && Boolean(left.longContext) === Boolean(right.longContext)
    && (left.role ?? "orchestrator") === (right.role ?? "orchestrator")
    && Boolean(left.inherit) === Boolean(right.inherit);
}

async function promptDigest(prompt: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new OneSubmitPreflightError("stale_binding");
  const bytes = new TextEncoder().encode(prompt);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Retry only a typed Main refusal before a proposal or invocation is accepted.
 * The request (including its original model snapshot) is immutable. An absent
 * Task may appear, or the same Task may advance one version; another Task,
 * changed runtime, accepted proposal, or a second drift must fail closed. */
export async function prepareOneTeamPreflightForSubmit(
  api: Pick<AgentlasIpc, "tasks" | "chats" | "oneTeamPreflight">,
  binding: OneSubmitTaskBinding,
  request: Omit<PrepareOneTeamPreflightInput, "chatId" | "expectedTaskId" | "expectedTaskVersion">,
): Promise<{ binding: OneSubmitTaskBinding; prepared: PrepareOneTeamPreflightResult }> {
  // Keep this boundary self-contained for callers other than OneShell. A
  // conversation can be promoted while the model is deciding whether a team
  // is needed; if that promotion is already durable, send the canonical Task
  // identity to Main instead of deliberately submitting a null binding.
  const admittedBinding = await resolveOneSubmitTaskBinding(api, binding);
  const [initialChat, initialProposal] = await Promise.all([
    api.chats.get(admittedBinding.chatId),
    api.oneTeamPreflight.getForChat(admittedBinding.chatId),
  ]);
  if (!initialChat || initialChat.id !== admittedBinding.chatId) throw new OneSubmitPreflightError("stale_binding");
  const prepare = (target: OneSubmitTaskBinding) => api.oneTeamPreflight.prepare({
    ...request,
    chatId: target.chatId,
    expectedTaskId: target.taskId,
    expectedTaskVersion: target.taskVersion,
  });
  const first = await prepare(admittedBinding);
  if (first.kind !== "preflight_error") return { binding: admittedBinding, prepared: first };
  if (first.code !== "stale_binding") throw new OneSubmitPreflightError(first.code);
  const [task, proposal, chat] = await Promise.all([
    api.tasks.findForChat(admittedBinding.chatId),
    api.oneTeamPreflight.getForChat(admittedBinding.chatId),
    api.chats.get(admittedBinding.chatId),
  ]);
  if (!task || task.originChatId !== admittedBinding.chatId
    || !task.id || !Number.isSafeInteger(task.version) || task.version < 1
    || (admittedBinding.taskId !== null && (task.id !== admittedBinding.taskId
      || admittedBinding.taskVersion === null || !Number.isSafeInteger(admittedBinding.taskVersion)
      || task.version <= admittedBinding.taskVersion))
    || (admittedBinding.taskId === null && admittedBinding.taskVersion !== null)
    || !chat || chat.id !== admittedBinding.chatId
    || !sameRuntimeSelection(initialChat.runtimeSelection, chat.runtimeSelection)
    || (request.runtimeSelection && !sameRuntimeSelection(request.runtimeSelection, chat.runtimeSelection))) {
    throw new OneSubmitPreflightError(first.code);
  }
  const digest = await promptDigest(request.userPrompt);
  const isNonTerminalExactProposal = (candidate: typeof proposal): boolean => Boolean(
    candidate
      && candidate.status !== "expired"
      && candidate.status !== "cancelled"
      && candidate.binding.promptDigest === digest,
  );
  // A proposal for this exact prompt is already the admission record. Do not
  // create a second one, even if a concurrent resolver changed its status.
  // Proposals for another turn are independent and may legitimately rotate
  // while this one is rebinding after the Task promotion race. Comparing the
  // whole latest-proposal snapshot made an unrelated expiry/resolution turn a
  // recoverable conversation->Task race into the generic stale error.
  const proposalChanged = proposal?.proposalId !== initialProposal?.proposalId
    || proposal?.version !== initialProposal?.version
    || proposal?.status !== initialProposal?.status;
  if (isNonTerminalExactProposal(proposal)
    || (proposalChanged && isNonTerminalExactProposal(initialProposal))) {
    throw new OneSubmitPreflightError(first.code);
  }
  const rebound: OneSubmitTaskBinding = {
    ...admittedBinding,
    taskId: task.id,
    taskVersion: task.version,
    taskIntent: "task",
  };
  const second = await prepare(rebound);
  if (second.kind === "preflight_error") throw new OneSubmitPreflightError(second.code);
  return { binding: rebound, prepared: second };
}
