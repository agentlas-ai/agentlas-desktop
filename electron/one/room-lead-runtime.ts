import { getDb } from "../store/db";
import { randomUUID } from "node:crypto";
import { roomMemberSessionIds } from "../store/room-purge";
import { clearLeadRequestOpen, isLeadRoom, leadRequestHolderAlive, leadRequestStopMarked, markLeadRequestOpen, markLeadRequestResumed, markLeadRoom, openLeadRequests, requestLeadRequestStop } from "../runtime/session-scope";
import { buildPeerEnvelope } from "../harness/peer-envelope";
import { withEarlierAttempt } from "../invocation/earlier-attempt";
import { withMemberQueueReporter } from "../runtime/run-priority";
import { createTurnWatch, type TurnWatch } from "./room-turn-watch";
import { OUTER_SILENCE_CODE, outerSilenceLimitMs } from "../invocation/outer-silence";
import type { RoomDb } from "./room-discussion-store";
import { createRoomDiscussionStore } from "./room-discussion-store";
import type { McpInvocationRequest } from "../../shared/types";
import { markOwnerSpoke } from "../invocation/owner-spoke";
import { BUSY_OTHER_HOST_FAILURE, createLeadRouter, planLeadResume, type LeadMember, type LeadPermission, type LeadRouter, type LeadRouterPorts, type TurnResult } from "./room-lead-router";

/*
 * Production wiring of the lead router and the one function every owner-input route calls.
 * Lazy requires keep the module cheap to load from the invocation service. A turn is an ordinary invocation of the member's own
 * (member, room) child session; its answer is read back from that session and posted to the room.
 */

/** The word of a turn whose run the invocation service no longer holds and never settled (found by the liveness look in room-turn-watch.ts, not by time). */
export const ROOM_TURN_LOST_CODE = "room_turn_lost";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A caller's run id is used only when the invocation service would accept it; anything else gets a fresh one (never a turn that cannot start). */
const usableRunId = (value: unknown): string | undefined => (typeof value === "string" && UUID_RE.test(value) ? value : undefined);

export interface OwnerRoomMessage {
  chatId?: unknown; userPrompt?: unknown; promptOrigin?: unknown; agentAppMode?: unknown; runId?: unknown;
  permissions?: unknown; onePermissionMode?: unknown; images?: unknown; fileGroupId?: unknown;
  /** The composer's pick for this line: the turn's agent list as orchestration targets (renderer lib/composer-agent-pick.ts). */
  taskForceTargets?: unknown;
  /** The composer's id for this send. */
  clientIntentId?: unknown;
}

/** The agent ids of the composer's pick (`taskForceTargets`): agent targets only; a team/firm target is not a member of this room. */
export function pickedAgentIdsOf(req: Pick<OwnerRoomMessage, "taskForceTargets">): string[] {
  if (!Array.isArray(req.taskForceTargets)) return [];
  const ids: string[] = [];
  for (const target of req.taskForceTargets as Array<{ entityKind?: unknown; agentId?: unknown }>) {
    if (target && target.entityKind === "agent" && typeof target.agentId === "string" && target.agentId && !ids.includes(target.agentId)) ids.push(target.agentId);
  }
  return ids;
}

function permissionOf(req: OwnerRoomMessage): LeadPermission {
  const raw = req.onePermissionMode ?? req.permissions;
  return raw === "read" || raw === "write" || raw === "full" ? raw : "write";
}

