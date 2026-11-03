/*
 * Which work a One computer-use execution or context grant belongs to (the `assertTask` port of context-platform.ts).
 *
 * A Work, follow-up or chat-send request carries a canonical Task. A reply turn in One's own conversation has none: the supervisor
 * binds it as `one:<chatId>` (supervisor-os-execution.ts, one-vault-runtime.ts, OneSecurityFeatures.tsx). This check knew only
 * canonical Tasks, so every screen observation and action of a reply turn failed with a code-less error that the computer-use
 * server reported as `one-os-authority-unavailable` (observed in use: all 9 of Hope's calls from 12:47 to 13:35 UTC, while
 * the owner was asking Hope to reopen a browser it could not see). The failures are typed now, so the real reason reaches the run.
 */
import type { OneContextScope } from "../../shared/one-context";
import { OneContextError } from "./context-service";

/** The scope prefix the supervisor uses for a reply turn in One's own conversation. */
export const ONE_REPLY_SCOPE_PREFIX = "one:";

interface ScopeTask { id: string; originChatId?: string | null; archivedAt?: string | null; projectId?: string | null; firmId?: string | null }
interface ScopeChat { id: string; archivedAt?: string | null; projectId?: string | null; firmId?: string | null }

export interface OneContextTaskSources {
  activeOneId(): string;
  task(taskId: string): ScopeTask | null | undefined;
  chat(chatId: string): ScopeChat | null | undefined;
  /** The chat is One's own conversation (one_supervisor_conversations). */
  personalConversation(oneId: string, chatId: string): boolean;
  /** One delegated this Task and its worker runs in this chat (one_supervisor_requests.workerChatId). */
  requestedWorkerChat(oneId: string, taskId: string, chatId: string): boolean;
}

export function assertOneContextTask(scope: OneContextScope, sources: OneContextTaskSources): void {
  if (scope.oneId !== sources.activeOneId()) throw new OneContextError("one-context-task-unavailable");
  if (scope.taskId.startsWith(ONE_REPLY_SCOPE_PREFIX)) {
    const chat = sources.chat(scope.taskId.slice(ONE_REPLY_SCOPE_PREFIX.length));
    if (!chat || chat.archivedAt) throw new OneContextError("one-context-task-unavailable");
    // Only One's own conversation has reply turns; any other chat named this way is not One's to act from.
    if (!sources.personalConversation(scope.oneId, chat.id)) throw new OneContextError("one-context-task-source-unavailable");
    return;
  }
  const task = sources.task(scope.taskId), chat = task?.originChatId ? sources.chat(task.originChatId) : null;
  if (!task || task.archivedAt || !chat || chat.archivedAt || chat.projectId !== task.projectId || chat.firmId !== task.firmId) {
    throw new OneContextError("one-context-task-unavailable");
  }
  if (!sources.personalConversation(scope.oneId, chat.id) && !sources.requestedWorkerChat(scope.oneId, task.id, chat.id)) {
    throw new OneContextError("one-context-task-source-unavailable");
  }
}
