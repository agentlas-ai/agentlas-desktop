import { createHash } from "node:crypto";
import type { DueSource, DueWhy } from "./due-timer";
import { peerChainStopped } from "./peer-chain";
import type { PeerChainMark } from "./peer-chain";
import { PEER_TEXT_MAX_CHARS, type DeliverInput, type DeliverResult } from "./deliver";
import { openPeerSendsOfChat, reconcilePeerSendIntentsAtStart } from "./peer-send-window";

/*
 * Peer-reply wait: "I'll relay their answer when it arrives" is a host object, not a sentence.
 *
 * message_send with `await_reply: true` registers ONE wait: when the receiving conversation's turn that read this message ends, the sending
 * conversation gets a wake turn carrying that answer. The wait survives a restart (it is a row), is listed for the sending conversation's
 * pending-promises band (listPeerReplyWaits), expires, and is cancelled by the things that must always win (the owner's Stop of the sender, a
 * Stop of the message chain, a deleted conversation). Without `await_reply` nothing is registered and nothing waits: the tool says so.
 *
 * Storage: ONE row per wait in the `meta` table (key `peer-wait:<id>`, the way peer chains are kept: no new table or column).
 *   WHO WRITES: registerPeerReplyWait (message_send, Main or the background service), onPeerReplyTurnSettled, notePeerMessageSent, sweepPeerReplyWaits.
 *   WHO READS : the due-timer source below (Main only, nextAt = earliest expiry or a woken-but-undelivered wait), listPeerReplyWaits (pending band).
 *   WHEN DELETED: the wake was handed over, the wait expired (24 h), it was cancelled (owner Stop, chain Stop, a conversation deleted), or the sender's
 *     own message arrived first (the answer came as a message). A terminal row is never kept: its record is the receipt (a system row in the sender's
 *     conversation, written through the receipt sink), so nothing accumulates. At most PEER_WAIT_MAX_PER_CHAT rows per sending conversation.
 * The answer text is NOT stored: the wake re-reads the receiver's newest answer when it is delivered. No model is called by anything here, and no
 * timer of its own exists (the one due-timer asks nextAt/run).
 *
 * State: active -> fired (the receiver's turn ended) -> deleted after the wake was handed to the sender's next-turn queue.
 *        active -> deleted (expired | cancelled | answered_by_message). A fired wait whose wake could not be handed over is retried by the due-timer
 *        (a look that leaves it due is held 30 s by the timer) up to PEER_WAIT_WAKE_ATTEMPTS, and the wake carries the wait id as its intent id, so a
 *        crash between "handed over" and "row deleted" delivers once (the queue refuses the same intent twice).
 */

export const PEER_WAIT_KEY_PREFIX = "peer-wait:";
/** How long a wait lives. Same 24 h as the other "an old instruction must not run tomorrow" deadlines. */
export const PEER_WAIT_EXPIRES_MS = 24 * 60 * 60_000;
/** Waits one sending conversation may have open at once (message_send refuses the 9th wait with `wait_limit`; the message itself is still sent). */
export const PEER_WAIT_MAX_PER_CHAT = 8;
/**
 * After an app start an open wait has this long for its receiver's turn to run again and settle (a turn the close cut off is picked up again by the app, or it is not).
 * Past it the sender is told no answer came (an honest end instead of a band that says "waiting" for 24 h). A receiver that settles sooner fires the wait as usual.
 */
export const PEER_WAIT_RESTART_GRACE_MS = 10 * 60_000;
/** Tries to hand one wake to the sender's queue before the wait ends as failed. */
export const PEER_WAIT_WAKE_ATTEMPTS = 3;
/** A wake in hand by one process is not taken by the other for this long (the timer's own 30 s hold). */
const WAKE_LEASE_MS = 30_000;

