/**
 * Room discussion runtime wiring (A4): connects the pure engine (room-discussion-core.ts) to the stores and to the
 * invocation service. Host-agnostic: nothing here imports electron, and every heavy dependency is loaded lazily, so
 * the same module runs in Main today and in the daemon once A1/A2 move room ownership there.
 *
 * Where a speaker runs: in the existing (member, room) child "division" session that team-dispatch also uses
 * (chats.parent_chat_id = the room, agent_id = the member), so the member's long-lived model thread is reused and
 * only the posts since its cursor are sent. Speakers are read-only talkers: no tools, no files.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { currentUiLocale } from "../ui-locale";
import type { OneDiscussionPostInput, OneDiscussionPostResult, OneDiscussionState } from "../../shared/one-discussion";
import {
  RoomDiscussionEngine, SpeakerCaps, type RoomMember, type RoomRoster, type SpeakerHandle, type SpeakerRunnerPort, type SpeakerSettled,
} from "./room-discussion-core";
import { createRoomDiscussionStore, type RoomDb } from "./room-discussion-store";

/** A speaker that has not settled after this long is cancelled and reported as `turn_timeout`. */
export const SPEAKER_TURN_TIMEOUT_MS = 6 * 60_000;

/** Services the wiring needs. Production resolves them lazily; the gates inject stubs. */
export interface RoomDiscussionServices {
  roster(chatId: string): RoomRoster | null;
  /** Room itself (not a speaker session) is running an ordinary turn. */
  roomBusy(chatId: string): boolean;
  chats: {
    appendChatMessage(chatId: string, role: "user" | "assistant", text: string, options?: { speakerAgentId?: string }): { id: string; createdAt: string };
    createChat(input: { agentId: string; title: string; originSurface: "one"; taskMode: "conversation"; kind: "division"; parentChatId: string }): { id: string };
    listChatMessages(chatId: string, limit?: number): Array<{ role: string; text: string; createdAt: string }>;
  };
  invocation: {
    activeChatIds(): string[];
    start(request: Record<string, unknown>): { runId: string };
    cancel(runId: string): unknown;
    onSettled(listener: (envelope: { runId: string; chatId: string; receipt: { status: string } }) => void): () => void;
  };
  slots(): { inUse: number; queued: number; limit: number };
  emit(chatId: string): void;
  db(): RoomDb;
  childChatFor(roomChatId: string, agentId: string): string | null;
  locale(): "ko" | "en";
}

function finalStatus(receiptStatus: string): SpeakerSettled["status"] {
  if (receiptStatus === "completed" || receiptStatus === "succeeded" || receiptStatus === "success") return "completed";
  if (receiptStatus === "cancelled") return "cancelled";
  if (receiptStatus === "interrupted") return "interrupted";
  return "failed";
}

function lastAssistantSince(services: RoomDiscussionServices, chatId: string, sinceMs: number): string | null {
  const messages = services.chats.listChatMessages(chatId, 12);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (Date.parse(message.createdAt) < sinceMs) break;
    if (message.role === "assistant" && message.text.trim()) return message.text.trim();
  }
  return null;
}

