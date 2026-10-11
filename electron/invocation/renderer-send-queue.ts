import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import type { ChatHistoryEntry, InvocationCurrentTurnSteerReceipt, InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { appendChatMessage, autoTitleFromFirstMessage } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { withPreparedUserRow } from "../store/prepared-user-rows";
import { pickLocale } from "../runtime/status-i18n";
import { invocationService } from "./service";
import { withoutOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import {
  canQueuePendingSend,
  createPendingChatSends,
  pendingSendPromptHash,
  type PendingChatSends,
  type PendingSendRecord,
} from "./pending-chat-sends";
import { isTransientSendRefusal } from "../../shared/transient-send-refusal";

/**
 * The Main-side wiring of the per-chat send queue (pending-chat-sends.ts) for the messages the renderer sends.
 *
 * `startNow` is the renderer's own start path (the body of invoke:run). A message that path refuses transiently, or that
 * arrives while earlier messages of the same chat are still waiting, is accepted here instead: saved to the transcript,
 * persisted, and started by the queue when the chat is free. The renderer gets an ordinary answer.
 */

export type RendererStartNow = (event: IpcMainInvokeEvent, req: McpInvocationRequest) => Promise<{ runId: string }>;

/** What invoke:run answers when the message was accepted but its run starts later. */
export interface QueuedRunAnswer { runId: string; chatId: string; queued: true }

function chatIsFree(chatId: string): boolean {
  if (invocationService.activeChatIds().includes(chatId)) return false;
  try { if (getPendingInvocationAdmissionForChat(chatId)) return false; } catch { /* unreadable is not proof of busy */ }
  try { if (invocationRunOwners.getActiveOwner(chatId)) return false; } catch { /* same */ }
  return true;
}

/** The neutral line for a message that could not run and needs the owner (one line, no codes, no process names). */
export function queuedSendEndedNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "이 메시지는 실행되지 못했어요. 모델 연결과 사용 한도를 확인한 뒤 다시 보내 주세요."
    : "This message could not run. Check the model connection and usage limits, then send it again.";
}

export function createRendererSendQueue(startNow: RendererStartNow): {
  queue: PendingChatSends<IpcMainInvokeEvent>;
  /** invoke:run: start now, or accept into the queue. */
  run(event: IpcMainInvokeEvent, req: McpInvocationRequest): Promise<{ runId: string } | QueuedRunAnswer>;
  /** invoke:steer / invoke:steerCurrentTurn: when the steer was refused transiently, accept it as a message that runs next. */
  acceptRefusedSteer(event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string | undefined, cause: unknown): InvocationSteerResult | null;
  steerReceiptFor(chatId: string, intentId: string): InvocationSteerResult | null;
  currentTurnReceiptFor(chatId: string, intentId: string, runId: string): InvocationCurrentTurnSteerReceipt | null;
} {
  const queue = createPendingChatSends<IpcMainInvokeEvent>({
    db: getDb() as unknown as Parameters<typeof createPendingChatSends>[0]["db"],
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: Math.random,
    isChatFree: chatIsFree,
    senderAlive: (event) => { try { return !event.sender.isDestroyed(); } catch { return false; } },
    saveUserRow: (request) => {
      if (request.promptOrigin === "system") return null;
      const row = appendChatMessage(request.chatId, "user", request.userPrompt, request.images?.length ? { images: request.images } : undefined);
      try { autoTitleFromFirstMessage(request.chatId, request.userPrompt); } catch { /* a title is cosmetic */ }
      return row;
    },
    start: (event, request, userRow) => {
      // Never inherit a settling run's personal-native original (see withoutOnePersonalNativeOriginal).
      const start = () => withoutOnePersonalNativeOriginal(() => startNow(event, request as McpInvocationRequest));
      return userRow
        ? withPreparedUserRow<ChatHistoryEntry, { runId: string }>(request.chatId, request.userPrompt, userRow as ChatHistoryEntry, start)
        : start();
    },
    onEnded: ({ chatId, request, reason }) => {
      // The message stays in the transcript. A message that could not run because a window closed or a restart happened
      // is not announced; one that hit a refusal the owner must fix gets one neutral line.
      if (reason === "closed") return;
      try {
        appendChatMessage(chatId, "assistant", queuedSendEndedNotice(pickLocale(request)),
          { hostNotice: { purpose: "host-status", runId: request.runId ?? randomUUID(), status: "needs-owner" } });
      } catch { /* the saved message and the log remain */ }
    },
    onChange: (chatId) => { try { emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* cosmetic */ } },
    log: (message, detail) => console.info(`[send-queue] ${message}`, detail),
  });

  const accept = (event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string | undefined, cause?: unknown): PendingSendRecord =>
    queue.enqueue(event, req, { ...(intentId ? { intentId } : {}), ...(cause === undefined ? {} : { cause }) });

  return {
    queue,
    async run(event, req) {
      if (canQueuePendingSend(req) && queue.hasQueued(req.chatId)) {
        // Earlier messages of this chat are still waiting: this one goes behind them, in the order it was typed.
        accept(event, req, undefined);
        return { runId: req.runId ?? randomUUID(), chatId: req.chatId, queued: true };
      }
      try {
        return await startNow(event, req);
      } catch (cause) {
        if (canQueuePendingSend(req) && isTransientSendRefusal(cause)) {
          accept(event, req, undefined, cause);
          return { runId: req.runId ?? randomUUID(), chatId: req.chatId, queued: true };
        }
        throw cause;
      }
    },
    acceptRefusedSteer(event, req, intentId, cause) {
      if (!canQueuePendingSend(req) || !isTransientSendRefusal(cause)) return null;
      const id = intentId ?? randomUUID();
      const record = queue.find(req.chatId, id) ?? accept(event, req, id, cause);
      return {
        accepted: true, chatId: req.chatId, queued: true, interruptsCurrent: false,
        queuedRequestId: `pending-send:${record.id}`, promptHash: record.promptHash, intentId: id, status: "queued",
      };
    },
    steerReceiptFor(chatId, intentId) {
      const record = queue.find(chatId, intentId);
      if (!record) return null;
      return {
        accepted: true, chatId, queued: record.state === "queued", interruptsCurrent: false,
        queuedRequestId: `pending-send:${record.id}`, promptHash: record.promptHash, intentId,
        status: record.state === "queued" ? "queued" : record.state === "started" ? "started" : "failed",
      };
    },
    currentTurnReceiptFor(chatId, intentId, runId) {
      const record = queue.find(chatId, intentId);
      if (!record) return null;
      const userRow = record.userRow as { id?: string } | null;
      return {
        chatId, intentId, runId, promptHash: record.promptHash, messageId: userRow?.id ?? record.id,
        // Accepted and durable; whether it has started is the queue's business, not a state the owner has to see.
        status: "applied",
      };
    },
  };
}

export { pendingSendPromptHash };
