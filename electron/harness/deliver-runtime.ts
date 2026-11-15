import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { deliver, type DeliverInput, type DeliverPorts, type DeliverResult, type PeerChatFacts } from "./deliver";
import { admitPeerDelivery, peerChainOfLiveRun } from "./peer-chain";
import { approvalScopeOfChat } from "../runtime/approval-scope";
import { getRuntimeToolPermissionArbiter, toolApprovalRefusal, type RuntimeToolPermissionAsk } from "../runtime/tool-approval";

/*
 * Production wiring of deliver() (Agentlas 2.0 N5/N6). Lazy requires keep this cheap to load from the One team control server.
 * Everything that decides is in deliver.ts; this file only reads the store, asks the approval rule, and calls the receiving side's own path.
 */

type Row = { kind: string | null; title: string | null; archivedAt: string | null; projectId: string | null; parentId: string | null; surfacePack: string | null; agentId: string | null };

function readRow(chatId: string): Row | null {
  try {
    return (getDb().prepare("SELECT kind, title, archived_at AS archivedAt, project_id AS projectId, parent_chat_id AS parentId, surface_pack AS surfacePack, agent_id AS agentId FROM chats WHERE id = ?").get(chatId) as Row | undefined) ?? null;
  } catch { return null; }
}

export function peerChatFacts(chatId: string): PeerChatFacts {
  const row = readRow(chatId);
  if (!row) return { exists: false, archived: false, title: "", projectId: null, memberSession: false, leadRoom: false, pack: false, personal: false, hubCallOnly: false };
  const room = (require("../one/room-lead-runtime") as typeof import("../one/room-lead-runtime")); // eslint-disable-line @typescript-eslint/no-require-imports
  const memberSession = row.kind === "division" && Boolean(row.parentId) && (() => { try { return (require("../runtime/session-scope") as typeof import("../runtime/session-scope")).isLeadRoomMemberChat(getDb(), chatId); } catch { return false; } })(); // eslint-disable-line @typescript-eslint/no-require-imports
  // A member's hidden session is named by its room, and belongs to the room's project.
  const named = memberSession && row.parentId ? readRow(row.parentId) : row;
  const scope = approvalScopeOfChat(chatId);
  let personal = false;
  try { personal = (require("../one/supervisor") as typeof import("../one/supervisor")).isPersonalSupervisorConversation(chatId); } catch { personal = false; } // eslint-disable-line @typescript-eslint/no-require-imports
  try { if (!personal) personal = (require("../one/personal-agent-rooms") as typeof import("../one/personal-agent-rooms")).isPersonalAgentRoom(memberSession && row.parentId ? row.parentId : chatId); } catch { /* no such table: not a supervised room */ } // eslint-disable-line @typescript-eslint/no-require-imports
  let hubCallOnly = false;
  try {
    const seat = row.agentId ? getDb().prepare("SELECT source FROM one_org_members WHERE installed_agent_id = ? AND archived_at IS NULL LIMIT 1").get(row.agentId) as { source?: string } | undefined : undefined;
    hubCallOnly = seat?.source === "hub";
  } catch { hubCallOnly = false; }
  return {
    exists: true, archived: Boolean(row.archivedAt), title: (named?.title ?? row.title ?? "").slice(0, 120),
    projectId: scope?.kind === "project" ? scope.id : null,
    memberSession, leadRoom: !memberSession && room.isLeadRoomChat(chatId), pack: Boolean(row.surfacePack || named?.surfacePack), personal, hubCallOnly,
  };
}

/** The receiving conversation's own current permission: what its owner last ran it with (a conversation that never ran reads only). */
function permissionOfChat(chatId: string): "read" | "write" | "full" {
  try {
    const service = (require("../invocation/service") as typeof import("../invocation/service")).invocationService; // eslint-disable-line @typescript-eslint/no-require-imports
    return service.latestOwnerReceipt(chatId)?.executionPermission ?? "read";
  } catch { return "read"; }
}