/** Speaker runner over the invocation service, one child session per (member, room). */
export function createSpeakerRunner(services: RoomDiscussionServices, options: { timeoutMs?: number } = {}): SpeakerRunnerPort {
  const waiting = new Map<string, (settled: SpeakerSettled) => void>();
  let unsubscribe: (() => void) | null = null;
  const ensureListener = () => {
    if (unsubscribe) return;
    unsubscribe = services.invocation.onSettled((envelope) => {
      const resolve = waiting.get(envelope.runId);
      if (!resolve) return;
      waiting.delete(envelope.runId);
      const status = finalStatus(envelope.receipt.status);
      resolve({ status, text: null, ...(status === "failed" ? { errorCode: "run_failed" } : {}) });
    });
  };

  return {
    start({ chatId, member, prompt, locale }) {
      ensureListener();
      let childChatId = services.childChatFor(chatId, member.agentId);
      if (!childChatId) {
        const roomTitle = services.roster(chatId)?.title ?? "";
        childChatId = services.chats.createChat({
          agentId: member.agentId, title: `${locale === "ko" ? "토론" : "Discussion"} · ${roomTitle}`.slice(0, 120),
          originSurface: "one", taskMode: "conversation", kind: "division", parentChatId: chatId,
        }).id;
      }
      if (services.invocation.activeChatIds().includes(childChatId)) {
        throw new Error("member_busy: that member's room session is working on something else");
      }
      const runId = randomUUID();
      const startedAt = Date.now();
      const child = childChatId;
      let settle!: (settled: SpeakerSettled) => void;
      const done = new Promise<SpeakerSettled>((resolve) => { settle = resolve; });
      waiting.set(runId, (settled) => {
        // Completion is published only after the answer body is durable, so the child session holds it by now.
        if (settled.status === "completed") {
          const text = lastAssistantSince(services, child, startedAt - 1_000);
          settle(text ? { status: "completed", text } : { status: "failed", text: null, errorCode: "empty_answer" });
        } else settle(settled);
      });
      try {
        services.invocation.start({
          runId, chatId: child, userPrompt: prompt, promptOrigin: "system", locale,
          permissions: "read", onePermissionMode: "read", taskIntent: "conversation", oneMode: true,
        });
      } catch (error) {
        waiting.delete(runId);
        throw error;
      }
      const timer = setTimeout(() => {
        if (!waiting.has(runId)) return;
        waiting.delete(runId);
        try { services.invocation.cancel(runId); } catch { /* the run may already be gone */ }
        settle({ status: "failed", text: null, errorCode: "turn_timeout" });
      }, options.timeoutMs ?? SPEAKER_TURN_TIMEOUT_MS);
      timer.unref?.();
      void done.finally(() => clearTimeout(timer));
      const handle: SpeakerHandle = {
        runId, childChatId: child, done,
        cancel: () => {
          try { services.invocation.cancel(runId); } catch { /* unconditional */ }
          // A run that never reached the model settles through onSettled; if it did not start, close the wait here.
          setTimeout(() => {
            const pending = waiting.get(runId);
            if (!pending) return;
            waiting.delete(runId);
            settle({ status: "cancelled", text: null });
          }, 3_000).unref?.();
        },
      };
      return handle;
    },
  };
}

export interface RoomDiscussionRuntime {
  engine: RoomDiscussionEngine;
  caps: SpeakerCaps;
  post(input: OneDiscussionPostInput): OneDiscussionPostResult;
  stop(chatId: string): { stopped: boolean };
  state(chatId: string): OneDiscussionState;
  setEnabled(chatId: string, enabled: boolean | null): OneDiscussionState;
  recover(): { closed: number; published: number; resumed: number };
}

/**
 * A group room is not a discussion floor: One runs the room (orchestrator, Goal, strategy, tactics, team dispatch)
 * and members work. Owner posts therefore never go to this engine unless a caller opts in explicitly (the gates do).
 * Production leaves it off; the code stays only for the thread index of rooms that already hold such messages.
 */
export const ROOM_DISCUSSION_ROUTING_DEFAULT = false;

export function createRoomDiscussionRuntime(services: RoomDiscussionServices, options: { timeoutMs?: number; hostId?: string; routing?: boolean } = {}): RoomDiscussionRuntime {
  const routing = options.routing ?? ROOM_DISCUSSION_ROUTING_DEFAULT;
  const store = createRoomDiscussionStore({
    db: services.db,
    appendChatMessage: services.chats.appendChatMessage,
    resolveName: (chatId, agentId) => services.roster(chatId)?.members.find((member) => member.agentId === agentId)?.name ?? null,
    hostId: options.hostId,
  });
  // Run slots held or awaited by anything other than a discussion speaker of this process.
  const ledger: { caps?: SpeakerCaps } = {};
  const caps: SpeakerCaps = ledger.caps = new SpeakerCaps({
    globalLimit: () => services.slots().limit,
    externalBusy: (): number => { const slots = services.slots(); return Math.max(0, slots.inUse + slots.queued - (ledger.caps?.count() ?? 0)); },
  });
  const engine = new RoomDiscussionEngine({
    log: store.log, state: store.state, caps, runner: createSpeakerRunner(services, { timeoutMs: options.timeoutMs }),
    roster: (chatId) => services.roster(chatId), roomBusy: (chatId) => services.roomBusy(chatId), emit: (chatId) => services.emit(chatId),
  });
  let recovered = false;
  const ensureRecovered = () => {
    if (recovered) return;
    recovered = true;
    try { engine.recover(); } catch (error) { console.warn("[room-discussion] recovery skipped:", error instanceof Error ? error.message : error); }
  };
  const stateOf = (chatId: string): OneDiscussionState => ({ ...engine.view(chatId), messages: store.messageMeta(chatId) });
  /**





 */
  const parkedStateOf = (chatId: string): OneDiscussionState => {
    const last = store.state.lastDiscussion(chatId);
    return {
      chatId, enabled: false, explicit: store.state.setting(chatId), memberCount: 0, active: null,
      last: last ? { discussionId: last.id, status: last.status, stopReason: last.stopReason, roundNo: last.roundNo } : null,
      messages: store.messageMeta(chatId),
    };
  };
  return {
    engine, caps,
    post(input) {
      if (!routing) return { handled: false, reason: "discussion_off" };
      ensureRecovered();
      return engine.post(input);
    },
    // Stop is unconditional in both modes; parked, it only closes a stale row (no loop runs in this process).
    stop(chatId) { if (routing) ensureRecovered(); return { stopped: engine.stop(chatId).stopped }; },
    state(chatId) {
      if (!routing) return parkedStateOf(chatId);
      ensureRecovered();
      return stateOf(chatId);
    },
    setEnabled(chatId, enabled) {
      if (!routing) { engine.setEnabled(chatId, enabled); return parkedStateOf(chatId); }
      ensureRecovered();
      engine.setEnabled(chatId, enabled);
      return stateOf(chatId);
    },
    recover() { recovered = true; return engine.recover(); },
  };
}

