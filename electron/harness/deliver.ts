import { buildPeerEnvelope } from "./peer-envelope";
import { peerChainIdForRun, type PeerChainMark, type PeerDeliveryVerdict } from "./peer-chain";
import { admitScopeDelivery, type ScopeStamp } from "../../shared/scope-stamp";

/*
 * The one way a message from one conversation reaches another (Agentlas 2.0 N5/N6, decision).
 * Thin on purpose: it decides whether the message may go, asks the owner once if it must, and hands it to the receiving side's own
 * path - a group room's lead router for a room, the ordinary next-turn queue for a session. It starts no turn of its own and keeps
 * no state of its own (the chain's state is harness/peer-chain.ts, the waiting message is the conversation's own queue row).
 *
 * Who may send to whom: both conversations belong to the SAME project. Never to or from a conversation without a project, to
 * a Science or Finance conversation, to a conversation of an agent that was only called from the Hub (it answers its caller
 * and nothing else), to the personal agent (it is the owner's secretary, the owner instructs it; it is not a peer - it reaches
 * conversations through its own tool), or to a member's hidden session of a room (write to the room: its lead receives it).
 * The first message of a project asks the owner once (the card is the existing approval card for a send: "yes", "always allow in
 * this project", "no"); nobody to ask (an unattended run) refuses with the fact, the same way the approval rule refuses.
 */

export type PeerRefusalCode =
  | "empty" | "too_long" | "self" | "no_project" | "not_found" | "not_same_project" | "target_not_allowed"
  | "repeated" | "chain_stopped" | "chain_too_wide" | "bundle_full" | "owner_declined" | "no_one_to_ask" | "unavailable";

export interface PeerChatFacts {
  exists: boolean; archived: boolean; title: string;
  /** The conversation's project, a member's hidden session counted as its room's. */
  projectId: string | null;
  /** A member's hidden (member, room) session. */
  memberSession: boolean;
  /** A group room under the lead model: it receives through its lead. */
  leadRoom: boolean;
  /** Science / Finance (a screen pack's own conversation). */
  pack: boolean;
  /** The personal agent's conversation, or a room it runs. */
  personal: boolean;
  /** An agent called from the Hub only. */
  hubCallOnly: boolean;
}

export const PEER_TEXT_MAX_CHARS = 4000;

export interface DeliverInput {
  fromChatId: string;
  /** The run of the sending turn: the chain this message belongs to is the sender's own (when its turn came from a chain) or begins here. */
  fromRunId: string;
  toChatId: string;
  text: string;
  replyTo?: string;
  /** True when a person can answer an approval card now (false: an automation, a headless run). */
  attended: boolean;
  /** The sending run's permission (full access asks nothing but money,). */
  permission: "read" | "write" | "full";
  /** The send intent's own signal (peer-send-window.ts): the person's Stop of the sender closes a card this send raised. The end of a turn does not. */
  signal?: AbortSignal;
  /** The intent's receipt key (peer-send-window.ts): every receipt of this send is one row. */
  receiptKey?: string;
  /** Tells the caller when a person is being asked (target card, first-send card) and when that ends, so a call that outlasts its window can say what it waits for. */
  progress?: (p: import("./peer-send-window").PeerSendPhase) => void;
}

export type DeliverResult =
  | { ok: true; to: { chatId: string; title: string; kind: "session" | "room" }; chainId: string; queued: boolean; runId?: string;
    /** The receiving conversation's Goal is waiting: the message is kept for the Goal's next step instead of starting a turn. */ parked?: true }
  /** `intentId`: the send's own id, set once the owner was asked, so the refusal's receipt is the same row as the "waiting for your choice" one. */
  | { ok: false; code: PeerRefusalCode; message: string; intentId?: string };