function productionPorts(): LeadRouterPorts {
  const chats = () => require("../store/chats") as typeof import("../store/chats"); // eslint-disable-line @typescript-eslint/no-require-imports
  const invocation = () => (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
  const locale = (): "ko" | "en" => ((require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en"); // eslint-disable-line @typescript-eslint/no-require-imports
  const store = () => createRoomDiscussionStore({
    db: () => getDb() as unknown as RoomDb,
    appendChatMessage: (chatId, _role, text, options) => { const entry = chats().appendChatMessage(chatId, "assistant", text, { speakerAgentId: options?.speakerAgentId ?? "", noGoalResult: true }); return { id: entry.id, createdAt: entry.createdAt }; },
  });
  const waiting = new Map<string, (result: TurnResult) => void>();
  /** The running-time clock of each turn (it does not run while the turn waits for a run slot). */
  const watches = new Map<string, TurnWatch>();
  let off: (() => void) | null = null;
  let offEvents: (() => void) | null = null;
  const listen = () => {
    if (!offEvents) offEvents = invocation().onEvent((envelope: { runId: string; event: { activity?: { code?: string } } }) => { watches.get(envelope.runId)?.event(envelope.event?.activity?.code); });
    if (off) return;
    off = invocation().onSettled((envelope: { runId: string; receipt: { status: string } }) => {
      const resolve = waiting.get(envelope.runId);
      if (!resolve) return;
      waiting.delete(envelope.runId);
      const status = envelope.receipt.status;
      // The run's own typed failure (a provider limit, an exhausted plan) rides with the result so the router can wait and try again.
      const failure = (envelope.receipt as { runtimeFailure?: { kind?: string; retryAfterAt?: string } }).runtimeFailure;
      // The run's own closed words ride with the failure so the room line can say why (the same reading work/session-dispatch.ts uses): the code behind an unfinished turn, else its own, else the receipt's.
      const rec = envelope.receipt as { errorCode?: string; runtimeFailure?: { providerCode?: string; cause?: { providerCode?: string } } };
      const word = [rec.runtimeFailure?.cause?.providerCode, rec.runtimeFailure?.providerCode, rec.errorCode].find((value): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,96}$/.test(value));
      // The member's chat is held by a turn of the OTHER process (the background service): nothing ran, and it ends by itself (defect 17).
      const heldByOtherHost = (envelope.receipt as { errorCode?: string }).errorCode === "invocation_chat_busy_other_host";
      resolve({
        status: status === "completed" || status === "succeeded" || status === "success" ? "completed" : status === "cancelled" ? "cancelled" : "failed", text: null,
        ...(heldByOtherHost ? { failure: { kind: BUSY_OTHER_HOST_FAILURE } }
          : failure && typeof failure.kind === "string" ? { failure: { kind: failure.kind, ...(typeof failure.retryAfterAt === "string" ? { retryAfterAt: failure.retryAfterAt } : {}), ...(word ? { code: word } : {}) } }
          : status === "completed" || status === "succeeded" || status === "success" || status === "cancelled" || !word ? {} : { failure: { kind: "failed", ...(word ? { code: word } : {}) } }),
      });
    });
  };
  const childChatFor = (roomChatId: string, agentId: string): string | null => {
    const row = getDb().prepare(
      `SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND origin_surface = 'one' AND agent_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC LIMIT 1`).get(roomChatId, agentId) as { id: string } | undefined;
    return row?.id ?? null;
  };
  /** The newest answer of a child session. A turn's answer is the one that was not there before the turn started (a clock could not tell
   *  a new answer from the previous one posted a moment earlier). */
  const lastAnswer = (chatId: string): { id: string; text: string } | null => {
    const messages = chats().listChatMessages(chatId, 12);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant" && message.text.trim()) return { id: message.id, text: message.text.trim() };
    }
    return null;
  };
  return {
    db: () => getDb() as unknown as RoomDb,
    roster(roomChatId) {
      const taskforce = (require("./taskforces") as typeof import("./taskforces")).listOneTaskforces().find((item) => item.chatId === roomChatId); // eslint-disable-line @typescript-eslint/no-require-imports
      if (!taskforce) return null;
      const byAgent = new Map((require("./org") as typeof import("./org")).getOneOrgState().members.filter((member) => !member.archivedAt).map((member) => [member.installedAgentId, member])); // eslint-disable-line @typescript-eslint/no-require-imports
      const members: LeadMember[] = [];
      for (const agentId of taskforce.memberAgentIds) {
        const member = byAgent.get(agentId);
        if (!member || member.statusKind === "locked") continue;
        members.push({ agentId, name: member.displayName, aliases: [member.nameEn, member.agentSlug].filter((value): value is string => Boolean(value)), ...(member.source === "hub" ? { callOnly: true } : {}) });
      }
      return { title: taskforce.title, members };
    },
    appendOwnerLine(roomChatId, text, extra) {
      const entry = chats().appendChatMessage(roomChatId, "user", text, { ...(Array.isArray(extra.images) && extra.images.length ? { images: extra.images as never } : {}), ...(extra.fileGroupId ? { fileGroupId: extra.fileGroupId } : {}), ...(extra.clientIntentId ? { clientIntentId: extra.clientIntentId } : {}) });
      return { id: entry.id };
    },
    appendMemberPost(roomChatId, member, text, replyTo) {
      const written = store().log.appendMemberPost(roomChatId, { speaker: { agentId: member.agentId, name: member.name, aliases: [] }, text, kind: "post", replyTo, discussionId: null, roundNo: null });
      return { messageId: written.messageId, seq: written.seq };
    },
    appendSystemLine(roomChatId, text) {
      try { chats().appendChatMessage(roomChatId, "assistant", text, { noGoalResult: true }); } catch { /* the room may be gone */ }
      (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id: roomChatId }); // eslint-disable-line @typescript-eslint/no-require-imports
    },
    appendPeerLine(roomChatId, text) {
      const entry = chats().appendChatMessage(roomChatId, "assistant", text, { noGoalResult: true });
      return { id: entry.id };
    },
    hadInterruptedTurn(roomChatId, member) {
      const child = childChatFor(roomChatId, member.agentId);
      const latest = child ? invocation().latestReceipt(child) as ({ status?: string; hostStopCause?: string } | null | undefined) : null;
      return Boolean(latest && (latest.status === "interrupted" || ["app_closed", "app_shutdown", "update_restart"].includes(String(latest.hostStopCause ?? ""))));
    },
    bindOwnerPrompt(roomChatId, ownerMessageId, runId) {
      (require("../store/run-events") as typeof import("../store/run-events")).tryRecordRunEvent({ runId, chatId: roomChatId, kind: "invoke_prompt_bound", payload: { promptMessageId: ownerMessageId } }); // eslint-disable-line @typescript-eslint/no-require-imports
    },
    cancelRun(runId) {
      // The run is stopped wherever it is (running, or waiting for a slot). Whatever the invocation service answers, the turn's wait
      // ends here: a cancel that finds no run (it never started, or already ended) must not leave the router waiting on a turn.
      try { invocation().cancel(runId); } catch { /* may already be gone */ }
      const resolve = waiting.get(runId);
      if (resolve) { waiting.delete(runId); resolve({ status: "cancelled", text: null }); }
      // The room's request was stopped: a chain of messages this turn started goes with it (harness/peer-chain-stop.ts). Not waited for.
      try { void (require("../harness/peer-chain-runtime") as typeof import("../harness/peer-chain-runtime")).stopPeerChainsOfRun(runId); } catch { /* the room's own Stop has been done */ } // eslint-disable-line @typescript-eslint/no-require-imports
    },
    markOpen: (roomChatId, ownerMessageId, extra) => markLeadRequestOpen(getDb(), roomChatId, ownerMessageId, Date.now(), undefined, extra),
    clearOpen: (roomChatId, ownerMessageIds) => clearLeadRequestOpen(getDb(), roomChatId, ownerMessageIds),
    stopMarked: (roomChatId, ownerMessageIds) => leadRequestStopMarked(getDb(), roomChatId, ownerMessageIds),
    stopEpoch: (roomChatId) => chats().getChatStopEpoch(roomChatId),
    emit: (roomChatId) => (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id: roomChatId }), // eslint-disable-line @typescript-eslint/no-require-imports
    locale,
    async runTurn({ roomChatId, member, prompt, permission, runId, extra, ownerSpoke, chainId, earlierAttempt }) {
      listen();
      // The room's own session scope is what keeps a member's turn out of the agent's other conversations. If it cannot be bound the turn
      // does NOT run on the agent's shared seat session (that would silently drop the isolation): one more try, then the turn fails
      // with a plain line in the room.
      {
        const bind = () => (require("../runtime/session-scope") as typeof import("../runtime/session-scope")).bindOneTaskforceSessionScope(getDb(), roomChatId); // eslint-disable-line @typescript-eslint/no-require-imports
        try { bind(); } catch (first) {
          try { bind(); } catch (second) {
            console.warn("[room-lead] the room's session scope could not be bound:", second instanceof Error ? second.message : String(second ?? first));
            throw Object.assign(new Error("room_session_scope_unavailable"), { code: "room_session_scope_unavailable" });
          }
        }
      }
      let child = childChatFor(roomChatId, member.agentId);
      const room = chats().getChat(roomChatId);
      if (!child) {
        child = chats().createChat({ agentId: member.agentId, title: `${locale() === "ko" ? "그룹" : "Group"} · ${room?.title ?? ""}`.slice(0, 120), originSurface: "one", taskMode: "conversation", kind: "division", parentChatId: roomChatId }).id;
        try { (require("../store/capability-grants") as typeof import("../store/capability-grants")).grantChatAlwaysApproval(child, "one-delegation"); } catch { /* the turn still runs; only its Always allow mark is missing */ } // eslint-disable-line @typescript-eslint/no-require-imports
      }
      const childId = child;
      const answerBefore = lastAnswer(childId)?.id ?? null;
      let settle!: (result: TurnResult) => void;
      const done = new Promise<TurnResult>((resolve) => { settle = resolve; });
      waiting.set(runId, (result) => {
        if (result.status !== "completed") return settle(result); // keeps the typed failure
        const answer = lastAnswer(childId);
        settle(answer && answer.id !== answerBefore ? { status: "completed", text: answer.text } : { status: "failed", text: null });
      });
      // The room's chosen model applies to its members unless a member carries its own (the same rule as a hand-off from the personal agent).
      let runtimeSelection: unknown;
      try {
        const override = (require("../store/agent-runtime-overrides") as typeof import("../store/agent-runtime-overrides")).getAgentRuntimeOverride("agent", member.agentId); // eslint-disable-line @typescript-eslint/no-require-imports
        runtimeSelection = override ? undefined : room?.runtimeSelection ?? undefined;
      } catch { runtimeSelection = undefined; }
      // A room in a project runs its members where the room runs (its folder, else the project's); a child session has neither of its own.
      let binding: import("../invocation/workspace-binding").InvocationWorkspaceBinding | undefined;
      try {
        const captured = (require("../invocation/workspace-binding") as typeof import("../invocation/workspace-binding")).captureMobileOneInvocationBinding(roomChatId); // eslint-disable-line @typescript-eslint/no-require-imports
        if (captured.canonicalPath) binding = captured;
      } catch { binding = undefined; }
      // A room with no folder of its own works in a folder of its own (agent-cwd/<room id>), not the one folder every such room of every
      // agent shares. It is removed with the room (store/chats.ts removeChat). Nothing in the shared folder is touched.
      if (!binding) {
        try { binding = (require("../runtime/room-member-cwd") as typeof import("../runtime/room-member-cwd")).roomMemberBinding(roomChatId) ?? undefined; } catch { binding = undefined; } // eslint-disable-line @typescript-eslint/no-require-imports
      }
      // The clock exists (and listens) before the run is handed over, so a queue signal that arrives at once is not missed.
      // The limit is the runner's own silence limit (it follows the runner, it is not a number of the room); a run the service no longer holds ends by that fact.
      const endTurn = (code: string) => () => {
        if (!waiting.has(runId)) return;
        waiting.delete(runId);
        try { invocation().cancel(runId); } catch { /* may already be gone */ }
        settle({ status: "failed", text: null, failure: { kind: "timeout", code } });
      };
      const watch = createTurnWatch({
        timeoutMs: outerSilenceLimitMs(),
        onTimeout: endTurn(OUTER_SILENCE_CODE),
        isLive: () => invocation().activeRunIds().includes(runId),
        onLost: endTurn(ROOM_TURN_LOST_CODE),
      });
      watches.set(runId, watch);
      watch.start();
      try {
        const request = {
          runId, chatId: childId, userPrompt: prompt, promptOrigin: "system", locale: locale(), permissions: permission, onePermissionMode: permission,
          taskIntent: "conversation", oneMode: true,
          ...(runtimeSelection ? { runtimeSelection: runtimeSelection as never } : {}),
          ...(Array.isArray(extra.images) && extra.images.length ? { images: extra.images as never } : {}),
          ...(extra.fileGroupId ? { fileGroupId: extra.fileGroupId } : {}),
          // A turn of a request another conversation opened carries that chain (a Stop of the chain reaches it, harness/peer-chain.ts).
          ...(chainId ? { peerChain: { id: chainId, from: roomChatId } } : {}),
        } as never as McpInvocationRequest;
        // The member's first turn of a request answers the line the owner wrote in the room: the owner spoke (#3). A turn another member started with an `@` does not.
        // A turn of a request a message from another conversation opened, and a turn run again after a restart, is never the owner's word: no marker is set for them.
        if (ownerSpoke === true) markOwnerSpoke(request, { answersOwnerMessage: true });
        const startRequest = earlierAttempt ? withEarlierAttempt(request as never) : request;
        withMemberQueueReporter((queued) => watch.setQueued(queued), () => invocation().start(startRequest as never, binding, undefined, undefined, "one-dispatch-brief"));
      } catch (error) {
        waiting.delete(runId);
        watch.stop(); watches.delete(runId);
        throw error;
      }
      return done.finally(() => { watch.stop(); watches.delete(runId); });
    },
  };
}