export const peerIntentId = (chainId: string, toChatId: string, text: string): string =>
  `peer:${createHash("sha256").update(`${chainId}\u0000${toChatId}\u0000${text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 40)}`;

export function productionDeliverPorts(): DeliverPorts {
  return {
    facts: peerChatFacts,
    chainOfRun: (runId) => peerChainOfLiveRun(getDb(), runId),
    admit: (input) => admitPeerDelivery(getDb(), input),
    async approve(input) {
      // The existing approval rule decides (runtime/host-tool-permission-policy.ts): a first message in a project raises the "sending out" card
      // with "yes / always allow in this project / no"; a saved "always allow" of this project passes; full access asks nothing but money;
      // with nobody to ask (an unattended run) it refuses and says why, exactly as for any other sending tool.
      const arbiter = getRuntimeToolPermissionArbiter();
      if (!arbiter) return "no_one_to_ask";
      const ask: RuntimeToolPermissionAsk = {
        runtime: "one-team", sessionKey: `peer-message:${input.fromChatId}`, tool: "message_send", kind: "other", mutating: true,
        detail: `message to "${input.toTitle}"`, permission: input.permission, chatId: input.fromChatId, ...(input.attended ? {} : { unattended: true as const }),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const decision = await arbiter(ask);
      if (decision !== "deny") return "allow";
      const cause = toolApprovalRefusal(ask)?.cause;
      return cause === "nobody_to_ask" ? "no_one_to_ask" : cause === "no_answer" ? "expired" : "deny";
    },
    toRoom(input) {
      const rooms = require("../one/room-lead-runtime") as typeof import("../one/room-lead-runtime"); // eslint-disable-line @typescript-eslint/no-require-imports
      return rooms.routeLeadRoomPeerMessage({ chatId: input.roomChatId, body: input.body, envelope: input.envelope, fromLabel: input.fromLabel, fromKind: input.fromKind, chainId: input.chain.id, permission: permissionOfChat(input.roomChatId) });
    },
    async toSession(input) {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(input.chatId); // eslint-disable-line @typescript-eslint/no-require-imports
      const permissions = permissionOfChat(input.chatId);
      const locale = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en"; // eslint-disable-line @typescript-eslint/no-require-imports
      // A turn of the receiving conversation's own session: system-written (it is nobody's typed word), at that conversation's own permission (no cap),
      // queued behind its running turn or started at once when it is idle. The owner-control router reaches the process that holds the conversation.
      const request = {
        chatId: input.chatId, userPrompt: input.text, promptOrigin: "system" as const, steeringMode: "queue" as const, taskIntent: "task" as const, locale,
        permissions, peerChain: input.chain,
        ...(chat?.originSurface === "one" ? { oneMode: true, onePermissionMode: permissions } : {}),
      };
      const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control"); // eslint-disable-line @typescript-eslint/no-require-imports
      const receipt = await control.steerInvocationOwnerNextTurn(request as never, input.intentId);
      const status = (receipt as { status?: string }).status;
      // A waiting Goal refused the turn and the message was kept for the Goal's next step (the row ends "cancelled" with that cause): nothing started, nothing was lost.
      if (status === "cancelled") return { queued: true, parked: true };
      const started = status === "started" || (receipt as { queued?: boolean }).queued === false;
      return { queued: !started, ...((receipt as { runId?: string }).runId ? { runId: (receipt as { runId: string }).runId } : {}) };
    },
    intentId: peerIntentId,
  };
}

/** The message_send tool's call (the One team control server's `message` operation): the sender is the capability's conversation and run. */
export function sendPeerMessage(input: DeliverInput): Promise<DeliverResult> {
  return deliver(input, productionDeliverPorts());
}

/** The conversations of the sender's project a message may go to (not itself, not archived, no hidden member session, no screen pack's): id and title. */
function projectPeers(fromChatId: string, projectId: string): Array<{ id: string; title: string }> {
  try {
    return getDb().prepare("SELECT id, title FROM chats WHERE project_id = ? AND kind = 'user' AND archived_at IS NULL AND surface_pack IS NULL AND id <> ? ORDER BY updated_at DESC LIMIT 200")
      .all(projectId, fromChatId) as Array<{ id: string; title: string }>;
  } catch { return []; }
}

/**
 * Whether a conversation is offered the message_send tool (mcp-config.ts): it belongs to a project that has another conversation to write to,
 * and it is not itself the personal agent's, a screen pack's or a Hub-called agent's. Any other conversation's tool list is what it always was.
 */
export function peerMessageToolNames(chatId: string | null | undefined): readonly string[] {
  if (!chatId) return [];
  try {
    const facts = peerChatFacts(chatId);
    if (!facts.exists || !facts.projectId || facts.pack || facts.personal || facts.hubCallOnly) return [];
    return projectPeers(chatId, facts.projectId).length > 0 ? ["message_send"] : [];
  } catch { return []; }
}

const norm = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** The tool call: resolves `to` (an id, or a title that names exactly one conversation of the project) and delivers. The answer is what the model reads. */
export async function sendPeerMessageTo(input: Omit<DeliverInput, "toChatId"> & { to: string }): Promise<Record<string, unknown>> {
  const facts = peerChatFacts(input.fromChatId);
  const peers = facts.projectId ? projectPeers(input.fromChatId, facts.projectId) : [];
  const wanted = input.to.trim();
  let target = peers.find((peer) => peer.id === wanted);
  if (!target) {
    const exact = peers.filter((peer) => norm(peer.title) === norm(wanted));
    const loose = exact.length > 0 ? exact : peers.filter((peer) => wanted.length >= 2 && norm(peer.title).includes(norm(wanted)));
    if (loose.length > 1) return { delivered: false, code: "ambiguous", message: "more than one conversation of this project has that name; say which by id; nothing was sent", candidates: loose.slice(0, 6) };
    target = loose[0];
  }
  if (!target) {
    // Other projects' conversations are not listed (nothing about them is revealed): the id may still name one, and deliver() refuses it plainly.
    if (/^[0-9a-f-]{20,}$/i.test(wanted)) {
      const result = await sendPeerMessage({ ...input, toChatId: wanted });
      return result.ok ? { delivered: true, to: result.to.title, kind: result.to.kind, queued: result.queued } : { delivered: false, code: result.code, message: result.message };
    }
    return { delivered: false, code: "not_found", message: "no conversation of this project has that name; nothing was sent", candidates: peers.slice(0, 6) };
  }
  const result = await sendPeerMessage({ ...input, toChatId: target.id });
  return result.ok
    ? { delivered: true, to: result.to.title, kind: result.to.kind, queued: result.queued, note: result.parked ? "its Goal is waiting; it reads this at its next step"
      : result.queued ? "it waits for that conversation's current turn and is delivered after it" : "that conversation started a turn on it now" }
    : { delivered: false, code: result.code, message: result.message };
}
