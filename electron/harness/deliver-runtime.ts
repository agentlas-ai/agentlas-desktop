import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { deliver, type DeliverInput, type DeliverPorts, type DeliverResult, type PeerChatFacts } from "./deliver";
import { admitPeerDelivery, peerChainOfLiveRun } from "./peer-chain";
import { approvalScopeOfChat } from "../runtime/approval-scope";
import { offeredPeerTools, peerCandidates } from "../scope/scope-gate";
import { pickPeerTarget } from "./peer-target-card";
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

/** The hidden session a lead-model group room runs a member's turns in (a division child of a lead room). */
export function isRoomMemberSession(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  try { return (require("../runtime/session-scope") as typeof import("../runtime/session-scope")).isLeadRoomMemberChat(getDb(), chatId); } catch { return false; } // eslint-disable-line @typescript-eslint/no-require-imports
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

/** The words of the message a card names, short and on one line: the request the card belongs to (the card can outlive the turn that asked). */
export const peerExcerpt = (text: string, max = 60): string => {
  const one = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The line of the approval card for a message: the receiving conversation by name and its project by name, in the app's language. */
export function peerTargetDetail(toTitle: string, projectId: string | null): string {
  let projectName = "";
  try { projectName = (require("../store/projects") as typeof import("../store/projects")).getProject(projectId ?? "")?.name?.trim() ?? ""; } catch { projectName = ""; } // eslint-disable-line @typescript-eslint/no-require-imports
  let ko = false;
  try { ko = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko"; } catch { ko = false; } // eslint-disable-line @typescript-eslint/no-require-imports
  const title = toTitle.replace(/\s+/g, " ").trim() || (ko ? "이름 없는 대화" : "untitled conversation");
  if (ko) return projectName ? `「${title}」 대화(프로젝트 「${projectName}」)로 메시지 보내기` : `「${title}」 대화로 메시지 보내기`;
  return projectName ? `message to the conversation "${title}" (project "${projectName}")` : `message to the conversation "${title}"`;
}

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
        // The card names WHERE the message goes: the conversation and its project, so a person sees at once that it stays inside this project.
        detail: `${peerTargetDetail(input.toTitle, input.toProjectId)}: 「${peerExcerpt(input.text)}」`, permission: input.permission, chatId: input.fromChatId, ...(input.attended ? {} : { unattended: true as const }),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const decision = await arbiter(ask);
      if (decision !== "deny") return "allow";
      const cause = toolApprovalRefusal(ask)?.cause;
      // Only a refusal the rule typed as the owner's own "no" is a "no": any other end of the ask (a fault, a stopped run) asked nobody.
      return cause === "nobody_to_ask" ? "no_one_to_ask" : cause === "no_answer" ? "expired" : cause === "owner_denied" ? "deny" : "not_asked";
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
    ownerStoppedSince: (chatId, sinceMs) => {
      try { return (require("../chat/chat-stop") as typeof import("../chat/chat-stop")).ownerStoppedSince(chatId, new Date(sinceMs).toISOString()); } catch { return false; } // eslint-disable-line @typescript-eslint/no-require-imports
    },
  };
}

/** The message_send tool's call (the One team control server's `message` operation): the sender is the capability's conversation and run. */
export async function sendPeerMessage(input: DeliverInput): Promise<DeliverResult> {
  const result = await deliver(input, productionDeliverPorts());
  // a message the person is told about leaves ONE receipt in the SENDER's conversation, made from this result and never from the model's words.
  // Retried calls are one row (the id derives from the run, the target and the intent). recordMessageReceipt never throws.
  (require("./turn-receipts") as typeof import("./turn-receipts")).recordMessageReceipt({ fromChatId: input.fromChatId, fromRunId: input.fromRunId, toChatId: input.toChatId,
    text: input.text, intentId: result.ok ? peerIntentId(result.chainId, input.toChatId, input.text) : result.intentId ?? null, result, ...(input.receiptKey ? { receiptKey: input.receiptKey } : {}) }); // eslint-disable-line @typescript-eslint/no-require-imports
  // The id only keys the receipt; the model's tool answer keeps the shape it always had.
  if (!result.ok && result.intentId !== undefined) { const { intentId: _keyOnly, ...answer } = result; return answer; }
  return result;
}

/**
 * Whether a conversation is offered the message_send tool (mcp-config.ts). every conversation of a project that is not itself the personal
 * agent's, a screen pack's or a Hub-called agent's has it - a project with no other conversation answers a call with the typed `no_peer` refusal instead of
 * a tool that is not there (the model improvised around the missing tool). Any other conversation's tool list is what it always was.
 */
export function peerMessageToolNames(chatId: string | null | undefined): readonly string[] {
  if (!chatId) return [];
  try { return offeredPeerTools(peerChatFacts(chatId)); } catch { return []; }
}

const norm = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** What the tool call may be given instead of the real parts (tests, and a host with another way to make a conversation). */
export interface PeerSendDeps {
  send?: (input: DeliverInput) => Promise<DeliverResult>;
  pick?: typeof pickPeerTarget;
  /** Makes an empty conversation of the project for the owner's "create a new conversation" button; returns its id, or null when it cannot. */
  createConversation?: (input: { fromChatId: string; projectId: string }) => string | null;
}

/** The owner's "create a new conversation" button: an empty conversation of the sender's project (same agent, same surface). */
function createPeerConversation(input: { fromChatId: string; projectId: string }): string | null {
  try {
    const chats = require("../store/chats") as typeof import("../store/chats"); // eslint-disable-line @typescript-eslint/no-require-imports
    const from = chats.getChat(input.fromChatId);
    return chats.createChat({ projectId: input.projectId, ...(from?.agentId ? { agentId: from.agentId } : {}), originSurface: from?.originSurface === "one" ? "one" : "work" }).id;
  } catch { return null; }
}

const projectNameOf = (projectId: string | null): string => {
  if (!projectId) return "";
  try { return (require("../store/projects") as typeof import("../store/projects")).getProject(projectId)?.name ?? ""; } catch { return ""; } // eslint-disable-line @typescript-eslint/no-require-imports
};

/**
 * The tool call: resolves `to` and delivers. The answer is what the model reads.
 * `to` names a conversation only as an id of the sender's project or the whole title of exactly one of them. Anything else (no match, several, a look-alike)
 * is NOT settled by the model: the host puts the candidates to the owner on a card (peer-target-card.ts) and the id of the button the owner presses is the target.
 */
export async function sendPeerMessageTo(input: Omit<DeliverInput, "toChatId"> & { to: string }, deps: PeerSendDeps = {}): Promise<Record<string, unknown>> {
  const out = await sendPeerMessageToInner(input, deps);
  // A refusal with no resolved target has no conversation id to point at: its receipt points at the run. A refusal from deliver() was already receipted by sendPeerMessage.
  if (out.delivered === false && typeof out.code === "string" && ["no_peer", "no_project", "not_found", "ambiguous", "not_picked", "empty"].includes(out.code)) {
    (require("./turn-receipts") as typeof import("./turn-receipts")).recordMessageReceipt({ fromChatId: input.fromChatId, fromRunId: input.fromRunId, toChatId: null, text: input.text, result: { delivered: false, code: out.code }, ...(input.receiptKey ? { receiptKey: input.receiptKey } : {}) }); // eslint-disable-line @typescript-eslint/no-require-imports
  }
  return out;
}

async function sendPeerMessageToInner(input: Omit<DeliverInput, "toChatId"> & { to: string }, deps: PeerSendDeps = {}): Promise<Record<string, unknown>> {
  const sendOne = deps.send ?? sendPeerMessage;
  // An empty body is refused BEFORE any card is raised: a person is never asked to pick a conversation for a message that cannot be sent.
  if (typeof input.text !== "string" || !input.text.trim()) return { delivered: false, code: "empty", message: "the message is empty; nothing was sent" };
  const facts = peerChatFacts(input.fromChatId);
  if (!facts.projectId) return { delivered: false, code: "no_project", message: "this conversation belongs to no project, so it has no other conversations to write to; nothing was sent" };
  const project = projectNameOf(facts.projectId);
  const peers = peerCandidates(input.fromChatId);
  const wanted = input.to.trim();
  const delivered = (result: DeliverResult, how?: string): Record<string, unknown> => result.ok
    ? { delivered: true, to: result.to.title, kind: result.to.kind, ...(project ? { project } : {}), queued: result.queued, ...(how ? { picked_by: how } : {}),
      note: result.parked ? "its Goal is waiting; it reads this at its next step" : result.queued ? "it waits for that conversation's current turn and is delivered after it"
        : result.runId ? "that conversation started a turn on it now" : "it is delivered; it is read at that conversation's next turn" }
    : { delivered: false, code: result.code, message: result.message };
  let target = peers.find((peer) => peer.id === wanted);
  let pool: Array<{ id: string; title: string }> = [];
  let lookAlikes = false, ambiguous = false;
  if (!target) {
    // Only the id or the whole title (case, spacing and width ignored) names a conversation. A title that merely CONTAINS the words is a conversation that
    // looks similar, and a title is not stable (a conversation is renamed by its first answer): it is offered to the owner as a candidate, never sent to.
    const exact = peers.filter((peer) => norm(peer.title) === norm(wanted));
    if (exact.length === 1) target = exact[0];
    else if (exact.length > 1) { pool = exact; ambiguous = true; }
    else if (wanted.length >= 2) { pool = peers.filter((peer) => norm(peer.title).includes(norm(wanted)) || norm(wanted).includes(norm(peer.title)) && norm(peer.title).length >= 2); lookAlikes = true; }
  }
  if (!target) {
    // Other projects' conversations are not listed (nothing about them is revealed): the id may still name one, and deliver() refuses it plainly.
    if (/^[0-9a-f-]{20,}$/i.test(wanted)) return delivered(await sendOne({ ...input, toChatId: wanted }));
    if (peers.length === 0) return { delivered: false, code: "no_peer", message: "this project has no other conversation to write to; nothing was sent" };
    const listed = [...pool, ...peers.filter((peer) => !pool.some((one) => one.id === peer.id))].slice(0, 7);
    const notFound = { delivered: false, code: ambiguous ? "ambiguous" : "not_found", message: `${ambiguous ? "more than one conversation of this project has that name" : "no conversation of this project has exactly that name"}; nothing was sent; nobody could be asked to pick one`, ...(lookAlikes && pool.length ? { similar: pool.slice(0, 6).map((peer) => peer.id) } : {}), candidates: listed };
    if (input.attended === false) return notFound;
    let locale: "ko" | "en" = "en";
    try { locale = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en"; } catch { locale = "en"; } // eslint-disable-line @typescript-eslint/no-require-imports
    input.progress?.({ phase: "asking_target", candidates: listed.map((peer) => peer.title).filter(Boolean).slice(0, 7) });
    const picked = await (deps.pick ?? pickPeerTarget)({ fromChatId: input.fromChatId, wanted, candidates: listed, excerpt: peerExcerpt(input.text), ...(project ? { projectName: project } : {}), locale, ...(input.signal ? { signal: input.signal } : {}) });
    input.progress?.({ phase: "working" });
    if (picked.kind === "picked") {
      // The id came from a button the host offered, from this project's list: deliver() checks the project once more and asks the first-send card as for any message.
      if (!listed.some((peer) => peer.id === picked.id)) return { delivered: false, code: "not_picked", message: "the picked conversation was not one the host offered; nothing was sent" };
      return delivered(await sendOne({ ...input, toChatId: picked.id }), "owner_card");
    }
    if (picked.kind === "new_conversation") {
      const id = (deps.createConversation ?? createPeerConversation)({ fromChatId: input.fromChatId, projectId: facts.projectId });
      if (!id) return { delivered: false, code: "not_picked", message: "the owner chose a new conversation and it could not be created from here; nothing was sent; tell the owner to open a new conversation in this project" };
      return delivered(await sendOne({ ...input, toChatId: id }), "owner_card");
    }
    if (picked.why === "no_surface") return notFound;
    return { delivered: false, code: "not_picked", message: "the host showed the owner a card to pick the conversation and the owner did not pick one; nothing was sent; do not ask the owner again in words" };
  }
  return delivered(await sendOne({ ...input, toChatId: target.id }));
}