export type PeerWaitState = "active" | "fired";
export type PeerWaitFiredOutcome = "answered" | "interrupted";
/** `host_stopped`: the receiver's turn ended because the APP closed or restarted for an update (invocation-host-stop). The wait is not its end: the app picks the turn up again. */
export type PeerWaitSettleEnd = PeerWaitFiredOutcome | "host_stopped";

export interface PeerReplyWait {
  v: 1;
  id: string;
  senderChatId: string;
  senderRunId: string;
  targetChatId: string;
  chainId: string;
  intentId: string;
  createdAt: number;
  expiresAt: number;
  state: PeerWaitState;
  /** active, after an app start: when the wait is closed as "no answer came" if the receiver's turn did not settle (PEER_WAIT_RESTART_GRACE_MS). */
  resumeBy?: number;
  /** fired: the receiver's turn that read the message. */
  firedRunId?: string;
  outcome?: PeerWaitFiredOutcome;
  attempts: number;
  leaseUntil?: number;
}

/** The receipt of a wait, shaped by the sheet's receipt.card.v1 (section 2). The receipt writer owns the row; this module only builds the value. */
export interface PeerWaitReceiptValue {
  v: 1;
  id: string;
  kind: "wait";
  outcome: "done" | "refused" | "failed" | "cancelled" | "expired";
  code: PeerWaitReceiptCode;
  ref: { waitId: string };
  runId: string;
  chatId: string;
  scope: unknown;
  at: string;
}
export type PeerWaitReceiptCode = "waiting" | "answered" | "answered_by_message" | "interrupted" | "wait_limit" | "chain_stopped" | "owner_stopped" | "chat_gone" | "wake_failed" | "expired";

