import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import type { ChatHistoryEntry, InvocationCurrentTurnSteerReceipt, InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { appendChatMessage, autoTitleFromFirstMessage } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { invocationRunOwners, invocationProcessOwner } from "../store/invocation-run-owners";
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
import { liveAppControlRendererEvent } from "../app-control/ipc-registry";
import { getInvocationRunReceipt } from "../store/run-events";
import { readRunTurnPlacement } from "./turn-placement";

/**
 * The Main-side wiring of the per-chat send queue (pending-chat-sends.ts) for the messages the renderer sends.
 *
 * `startNow` is the renderer's own start path (the body of invoke:run). A message that path refuses transiently, or that
 * arrives while earlier messages of the same chat are still waiting, is accepted here instead: saved to the transcript,
 * persisted, and started by the queue when the chat is free. The renderer gets an ordinary answer.
 */

export type RendererStartNow = (event: IpcMainInvokeEvent, req: McpInvocationRequest) => Promise<{ runId: string }>;

/**
 * What invoke:run answers when the message was accepted but its run starts later (ID-8). `runId` only echoes the
 * request's own id as the acknowledgement identity the renderer checks (OneShell: invoke_start_ack_identity_mismatch);
 * no run will carry it, and with no request id there is none ("") instead of a made-up one. The message's real identity
 * is the queue row: `pendingSendId`, also as `queuedRequestId` ("pending-send:<id>", the form the steer receipts use);
 * the run that later takes it is recorded on that row, and a notice about the message names it the same way.
 */
export interface QueuedRunAnswer { runId: string; chatId: string; queued: true; pendingSendId: string; queuedRequestId: string }

/** The id a host notice about a queued message carries: the run that took it, else its queue row (never a random id). */
export function queuedSendNoticeRunId(runId: string | null | undefined, sendId: string): string {
  return runId || `pending-send:${sendId}`;
}

function chatIsFree(chatId: string): boolean {
  if (invocationService.activeChatIds().includes(chatId)) return false;
  try { if (getPendingInvocationAdmissionForChat(chatId)) return false; } catch { /* unreadable is not proof of busy */ }
  try { if (invocationRunOwners.getActiveOwner(chatId)) return false; } catch { /* same */ }
  return true;
}

/** How long a queued message may wait on a busy chat before we look into why, and how often we repeat the line. */
const BUSY_DIAGNOSIS_AFTER_MS = 60_000;
const BUSY_DIAGNOSIS_EVERY_MS = 5 * 60_000;
const busyDiagnosisAt = new Map<string, number>();

/**
 * Why a queued message cannot start: the machine facts only (no prose, no prompt text). A lease owned by an earlier
 * process of this same host kind is released here exactly as at startup: this process holds the single-instance lock,
 * so the earlier one is gone and only its own death could have left the row active.
 */
export function diagnoseBusyChat(chatId: string, waitedMs: number, now: number = Date.now()): void {
  if (waitedMs < BUSY_DIAGNOSIS_AFTER_MS) return;
  const me = invocationProcessOwner();
  let owner: ReturnType<typeof invocationRunOwners.getActiveOwner> = null;
  try { owner = invocationRunOwners.getActiveOwner(chatId); } catch { /* unreadable is not proof */ }
  if (owner && owner.ownerKind === me.ownerKind && owner.ownerId !== me.ownerId) {
    try {
      const released = invocationRunOwners.releaseAbandoned(me.ownerKind, me.ownerId);
      console.warn("[send-queue] released leases of an earlier process", { chatId, released: released.length, ownerKind: me.ownerKind });
    } catch (error) {
      console.warn("[send-queue] could not release earlier-process leases", { chatId, code: String((error as { message?: string })?.message ?? error).slice(0, 80) });
    }
    return;
  }
  const last = busyDiagnosisAt.get(chatId) ?? 0;
  if (now - last < BUSY_DIAGNOSIS_EVERY_MS) return;
  busyDiagnosisAt.set(chatId, now);
  let activeRun = false, admission = false;
  // This process's own turns only: activeChatIds also lists the chats this process leases outside a turn (W5).
  try { activeRun = invocationService.turnChatIds().includes(chatId); } catch { /* diagnostic only */ }
  try { admission = Boolean(getPendingInvocationAdmissionForChat(chatId)); } catch { /* diagnostic only */ }
  console.warn("[send-queue] message still waiting for a busy chat", {
    chatId, waitedSeconds: Math.round(waitedMs / 1000), activeRunInThisProcess: activeRun, pendingAdmission: admission,
    lease: owner ? { state: owner.state, ownerKind: owner.ownerKind, ownedByThisProcess: owner.ownerId === me.ownerId, runId: owner.runId } : null,
    // A lease this process owns while no run of this process is active is a leak (the run ended without releasing it).
    suspectedLeak: Boolean(owner && owner.ownerId === me.ownerId && !activeRun && !admission),
  });
}

/**
 * Whether the run that took a queued message is still live: in this process, or in the daemon (its receipt says
 * running while the daemon's owner row holds it). Anything else has a terminal and can be decided.
 */
export function queuedSendRunState(runId: string): "running" | "settled" {
  if (invocationService.activeRunIds().includes(runId)) return "running";
  const receipt = getInvocationRunReceipt(runId);
  return receipt && (receipt.status === "running" || receipt.status === "cancelling") ? "running" : "settled";
}

/**
 * Typed placement of a settled run (turn-placement.ts). A run that completed, or stopped to ask the owner, has handled
 * the message even when no runtime fact was recorded (a host-only answer).
 */
export function queuedSendPlacement(runId: string): "placed" | "not-dispatched" | "unconfirmed" {
  const receipt = getInvocationRunReceipt(runId);
  if (receipt && (receipt.status === "completed" || receipt.status === "waiting_input")) return "placed";
  return readRunTurnPlacement(runId);
}

/** One neutral line for a message whose run ended without proof that it reached the model (never re-sent). */
export function queuedSendUncertainNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "이 메시지가 모델에 전달됐는지 확인되지 않아 다시 보내지 않았어요. 작업 기록을 확인하고 필요하면 다시 보내 주세요."
    : "It is not confirmed that this message reached the model, so it was not sent again. Check the work history and send it again if needed.";
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
    onBusyWait: ({ chatId, waitedMs }) => diagnoseBusyChat(chatId, waitedMs),
    senderAlive: (event) => { try { return !event.sender.isDestroyed(); } catch { return false; } },
    // The queue is Main's: a closed window's messages start from another open window of the app (its real IPC event).
    replacementSender: () => liveAppControlRendererEvent(),
    runState: queuedSendRunState,
    placement: queuedSendPlacement,
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
    onEnded: ({ chatId, request, reason, code, runId, sendId }) => {
      // The message stays in the transcript. A message that could not run because a restart happened is not announced;
      // one that hit a refusal the owner must fix gets one neutral line.
      if (reason === "closed") return;
      if (reason === "uncertain") {
        // Never re-sent. The run already showed its own failure or the owner stopped it; otherwise say it once.
        if (code === "process_restarted") return;
        let status: string | undefined;
        try { status = runId ? getInvocationRunReceipt(runId)?.status : undefined; } catch { status = undefined; }
        if (status === "failed" || status === "cancelled") return;
        try {
          appendChatMessage(chatId, "assistant", queuedSendUncertainNotice(pickLocale(request)),
            { hostNotice: { purpose: "host-status", runId: queuedSendNoticeRunId(runId, sendId), status: "needs-owner" } });
        } catch { /* the saved message and the log remain */ }
        return;
      }
      try {
        appendChatMessage(chatId, "assistant", queuedSendEndedNotice(pickLocale(request)),
          { hostNotice: { purpose: "host-status", runId: queuedSendNoticeRunId(runId, sendId), status: "needs-owner" } });
      } catch { /* the saved message and the log remain */ }
    },
    onChange: (chatId) => { try { emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* cosmetic */ } },
    log: (message, detail) => console.info(`[send-queue] ${message}`, detail),
  });

  // A run that settles in this process decides its message at once (runs settled in the daemon are found by the poll).
  invocationService.onSettled((envelope) => { try { queue.settleRun(envelope.runId); } catch { /* the poll decides it */ } });

  const accept = (event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string | undefined, cause?: unknown): PendingSendRecord =>
    queue.enqueue(event, req, { ...(intentId ? { intentId } : {}), ...(cause === undefined ? {} : { cause }) });

  return {
    queue,
    async run(event, req) {
      const queuedAnswer = (record: PendingSendRecord): QueuedRunAnswer => ({ runId: req.runId ?? "", chatId: req.chatId, queued: true,
        pendingSendId: record.id, queuedRequestId: `pending-send:${record.id}` });
      if (canQueuePendingSend(req) && queue.hasQueued(req.chatId)) {
        // Earlier messages of this chat are still waiting: this one goes behind them, in the order it was typed.
        return queuedAnswer(accept(event, req, undefined));
      }
      try {
        return await startNow(event, req);
      } catch (cause) {
        if (canQueuePendingSend(req) && isTransientSendRefusal(cause)) {
          return queuedAnswer(accept(event, req, undefined, cause));
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
        accepted: true, chatId, queued: record.state === "queued" || record.state === "starting", interruptsCurrent: false,
        queuedRequestId: `pending-send:${record.id}`, promptHash: record.promptHash, intentId,
        ...(record.runId ? { runId: record.runId } : {}),
        // "draining": admitted, placement not known yet. "held": ended without proof of placement; never re-sent.
        status: record.state === "queued" ? "queued" : record.state === "starting" ? "draining" : record.state === "started" ? "started"
          : record.state === "uncertain" ? "held" : "failed",
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