let ports: LeadRouterPorts | null = null;
let router: LeadRouter | null = null;
/** A gate injects its own ports; the product never calls this. */
export function setLeadRouterPortsForTest(next: LeadRouterPorts | null): void { ports = next; router = null; }
function leadRouter(): LeadRouter {
  if (!router) router = createLeadRouter(ports ?? productionPorts());
  return router;
}

/**
 * Whether this chat is a group room run under the lead model. A marked room is one. A group room made BEFORE the lead model has no
 * mark and is taken over here, when it is opened or its next message arrives (no backfill, nothing is rewritten ahead of time): the
 * mark is written once and the room runs as a lead room from then on. A room whose chat is running a turn right now keeps that turn
 * (it is never cut off); it is taken over at the first message after the turn ends.
 */
export function isLeadRoomChat(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  try {
    const db = getDb();
    if (isLeadRoom(db, chatId)) return true;
    const group = db.prepare("SELECT 1 AS present FROM one_taskforces WHERE chat_id = ?").get(chatId) as { present: number } | undefined;
    if (!group) return false;
    const chat = db.prepare("SELECT origin_surface AS surface, kind, archived_at AS archivedAt, seat_id AS seatId FROM chats WHERE id = ?").get(chatId) as { surface: string | null; kind: string; archivedAt: string | null; seatId: string | null } | undefined;
    if (!chat || chat.kind !== "user" || chat.surface !== "one" || chat.archivedAt) return false;
    try { if ((require("./personal-agent-rooms") as typeof import("./personal-agent-rooms")).isPersonalAgentRoom(chatId, db)) return false; } catch { /* no such table: not a supervised room */ } // eslint-disable-line @typescript-eslint/no-require-imports
    if (activeChatIds().includes(chatId)) return false; // the old turn in progress finishes the old way
    // A teammate the personal agent delegated to from this room, still working: its report comes back the old way (to the room chat,
    // through the personal agent). Taking the room over now would turn that report away, so it is taken over after the job ends.
    if (delegationsRunning(db, chatId)) return false;
    if (!ports && !leadRouterHasMembers(chatId)) return false;
    markLeadRoom(db, chatId);
    return true;
  } catch { return false; }
}
/**
 * A teammate job this room's chat delegated (one_team_dispatches.parent_chat_id) that is still working, or finished and not yet
 * reported back. Only recent rows count (6 hours): a row an old crash left behind must not keep a room from being taken over for ever.
 * A store without the table has none.
 */
