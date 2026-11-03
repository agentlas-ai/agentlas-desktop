import { createHash, randomUUID } from "node:crypto";
import { followupRequestJson } from "../../shared/followup-custody";
import { FOLLOWUP_STOPPED, type FollowupCapture } from "../store/followup-custody-core";
import type { IpcMainInvokeEvent } from "electron";
import type { ChatHistoryEntry, InvocationCurrentTurnSteerReceipt, InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { appendChatMessage, autoTitleFromFirstMessage } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getInvocationAdmission, getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { invocationRunOwners, invocationProcessOwner } from "../store/invocation-run-owners";
import { releaseGoneTerminalOwners } from "../store/terminal-owner-liveness";
import { userDataDir } from "../runtime-paths";
import { withPreparedUserRow } from "../store/prepared-user-rows";
import { pickLocale } from "../runtime/status-i18n";
import { invocationService, type InvocationSettledEnvelope } from "./service";
import { withoutOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import {
  canQueuePendingSend,
  createPendingChatSends,
  pendingSendPromptHash,
  PendingSendImagesUnsaved,
  PendingSendSourceReadBusy,
  type PendingChatSends,
  type PendingSendRecord,
} from "./pending-chat-sends";
import { isRefusedBeforeDispatch, isTransientSendRefusal, sendRefusalCode, startOwnerSendOrAcceptRefusal, startRefusalNeedsOwner } from "../../shared/transient-send-refusal";
import { liveAppControlRendererEvent } from "../app-control/ipc-registry";
import { getInvocationRunReceipt } from "../store/run-events";
import { isOwnerEndedInvocation } from "../../shared/invocation-host-stop";
import { queuedSendInternalFailure } from "./queue-retry-fact";
import { readRunTurnPlacement } from "./turn-placement";
import { hasEarlierAttempt, ownerStoppedChatSince, unconfirmedRunShouldBeSentAgain } from "./earlier-attempt";
import { forgetDirectStartKept, noteDirectStartKept } from "./resend-forecast";
import { queuedSendUnansweredNotice } from "./queued-send-notices";
export { queuedSendUnansweredNotice };
import type { QueuedOwnerInputCustody, QueuedOwnerStartBoundary } from "./queued-owner-input-custody";
import { OWNER_INTAKE_NOTICE_AFTER_MS, ownerIntakeReceivedNotice } from "./owner-intake";

/**
 * The Main-side wiring of the per-chat send queue (pending-chat-sends.ts) for the messages the renderer sends.
 *
 * `startNow` is the renderer's own start path (the body of invoke:run). A message that path refuses transiently, or that
 * arrives while earlier messages of the same chat are still waiting, is accepted here instead: saved to the transcript,
 * persisted, and started by the queue when the chat is free. The renderer gets an ordinary answer.
 */

export type RendererSourceBoundary = QueuedOwnerStartBoundary & { startSource?<T>(start: () => T): T };
export type RendererStartNow = (event: IpcMainInvokeEvent, req: McpInvocationRequest, boundary?: RendererSourceBoundary) => Promise<{ runId: string }>;

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

/**
 * Whether a start the host refused is only the app's own state, and the message should wait for it instead of ending on the screen
 * as a code. Both must hold: the host proved nothing reached a runtime (the error's own `turnDelivery: "not-dispatched"` marker, or the
 * run's admission row decided `rejected` with its no-start proof), and the refusal is not one the owner acts on
 * (startRefusalNeedsOwner). The transient allowlist (shared/transient-send-refusal.ts) is handled before this and is not repeated here.
 * A refusal with no proof, or after the hand-off, is never taken: that message could have acted.
 */
export function undispatchedStartWaits(cause: unknown, runId: string | null | undefined): boolean {
  if (isTransientSendRefusal(cause)) return false;
  if (startRefusalNeedsOwner(sendRefusalCode(cause))) return false;
  if (isRefusedBeforeDispatch(cause)) return true;
  if (!runId) return false;
  try { return getInvocationAdmission(runId)?.status === "rejected"; } catch { return false; }
}

/** One calm line for a message that was saved and retried but still could not start: no code, and nothing was sent anywhere. */
export function queuedSendHeldNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "메시지는 저장됐지만 아직 시작하지 못했어요. 아무것도 실행되지 않았으니 같은 내용을 한 번 더 보내 주세요."
    : "Your message is saved, but it has not started yet. Nothing ran, so please send it once more.";
}

/**
 * The neutral line for a message that could not run (one line, no codes, no process names). It names no cause: "check the model connection
 * and usage limits" was said for every cause, including the app's own state, which the owner has nothing to fix. A refusal the owner acts
 * on (a cost cap, a stopped Goal) is told with its own sentence when it happens, not here.
 */
export function queuedSendEndedNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "이 메시지는 아직 실행되지 못했어요. 잠시 뒤 같은 내용을 다시 보내 주세요."
    : "This message has not run yet. Send the same text again in a moment.";
}

