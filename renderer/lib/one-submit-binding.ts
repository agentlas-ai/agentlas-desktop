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
    super(`One team preflight refused the current binding (${code})`);
    this.name = "OneSubmitPreflightError";
  }
}

/** Refusals that may clear on a fresh read (roster/runtime/proposal drift or a
 * transient judge outage). Retried exactly once, automatically. */
const RETRY_ONCE_CODES = new Set(["runtime_changed", "candidate_changed", "expired", "judgment_unavailable"]);

/** Specific, actionable wording for a refusal that survived every automatic path.
 * The machine code is always carried so the cause is visible, never guessed. */
export function oneSubmitPreflightNotice(code: string, ko: boolean): string {
  const tail = ko ? ` 글과 첨부는 작성창에 그대로 있습니다. (사유 코드: ${code})` : ` Your text and attachments are still in the composer. (reason code: ${code})`;
  switch (code) {
    case "runtime_changed":
      return (ko
        ? "이 대화에 고정된 실행 모델을 지금 찾을 수 없어 시작하지 못했습니다. 모델 선택에서 연결된 모델을 고른 뒤 보내 주세요."
        : "The model pinned to this chat is not available right now, so nothing started. Pick a connected model in the model menu, then send.") + tail;
    case "candidate_changed":
      return (ko
        ? "방의 팀원 구성이 바뀌어 시작하지 못했습니다. 팀원 목록을 확인한 뒤 보내 주세요."
        : "This room's members changed, so nothing started. Check the member list, then send.") + tail;
    case "judgment_unavailable":
      return (ko
        ? "편성 판단 모델이 응답하지 않아 시작하지 못했습니다. 모델 연결을 확인한 뒤 보내 주세요."
        : "The staffing model did not answer, so nothing started. Check the model connection, then send.") + tail;
    case "invalid_request":
      return (ko
        ? "요청 형식이 데스크탑과 맞지 않아 시작하지 못했습니다. 앱을 최신 판으로 업데이트해 주세요."
        : "The request shape did not match this Desktop build, so nothing started. Update the app to the latest version.") + tail;
    default:
      return (ko
        ? "팀 준비 단계에서 거절돼 시작하지 못했습니다. 작업 상태를 확인한 뒤 보내 주세요."
        : "Team preparation refused this message, so nothing started. Check the task state, then send.") + tail;
  }
}

/** Electron IPC keeps undefined-valued keys. Main treats unknown keys as an
 * invalid request, so send only the keys that carry a value. */
function compactRuntimeSelection(selection: RuntimeSelection | undefined): RuntimeSelection | undefined {
  if (!selection) return selection;
  return Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined)) as unknown as RuntimeSelection;
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
  const compactRequest = request.runtimeSelection
    ? { ...request, runtimeSelection: compactRuntimeSelection(request.runtimeSelection) }
    : request;
  const prepare = (target: OneSubmitTaskBinding) => api.oneTeamPreflight.prepare({
    ...compactRequest,
    chatId: target.chatId,
    expectedTaskId: target.taskId,
    expectedTaskVersion: target.taskVersion,
  });
  const first = await prepare(admittedBinding);
  if (first.kind !== "preflight_error") return { binding: admittedBinding, prepared: first };
  if (RETRY_ONCE_CODES.has(first.code)) {
    // One automatic rebind: re-read the canonical Task (it may have advanced
    // while the Goal sweep resumed) and ask Main once more with the same
    // immutable request. A second refusal is surfaced with its code.
    const fresh = await api.tasks.findForChat(admittedBinding.chatId).catch(() => null);
    const rebound: OneSubmitTaskBinding = fresh && fresh.originChatId === admittedBinding.chatId
      ? { ...admittedBinding, taskId: fresh.id, taskVersion: fresh.version, taskIntent: "task" }
      : admittedBinding;
    const retried = await prepare(rebound);
    if (retried.kind !== "preflight_error") return { binding: rebound, prepared: retried };
    throw new OneSubmitPreflightError(retried.code);
  }
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