export interface DeliverPorts {
  facts(chatId: string): PeerChatFacts;
  /** The chain the sending turn belongs to, when it was opened by a message of one. */
  chainOfRun(fromRunId: string): PeerChainMark | null;
  /** Look at / record a delivery in the chain (peer-chain.ts admitPeerDelivery). */
  admit(input: { chainId: string; origin: { runId: string; chatId: string }; fromChatId: string; toChatId: string; text: string; commit: boolean }): PeerDeliveryVerdict;
  /** The approval: has the owner allowed messages between this project's conversations (a saved "always allow"), or does the card get an answer. */
  approve(input: { fromChatId: string; toChatId: string; toTitle: string; /** The receiving conversation's project: the card names it beside the conversation. */ toProjectId: string; /** The message itself: the card names the request it belongs to (an old card is never mistaken for a later turn's). */ text: string; attended: boolean; permission: "read" | "write" | "full"; signal?: AbortSignal }): Promise<"allow" | "deny" | "no_one_to_ask" | "expired" | "not_asked">;
  /** Into a group room: its lead receives it. Null when the room cannot take it now. */
  toRoom(input: { roomChatId: string; /** What the room shows (the sender's words). */ body: string; /** What the lead reads (the envelope). */ envelope: string; fromLabel: string; fromKind: "session" | "room"; chain: PeerChainMark }): { runId: string } | null;
  /** Into a session: the next-turn queue of that conversation (it starts a turn at once when the conversation is idle). */
  toSession(input: { chatId: string; text: string; chain: PeerChainMark; intentId: string }): Promise<{ queued: boolean; runId?: string; parked?: true }>;
  intentId(chainId: string, toChatId: string, text: string): string;
  /** The person stopped `chatId` after `sinceMs` and has not spoken since (chat/chat-stop.ts ownerStoppedSince). Absent: never. */
  ownerStoppedSince?(chatId: string, sinceMs: number): boolean;
}

const refuse = (code: PeerRefusalCode, message: string): DeliverResult => ({ ok: false, code, message });

const SAME_WORDS = "the same words were already sent to this conversation in this chain; nothing new was delivered. Send something that moves it forward, or wait for its answer.";