export interface RendererSendQueueOptions {
  followupAccountDigest?(request: McpInvocationRequest): string;
  recoverFollowups?(accept: (request: McpInvocationRequest, intentId: string, messageId?: string) => PendingSendRecord): void;
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
  acceptCurrentTurnFallback(event: IpcMainInvokeEvent, req: McpInvocationRequest, intentId: string, messageId?: string): PendingSendRecord;
  resumeCustodiedInputs(restoreAuthority?: boolean): void;
  steerReceiptFor(chatId: string, intentId: string): InvocationSteerResult | null;
  currentTurnReceiptFor(chatId: string, intentId: string): InvocationCurrentTurnSteerReceipt | null;
} {
  let disposed = false;
  const followupForQueue = (id:string) => getDb().prepare("SELECT * FROM invocation_followup_custody WHERE queue_id=?").get(id) as FollowupCapture|undefined;
  const placement = (runId:string) => {
    const captured = getDb().prepare(`SELECT f.chat_id FROM invocation_followup_custody f JOIN pending_chat_sends q ON q.id=f.queue_id WHERE q.run_id=?`).get(runId) as {chat_id:string}|undefined;
    if (captured) {
      const closed = getDb().prepare("SELECT 1 FROM invocation_followup_custody WHERE closed_attempt_run_id=?").get(runId);
      if (closed) return "not-dispatched" as const;
      const admission = getInvocationAdmission(runId);
      if (admission?.status === "rejected" && admission.chatId === captured.chat_id) return "not-dispatched" as const;
    }
    return options.custody ? options.custody.placement(runId) : queuedSendPlacement(runId);
  };
  const canQueue = (request: McpInvocationRequest) => canQueuePendingSend(request, options.custody?.canQueue(request) === true);
  const startOwned = (event: IpcMainInvokeEvent, request: McpInvocationRequest, queueId: string | null, before?: () => void | Promise<void>) => {
    const start = async (execution: McpInvocationRequest, boundary?: QueuedOwnerStartBoundary) => {
      let captured: unknown;
      try { captured = queueId ? getDb().prepare("SELECT intent_id FROM invocation_followup_custody WHERE queue_id=?").get(queueId) : undefined; }
      catch (error) {
        const busy = PendingSendSourceReadBusy.from(error);
        if (busy) throw busy;
        throw error;
      }
      if (!captured) {
        await before?.();
        return startNow(event, execution, boundary);
      }
      let sourceEntered = false;
      const exactBoundary: RendererSourceBoundary = { startSource<T>(enter: () => T): T {
        // Keep Stop's shared-store CAS excluded until the synchronous source
        // capture has installed its cancellation target (before its first await).
        const entered = getDb().transaction(() => {
          try { return {result:enter()}; }
          catch (error) { if (error instanceof Error && error.message === FOLLOWUP_STOPPED) return {error}; throw error; }
        }).immediate();
        if ("error" in entered) throw entered.error;
        return entered.result;
      }, enterSource() {
        getDb().transaction(() => {
          const live = getDb().prepare(`SELECT f.account_digest,f.request_json FROM invocation_followup_custody f JOIN pending_chat_sends q ON q.id=f.queue_id
            WHERE q.id=? AND q.run_id=? AND q.state='starting' AND f.state='entered'`).get(queueId,execution.runId);
          if (!live) {
            // This exact caller has not entered its source. Persist the closure
            // separately from Stop so explicit same-ID resume need not guess.
            getDb().prepare("UPDATE invocation_followup_custody SET closed_attempt_run_id=? WHERE queue_id=? AND state='stopped'").run(execution.runId,queueId);
            return false;
          }
          const saved = live as {account_digest:string;request_json:string};
          if (!options.followupAccountDigest || saved.account_digest !== options.followupAccountDigest(JSON.parse(saved.request_json) as McpInvocationRequest)) throw new Error("followup_owner_changed");
          boundary?.enterSource();
          sourceEntered = true;
          return true;
        }).immediate() || (() => { throw new Error(FOLLOWUP_STOPPED); })();
      } };
      try {
        await before?.();
        return await startNow(event, execution, exactBoundary);
      } catch (error) {
        if (!sourceEntered) getDb().prepare("UPDATE invocation_followup_custody SET closed_attempt_run_id=? WHERE queue_id=?")
          .run(execution.runId,queueId);
        throw error;
      }
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
    persistentInput: (id) => Boolean(followupForQueue(id)) || options.custody?.persistentInput(id) === true,
    onHeld: (id,code) => { if (!followupForQueue(id)) options.custody?.hold(id,code); },
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
    placement,
    reserveStart: (id,request,markStarting) => {
      if (!options.custody) throw new Error("queued_input_custody_required");
      options.custody.reserveStart(id,request,markStarting);
    },
    reservePlainStart: (id,_request,markStarting) => {
      getDb().transaction(() => {
        const captured = getDb().prepare("SELECT state FROM invocation_followup_custody WHERE queue_id=?").get(id) as {state:string}|undefined;
        if (!captured) return;
        if (captured.state !== "entered") throw new Error(FOLLOWUP_STOPPED);
        markStarting();
      }).immediate();
    },
    waitsBeforeDispatch: undispatchedStartWaits,
    canRetryStart: (request, runId) => {
      const captured = getDb().prepare(`SELECT 1 FROM invocation_followup_custody f JOIN pending_chat_sends q ON q.id=f.queue_id WHERE q.run_id=?`).get(runId);
      if (captured) return placement(runId) === "not-dispatched";
      return !request.oneAttachmentRef && !request.oneTeamPreflightRef || options.custody?.placement(runId) === "not-dispatched";
    },
    onPlaced: () => options.custody?.reconcile(),
    // A message whose run was lost without a stated cause is sent once more with the earlier-attempt line; the owner's Stop, a steering
    // interrupt, a host stop and a run the owner already saw fail are never sent again (earlier-attempt.ts reads the receipt).
    resendWhenUnconfirmed: (runId) => {
      if (!runId) return unconfirmedRunShouldBeSentAgain(null);
      try { return unconfirmedRunShouldBeSentAgain(getInvocationRunReceipt(runId)); } catch { return false; }
    },
    ownerStoppedSince: (chatId, sinceMs) => ownerStoppedChatSince(getDb(), chatId, sinceMs),
    failureCode: (runId) => getInvocationRunReceipt(runId)?.errorCode ?? null,
    // The owner's Stop, a direction steered over the run, a Goal they paused or deleted: that run's message is never started again.
    endedByOwner: (runId) => {
      const receipt = getInvocationRunReceipt(runId);
      return !!receipt && isOwnerEndedInvocation(receipt);
    },
    internalFailure: (runId) => queuedSendInternalFailure(getInvocationRunReceipt(runId)),
    saveUserRow: (request) => {
      if (request.promptOrigin === "system") return null;
      const row = options.custody?.savedUserRow(request)
        ?? appendChatMessage(request.chatId, "user", request.userPrompt, { ...(request.images?.length ? { images: request.images } : {}), ...(request.fileGroupId ? { fileGroupId: request.fileGroupId } : {}) });
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
      if (reason === "held") {
        // The start was refused before dispatch on every bounded retry. Held, not failed: said once, without the code.
        try {
          appendChatMessage(chatId, "assistant", queuedSendHeldNotice(pickLocale(request)),
            { hostNotice: { purpose: "host-status", runId: queuedSendNoticeRunId(null, sendId), status: "needs-owner" } });
        } catch { /* the saved message and the log remain */ }
        return;
      }
      if (reason === "uncertain") {
        // Nothing is asked of the owner. The owner's Stop, a steering interrupt, a host stop, a failure the run already showed and a run a
        // later turn took over speak for themselves. A run lost WITHOUT a stated cause that is not sent again (the one resend is spent, or a
        // one-use input) has nothing that speaks for it: one calm line, so the message does not end with no line at all. The ledger keeps
        // the row (state "uncertain", its code) and the log line.
        let lostWithoutCause = false;
        // A failed run (an unsettled turn) already showed its own failure line; only a run that left no line of its own gets this one.
        try {
          const receipt = runId ? getInvocationRunReceipt(runId) : null;
          lostWithoutCause = receipt?.status !== "failed" && unconfirmedRunShouldBeSentAgain(receipt);
        } catch { lostWithoutCause = false; }
        if (lostWithoutCause) {
          try {
            appendChatMessage(chatId, "assistant", queuedSendUnansweredNotice(pickLocale(request)),
              { hostNotice: { purpose: "host-status", runId: queuedSendNoticeRunId(runId, sendId), status: "app-failed" } });
          } catch { /* the saved message and the log remain */ }
        }
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

  const messageCustody = (record: PendingSendRecord): "exact" | "unconfirmed" => {
    const messageId = (record.userRow as {id?:string}|null)?.id;
    const request = record.request;
    if (!messageId || request.fileGroupId || request.oneAttachmentRef || request.oneTeamPreflightRef) return "unconfirmed";
    const db = getDb();
    if (!db.prepare("SELECT 1 FROM chat_messages WHERE id=? AND chat_id=? AND role='user' AND text=?")
      .get(messageId, record.chatId, request.userPrompt)) return "unconfirmed";
    if (request.images?.length) {
      const rows = db.prepare("SELECT name,media_type,data FROM chat_message_attachments WHERE message_id=? AND chat_id=? ORDER BY rowid")
        .all(messageId, record.chatId) as {name:string;media_type:string;data:Buffer}[];
      if (rows.length !== request.images.length || rows.some((row, index) => row.media_type !== request.images![index].mediaType
        || row.name !== request.images![index].name || !Buffer.isBuffer(row.data) || row.data.toString("base64") !== request.images![index].data)) return "unconfirmed";
    }
    return "exact";
  };
  const recordRequestHash = (record: PendingSendRecord) => createHash("sha256").update(followupRequestJson(record.request), "utf8").digest("hex");

  /**
   * A message the composer started directly (the chat was free) has no queue row, so when its run is lost or its turn ends unsettled the
   * queue could not send it again (earlier-attempt.ts decides from the receipt, a2979948a built that half for queued rows). The request
   * of a direct start is kept here only until its run settles; if the run ended with an unknown outcome, the message is queued as the one
   * resend the cap allows: same transcript row (no second copy of the message), the earlier-attempt line for the model, and the owner's
   * Stop, a newer message of the owner or a message already waiting each cancel it. Decision (E2): an unknown outcome
   * never stops to ask. One and Work rooms, and a room that holds a Goal, all send through this path.
   */
  const directStarts = new Map<string, { event: IpcMainInvokeEvent; request: McpInvocationRequest }>();
  const DIRECT_STARTS_KEPT = 16;
  const rememberDirectStart = (runId: string | undefined, event: IpcMainInvokeEvent, request: McpInvocationRequest): void => {
    if (!runId || hasEarlierAttempt(request) || request.oneAttachmentRef || request.oneTeamPreflightRef || !canQueue(request)) return;
    directStarts.set(runId, { event, request });
    noteDirectStartKept(runId);
    while (directStarts.size > DIRECT_STARTS_KEPT) {
      const oldest = directStarts.keys().next().value as string;
      directStarts.delete(oldest);
      forgetDirectStartKept(oldest);
    }
  };
  const resendLostDirectRun = (envelope: InvocationSettledEnvelope): void => {
    const held = directStarts.get(envelope.runId);
    if (!held) return;
    directStarts.delete(envelope.runId);
    forgetDirectStartKept(envelope.runId);
    const { event, request } = held;
    const chatId = request.chatId;
    if (!unconfirmedRunShouldBeSentAgain(envelope.receipt)) return;
    // A turn proven in the conversation is not lost; only an unconfirmed placement is sent again.
    if (queuedSendPlacement(envelope.runId) !== "unconfirmed") return;
    if (queue.hasQueued(chatId)) return;
    const db = getDb();
    // The owner moved on: this is no longer the newest thing they said here.
    const newest = db.prepare("SELECT id, text, created_at AS createdAt FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(chatId) as { id: string; text: string; createdAt: string } | undefined;
    if (!newest || newest.text !== request.userPrompt) return;
    if (ownerStoppedChatSince(db, chatId, Date.parse(envelope.receipt.startedAt) || 0)) return;
    // A consumed preparation submission cannot be bound again; the message prepares as any other would.
    queue.enqueue(event, { ...request, preflightSubmissionId: undefined }, { userRow: { ...newest, role: "user" }, resentUnconfirmed: true, imagesByReference: true });
  };

  // A run that settles in this process decides its message at once (runs settled in the daemon are found by the poll).
  const offSettled=invocationService.onSettled((envelope) => {
    if (disposed) return;
    try { resumeCustodiedInputs(); queue.settleRun(envelope.runId); } catch { /* the poll decides it */ }
    try { resendLostDirectRun(envelope); } catch { /* the message and the run's own line remain */ }
  });

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
      const record = queue.enqueue(event, req, { ...(intentId ? { intentId } : {}), ...(cause === undefined ? {} : { cause }), imagesByReference: true });
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
    options.recoverFollowups?.((request,intentId,messageId) => {
      const userRow = messageId ? getDb().prepare("SELECT id,text,created_at AS createdAt FROM chat_messages WHERE id=? AND chat_id=? AND role='user' AND text=?")
        .get(messageId,request.chatId,request.userPrompt) : undefined;
      if (messageId && !userRow) throw new Error("followup_message_custody_missing");
      return queue.enqueue(undefined as unknown as IpcMainInvokeEvent,request,{intentId,requireUserRow:true,...(userRow ? {userRow} : {})});
    });
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
      // Only this queue marks a second send (earlier-attempt.ts); a request coming in from a window never carries the marker.
      delete (req as { earlierAttemptUncertain?: unknown }).earlierAttemptUncertain;
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
        try { return queuedAnswer(accept(event, req, undefined)); }
        // Images the transcript store would not take cannot be queued by reference; the start below refuses them on its own terms.
        catch (error) { if (!(error instanceof PendingSendImagesUnsaved)) throw error; }
      }
      return startOwnerSendOrAcceptRefusal(() => startOwned(event, req, null).then((started) => { rememberDirectStart(started?.runId, event, req); return started; }), (cause) => {
        if (!canQueue(req)) return null;
        if ((isTransientSendRefusal(cause) || undispatchedStartWaits(cause, req.runId))
          && (!req.oneAttachmentRef && !req.oneTeamPreflightRef || options.custody?.placement(req.runId!) === "not-dispatched")) {
          try { return queuedAnswer(noticeIfStillWaiting(accept(event,req,undefined,cause), req)); }
          // Images too big to queue inline that could not be tied to the transcript row's stored bytes (an invalid image): the
          // original refusal stands, as it did before such a message could queue at all.
          catch (error) { if (!(error instanceof PendingSendImagesUnsaved)) throw error; return null; }
        }
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
      let record: PendingSendRecord;
      try { record = queue.find(req.chatId, id) ?? accept(event, req, id, cause); }
      catch (error) { if (error instanceof PendingSendImagesUnsaved) return null; throw error; }
      return {
        accepted: true, chatId: req.chatId, queued: true, interruptsCurrent: false,
        queuedRequestId: `pending-send:${record.id}`, promptHash: record.promptHash, intentId: id, status: "queued",
      };
    },
    acceptCurrentTurnFallback(event, req, intentId, messageId) {
      if (!canQueue(req)) throw new Error("followup_fallback_requires_resource_capture");
      const userRow = messageId ? getDb().prepare("SELECT id,text,created_at AS createdAt FROM chat_messages WHERE id=? AND chat_id=? AND role='user' AND text=?")
        .get(messageId, req.chatId, req.userPrompt) as {id:string;text:string;createdAt:string}|undefined : undefined;
      if (messageId && !userRow) throw new Error("followup_message_custody_missing");
      // The caller owns the IMMEDIATE source-closure transaction. Both records
      // and the exact user row either commit together or all roll back.
      const record = queue.enqueue(event, req, { intentId, requireUserRow: true, imagesByReference: true, ...(userRow ? {userRow:{...userRow,role:"user"}} : {}) });
      options.onQueued?.(req);
      return record;
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
    currentTurnReceiptFor(chatId, intentId) {
      const record = queue.find(chatId, intentId);
      if (!record) return null;
      const userRow = record.userRow as { id?: string } | null;
      const origin = getDb().prepare("SELECT * FROM invocation_followup_custody WHERE intent_id=? AND chat_id=? AND queue_id=?")
        .get(intentId, chatId, record.id) as FollowupCapture | undefined;
      if (origin && (!options.followupAccountDigest || origin.account_digest !== options.followupAccountDigest(JSON.parse(origin.request_json) as McpInvocationRequest))) throw new Error("followup_owner_changed");
      return {
        chatId, intentId, runId: origin?.origin_run_id ?? "", promptHash: record.promptHash, messageId: userRow?.id ?? "",
        receiptVersion: 2, requestHash: origin?.request_hash ?? recordRequestHash(record),
        origin: origin ? { kind: "current-turn", runId: origin.origin_run_id } : { kind: "legacy-unconfirmed" },
        delivery: { kind: "next-turn", queueId: record.id, ...(record.runId ? {runId:record.runId} : {}) },
        status: record.state === "queued" ? "queued" : record.state === "starting" ? "dispatching"
          : record.state === "started" ? "applied" : record.state === "held" || record.state === "uncertain" ? "uncertain" : "rejected",
        messageCustody: messageCustody(record), ...(record.lastCode ? {code:record.lastCode} : {}),
      };
    },
  };
}

export { pendingSendPromptHash };
