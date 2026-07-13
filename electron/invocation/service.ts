import { agentRunCwd } from "../runtime/exec";
import { resolveInvocationRunId } from "../runtime/run-id";
import {
  InvocationLifecycleRegistry,
  registerDurableInvocationStart,
} from "../runtime/invocation-lifecycle";
import { runMcpInvocation } from "../mcp/client";
import { pickLocale } from "../runtime/status-i18n";
import {
  getInvocationRunReceipt,
  getLatestInvocationRunReceipt,
  hasInvocationRunReceipt,
  recordMcpInvocationEvent,
  recordRunEvent,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "../store/run-events";
import { getProject } from "../store/projects";
import {
  appendChatMessage,
  getChat,
  getChatWorkingFolder,
  listChatMessages,
} from "../store/chats";
import type {
  InvocationRunReceipt,
  InvocationSteerResult,
  McpInvocationEvent,
  McpInvocationRequest,
} from "../../shared/types";

/** DESKTOP_MOBILE_BRIDGE: renderer IPC and Mobile Bridge share this authority. */
export interface InvocationEventEnvelope {
  runId: string;
  chatId: string;
  event: McpInvocationEvent;
}

export interface InvocationAttachResult {
  runId: string;
  events: McpInvocationEvent[];
  /** 실행 시작 시각(ISO) — 재접속한 렌더러가 상태줄 경과시간을 0s부터 다시 세지 않게 한다. */
  startedAt?: string;
}

export interface InvocationStartResult {
  runId: string;
}

interface RunRecord {
  controller: AbortController;
  chatId: string;
  startedAt: string;
  cancelRequestedAt: string | null;
  events: McpInvocationEvent[];
  partialText: string;
  resultFolder?: string;
  actualAgentId?: string;
}

type InvocationEventListener = (envelope: InvocationEventEnvelope) => void;
type ActiveChatsListener = (chatIds: string[]) => void;

const MAX_BUFFERED_EVENTS = 4_000;
const MAX_PARTIAL_CHARS = 2 * 1024 * 1024;
const MAX_STEER_QUEUE_DEPTH = 8;

class InvocationService {
  private readonly activeRuns = new InvocationLifecycleRegistry<RunRecord>();
  private readonly eventListeners = new Set<InvocationEventListener>();
  private readonly activeChatsListeners = new Set<ActiveChatsListener>();
  private readonly steerQueues = new Map<string, McpInvocationRequest[]>();

  onEvent(listener: InvocationEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onActiveChats(listener: ActiveChatsListener): () => void {
    this.activeChatsListeners.add(listener);
    return () => this.activeChatsListeners.delete(listener);
  }

  activeChatIds(): string[] {
    return this.activeRuns.activeChatIds();
  }

  start(req: McpInvocationRequest): InvocationStartResult {
    if (typeof req.runId === "string" && hasInvocationRunReceipt(req.runId)) {
      throw new Error("Invocation runId already has a durable receipt; use a new runId");
    }
    const runId = resolveInvocationRunId(
      req.runId,
      (candidate) => this.activeRuns.hasSeen(candidate) || hasInvocationRunReceipt(candidate),
    );
    const runReq: McpInvocationRequest = { ...req, runId };
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const chat = getChat(req.chatId);
    if (!chat) throw new Error("Chat not found");
    const projectFolder = chat.projectId ? getProject(chat.projectId)?.folderPath ?? null : null;
    const record: RunRecord = {
      controller,
      chatId: req.chatId,
      startedAt,
      cancelRequestedAt: null,
      events: [],
      partialText: "",
      resultFolder: getChatWorkingFolder(req.chatId) ?? projectFolder ?? agentRunCwd(),
    };

    registerDurableInvocationStart({
      registry: this.activeRuns,
      runId,
      record,
      publishActiveState: () => this.publishActiveChats(),
      persistStart: () => recordRunEvent({
        runId,
        kind: "invoke_started",
        chatId: runReq.chatId,
        payload: {
          permissions: runReq.permissions,
          toolMode: runReq.toolMode,
          hubMode: runReq.hubMode,
          borrowAgents: runReq.borrowAgents,
          hasImages: Boolean(runReq.images?.length),
          planMode: runReq.planMode,
          goalMode: runReq.goalMode,
          appsGenerateMode: runReq.appsGenerateMode,
        },
      }),
    });

    let terminalObserved = false;
    void runMcpInvocation(
      runReq,
      (rawEvent) => {
        const event: McpInvocationEvent =
          rawEvent.kind === "partial" &&
          typeof rawEvent.text === "string" &&
          rawEvent.text.length > MAX_PARTIAL_CHARS
            ? {
                ...rawEvent,
                text:
                  rawEvent.text.slice(0, MAX_PARTIAL_CHARS) +
                  (pickLocale(runReq) === "ko"
                    ? "\n\n[출력이 너무 길어 잘렸습니다 — 런어웨이 출력 메모리 보호]"
                    : "\n\n[Output truncated — runaway output memory guard]"),
              }
            : rawEvent;
        const attributedAgentId = event.runtimeAgentId ?? event.agentId;
        if (attributedAgentId) record.actualAgentId = attributedAgentId;

        let wireEvent = event;
        if (event.kind === "partial" && !event.agentId && typeof event.text === "string") {
          const full = event.text;
          const previous = record.partialText;
          const probe = Math.min(32, previous.length);
          const appended =
            full.length >= previous.length &&
            (probe === 0 || full.slice(previous.length - probe, previous.length) === previous.slice(-probe));
          if (appended) {
            const delta = full.slice(previous.length);
            if (!delta) return;
            wireEvent = { ...event, text: undefined, delta, textLen: full.length };
          } else {
            wireEvent = { ...event, textLen: full.length };
          }
          record.partialText = full;
        }

        const last = record.events[record.events.length - 1];
        // partial(누적 전문)과 usage(단조 카운터)는 마지막 값만 의미 있다 — 연속이 아니어도
        // 같은 kind의 직전 버퍼 항목을 교체해 버퍼가 고빈도 신호로 밀려나지 않게 한다.
        if (event.kind === "partial" && !event.agentId && last?.kind === "partial" && !last.agentId) {
          record.events[record.events.length - 1] = event;
        } else if (event.kind === "usage") {
          let prevUsageIdx = -1;
          for (let i = record.events.length - 1; i >= 0; i -= 1) {
            if (record.events[i].kind === "usage") {
              prevUsageIdx = i;
              break;
            }
          }
          if (prevUsageIdx >= 0) record.events[prevUsageIdx] = event;
          else record.events.push(event);
        } else {
          record.events.push(event);
        }
        if (record.events.length > MAX_BUFFERED_EVENTS) {
          record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
        }
        recordMcpInvocationEvent(runId, runReq, event);
        this.publishEvent({ runId, chatId: runReq.chatId, event: wireEvent });

        if (event.kind === "final" || event.kind === "error") {
          if (event.kind === "error" && controller.signal.aborted && record.partialText.trim()) {
            try {
              appendChatMessage(runReq.chatId, "assistant", record.partialText);
            } catch {
              // The durable run ledger still records terminal state.
            }
          }
          const terminalKind =
            event.kind === "final"
              ? "invoke_completed"
              : controller.signal.aborted
                ? "invoke_cancelled"
                : "invoke_failed";
          terminalObserved = true;
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: attributedAgentId ?? record.actualAgentId,
            payload: {
              resultFolder: record.resultFolder,
              errorCode: event.error?.code,
              errorMessage: event.error?.message,
            },
          });
          if (this.activeRuns.settle(runId)) this.publishActiveChats();
        }
      },
      controller.signal,
    )
      .then((result) => {
        record.resultFolder = result.resultFolder ?? record.resultFolder;
        tryRecordRunEvent({
          runId,
          kind: "invoke_result",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: {
            resultFolder: record.resultFolder,
            tokens: result.tokens,
            hasFinalText: Boolean(result.finalText?.trim()),
          },
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        tryRecordRunEvent({
          runId,
          kind: "invoke_threw",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: { errorMessage: message },
        });
        tryRecordFailureEvent({
          runId,
          source: "invoke",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          errorCode: "invoke_threw",
          errorMessage: message,
        });
        if (!terminalObserved) {
          terminalObserved = true;
          if (controller.signal.aborted && record.partialText.trim()) {
            try {
              appendChatMessage(runReq.chatId, "assistant", record.partialText);
            } catch {
              // Best effort. The final error remains visible over the event stream.
            }
          }
          const event: McpInvocationEvent = {
            kind: "error",
            runtimeAgentId: record.actualAgentId,
            error: {
              code: controller.signal.aborted ? "cancelled" : "invoke-threw",
              message,
            },
          };
          record.events.push(event);
          recordMcpInvocationEvent(runId, runReq, event);
          this.publishEvent({ runId, chatId: runReq.chatId, event });
          tryRecordRunEvent({
            runId,
            kind: controller.signal.aborted ? "invoke_cancelled" : "invoke_failed",
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: { resultFolder: record.resultFolder, errorMessage: message },
          });
        }
      })
      .finally(() => {
        if (!terminalObserved) {
          tryRecordRunEvent({
            runId,
            kind: controller.signal.aborted ? "invoke_cancelled" : "invoke_failed",
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: {
              resultFolder: record.resultFolder,
              errorMessage: "Runtime settled without a terminal event",
            },
          });
        }
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        this.drainSteerQueue(runReq.chatId);
      });

    return { runId };
  }

  cancel(runId: string): "requested" | "already-requested" | "not-found" {
    const result = this.activeRuns.requestCancel(runId);
    if (result === "requested") {
      const record = this.activeRuns.get(runId);
      tryRecordRunEvent({
        runId,
        kind: "invoke_cancel_requested",
        chatId: record?.chatId,
        payload: { requestedAt: record?.cancelRequestedAt },
      });
    }
    return result;
  }

  /** DESKTOP_MOBILE_BRIDGE: main owns steering so every client gets identical resume semantics. */
  steer(req: McpInvocationRequest, expectedRunId?: string): InvocationSteerResult {
    const active = [...this.activeRuns.entries()].find(([, record]) => record.chatId === req.chatId);
    if (expectedRunId && active?.[0] !== expectedRunId) {
      throw new Error("Steering target is stale; attach to the current Desktop run and retry");
    }
    if (!active) {
      return { accepted: true, queued: false, runId: this.start({ ...req, runId: undefined }).runId };
    }
    const queue = this.steerQueues.get(req.chatId) ?? [];
    if (queue.length >= MAX_STEER_QUEUE_DEPTH) {
      throw new Error("Steering queue is full; wait for the current Desktop run to settle");
    }
    queue.push({ ...req, runId: undefined });
    this.steerQueues.set(req.chatId, queue);
    this.cancel(active[0]);
    return {
      accepted: true,
      queued: true,
      activeRunId: active[0],
      position: queue.length,
    };
  }

  attach(chatId: string): InvocationAttachResult | null {
    let found: InvocationAttachResult | null = null;
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId === chatId) {
        found = { runId, events: record.events.slice(), startedAt: record.startedAt };
      }
    }
    return found;
  }

  receipt(runId: string): InvocationRunReceipt | null {
    const record = this.activeRuns.get(runId);
    const durable = getInvocationRunReceipt(runId);
    if (!record) return durable;
    return {
      ...(durable ?? {
        runId,
        chatId: record.chatId,
        startedAt: record.startedAt,
        updatedAt: record.startedAt,
        eventCount: record.events.length,
      }),
      status: record.cancelRequestedAt ? "cancelling" : "running",
      updatedAt: record.cancelRequestedAt ?? durable?.updatedAt ?? record.startedAt,
      eventCount: Math.max(durable?.eventCount ?? 0, record.events.length),
      ...(record.resultFolder ? { resultFolder: record.resultFolder } : {}),
    };
  }

  latestReceipt(chatId: string): InvocationRunReceipt | null {
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId === chatId) return this.receipt(runId);
    }
    return getLatestInvocationRunReceipt(chatId);
  }

  history(chatId: string) {
    return listChatMessages(chatId);
  }

  private publishEvent(envelope: InvocationEventEnvelope): void {
    for (const listener of this.eventListeners) {
      try {
        listener(envelope);
      } catch {
        // A renderer or phone disconnect must never break the host run.
      }
    }
  }

  private publishActiveChats(): void {
    const chatIds = this.activeChatIds();
    for (const listener of this.activeChatsListeners) {
      try {
        listener(chatIds);
      } catch {
        // Projection listeners are isolated from execution authority.
      }
    }
  }

  private drainSteerQueue(chatId: string): void {
    const queue = this.steerQueues.get(chatId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) this.steerQueues.delete(chatId);
    if (!next) return;
    queueMicrotask(() => {
      try {
        this.start(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.publishEvent({
          runId: "steer",
          chatId,
          event: { kind: "error", error: { code: "steer-start-failed", message } },
        });
      }
    });
  }
}

export const invocationService = new InvocationService();
