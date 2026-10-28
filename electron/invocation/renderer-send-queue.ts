import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import type { ChatHistoryEntry, InvocationCurrentTurnSteerReceipt, InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { appendChatMessage, autoTitleFromFirstMessage } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { invocationRunOwners, invocationProcessOwner } from "../store/invocation-run-owners";
import { releaseGoneTerminalOwners } from "../store/terminal-owner-liveness";
import { userDataDir } from "../runtime-paths";
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
import { isTransientSendRefusal, sendRefusalCode, startOwnerSendOrAcceptRefusal } from "../../shared/transient-send-refusal";
import { liveAppControlRendererEvent } from "../app-control/ipc-registry";
import { getInvocationRunReceipt } from "../store/run-events";
import { readRunTurnPlacement } from "./turn-placement";
import type { QueuedOwnerInputCustody, QueuedOwnerStartBoundary } from "./queued-owner-input-custody";
import { OWNER_INTAKE_NOTICE_AFTER_MS, ownerIntakeReceivedNotice } from "./owner-intake";

/**
 * The Main-side wiring of the per-chat send queue (pending-chat-sends.ts) for the messages the renderer sends.
 *
 * `startNow` is the renderer's own start path (the body of invoke:run). A message that path refuses transiently, or that
 * arrives while earlier messages of the same chat are still waiting, is accepted here instead: saved to the transcript,
 * persisted, and started by the queue when the chat is free. The renderer gets an ordinary answer.
 */

export type RendererStartNow = (event: IpcMainInvokeEvent, req: McpInvocationRequest, boundary?: QueuedOwnerStartBoundary) => Promise<{ runId: string }>;

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

// A Work project is shared attribution, not a provider process: another chat of the project is an independent native writer
// (runtime/native-writer-admission.ts queues only turns that write the same native session), so a message never waits here on
// a sibling chat. The old "one CLI per Work project" hold existed only to avoid work_project_residency_busy, which is gone.
function chatIsFree(chatId: string): boolean {
  if (invocationService.activeChatIds().includes(chatId)) return false;
  if (invocationService.hasQueuedOwnerRequest(chatId)) return false;
  try { if (getPendingInvocationAdmissionForChat(chatId)) return false; } catch { /* unreadable is not proof of busy */ }
  try {
    let holder = invocationRunOwners.getActiveOwner(chatId);
    // A terminal that died without releasing (kill -9, a crash, power loss) holds its chat for good unless its owner is PROVEN gone.
    if (holder && holder.ownerKind === "terminal" && holder.ownerId !== invocationProcessOwner().ownerId) {
      try { sweepGoneTerminalOwners(chatId); } catch { /* a failed proof keeps the lease: the chat stays busy */ }
      holder = invocationRunOwners.getActiveOwner(chatId);
    }
    if (holder) return false;
  } catch { /* same */ }
  return true;
}

// The proof can run `ps` (or PowerShell) for a live terminal, and the queue asks every few seconds: look again at most this often.
const TERMINAL_SWEEP_EVERY_MS = 10_000;
const terminalSweepAt = new Map<string, number>();
const terminalSweepKept = new Map<string, { code: string; pid?: number; ownerId: string }>();

/** Release the chat's terminal lease if (and only if) its owner process and agent children are provably gone. */
export function sweepGoneTerminalOwners(chatId: string, now: number = Date.now()): number {
  const last = terminalSweepAt.get(chatId) ?? 0;
  if (now - last < TERMINAL_SWEEP_EVERY_MS) return 0;
  terminalSweepAt.set(chatId, now);
  const swept = releaseGoneTerminalOwners(invocationRunOwners, userDataDir(), { chatId });
  if (swept.released.length > 0) {
    terminalSweepKept.delete(chatId);
    console.warn("[send-queue] released a lease of a terminal that is gone", { chatId, released: swept.released.length, runIds: swept.released.map((owner) => owner.runId) });
  } else if (swept.kept[0]) {
    terminalSweepKept.set(chatId, { code: swept.kept[0].code, ownerId: swept.kept[0].ownerId, ...(swept.kept[0].pid !== undefined ? { pid: swept.kept[0].pid } : {}) });
  }
  return swept.released.length;
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
    // Why a terminal-held chat could not be released: the machine code of the proof (terminal_owner_alive, _child_alive, ...).
    ...(owner?.ownerKind === "terminal" && terminalSweepKept.get(chatId) ? { terminalProof: terminalSweepKept.get(chatId) } : {}),
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

export interface RendererSendQueueOptions {
  custody?: QueuedOwnerInputCustody;
  /** Main normalization precedes custody; renderer-only authority is stripped. */
  sanitizeRequest?(request: McpInvocationRequest): McpInvocationRequest;
  /** Whether an IPC event is a trusted app page right now (ipc.ts assertTrustedSitePublishIpcSender). */
  senderTrusted?(event: IpcMainInvokeEvent): boolean;
  /** Only Main's durable queue may rebind its exact saved preflight before a deferred start. */
  beforeQueuedStart?(event: IpcMainInvokeEvent, request: McpInvocationRequest): void | Promise<void>;
  /** Synchronous, in the same store transaction as acceptance: release only the queued parent's preparation slot. */
  onQueued?(request: McpInvocationRequest): void;
  /**
   * The owner direction the process hosting the turn already recorded under this intent (recorded-owner-steer.ts), in the shape
   * invoke:steer answers; null when there is none. A refused steer accepted here as the next message is dropped instead of started
   * when the host recorded it after all (its reply was lost), and its receipt then answers with the host's own.
   */
  recordedOwnerSteer?(chatId: string, intentId: string): InvocationSteerResult | null;
}

const UNTRUSTED_SENDER_CODES = new Set(["untrusted-site-publish-ipc-sender", "untrusted-site-publish-ipc-window"]);

export function createRendererSendQueue(startNow: RendererStartNow, options: RendererSendQueueOptions = {}): {
  queue: PendingChatSends<IpcMainInvokeEvent>;
  dispose(): void;
  /** invoke:run: start now, or accept into the queue. */
  run(event: IpcMainInvokeEvent, req: McpInvocationRequest): Promise<{ runId: string } | QueuedRunAnswer>;
  /** invoke:steer / invoke:steerCurrentTurn: when the steer was refused transiently, accept it as a message that runs next. */
  acceptRefusedSteer(event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string | undefined, cause: unknown): InvocationSteerResult | null;
  resumeCustodiedInputs(restoreAuthority?: boolean): void;
  steerReceiptFor(chatId: string, intentId: string): InvocationSteerResult | null;
  currentTurnReceiptFor(chatId: string, intentId: string, runId: string): InvocationCurrentTurnSteerReceipt | null;
} {
  let disposed = false;
  const canQueue = (request: McpInvocationRequest) => canQueuePendingSend(request, options.custody?.canQueue(request) === true);
  const startOwned = (event: IpcMainInvokeEvent, request: McpInvocationRequest, queueId: string | null, before?: () => void | Promise<void>) => {
    const start = async (execution: McpInvocationRequest, boundary?: QueuedOwnerStartBoundary) => {
      await before?.();
      return startNow(event, execution, boundary);
    };
    return options.custody ? options.custody.start(request, queueId, start) : start(request);
  };
  const queue = createPendingChatSends<IpcMainInvokeEvent>({
    db: getDb() as unknown as Parameters<typeof createPendingChatSends>[0]["db"],
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: Math.random,
    isChatFree: chatIsFree,
    alreadyDelivered: (chatId, intentId) => options.recordedOwnerSteer?.(chatId, intentId) != null,
    persistentInput: (id) => options.custody?.persistentInput(id) === true,
    onHeld: (id,code) => options.custody?.hold(id,code),
    inputReady: (id, request) => !request.oneAttachmentRef && !request.oneTeamPreflightRef || options.custody?.readyForQueue(id) === true,
    onBusyWait: ({ chatId, waitedMs }) => diagnoseBusyChat(chatId, waitedMs),
    senderAlive: (event) => {
      try { return !event.sender.isDestroyed() && (options.senderTrusted ? options.senderTrusted(event) : true); } catch { return false; }
    },
    // The queue is Main's: a closed window's messages start from another open window of the app (its real IPC event),
    // only once that window is a trusted app page (right after a restart the first one can still be the startup page).
    replacementSender: () => {
      const event = liveAppControlRendererEvent();
      if (!event) return null;
      try { return !options.senderTrusted || options.senderTrusted(event) ? event : null; } catch { return null; }
    },
    senderRefused: (cause) => UNTRUSTED_SENDER_CODES.has(String((cause as { code?: unknown })?.code ?? (cause as { message?: unknown })?.message ?? "")),
    runState: queuedSendRunState,
    placement: (runId) => options.custody ? options.custody.placement(runId) : queuedSendPlacement(runId),
    reserveStart: (id,request,markStarting) => {
      if (!options.custody) throw new Error("queued_input_custody_required");
      options.custody.reserveStart(id,request,markStarting);
    },
    canRetryStart: (request, runId) => !request.oneAttachmentRef && !request.oneTeamPreflightRef || options.custody?.placement(runId) === "not-dispatched",
    onPlaced: () => options.custody?.reconcile(),
    failureCode: (runId) => getInvocationRunReceipt(runId)?.errorCode ?? null,
    saveUserRow: (request) => {
      if (request.promptOrigin === "system") return null;
      const row = options.custody?.savedUserRow(request)
        ?? appendChatMessage(request.chatId, "user", request.userPrompt, request.images?.length ? { images: request.images } : undefined);
      try { autoTitleFromFirstMessage(request.chatId, request.userPrompt); } catch { /* a title is cosmetic */ }
      return row;
    },
    start: async (event, request, userRow, sendId) => {
      // Never inherit a settling run's personal-native original (see withoutOnePersonalNativeOriginal).
      const start = () => withoutOnePersonalNativeOriginal(() => startOwned(event, request as McpInvocationRequest, sendId, () => options.beforeQueuedStart?.(event, request as McpInvocationRequest)));
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
      // A run that took the message and failed has already shown its own typed failure (persistEmptyFailureNotice);
      // a second line blaming "model connection and usage limits" was wrong for every app-side cause.
      if (runId) {
        let status: string | undefined;
        try { status = getInvocationRunReceipt(runId)?.status; } catch { status = undefined; }
        if (status === "failed" || status === "cancelled") return;
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
  const offSettled=invocationService.onSettled((envelope) => { if (disposed) return; try { resumeCustodiedInputs(); queue.settleRun(envelope.runId); } catch { /* the poll decides it */ } });

  // Owner intake (owner-intake.ts): a message that is still waiting for its chat a moment later gets one received line,
  // the same typed row the phone path writes, so the owner sees it was taken and runs once the chat is free.
  const noticeIfStillWaiting = (record: PendingSendRecord, request: McpInvocationRequest): PendingSendRecord => {
    const timer = setTimeout(() => {
      if (disposed) return;
      try {
        const current = queue.get(record.id);
        if (!current || current.state !== "queued") return;
        appendChatMessage(request.chatId, "assistant", ownerIntakeReceivedNotice(pickLocale(request)),
          { hostNotice: { purpose: "host-status", runId: queuedSendNoticeRunId(current.runId, record.id), status: "owner-received" } });
        try { emitDesktopStoreChange({ entity: "chat", id: request.chatId }); } catch { /* cosmetic */ }
      } catch { /* the message itself is saved and queued */ }
    }, OWNER_INTAKE_NOTICE_AFTER_MS);
    timer.unref?.();
    return record;
  };

  const accept = (event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string | undefined, cause?: unknown): PendingSendRecord =>
    getDb().transaction(() => {
      const record = queue.enqueue(event, req, { ...(intentId ? { intentId } : {}), ...(cause === undefined ? {} : { cause }) });
      options.custody?.adopt(req, record.id);
      options.onQueued?.(req);
      return record;
    }).immediate();

  // A crash between exact capture/refusal and enqueue must not strand owner
  // input. Adoption and attempt opening serialize on the same owner DB. An
  // absent source attempt is safe only with the completed Main capture marker;
  // any opened/unknown attempt is held instead. No synthetic sender can start it.
  const resumeCustodiedInputs = (restoreAuthority=false) => {
    if (disposed) return;
    for (const request of options.custody?.recoverableRequests(restoreAuthority) ?? []) {
      try { accept(undefined as unknown as IpcMainInvokeEvent, request, undefined); }
      catch { /* Retain exact provisional custody; never invent missing proof. */ }
    }
    for (const request of options.custody?.heldRequests() ?? []) {
      try {
        getDb().transaction(() => {
          const record=queue.enqueue(undefined as unknown as IpcMainInvokeEvent,request);
          options.custody!.adoptHeld(request,record.id,"queued_input_capture_incomplete");
          queue.hold(record.id,"queued_input_capture_incomplete");
          options.onQueued?.(request);
        }).immediate();
      } catch { /* Owned text remains durable; incomplete media is never executed. */ }
    }
    options.custody?.reconcile();
    for (const resumed of options.custody?.resumeHeldQueues(restoreAuthority) ?? []) {
      void queue.pumpNow(resumed.chatId).catch(() => { /* Retain the exact row; the next recovery pass reads its placement. */ });
    }
  };
  resumeCustodiedInputs();
  // Native daemon settlements are also observed through the shared store;
  // their local Main onSettled callback is not guaranteed after reconnect.
  const custodyRecoveryTimer = options.custody ? setInterval(() => {
    try { resumeCustodiedInputs(); } catch { /* Store/account unavailable: retain input. */ }
  }, 2_000) : undefined;
  custodyRecoveryTimer?.unref();

  return {
    queue, resumeCustodiedInputs,
    dispose() { disposed = true; offSettled?.(); if (custodyRecoveryTimer) clearInterval(custodyRecoveryTimer); queue.dispose(); },
    async run(event, req) {
      const rawSubmission = req.preflightSubmissionId;
      req = options.sanitizeRequest ? options.sanitizeRequest(req) : { ...req };
      if (rawSubmission !== undefined) req.preflightSubmissionId = rawSubmission;
      const previous = options.custody?.existing(req);
      const queuedAnswer = (record: PendingSendRecord): QueuedRunAnswer => ({ runId: req.runId ?? "", chatId: req.chatId, queued: true,
        pendingSendId: record.id, queuedRequestId: `pending-send:${record.id}` });
      if (previous) {
        const existing = previous.queue_id ? queue.get(previous.queue_id) : null;
        if (existing) return queuedAnswer(existing);
        throw new Error("queued_input_run_identity_exists");
      }
      try { options.custody?.capture(req); }
      catch (cause) {
        if (!canQueuePendingSend(req,true) || !options.custody?.captureHeld(req)) throw cause;
        const code=sendRefusalCode(cause) ?? "queued_input_capture_incomplete";
        const held=getDb().transaction(() => {
          const record=queue.enqueue(event,req);
          options.custody!.adoptHeld(req,record.id,code);
          queue.hold(record.id,code);
          options.onQueued?.(req);
          return record;
        }).immediate();
        return queuedAnswer(held);
      }
      if (canQueue(req) && queue.hasQueued(req.chatId)) {
        // Earlier messages of this chat are still waiting: this one goes behind them, in the order it was typed.
        return queuedAnswer(accept(event, req, undefined));
      }
      return startOwnerSendOrAcceptRefusal(() => startOwned(event, req, null), (cause) => {
        if (!canQueue(req)) return null;
        if (isTransientSendRefusal(cause)
          && (!req.oneAttachmentRef && !req.oneTeamPreflightRef || options.custody?.placement(req.runId!) === "not-dispatched"))
          return queuedAnswer(noticeIfStillWaiting(accept(event,req,undefined,cause), req));
        if (!options.custody?.canHold(req)) return null;
        // Hard refusals and unknown effects retain owner input, but never enter
        // the retry drain without a later exact positive no-effect boundary.
        return getDb().transaction(() => {
          const record=queue.enqueue(event,req,{cause});
          const code=sendRefusalCode(cause) ?? "queued_input_start_unconfirmed";
          options.custody!.adoptHeld(req,record.id,code);
          queue.hold(record.id,code,req.runId);
          options.onQueued?.(req);
          return queuedAnswer(record);
        }).immediate();
      });
    },
    acceptRefusedSteer(event, req, intentId, cause) {
      if (!canQueue(req) || !isTransientSendRefusal(cause)) return null;
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
      // Dropped because the host of the turn had recorded this very direction: its own receipt is the truth (its row, its status).
      if (record.state === "abandoned" && record.lastCode === "steer_recorded") {
        try { return options.recordedOwnerSteer?.(chatId, intentId) ?? null; } catch { return null; }
      }
      return {
        accepted: true, chatId, queued: record.state === "queued" || record.state === "starting", interruptsCurrent: false,
        queuedRequestId: `pending-send:${record.id}`, promptHash: record.promptHash, intentId,
        ...(record.runId ? { runId: record.runId } : {}),
        // "draining": admitted, placement not known yet. "held": ended without proof of placement; never re-sent.
        status: record.state === "queued" ? "queued" : record.state === "starting" ? "draining" : record.state === "started" ? "started"
          : record.state === "uncertain" || record.state === "held" ? "held" : "failed",
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