// ── Production services (lazy; Main today, daemon later) ────────────────────

function productionServices(): RoomDiscussionServices {
  const chats = () => require("../store/chats") as typeof import("../store/chats");
  const invocation = () => (require("../invocation/service") as typeof import("../invocation/service")).invocationService;
  return {
    roster(chatId) {
      const { listOneTaskforces } = require("./taskforces") as typeof import("./taskforces");
      const taskforce = listOneTaskforces().find((item) => item.chatId === chatId);
      if (!taskforce) return null;
      const { getOneOrgState } = require("./org") as typeof import("./org");
      const byAgent = new Map(getOneOrgState().members.filter((member) => !member.archivedAt).map((member) => [member.installedAgentId, member]));
      const members: RoomMember[] = [];
      for (const agentId of taskforce.memberAgentIds) {
        const member = byAgent.get(agentId);
        if (!member || member.statusKind === "locked" || member.statusKind === "failed") continue;
        members.push({ agentId, name: member.displayName, aliases: [member.nameEn, member.agentSlug].filter((value): value is string => Boolean(value)) });
      }
      return { title: taskforce.title, description: taskforce.description, members, locale: currentUiLocale() === "ko" ? "ko" : "en" };
    },
    roomBusy: (chatId) => invocation().activeChatIds().includes(chatId),
    chats: {
      appendChatMessage: (chatId, role, text, options) => {
        const entry = chats().appendChatMessage(chatId, role, text, options);
        return { id: entry.id, createdAt: entry.createdAt };
      },
      createChat: (input) => chats().createChat(input),
      listChatMessages: (chatId, limit) => chats().listChatMessages(chatId, limit),
    },
    invocation: {
      activeChatIds: () => invocation().activeChatIds(),
      start: (request) => invocation().start(request as never, undefined, undefined, undefined, "one-dispatch-brief"),
      cancel: (runId) => invocation().cancel(runId),
      onSettled: (listener) => invocation().onSettled(listener as never),
    },
    slots() {
      const { runSlotStats } = require("../runtime/run-slots") as typeof import("../runtime/run-slots");
      const stats = runSlotStats();
      return { inUse: stats.inUse, queued: stats.queued, limit: stats.limit };
    },
    emit: (chatId) => emitDesktopStoreChange({ entity: "chat", id: chatId }),
    db: () => getDb() as unknown as RoomDb,
    childChatFor(roomChatId, agentId) {
      const row = getDb().prepare(
        `SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND origin_surface = 'one'
            AND agent_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      ).get(roomChatId, agentId) as { id: string } | undefined;
      return row?.id ?? null;
    },
    locale: () => (currentUiLocale() === "ko" ? "ko" : "en"),
  };
}

let singleton: RoomDiscussionRuntime | null = null;

/** The process-wide runtime. One ledger per process keeps the per-member and global caps honest. */
export function roomDiscussion(): RoomDiscussionRuntime {
  if (!singleton) singleton = createRoomDiscussionRuntime(productionServices());
  return singleton;
}