export interface PeerWaitDb {
  prepare(sql: string): { run(...args: any[]): unknown; get(...args: any[]): unknown; all(...args: any[]): unknown[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  transaction?: (fn: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface PeerReplyWaitPorts {
  db(): PeerWaitDb;
  now?: () => number;
  chatExists(chatId: string): boolean;
  /** The owner stopped this conversation after `sinceIso` and has not spoken since (chat/chat-stop.ts ownerStoppedSince). */
  ownerStoppedSince(chatId: string, sinceIso: string): boolean;
  /** The newest answer text the receiver wrote since `sinceIso`, "" when it wrote none; and the conversation's name. */
  readAnswer(targetChatId: string, sinceIso: string): { text: string; title: string };
  /** Hands the wake to the sending conversation's next-turn queue (idempotent on `intentId`). Throws when it could not. */
  wake(input: { senderChatId: string; text: string; intentId: string }): Promise<void>;
  /** Writes / updates the receipt row of the wait in the sender's conversation. Never throws into the caller. */
  receipt(value: PeerWaitReceiptValue): void;
  /** The scope stamp of the sending conversation. */
  stamp(chatId: string, runId: string): unknown;
}

const keyOf = (id: string): string => PEER_WAIT_KEY_PREFIX + id;
const iso = (ms: number): string => new Date(ms).toISOString();

export const peerWaitId = (senderChatId: string, targetChatId: string, intentId: string): string =>
  `pw_${createHash("sha256").update(`${senderChatId}\u0000${targetChatId}\u0000${intentId}`).digest("hex").slice(0, 24)}`;

function parse(value: string): PeerReplyWait | null {
  try {
    const row = JSON.parse(value) as Partial<PeerReplyWait> | null;
    if (!row || row.v !== 1 || typeof row.id !== "string" || typeof row.senderChatId !== "string" || typeof row.targetChatId !== "string"
      || typeof row.chainId !== "string" || typeof row.intentId !== "string" || !Number.isFinite(row.createdAt) || !Number.isFinite(row.expiresAt)) return null;
    return { v: 1, id: row.id, senderChatId: row.senderChatId, senderRunId: typeof row.senderRunId === "string" ? row.senderRunId : "", targetChatId: row.targetChatId,
      chainId: row.chainId, intentId: row.intentId, createdAt: Number(row.createdAt), expiresAt: Number(row.expiresAt), state: row.state === "fired" ? "fired" : "active",
      ...(typeof row.firedRunId === "string" ? { firedRunId: row.firedRunId } : {}), ...(row.outcome === "answered" || row.outcome === "interrupted" ? { outcome: row.outcome } : {}),
      attempts: Number(row.attempts) || 0, ...(Number.isFinite(row.leaseUntil) ? { leaseUntil: Number(row.leaseUntil) } : {}),
      ...(Number.isFinite(row.resumeBy) ? { resumeBy: Number(row.resumeBy) } : {}) };
  } catch { return null; }
}

function all(db: PeerWaitDb): PeerReplyWait[] {
  const rows = db.prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(PEER_WAIT_KEY_PREFIX, PEER_WAIT_KEY_PREFIX.slice(0, -1) + ";") as Array<{ value: string }>;
  return rows.map((row) => parse(row.value)).filter((row): row is PeerReplyWait => row !== null);
}
const write = (db: PeerWaitDb, wait: PeerReplyWait): void => { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(keyOf(wait.id), JSON.stringify(wait)); };
const drop = (db: PeerWaitDb, id: string): void => { db.prepare("DELETE FROM meta WHERE key = ?").run(keyOf(id)); };

/** Read-modify-write as one immediate transaction (Main and the background service may touch the same wait in the same moment). */
function atomically<T>(db: PeerWaitDb, work: () => T): T {
  if (typeof db.transaction === "function") {
    const wrapped = db.transaction(work) as { immediate?: () => T } & (() => T);
    return typeof wrapped.immediate === "function" ? wrapped.immediate() : wrapped();
  }
  return work();
}

/** The open waits of a sending conversation, soonest expiry first (the pending-promises band of reads this). */
export function listPeerReplyWaits(db: PeerWaitDb, senderChatId: string): PeerReplyWait[] {
  return all(db).filter((wait) => wait.senderChatId === senderChatId).sort((a, b) => a.expiresAt - b.expiresAt);
}

export function peerWaitReceiptValue(wait: PeerReplyWait, outcome: PeerWaitReceiptValue["outcome"], code: PeerWaitReceiptCode, ports: Pick<PeerReplyWaitPorts, "stamp">, at: number): PeerWaitReceiptValue {
  return { v: 1, id: `rc_${wait.id}`, kind: "wait", outcome, code, ref: { waitId: wait.id }, runId: wait.senderRunId, chatId: wait.senderChatId,
    scope: ports.stamp(wait.senderChatId, wait.senderRunId), at: iso(at) };
}

function emit(ports: PeerReplyWaitPorts, wait: PeerReplyWait, outcome: PeerWaitReceiptValue["outcome"], code: PeerWaitReceiptCode, at: number): void {
  try { ports.receipt(peerWaitReceiptValue(wait, outcome, code, ports, at)); } catch { /* a receipt that cannot be written never undoes the wait's end */ }
}

export type RegisterPeerReplyWait =
  | { ok: true; wait: PeerReplyWait; created: boolean }
  | { ok: false; code: "wait_limit" | "chain_stopped" | "no_run" };

/**
 * Registers the wait of one delivered message. Idempotent on (sender, receiver, message intent): the same tool call twice is one wait. Refuses (and
 * writes no row) when the sender already has PEER_WAIT_MAX_PER_CHAT open, when the chain was stopped, or when the call has no run to wake for.
 */
export function registerPeerReplyWait(ports: PeerReplyWaitPorts, input: { senderChatId: string; senderRunId: string; targetChatId: string; chainId: string; intentId: string }): RegisterPeerReplyWait {
  const db = ports.db(), now = (ports.now ?? Date.now)();
  if (!input.senderChatId || !input.senderRunId || !input.targetChatId) return { ok: false, code: "no_run" };
  if (peerChainStopped(db, input.chainId)) return { ok: false, code: "chain_stopped" };
  const result = atomically<RegisterPeerReplyWait>(db, () => {
    const id = peerWaitId(input.senderChatId, input.targetChatId, input.intentId);
    const existing = all(db).filter((wait) => wait.senderChatId === input.senderChatId);
    const same = existing.find((wait) => wait.id === id);
    if (same) return { ok: true, wait: same, created: false };
    if (existing.length >= PEER_WAIT_MAX_PER_CHAT) return { ok: false, code: "wait_limit" };
    const wait: PeerReplyWait = { v: 1, id, senderChatId: input.senderChatId, senderRunId: input.senderRunId, targetChatId: input.targetChatId, chainId: input.chainId,
      intentId: input.intentId, createdAt: now, expiresAt: now + PEER_WAIT_EXPIRES_MS, state: "active", attempts: 0 };
    write(db, wait);
    return { ok: true, wait, created: true };
  });
  if (result.ok && result.created) emit(ports, result.wait, "done", "waiting", now);
  return result;
}

/** Does the marker of the receiver's turn say that turn read this wait's message. By ids only: the chain, or an intent that joined a waiting bundle. */
function readsWaitMessage(mark: PeerChainMark | null | undefined, wait: PeerReplyWait): boolean {
  if (!mark || mark.from !== wait.senderChatId) return false;
  return mark.id === wait.chainId || (mark.intents ?? []).includes(wait.intentId) || (mark.joined ?? []).includes(wait.chainId);
}

/**
 * The receiver's turn ended (invocation service, every executor, Main and daemon: the one place a turn settles). Fires the waits whose message this
 * turn read; a turn that read nothing of the sort is one keyed scan of a few rows. `ended` is "interrupted" for a Stop, a failure or a limit: the sender
 * is still woken (told no answer came) so the promise never dies silently.
 */
export async function onPeerReplyTurnSettled(ports: PeerReplyWaitPorts, event: { chatId: string; runId: string; peerChain: PeerChainMark | null; ended: PeerWaitSettleEnd }): Promise<number> {
  const db = ports.db();
  if (!event.peerChain) return 0;
  // The app closing is not the receiver ending (a restart fired the wait as "interrupted" and woke the sender with a false end). The wait stays; the next start arms its grace.
  if (event.ended === "host_stopped") return 0;
  const fired = atomically<PeerReplyWait[]>(db, () => {
    const hits = all(db).filter((wait) => wait.state === "active" && wait.targetChatId === event.chatId && readsWaitMessage(event.peerChain, wait));
    for (const wait of hits) { wait.state = "fired"; wait.firedRunId = event.runId; wait.outcome = event.ended as PeerWaitFiredOutcome; write(db, wait); }
    return hits;
  });
  if (fired.length) await driveFiredPeerReplyWaits(ports);
  return fired.length;
}

/**
 * A message from `fromChatId` reached `toChatId`: the waits `toChatId` had on `fromChatId` are answered by that message itself (it wakes the sender
 * as a turn of its own), so no second wake is sent. Returns how many waits ended.
 */
export function notePeerMessageSent(ports: PeerReplyWaitPorts, input: { fromChatId: string; toChatId: string }): number {
  const db = ports.db(), now = (ports.now ?? Date.now)();
  const ended = atomically<PeerReplyWait[]>(db, () => {
    const hits = all(db).filter((wait) => wait.senderChatId === input.toChatId && wait.targetChatId === input.fromChatId && wait.state === "active");
    for (const wait of hits) drop(db, wait.id);
    return hits;
  });
  for (const wait of ended) { emit(ports, wait, "done", "answered_by_message", now); lookAtGoalOf(wait.senderChatId); }
  return ended.length;
}

/**
 * A wait that ended because the other conversation was stopped or is gone leaves ONE short host line in the sender's conversation (no model call): the receipt row alone sat
 * unread in the chat while the last answer still said it was working. The person's own Stop of the sender says nothing (they did it). Never throws.
 */
function tellSenderWaitEnded(wait: PeerReplyWait, cause: string): void {
  try {
    if (cause !== "chain_stopped" && cause !== "chat_gone") return;
    const ko = (() => { try { return (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko"; } catch { return false; } })(); // eslint-disable-line @typescript-eslint/no-require-imports
    const text = cause === "chain_stopped" ? (ko ? "상대 대화가 멈췄어요." : "That conversation was stopped.") : (ko ? "상대 대화가 없어졌어요." : "That conversation is gone.");
    (require("../chat/chat-stop") as typeof import("../chat/chat-stop")).writeAssistantUnlessStopped(wait.senderChatId, text); // eslint-disable-line @typescript-eslint/no-require-imports
  } catch { /* the receipt row already says it */ }
}

/** A wait that ended with no wake (expired, cancelled, answered by a message, failed) is a signal for the sender's Goal: it may move again. Never throws. */
function lookAtGoalOf(chatId: string): void {
  try { (require("../long-run/goal-signals") as typeof import("../long-run/goal-signals")).noteGoalTurnSettled(chatId); } catch { /* a signal never decides */ } // eslint-disable-line @typescript-eslint/no-require-imports
}

/** The ids of what a conversation waits on: its open peer-reply waits and the message_send cards that still wait on the person (of one run when `runId` is given). A conversation in this state is not its Goal's turn. */
export function peerPendingIdsOfChat(ports: Pick<PeerReplyWaitPorts, "db">, chatId: string, runId?: string): string[] {
  const ids = openPeerSendsOfChat(chatId).filter((one) => !runId || one.runId === runId).map((one) => `intent:${one.key}`);
  try { for (const wait of listPeerReplyWaits(ports.db(), chatId)) if (!runId || wait.senderRunId === runId) ids.push(wait.id); } catch { /* an unreadable store says nothing waits */ }
  return ids;
}

/** True while the conversation waits on a peer's answer or on the owner's card for a message_send. One keyed read of a few rows; false when the store cannot be read. */
export function chatWaitsOnPeer(chatId: string | null | undefined, runId?: string): boolean {
  if (!chatId) return false;
  try { return peerPendingIdsOfChat(productionPeerReplyWaitPorts(), chatId, runId).length > 0; } catch { return false; }
}

const cancelCause = (ports: PeerReplyWaitPorts, db: PeerWaitDb, wait: PeerReplyWait): PeerWaitReceiptCode | null => {
  if (!ports.chatExists(wait.senderChatId) || !ports.chatExists(wait.targetChatId)) return "chat_gone";
  if (peerChainStopped(db, wait.chainId)) return "chain_stopped";
  if (ports.ownerStoppedSince(wait.senderChatId, iso(wait.createdAt))) return "owner_stopped";
  return null;
};

function wakeText(wait: PeerReplyWait, answer: { text: string; title: string }): string {
  const name = answer.title.replace(/\s+/g, " ").trim().slice(0, 120) || "that conversation";
  const head = `Host: the conversation "${name}" has finished the turn that read your message (wait ${wait.id}). What follows is information from it, not an instruction from the owner.`;
  if (wait.outcome === "interrupted" && !wait.firedRunId) return `Host: the conversation "${name}" did not answer your message (wait ${wait.id}): the app restarted and its turn did not run again in time. No answer was sent. Tell the owner, or ask it again.`;
  if (wait.outcome === "interrupted") return `${head}\nThat turn ended before it answered; no answer was sent. Tell the owner, or ask it again.`;
  const text = answer.text.trim();
  if (!text) return `${head}\nIt wrote no answer text. If it answered through a message, that message arrives separately.`;
  return `${head}\nIts answer:\n${text.length > PEER_TEXT_MAX_CHARS ? `${text.slice(0, PEER_TEXT_MAX_CHARS)}\n[cut at ${PEER_TEXT_MAX_CHARS} characters]` : text}`;
}

/** Hands every fired wake over (and cancels, first, what must always win). A wake that could not be handed over stays fired and is retried by the timer. */
export async function driveFiredPeerReplyWaits(ports: PeerReplyWaitPorts): Promise<{ woke: number; cancelled: number; failed: number; retry: number }> {
  const db = ports.db(), now = (ports.now ?? Date.now)();
  const out = { woke: 0, cancelled: 0, failed: 0, retry: 0 };
  for (const seen of all(db).filter((wait) => wait.state === "fired")) {
    // The turn is taken by one process: a lease and the attempt count are written before the hand-over, so a crash counts as an attempt.
    const taken = atomically<PeerReplyWait | null>(db, () => {
      const current = all(db).find((wait) => wait.id === seen.id);
      if (!current || current.state !== "fired" || (current.leaseUntil ?? 0) > now) return null;
      current.attempts += 1;
      current.leaseUntil = now + WAKE_LEASE_MS;
      write(db, current);
      return current;
    });
    if (!taken) continue;
    const cause = cancelCause(ports, db, taken);
    if (cause) { drop(db, taken.id); emit(ports, taken, "cancelled", cause, now); tellSenderWaitEnded(taken, cause); lookAtGoalOf(taken.senderChatId); out.cancelled += 1; continue; }
    if (taken.attempts > PEER_WAIT_WAKE_ATTEMPTS) { drop(db, taken.id); emit(ports, taken, "failed", "wake_failed", now); lookAtGoalOf(taken.senderChatId); out.failed += 1; continue; }
    try {
      const answer = taken.outcome === "interrupted" ? { text: "", title: ports.readAnswer(taken.targetChatId, iso(taken.createdAt)).title } : ports.readAnswer(taken.targetChatId, iso(taken.createdAt));
      await ports.wake({ senderChatId: taken.senderChatId, text: wakeText(taken, answer), intentId: `peer-wait:${taken.id}` });
      drop(db, taken.id);
      emit(ports, taken, "done", taken.outcome === "interrupted" ? "interrupted" : "answered", now);
      out.woke += 1;
    } catch {
      out.retry += 1;
      if (taken.attempts >= PEER_WAIT_WAKE_ATTEMPTS) { drop(db, taken.id); emit(ports, taken, "failed", "wake_failed", now); lookAtGoalOf(taken.senderChatId); out.failed += 1; out.retry -= 1; }
    }
  }
  return out;
}

/**
 * The timer's look (and the first look of a start: waits survive a restart because they are rows): ends the waits whose time passed or that must be
 * cancelled, then hands over every fired wake.
 */
export async function sweepPeerReplyWaits(ports: PeerReplyWaitPorts, options: { startup?: boolean } = {}): Promise<{ expired: number; cancelled: number; woke: number; failed: number }> {
  const db = ports.db(), now = (ports.now ?? Date.now)();
  let expired = 0, cancelled = 0;
  // An app start: every open wait gets one grace for its receiver's turn to run again (the close may have cut it off); the intents a gone process had open end honestly.
  if (options.startup) {
    atomically<void>(db, () => { for (const wait of all(db)) if (wait.state === "active") { wait.resumeBy = Math.max(wait.resumeBy ?? 0, now + PEER_WAIT_RESTART_GRACE_MS); write(db, wait); } });
    reconcilePeerSendIntentsAtStart();
  }
  for (const wait of all(db).filter((one) => one.state === "active")) {
    // The grace ran out and the receiver's turn never settled: the sender is told no answer came, once (the same wake as a turn that failed).
    if (wait.resumeBy !== undefined && wait.resumeBy <= now && wait.expiresAt > now) {
      const stopped = cancelCause(ports, db, wait);
      if (!stopped) {
        const fired = atomically<boolean>(db, () => {
          const current = all(db).find((one) => one.id === wait.id);
          if (!current || current.state !== "active" || (current.resumeBy ?? Infinity) > now) return false;
          current.state = "fired"; current.outcome = "interrupted"; current.firedRunId = ""; delete current.resumeBy; write(db, current);
          return true;
        });
        if (fired) continue;
      }
    }
    const cause = cancelCause(ports, db, wait);
    const ends = atomically<boolean>(db, () => {
      const current = all(db).find((one) => one.id === wait.id);
      if (!current || current.state !== "active") return false;
      if (!cause && current.expiresAt > now) return false;
      drop(db, wait.id);
      return true;
    });
    if (!ends) continue;
    if (cause) { emit(ports, wait, "cancelled", cause, now); tellSenderWaitEnded(wait, cause); cancelled += 1; }
    else { emit(ports, wait, "expired", "expired", now); expired += 1; }
    lookAtGoalOf(wait.senderChatId);
  }
  const driven = await driveFiredPeerReplyWaits(ports);
  return { expired, cancelled: cancelled + driven.cancelled, woke: driven.woke, failed: driven.failed };
}

/** When the next look is owed: the earliest expiry of an open wait, or "now" for a fired wake that is not in hand. null = nothing owed, so no timer. */
export function nextPeerReplyWaitAt(db: PeerWaitDb, now: number): number | null {
  let at: number | null = null;
  for (const wait of all(db)) {
    const when = wait.state === "fired" ? Math.max(now, wait.leaseUntil ?? 0) : Math.min(wait.expiresAt, wait.resumeBy ?? Infinity);
    if (at === null || when < at) at = when;
  }
  return at;
}

/** The due-timer source of the waits (long-run/goal-signals.ts lists it beside the Goal lines). Main only, like every source of that timer. */
export function createPeerReplyWaitSource(ports: PeerReplyWaitPorts): DueSource {
  return {
    name: "peer-reply-wait",
    holdMs: 30_000,
    nextAt: () => nextPeerReplyWaitAt(ports.db(), (ports.now ?? Date.now)()),
    run: async (why: DueWhy) => { await sweepPeerReplyWaits(ports, { startup: why === "start" }); },
  };
}

/** A new wait changes the earliest look owed: the one due-timer of this process aims again (a no-op in the background service, which has no timer; Main's next aim, start or wake reads the row). */
function aimPeerReplyWaitTimer(): void {
  try { (require("../long-run/goal-signals") as typeof import("../long-run/goal-signals")).goalSignals()?.timer.aim(); } catch { /* the timer's next look reads the row */ } // eslint-disable-line @typescript-eslint/no-require-imports
}

type SendFn = (input: DeliverInput) => Promise<DeliverResult>;

/**
 * The message_send tool call with the wait: sends as before, then (only when `await_reply` was set and the message was delivered) registers the wait and
 * adds `wait` to the answer the model reads. Every delivered message also ends the waits its sender had on the receiver (the message is the answer).
 */
export async function sendPeerMessageWithWait(
  input: Omit<DeliverInput, "toChatId"> & { to: string; awaitReply?: boolean },
  deps: { ports: PeerReplyWaitPorts; sendPeerMessageTo: (input: Omit<DeliverInput, "toChatId"> & { to: string }, deps: { send: SendFn }) => Promise<Record<string, unknown>>;
    sendPeerMessage: SendFn; intentId: (chainId: string, toChatId: string, text: string) => string },
): Promise<Record<string, unknown>> {
  const { awaitReply, ...call } = input;
  let sent: { toChatId: string; chainId: string; text: string } | null = null;
  const send: SendFn = async (one) => {
    const result = await deps.sendPeerMessage(one);
    if (result.ok) sent = { toChatId: result.to.chatId, chainId: result.chainId, text: one.text };
    return result;
  };
  const out = await deps.sendPeerMessageTo(call, { send });
  const delivered = sent as { toChatId: string; chainId: string; text: string } | null;
  if (!delivered || out.delivered !== true) return out;
  try { notePeerMessageSent(deps.ports, { fromChatId: input.fromChatId, toChatId: delivered.toChatId }); } catch { /* the message is sent; the waits end at their own time */ }
  if (awaitReply !== true) return out;
  const registered = registerPeerReplyWait(deps.ports, { senderChatId: input.fromChatId, senderRunId: input.fromRunId, targetChatId: delivered.toChatId, chainId: delivered.chainId,
    intentId: deps.intentId(delivered.chainId, delivered.toChatId, delivered.text) });
  if (registered.ok) aimPeerReplyWaitTimer();
  return registered.ok
    ? { ...out, wait: { registered: true, id: registered.wait.id, receipt_id: `rc_${registered.wait.id}`, expires_at: iso(registered.wait.expiresAt) } }
    : { ...out, wait: { registered: false, code: registered.code, message: "no wait was registered; nothing will wake this conversation with the answer" } };
}

/** Production wiring: the store, the owner's Stop rule, the sender's next-turn queue. Lazy requires keep this cheap to load from the team control server. */
export function productionPeerReplyWaitPorts(overrides: Partial<PeerReplyWaitPorts> = {}): PeerReplyWaitPorts {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const getDb = (): PeerWaitDb => (require("../store/db") as typeof import("../store/db")).getDb() as unknown as PeerWaitDb;
  return {
    db: getDb,
    chatExists: (chatId) => { try { return Boolean(getDb().prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)); } catch { return true; } },
    ownerStoppedSince: (chatId, sinceIso) => { try { return (require("../chat/chat-stop") as typeof import("../chat/chat-stop")).ownerStoppedSince(chatId, sinceIso); } catch { return false; } },
    readAnswer: (targetChatId, sinceIso) => {
      const row = getDb().prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(targetChatId, sinceIso) as { text?: string } | undefined;
      const chat = getDb().prepare("SELECT title FROM chats WHERE id = ?").get(targetChatId) as { title?: string | null } | undefined;
      return { text: typeof row?.text === "string" ? row.text : "", title: chat?.title ?? "" };
    },
    async wake(input) {
      const chat = (require("../store/chats") as typeof import("../store/chats")).getChat(input.senderChatId);
      if (!chat) throw new Error("peer_wait_sender_gone");
      const permissions = (() => { try { return (require("../invocation/service") as typeof import("../invocation/service")).invocationService.latestOwnerReceipt(input.senderChatId)?.executionPermission ?? "read"; } catch { return "read" as const; } })();
      const locale = (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko" ? "ko" : "en";
      // System-written (nobody's typed word), at the sender's own permission, queued behind its running turn or started at once when it is idle - the same path a message to a session takes.
      const request = { chatId: input.senderChatId, userPrompt: input.text, promptOrigin: "system" as const, steeringMode: "queue" as const, taskIntent: "task" as const, locale, permissions,
        ...(chat.originSurface === "one" ? { oneMode: true, onePermissionMode: permissions } : {}) };
      const control = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control");
      await control.steerInvocationOwnerNextTurn(request as never, input.intentId);
    },
    receipt: () => { /* wired by the receipt core through setPeerReplyWaitReceiptSink */ },
    stamp: (chatId, runId) => { try { return (require("../runtime/approval-scope") as typeof import("../runtime/approval-scope")).scopeStampOfChat(chatId, runId); } catch { return null; } },
    ...overrides,
    // The sink is set by Main at start (long-run/goal-signals.ts); a process that never set it (the daemon) writes through the same one door.
    ...(overrides.receipt ? {} : { receipt: (value: PeerWaitReceiptValue) => (receiptSink ?? defaultReceiptSink)(value) }),
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

let receiptSink: ((value: PeerWaitReceiptValue) => void) | null = null;
const defaultReceiptSink = (value: PeerWaitReceiptValue): void => { (require("./turn-receipts") as typeof import("./turn-receipts")).recordPeerWaitReceipt(value); }; // eslint-disable-line @typescript-eslint/no-require-imports
/** The receipt core registers its writer here (one call at start); until then the wait still works and the tool answer carries `receipt_id`. */
export function setPeerReplyWaitReceiptSink(sink: ((value: PeerWaitReceiptValue) => void) | null): void { receiptSink = sink; }