export async function deliver(input: DeliverInput, ports: DeliverPorts): Promise<DeliverResult> {
  const startedAt = Date.now();
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return refuse("empty", "the message is empty; nothing was sent");
  if (text.length > PEER_TEXT_MAX_CHARS) return refuse("too_long", `the message is longer than ${PEER_TEXT_MAX_CHARS} characters; shorten it or point to a file; nothing was sent`);
  if (input.fromChatId === input.toChatId) return refuse("self", "a message to this same conversation is not a message; nothing was sent");

  const from = ports.facts(input.fromChatId);
  const to = ports.facts(input.toChatId);
  if (!to.exists || to.archived) return refuse("not_found", "no such conversation in this project; nothing was sent");
  // One rule for "who may write to whom": the same pure function the personal agent's door and the candidate list use (shared/scope-stamp.ts).
  const stamp = (chat: string, facts: PeerChatFacts): ScopeStamp => ({ account: null, project: facts.projectId, chat });
  const allowed = admitScopeDelivery(stamp(input.fromChatId, from), stamp(input.toChatId, to), "peer");
  const fromProject = from.projectId;
  if (!fromProject || (!allowed.ok && allowed.code === "no_project")) return refuse("no_project", "this conversation belongs to no project, so it has no other conversations to write to; nothing was sent");
  if (!allowed.ok) return refuse("not_same_project", "that conversation is not in this project; messages go only between conversations of the same project; nothing was sent");
  if (to.pack || from.pack) return refuse("target_not_allowed", "conversations of a screen pack (Science and the like) do not exchange messages with other conversations; nothing was sent");
  if (to.personal || from.personal) return refuse("target_not_allowed", "the personal agent is not a conversation of the project: the owner talks to it directly; nothing was sent");
  if (to.hubCallOnly || from.hubCallOnly) return refuse("target_not_allowed", "an agent called from the Hub answers whoever called it and nothing else; nothing was sent");
  if (to.memberSession) return refuse("target_not_allowed", "that is a member's own session of a room: write to the room, its lead receives it; nothing was sent");

  const inherited = ports.chainOfRun(input.fromRunId);
  const chainId = inherited?.id ?? peerChainIdForRun(input.fromRunId);
  const origin = { runId: inherited ? inherited.id.slice("chain:".length) : input.fromRunId, chatId: inherited?.from ?? input.fromChatId };
  const lookup = { chainId, origin, fromChatId: input.fromChatId, toChatId: input.toChatId, text };
  // Asked first without writing: a repeat or a stopped chain never raises a card.
  const peek = ports.admit({ ...lookup, commit: false });
  if (peek === "stopped") return refuse("chain_stopped", "the owner stopped this chain of messages; nothing was sent");
  if (peek === "repeated") return refuse("repeated", SAME_WORDS);
  if (peek === "too_wide") return refuse("chain_too_wide", "this chain already reaches too many conversations; nothing was sent");

  const askedIntentId = ports.intentId(chainId, input.toChatId, text);
  const refuseAsked = (code: PeerRefusalCode, message: string): DeliverResult => ({ ok: false, code, message, intentId: askedIntentId });
  input.progress?.({ phase: "asking_consent", toChatId: input.toChatId, intentId: askedIntentId, ...(to.title ? { toTitle: to.title } : {}) });
  const answer = await ports.approve({ fromChatId: input.fromChatId, toChatId: input.toChatId, toTitle: to.title, toProjectId: fromProject, text, attended: input.attended, permission: input.permission, ...(input.signal ? { signal: input.signal } : {}) })
    .catch((error: unknown) => { if (input.signal?.aborted) return "not_asked" as const; throw error; });
  input.progress?.({ phase: "working" });
  // The card was closed by the person's Stop of this conversation (its signal): nobody answered, and nobody said no.
  if (answer !== "allow" && input.signal?.aborted) return refuseAsked("owner_declined", "the card was closed before the owner answered it; nothing was sent");
  if (answer === "no_one_to_ask") return refuseAsked("no_one_to_ask", "messages between conversations need the owner's yes the first time, and nobody can be asked in this run; nothing was sent");
  // The approval step ended without a card the owner answered (a fault, a stopped run): the owner did not say no, and the line must not say they did.
  if (answer === "not_asked") return refuseAsked("unavailable", "the approval step could not run, so the owner was not asked; nothing was sent; do not tell the owner they declined");
  if (answer !== "allow") return refuseAsked("owner_declined", answer === "expired" ? "the owner did not answer the question in time; nothing was sent" : "the owner said no; nothing was sent");

  // The answer may have taken minutes: the receiving conversation may have been archived meanwhile. It stays where the card said it was (a conversation never
  // changes project), so only its being there is read again; a card never authorises a conversation other than the one it named.
  // A yes that comes after the person stopped this conversation, or after it was deleted, sends nothing: the Stop is the later word.
  const senderAfter = ports.facts(input.fromChatId);
  if (!senderAfter.exists || senderAfter.archived) return refuseAsked("unavailable", "the sending conversation is gone; nothing was sent");
  if (input.signal?.aborted || ports.ownerStoppedSince?.(input.fromChatId, startedAt)) return refuseAsked("owner_declined", "the owner stopped this conversation after the question was asked; nothing was sent");
  const after = ports.facts(input.toChatId);
  if (!after.exists || after.archived || after.projectId !== from.projectId) return refuse("not_found", "that conversation is no longer available in this project; nothing was sent");
  // The answer may have taken minutes: the chain may have been stopped, or the same words sent by another turn, meanwhile. Written now.
  const verdict = ports.admit({ ...lookup, commit: true });
  if (verdict === "stopped") return refuse("chain_stopped", "the owner stopped this chain of messages; nothing was sent");
  if (verdict === "repeated") return refuse("repeated", SAME_WORDS);
  if (verdict === "too_wide") return refuse("chain_too_wide", "this chain already reaches too many conversations; nothing was sent");

  const chain: PeerChainMark = { id: chainId, from: input.fromChatId };
  const kind: "session" | "room" = to.leadRoom ? "room" : "session";
  const fromKind: "session" | "room" = from.leadRoom || from.memberSession ? "room" : "session";
  try {
    if (to.leadRoom) {
      const routed = ports.toRoom({ roomChatId: input.toChatId, body: text, envelope: buildPeerEnvelope({ fromLabel: from.title, fromKind, text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) }), fromLabel: from.title, fromKind, chain });
      if (!routed) return refuseAsked("unavailable", "that room cannot take a message right now; nothing was sent");
      return { ok: true, to: { chatId: input.toChatId, title: to.title, kind }, chainId, queued: false, runId: routed.runId };
    }
    const intentId = ports.intentId(chainId, input.toChatId, text);
    const sent = await ports.toSession({ chatId: input.toChatId, text: buildPeerEnvelope({ fromLabel: from.title, fromKind, text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) }), chain, intentId });
    return { ok: true, to: { chatId: input.toChatId, title: to.title, kind }, chainId, queued: sent.queued, ...(sent.runId ? { runId: sent.runId } : {}), ...(sent.parked ? { parked: true as const } : {}) };
  } catch (error) {
    // The words were recorded as sent in the chain; a later retry of the same words would be refused as a repeat, so the failure says so plainly.
    const code = (error as { code?: unknown } | null)?.code ?? (error as { message?: unknown } | null)?.message;
    // Refused by the receiving conversation's waiting bundle (invocation/service.ts joinWaitingPeerSteer): the same words already wait there, or it holds
    // as much as one turn reads. Neither is delivered; the sender is told which.
    if (code === "peer_repeated") return refuse("repeated", SAME_WORDS);
    if (code === "peer_bundle_full") return refuse("bundle_full", "that conversation already holds as much as it reads in one turn; wait for its answer; nothing was sent");
    return refuse(code === "peer_chain_stopped" ? "chain_stopped" : "unavailable", code === "peer_chain_stopped" ? "the owner stopped this chain of messages; nothing was sent"
      : "the message could not be handed to that conversation; if it is still needed, send it again with different words");
  }
}