const DELEGATION_WINDOW_MS = 6 * 60 * 60_000;
function delegationsRunning(db: ReturnType<typeof getDb>, chatId: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM one_team_dispatches WHERE parent_chat_id = ? AND updated_at > ?
          AND (status = 'running' OR (reported_at IS NULL AND status IN ('completed', 'succeeded', 'failed'))) LIMIT 1`)
      .get(chatId, new Date(Date.now() - DELEGATION_WINDOW_MS).toISOString()));
  } catch { return false; }
}
const activeChatIds = (): string[] => { try { return (require("../invocation/service") as typeof import("../invocation/service")).invocationService.activeChatIds(); } catch { return []; } }; // eslint-disable-line @typescript-eslint/no-require-imports
/** A room with nobody able to answer is not taken over: the old way keeps it (nothing would run otherwise). */
function leadRouterHasMembers(chatId: string): boolean { const roster = (ports ?? productionPorts()).roster(chatId); return Boolean(roster && roster.members.length > 0); }

/**
 * The one function every owner-input route calls before it would start a turn on a room chat. Returns the run id of the first turn
 * when the message was taken by the lead router, or null when the chat is not a lead room (the route goes on as before). The room
 * chat itself never runs a turn. A system-origin start (a follow-up, a goal continuation) and an agent-app turn are not owner
 * messages and are not routed. A message of pictures or files only is a message too: the attachments are posted as the owner's line
 * and the lead takes it (an empty message with nothing attached is ignored, and still never runs on the room chat).
 */
export function routeLeadRoomOwnerMessage(req: OwnerRoomMessage | null | undefined, origin: "owner" | "peer" = "owner", ownerTyped?: boolean): { runId: string } | null {
  if (!req || typeof req.chatId !== "string" || req.promptOrigin === "system" || req.agentAppMode === true) return null;
  if (!isLeadRoomChat(req.chatId)) return null;
  const text = typeof req.userPrompt === "string" ? req.userPrompt : "";
  const hasFiles = (Array.isArray(req.images) && req.images.length > 0) || (typeof req.fileGroupId === "string" && req.fileGroupId.length > 0);
  // An empty message with nothing attached used to be "taken" under a new run id that nothing ever ran, and a caller waiting for that run waited for ever
  // (desktop 3, B-11). It is a refusal with a code now; the composer and the phone never send one, so no screen changes.
  if (!text.trim() && !hasFiles) throw Object.assign(new Error("A message needs words or an attachment."), { code: "room_message_empty" });
  const result = leadRouter().post({
    chatId: req.chatId, text, origin, permission: permissionOf(req), pickedAgentIds: pickedAgentIdsOf(req),
    // The turns that answer this line are system-origin by design; whether the owner WROTE the line is the entry's fact: the composer says so (`ownerTyped`), every
    // other route carries the marker its own owner channel set (invocation/owner-spoke.ts). A line another member posted is never routed here (origin "peer").
    ownerSpoke: origin === "owner" && (ownerTyped ?? (req as { ownerSpoke?: unknown }).ownerSpoke === true),
    ...(usableRunId(req.runId) ? { runId: usableRunId(req.runId)! } : {}), images: req.images, ...(typeof req.fileGroupId === "string" ? { fileGroupId: req.fileGroupId } : {}), ...(typeof req.clientIntentId === "string" ? { clientIntentId: req.clientIntentId } : {}),
  });
  if (result.handled) return { runId: result.runId };
  // Desktop repair 6 (area 4, a room whose members are all locked): nobody can answer and the old way let the ROOM CHAT's own agent (not a member) take the message. A lock ends by an owner action (a renewed
  // lease, a replaced member), so this is not "read only" (that is for a room nobody can ever answer): the owner gets a coded refusal that ends the moment one member is unlocked.
  if (roomHasOnlyLockedMembers(req.chatId)) throw Object.assign(new Error("Every member of this room is locked right now, so nobody can answer. Unlock or replace a member to keep going."), { code: ROOM_MEMBERS_LOCKED_CODE });
  return null;
}

/** The machine code of a message to a group room whose live members are all locked. */
export const ROOM_MEMBERS_LOCKED_CODE = "room_members_locked" as const;
/** A group room with at least one live (un-archived) member, every one of whom is locked (an expired lease, a seat that needs replacing). Read only when the router found nobody to answer, so the common path never pays for it. */
function roomHasOnlyLockedMembers(chatId: string): boolean {
  try {
    const taskforce = (require("./taskforces") as typeof import("./taskforces")).listOneTaskforces().find((item) => item.chatId === chatId); // eslint-disable-line @typescript-eslint/no-require-imports
    if (!taskforce) return false;
    const byAgent = new Map((require("./org") as typeof import("./org")).getOneOrgState().members.filter((member) => !member.archivedAt).map((member) => [member.installedAgentId, member])); // eslint-disable-line @typescript-eslint/no-require-imports
    const live = taskforce.memberAgentIds.map((id) => byAgent.get(id)).filter((member): member is NonNullable<typeof member> => Boolean(member));
    return live.length > 0 && live.every((member) => member.statusKind === "locked");
  } catch { return false; }
}

/**
 * Why a message the personal agent writes into this conversation (one_chat_send) cannot be answered: a closed word, or null. The personal agent's message is
 * system-written, so the owner's guards (assertOwnerMayWriteRoom, and the locked-members refusal of routeLeadRoomOwnerMessage) do not run for it; it asks the same
 * two questions here, so a room nobody can answer is a refusal on the receipt and never a turn on the room chat itself. Agentlas 2.0 D7. The personal-agent-room half of
 * assertOwnerMayWriteRoom is not asked: the personal agent's own writes into its rooms are legitimate.
 */
export function personalAgentSendRefusal(chatId: string): "agent_deleted" | "no_members" | typeof ROOM_MEMBERS_LOCKED_CODE | null {
  let reason: string | null = null;
  try { reason = (require("./agent-chat-state") as typeof import("./agent-chat-state")).agentChatState(chatId).reason; } catch { reason = null; } // eslint-disable-line @typescript-eslint/no-require-imports
  if (reason === "agent_deleted" || reason === "no_members") return reason;
  return isLeadRoomChat(chatId) && roomHasOnlyLockedMembers(chatId) ? ROOM_MEMBERS_LOCKED_CODE : null;
}

/**
 * A message another conversation of the project sent into a lead room (harness/deliver.ts): the room's lead takes it. Returns the run id
 * of the lead's first turn, or null when the chat is no lead room or cannot take it (the caller says so; nothing is half done).
 * The text is not the owner's: it is written in the room as a line that is not an owner post and the turn that answers it is a system turn.
 */
export function routeLeadRoomPeerMessage(input: { chatId: string; body: string; envelope: string; fromLabel: string; fromKind: "session" | "room"; chainId: string; permission?: LeadPermission; runId?: string }): { runId: string } | null {
  if (!isLeadRoomChat(input.chatId)) return null;
  const result = leadRouter().postPeer(input);
  return result.handled ? { runId: result.runId } : null;
}

/** Used by gates: wait for the chain of the last post. */
export function leadRouterForTest(): LeadRouter { return leadRouter(); }

/** What `recoverInterruptedLeadRooms` reads and writes (a gate injects its own). */
export interface LeadRecoveryDeps {
  db: ReturnType<typeof getDb>;
  activeChatIds(): string[];
  /** Does another process (the background service) hold a live run lease on one of these chats? Then it is still answering. */
  otherHostHolds(chatIds: string[]): boolean;
  /** Is the process that wrote the open-request row (not this one) still running? Then the request is still being answered, between two turns. */
  holderAlive?(holder: { pid: number; pstart: number | null }): boolean;
  getChat(id: string): { archivedAt?: string | null } | null;
  lastMessage(id: string): { role: string } | undefined;
  say(id: string, text: string): void;
  ko(): boolean;
  /**
   * What a cut-off request still owes (Agentlas 2.0 N5), from the room's record and the members' read positions; null when it cannot be
   * worked out (no such post, no roster): the request then ends the older way. Absent: no request is continued.
   */
  plan?(chatId: string, request: { ownerMessageId: string; peer: boolean; chain: string | null }): { steps: ReadonlyArray<{ member: LeadMember; trigger: string }>; permission: LeadPermission; peerText: string | null } | null;
  /** Starts the remaining turns (router.resume). True when they started. */
  resume?(input: { chatId: string; ownerMessageId: string; permission: LeadPermission; chain: string | null; peerText: string | null; steps: ReadonlyArray<{ member: LeadMember; trigger: string }> }): boolean;
}

/** The room's own record and cursors, read the way the router reads them (no write besides the one-time seq index of an older room). */
function productionPlan(db: ReturnType<typeof getDb>, chatId: string, request: { ownerMessageId: string; peer: boolean }): { steps: Array<{ member: LeadMember; trigger: string }>; permission: LeadPermission; peerText: string | null } | null {
  const roster = (ports ?? productionPorts()).roster(chatId);
  if (!roster || roster.members.length === 0) return null;
  const store = createRoomDiscussionStore({ db: () => db as unknown as RoomDb, appendChatMessage: () => { throw new Error("room_recovery_is_read_only"); } });
  const root = store.log.postByMessageId(chatId, request.ownerMessageId);
  if (!root) return null;
  const posts = store.log.listPosts(chatId, { afterSeq: root.seq - 1, uptoSeq: store.log.maxSeq(chatId) });
  const steps = planLeadResume({
    rootMessageId: request.ownerMessageId, peer: request.peer, members: roster.members,
    posts: posts.map((post) => ({ seq: post.seq, messageId: post.messageId, author: post.author, speakerAgentId: post.speakerAgentId ?? null, text: post.text })),
    cursorOf: (agentId) => store.state.cursor(chatId, agentId),
  });
  // The request's own permission was written into its row; a row without it (an older build) continues as the owner's default.
  let permission: LeadPermission = "write";
  try { const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`room-lead-open:${chatId}`) as { value: string } | undefined; const perm = (JSON.parse(row?.value ?? "{}") as { perm?: unknown }).perm; if (perm === "read" || perm === "write" || perm === "full") permission = perm; } catch { /* the default */ }
  return { steps, permission, peerText: request.peer ? peerTextOfLine(root.text) : null };
}

/** The envelope of a message another conversation sent, rebuilt from the line the room kept of it (`[title · kind] body`). */
export function peerTextOfLine(line: string): string {
  const match = /^\[([^\]\n]{1,120}) · (session|room)\] ([\s\S]*)$/.exec(line);
  return buildPeerEnvelope(match ? { fromLabel: match[1]!, fromKind: match[2] as "session" | "room", text: match[3]! } : { fromLabel: "conversation", fromKind: "session", text: line });
}

function productionRecoveryDeps(): LeadRecoveryDeps {
  const chats = () => require("../store/chats") as typeof import("../store/chats"); // eslint-disable-line @typescript-eslint/no-require-imports
  return {
    db: getDb(),
    activeChatIds,
    otherHostHolds(chatIds) {
      try {
        const owners = require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners"); // eslint-disable-line @typescript-eslint/no-require-imports
        const self = owners.invocationProcessOwner().ownerId;
        return chatIds.some((id) => {
          const owner = owners.invocationRunOwners.getActiveOwner(id);
          return Boolean(owner && owner.ownerId !== self && (owner.state === "active" || owner.state === "settling"));
        });
      } catch { return false; }
    },
    holderAlive: leadRequestHolderAlive,
    getChat: (id) => chats().getChat(id),
    lastMessage: (id) => chats().listChatMessages(id, 3).at(-1),
    say(id, text) {
      chats().appendChatMessage(id, "assistant", text, { noGoalResult: true });
      (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id }); // eslint-disable-line @typescript-eslint/no-require-imports
    },
    ko: () => (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko", // eslint-disable-line @typescript-eslint/no-require-imports
    plan: (chatId, request) => productionPlan(getDb(), chatId, request),
    resume: (input) => leadRouter().resume({ chatId: input.chatId, ownerMessageId: input.ownerMessageId, permission: input.permission,
      // The message another conversation sent is carried by the turn that answers the request's root (the lead's), never by a hand-off turn.
      steps: input.steps.map((step) => ({ member: step.member, trigger: step.trigger, ...(input.peerText && step.trigger === input.ownerMessageId ? { peer: input.peerText } : {}),
        ...(input.chain ? { chainId: input.chain } : {}) })) }).handled,
  };
}

/**
 * At app start: a lead room whose request was still open when the app closed (the router left its "open request" row - written when it
 * took the owner's message, deleted when the request's last turn ended) lost the rest of its answers: the chain and the queue live in
 * memory only. Agentlas 2.0 N5: the request is CONTINUED, once. The members that had not answered it yet (worked out from the room's
 * record and their read positions: planLeadResume) run again - their turn told that an earlier try may have got this far - and what they
 * and the ones they hand to say is posted to the room as ever; a member that already answered does not run again, and no line says "send
 * it again". The row is marked continued (the process that continues it is its holder from then on): a request that is cut off a second
 * time ends the way every cut-off request did before - one plain line, once - so a restart never starts a loop. When the room's record
 * shows the request was answered in full (the app closed between the last answer and the row's deletion) the row is just deleted.
 * A Stop the owner pressed, a room the plan cannot be made for, and a room's members that are gone keep the older rule. A room whose
 * members' sessions are held by ANOTHER process (the background service answering) is left alone: it is not interrupted. Rooms from before
 * the row existed keep the older rule. Returns the number of rooms marked with a line.
 */
export function recoverInterruptedLeadRooms(deps?: LeadRecoveryDeps, onlyChatId?: string): number {
  let marked = 0;
  // App start (the product's call, not a gate's injected one): what rooms deleted by an older build left in the store goes now, once.
  // A look at one room (`onlyChatId`, see leadRoomWaiting) is not an app start: the sweeps stay at the start.
  if (!deps && !onlyChatId) {
    try { (require("../store/chats") as typeof import("../store/chats")).sweepOrphanRoomRows(); } catch { /* the next room delete sweeps */ } // eslint-disable-line @typescript-eslint/no-require-imports
    // Chains of messages between conversations that nobody touched for a week (harness/peer-chain.ts).
    try { (require("../harness/peer-chain") as typeof import("../harness/peer-chain")).sweepPeerChains(getDb()); } catch { /* the next start sweeps */ } // eslint-disable-line @typescript-eslint/no-require-imports
  }
  try {
    const d = deps ?? productionRecoveryDeps();
    const db = d.db;
    const open = new Map(openLeadRequests(db).map((entry) => [entry.chatId, entry]));
    const rows = db.prepare("SELECT substr(key, ?) AS id FROM meta WHERE key LIKE ?").all("room-lead:".length + 1, "room-lead:%") as Array<{ id: string }>;
    const ids = [...new Set([...rows.map((row) => row.id), ...open.keys()])].filter((id) => !onlyChatId || id === onlyChatId);
    const busy = new Set(d.activeChatIds());
    for (const id of ids) {
      const childIds = (db.prepare("SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division'").all(id) as Array<{ id: string }>).map((row) => row.id);
      if (busy.has(id) || childIds.some((child) => busy.has(child))) continue;
      const chat = d.getChat(id);
      if (!chat || chat.archivedAt) { if (open.has(id)) clearLeadRequestOpen(db, id); continue; }
      if (d.otherHostHolds([id, ...childIds])) continue; // the service is still answering: the row stays until it is over
      // Between two turns of a chain the service holds no run lease, so the lease check above sees nothing: the row names the process
      // that took the request, and while that process runs it is the one answering (no false "the app closed" line).
      const holder = open.get(id);
      if (holder?.pid && d.holderAlive?.({ pid: holder.pid, pstart: holder.pstart })) continue;
      // Continue the request once (N5). Anything that stops it from being continued falls through to the older rule below.
      if (holder && holder.ownerMessageId && !holder.resumed && !holder.stop && d.plan && d.resume) {
        let plan: ReturnType<NonNullable<LeadRecoveryDeps["plan"]>> = null;
        try { plan = d.plan(id, { ownerMessageId: holder.ownerMessageId, peer: holder.peer, chain: holder.chain }); } catch { plan = null; }
        if (plan && plan.steps.length === 0) { clearLeadRequestOpen(db, id, [holder.ownerMessageId]); continue; } // answered in full: nothing was lost
        if (plan && plan.steps.length > 0 && markLeadRequestResumed(db, id, holder.ownerMessageId)) {
          let started = false;
          try { started = d.resume({ chatId: id, ownerMessageId: holder.ownerMessageId, permission: plan.permission, chain: holder.chain, peerText: plan.peerText, steps: plan.steps }); } catch { started = false; }
          if (started) continue;
          // Nothing could be started (the room's members are gone): the request ends the older way. The mark stays, so it is not tried again.
        }
      }
      const last = d.lastMessage(id);
      const hadOpen = open.has(id);
      if (hadOpen) clearLeadRequestOpen(db, id);
      if (!hadOpen && (!last || last.role !== "user")) continue;
      const ko = d.ko();
      const ownerLast = !last || last.role === "user";
      d.say(id, ownerLast
        ? (ko ? "앱이 꺼져 이 요청의 답이 중단됐어요. 다시 보내 주세요." : "The app closed before this request was answered. Send it again.")
        : (ko ? "앱이 꺼져 이 요청의 나머지 답이 중단됐을 수 있어요. 필요하면 다시 보내 주세요." : "The app closed while this request was still being answered; the rest of the answers may be missing. Send it again if you need them."));
      marked += 1;
    }
  } catch { /* a store that is not ready has nothing to recover */ }
  return marked;
}

// ── Stop, and what the room shows while members wait ────────────────────────────

/**
 * The owner's Stop on a run that belongs to a lead room's request (any of its runs, queued or started - the id the caller was promised
 * counts): the whole request stops. Returns the room id, or null when the run is not a room's (the Stop goes on the ordinary way).
 */
export function stopLeadRoomByRun(runId: string): string | null {
  try {
    const roomChatId = router ? router.cancelByRun(runId) : null;
    // The person's Stop of a run of the room is the room's Stop: the counter moves too (the phone's and the service's Stop reach the room only here).
    if (roomChatId) raiseRoomStopEpoch(roomChatId);
    return roomChatId;
  } catch { return null; }
}
/** The room's Stop counter, raised by a Stop that arrived by a run id (never throws). */
function raiseRoomStopEpoch(roomChatId: string): void {
  try { (require("../store/chats") as typeof import("../store/chats")).bumpChatStopEpoch(roomChatId); } catch { /* the in-memory Stop already ended the request */ } // eslint-disable-line @typescript-eslint/no-require-imports
}
/** The room's own Stop (the pane's button). True when a request was running. */
export function stopLeadRoom(chatId: string): boolean {
  try { return router ? router.cancelRoom(chatId) : false; } catch { return false; }
}
/**
 * A room's request must not outlive its room or its members: the chain (running turns, turns waiting for a slot or behind a busy
 * member, hand-offs to come) is stopped when the room is archived or deleted, when a member leaves it, or when an agent is deleted.
 * Nothing runs for a room that cannot show the answer. Never throws.
 */
export function stopLeadRoomsOfAgent(agentId: string): number {
  let stopped = 0;
  try {
    const rows = getDb().prepare("SELECT chat_id AS chatId, member_agent_ids_json AS members FROM one_taskforces").all() as Array<{ chatId: string; members: string }>;
    for (const row of rows) {
      let ids: unknown = [];
      try { ids = JSON.parse(row.members); } catch { /* a damaged row names no one */ }
      if (Array.isArray(ids) && ids.includes(agentId)) {
        if (stopLeadRoom(row.chatId)) stopped += 1;
        releaseRoomMemberResidency(row.chatId, agentId);
      }
    }
  } catch { /* a store without the table has no rooms */ }
  return stopped;
}

/**
 * Lets go of the idle CLI sessions a room's members hold. A member's resident session is registered under its OWN child session id
 * (the hidden division chat of the (member, room) pair), not under the room's id, so releasing by the room id found nothing and a deleted
 * room's CLI and tool servers stayed until the idle trim (item 2). With `agentId` only that member's session is released (a
 * member who left, an agent that was deleted). A session that is running a turn is kept (its entry is released by the idle trim once the
 * turn is over); the room's own Stop ends the turn. Never throws; returns the number of resident sessions released.
 */
export function releaseRoomMemberResidency(roomChatId: string, agentId?: string): number {
  let released = 0;
  try {
    const sql = agentId
      ? "SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division' AND agent_id = ?"
      : "SELECT id FROM chats WHERE parent_chat_id = ? AND kind = 'division'";
    const rows = (agentId ? getDb().prepare(sql).all(roomChatId, agentId) : getDb().prepare(sql).all(roomChatId)) as Array<{ id: string }>;
    const residency = require("../runtime/agent-residency") as typeof import("../runtime/agent-residency"); // eslint-disable-line @typescript-eslint/no-require-imports
    for (const row of rows) {
      try { released += residency.releaseIdleAgentResidencyForChat(row.id).released; } catch { /* the idle trim will find it */ }
    }
  } catch { /* a store without the table holds no sessions */ }
  return released;
}

/**
 * Members lined up behind their own earlier turn, or waiting out a provider limit (live state; nothing after a restart). A request
 * that ANOTHER live process holds (the background service answering a phone message) is busy here too: its open-request row names
 * that process, so the window shows "working" between that chain's turns and not only while one of its runs is registered.
 */
export function leadRoomWaiting(chatId: string): { busy: boolean; held: Array<{ agentId: string; kind: "turn" | "retry"; retryAt?: number }> } {
  try {
    const local = router ? { busy: router.isBusy(chatId), held: router.waitingOf(chatId) } : { busy: false, held: [] };
    if (local.busy) return local;
    const open = openLeadRequests(getDb()).find((entry) => entry.chatId === chatId);
    // A request the owner has stopped is not "working": its chain ends at its next turn start without starting one.
    if (open?.stop) return local;
    if (open?.pid && leadRequestHolderAlive({ pid: open.pid, pstart: open.pstart })) return { ...local, busy: true };
    // The process that took the request is gone (the background service died, or the app of an older start): nothing will ever answer it, and the
    // recovery used to run once at the app's start only. It runs now for this one room - continued once, or one honest line (desktop 3, B-7).
    if (open && !recoveringRooms.has(chatId)) {
      recoveringRooms.add(chatId);
      try { recoverInterruptedLeadRooms(undefined, chatId); } catch { /* the room stays as it was; the next look tries again */ } finally { recoveringRooms.delete(chatId); }
      if (router?.isBusy(chatId)) return { busy: true, held: router.waitingOf(chatId) };
    }
    return local;
  } catch { return { busy: false, held: [] }; }
}
const recoveringRooms = new Set<string>();

/**
 * The room's Stop wherever its request runs. This process's own chain stops at once; a chain the background service holds is reached
 * through the member run it has registered right now (the service's cancel handler stops the whole request, see
 * runtime/invocation-owner-control.ts). Between two turns of that chain no run is registered, so there is nothing to reach yet:
 * false is returned and the next Stop lands on the next turn.
 */
export async function stopLeadRoomWhereHeld(chatId: string): Promise<boolean> {
  // The Stop belongs to the requests open at the moment it is made. Both marks are taken here, before the first await: a message
  // that arrives while the teammate jobs below are being stopped is a new request and must not be ended by this Stop.
  const stoppedHere = stopLeadRoom(chatId);
  // The Stop is written into the open request first, whatever else is true (a lease, a registered run, a live holder): the chain that
  // another process holds reads it before it starts its next turn, so a Stop between two turns is never lost.
  let marked = false;
  if (!stoppedHere) { try { marked = requestLeadRequestStop(getDb(), chatId); } catch { marked = false; } }
  // The room's teammate jobs go with it (a back-and-forth between two running jobs has no count limit, so this Stop is what ends it; team-dispatch.ts stopRoomTeamJobs).
  let jobsStopped = 0;
  try {
    const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control"); // eslint-disable-line @typescript-eslint/no-require-imports
    jobsStopped = await (require("./team-dispatch") as typeof import("./team-dispatch")).stopRoomTeamJobs(chatId, (id) => control.cancelInvocationOwnerRun(id, { dispatchBookkeeping: false })); // eslint-disable-line @typescript-eslint/no-require-imports
  } catch { jobsStopped = 0; }
  if (stoppedHere) return true;
  if (jobsStopped > 0) return true;
  try {
    const owners = require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners"); // eslint-disable-line @typescript-eslint/no-require-imports
    const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control"); // eslint-disable-line @typescript-eslint/no-require-imports
    const self = owners.invocationProcessOwner().ownerId;
    const held = roomMemberSessionIds(getDb(), chatId).map((id) => owners.invocationRunOwners.getActiveOwner(id))
      .filter((owner): owner is NonNullable<typeof owner> => Boolean(owner) && owner!.ownerId !== self && (owner!.state === "active" || owner!.state === "settling"));
    let stopped = false;
    for (const owner of held) { try { if ((await control.cancelInvocationOwnerRun(owner.runId)) !== "not-found") stopped = true; } catch { /* the service may be gone: its chain is gone with it */ } }
    return stopped || marked;
  } catch { return marked; }
}
/** True when the chat is a group room already run by the lead router (the mark is read, never written). */
export function isMarkedLeadRoom(chatId: unknown): boolean {
  if (typeof chatId !== "string" || !chatId) return false;
  try { return isLead(chatId); } catch { return false; }
}
const isLead = (chatId: string): boolean => isLeadRoom(getDb(), chatId);

export interface RoomConversationStop {
  /** A request of the room was running or a member run was reached. */
  stopped: boolean;
  /** The room's Stop counter after this Stop (chats.stop_epoch). */
  epoch: number;
  /** The sends the Stop took back (not sent): their words go back into the input box. */
  withdrawn: Array<{ id: string; source: string; intentId: string | null; text: string; bubbleRemoved: boolean }>;
  /** Run ids of the member sessions that were asked to stop here. */
  cancelledRuns: string[];
}

/**
 * THE Stop of a group room, whichever button asked for it (the composer's `chat.stop`, the room status line's "Stop", the phone's, the app-control Stop).
 * the two buttons used to do half each - `chat.stop` raised the Stop counter and cancelled the room chat's own run (a lead room has none), and the
 * status line's Stop cancelled the router's request but never wrote the Stop - so a member's answer could still be written after the person pressed Stop.
 * Order: (1) the Stop is written (counter, time, the sends that had not started), so nothing that races with the next steps can write after it;
 * (2) the router's request ends everywhere it is held; (3) every live run of a member session of this room is cancelled by what is registered, even one
 * the router has lost track of. Never throws.
 */
export async function stopRoomConversation(chatId: string): Promise<RoomConversationStop> {
  let epoch = 0;
  let withdrawn: RoomConversationStop["withdrawn"] = [];
  try {
    const owner = (require("../chat/chat-stop") as typeof import("../chat/chat-stop")).stopChatOwnerInputs(chatId); // eslint-disable-line @typescript-eslint/no-require-imports
    epoch = owner.epoch; withdrawn = owner.withdrawn;
  } catch { /* the Stop of the runs below never waits on the bookkeeping */ }
  let stopped = false;
  try { stopped = await stopLeadRoomWhereHeld(chatId); } catch { stopped = false; }
  const cancelledRuns: string[] = [];
  try {
    const inv = (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
    for (const memberChatId of roomMemberSessionIds(getDb(), chatId)) {
      const live = inv.currentTurn(memberChatId, { includeVerification: true });
      if (!live) continue;
      try { if (inv.cancel(live.runId) !== "not-found") { cancelledRuns.push(live.runId); stopped = true; } } catch { /* the next one is still asked */ }
    }
  } catch { /* no service in this process: its runs are another process's, reached by stopLeadRoomWhereHeld */ }
  return { stopped, epoch, withdrawn, cancelledRuns };
}

/**
 * The Stop of a run the owner sees (the phone's Stop button names the run id it was promised) that ends in "not found" because the
 * chain it belongs to is between two turns in another process: the same mark, found through the run's chat (the room itself, or a
 * member's child session of a room). True when a room's open request was marked.
 */
export function markLeadRoomStopByRun(runId: string): boolean {
  try {
    const db = getDb();
    const chatId = (require("../invocation/pending-chat-sends") as typeof import("../invocation/pending-chat-sends")).chatOfRun(db, runId); // eslint-disable-line @typescript-eslint/no-require-imports
    if (!chatId) return false;
    const parent = db.prepare("SELECT parent_chat_id AS parentId FROM chats WHERE id = ? AND kind = 'division'").get(chatId) as { parentId: string | null } | undefined;
    const roomId = parent?.parentId || chatId;
    if (!isLeadRoom(db, roomId)) return false;
    const marked = requestLeadRequestStop(db, roomId);
    if (marked) raiseRoomStopEpoch(roomId);
    return marked;
  } catch { return false; }
}

