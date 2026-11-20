import { createHash } from "node:crypto";

/*
 * The life of one message_send intent.
 *
 * A send can wait on a person: the card that picks the receiving conversation (peer-target-card.ts) or the first-send approval card (deliver.ts). The tool's wire is
 * 200 s (one/team-mcp-server.ts) and Codex ends an MCP tool at 60 s, so the CALL answers within PEER_SEND_ANSWER_WINDOW_MS and the INTENT goes on without it.
 *
 *   starting -> asking_target -> asking_consent -> working -> (sent | refused)
 *
 * The card belongs to the intent, not to the turn (an earlier version closed it with the turn, so the model's last words "a card is up, approve it" were false once the turn
 * ended, and a press a second before the turn ended was lost). An unanswered card stays in its conversation until it is answered or reaches its own deadline
 * (ask-user 10 min, approval 5 min). A late answer makes the host do the send exactly once, with no model call (the text and the target are known): the one receipt row
 * of the intent updates and the sender's conversation gets one host line. It closes only for the person's Stop of the sender (closePeerSendsOfChat), the sender being
 * gone, or the app ending (a restart: reconcilePeerSendIntentsAtStart writes the one honest receipt).
 *
 * The same call asked again - from this turn or a later one - joins the intent that is open (never a second card), or receives the finished outcome once. The intent is
 * keyed by what the call IS (conversation, target words, text), not by the run, so a new turn never sends again what an old one is still asking about. The card says
 * which request it is for (an excerpt of the message), so an old card in a new turn is not mistaken for that turn's.
 *
 * Storage: memory (this process) + ONE meta row `peer-intent:<key>` per open intent. WHO WRITES: this module at each phase change. WHO READS: the start-up reconcile
 * (a row whose process is gone). WHEN DELETED: the intent ended, or the reconcile closed it. At most PEER_INTENT_MAX_OPEN_PER_CHAT open per conversation.
 * No electron import: the team control server runs in the background service too (every other module is a lazy require inside a try).
 */

/** Under Codex's own 60 s tool limit (the shortest runtime wire) and the child's 200 s: the model hears "waiting" before any runtime gives up for it. */
export const PEER_SEND_ANSWER_WINDOW_MS = 45_000;
/** Open intents of one conversation: each holds a card the person must answer; a runaway turn cannot stack more. */
export const PEER_INTENT_MAX_OPEN_PER_CHAT = 4;
/** An intent still open after this long is not joined any more (its two cards end at 10 + 5 min; a hung one must not answer "waiting" for ever). */
export const PEER_INTENT_MAX_AGE_MS = 30 * 60_000;
/** A finished outcome nobody asked for again is dropped after this long. */
const UNCLAIMED_KEEP_MS = 5 * 60_000;
const MAX_KEPT = 64;
export const PEER_INTENT_KEY_PREFIX = "peer-intent:";
export const PEER_INTENT_STOP_REASON = "peer_send_owner_stop";

export type PeerSendPhase =
  | { phase: "starting" | "working" }
  | { phase: "asking_target"; /** Titles of the conversations the card offers (what the model may tell the person). */ candidates?: string[] }
  | { phase: "asking_consent"; toChatId: string; intentId: string; toTitle?: string };

export interface PeerSendWindowInput {
  /** Kept for callers; the intent is not keyed by it (a capability ends with its turn, the intent does not). */
  capabilityId?: string;
  chatId: string;
  runId: string;
  to: string;
  text: string;
  awaitReply: boolean;
  replyTo?: string;
  windowMs?: number;
}
export interface PeerSendWindowPorts {
  /** Does the send, with the intent's own signal, the progress callback it must hand to sendPeerMessageWithWait, and the intent's receipt key. */
  run(extra: { signal: AbortSignal; progress: (p: PeerSendPhase) => void; receiptKey: string }): Promise<Record<string, unknown>>;
  /** One receipt for a send that is not sent yet because the owner has not answered (turn-receipts.recordMessageReceipt). Never throws. */
  receipt(input: { fromChatId: string; fromRunId: string; toChatId: string | null; text: string; intentId: string | null; receiptKey: string; result: { delivered: false; code: string } }): void;
  /** What the host does when an intent ends after its caller was told "waiting" and nobody is waiting for the result: one line in the sender's conversation. Defaults to production. */
  late?(event: { chatId: string; result: Record<string, unknown> | null; lost: boolean }): void;
}

interface Intent {
  key: string; chatId: string; runId: string; startedAt: number;
  controller: AbortController;
  phase: PeerSendPhase;
  toChatId: string | null; chars: number;
  promise: Promise<Settled>;
  waiters: number; told: boolean;
}
type Settled = { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown };

const open = new Map<string, Intent>();
const finished = new Map<string, { settled: Settled; at: number }>();

const norm = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** What the call IS: the sender conversation, the words of the target, the text. Never the run or the capability (they end with a turn). */
export function peerIntentKey(input: Pick<PeerSendWindowInput, "chatId" | "to" | "text" | "awaitReply" | "replyTo">): string {
  return createHash("sha256").update("peer-intent-v2\0").update(JSON.stringify([input.chatId, norm(input.to), norm(input.text), input.awaitReply === true, input.replyTo ?? null])).digest("hex").slice(0, 32);
}

/* ---------------------------------------------------------------------------------------------- the row (restart) */

interface IntentRow { v: 1; key: string; chatId: string; runId: string; toChatId: string | null; chars: number; pid: number; at: number }
const db = (): { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } | null => {
  try { return (require("../store/db") as typeof import("../store/db")).getDb() as never; } catch { return null; } // eslint-disable-line @typescript-eslint/no-require-imports
};
function writeRow(intent: Intent): void {
  try {
    const row: IntentRow = { v: 1, key: intent.key, chatId: intent.chatId, runId: intent.runId, toChatId: intent.toChatId, chars: intent.chars, pid: process.pid, at: intent.startedAt };
    db()?.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(PEER_INTENT_KEY_PREFIX + intent.key, JSON.stringify(row));
  } catch { /* the in-memory intent still works; a restart cannot reconcile it, and its receipt row then stays until the owner reads it */ }
}
const dropRow = (key: string): void => { try { db()?.prepare("DELETE FROM meta WHERE key = ?").run(PEER_INTENT_KEY_PREFIX + key); } catch { /* the reconcile drops it */ } };
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string } | null)?.code === "EPERM"; } };

/* ---------------------------------------------------------------------------------------------- the open set */

/** The intents this conversation still has open, with the run that first asked (the Goal reads it: a conversation waiting on a person is not its turn). */
export function openPeerSendsOfChat(chatId: string): Array<{ key: string; runId: string }> {
  const out: Array<{ key: string; runId: string }> = [];
  const now = Date.now();
  for (const intent of [...open.values()]) {
    if (intent.chatId !== chatId) continue;
    // A hung intent (its two cards end at 10 + 5 min) is not "waiting" any more: it must not keep a Goal asleep for ever.
    if (now - intent.startedAt > PEER_INTENT_MAX_AGE_MS) { try { intent.controller.abort(new Error("peer_intent_too_old")); } catch { /* ends itself */ } open.delete(intent.key); continue; }
    out.push({ key: intent.key, runId: intent.runId });
  }
  return out;
}
export const openPeerSendKeysOfChat = (chatId: string): string[] => openPeerSendsOfChat(chatId).map((one) => one.key);

/** Kept for the capability's end (one/team-control-server.ts removeOneTeamCapability): the end of a TURN no longer closes a card. Always 0. */
export function closePeerSendsOf(_capabilityId: string): number { return 0; }

/** The person's Stop of the sender (chat/chat-stop.ts), or the sender being deleted: its open intents close, nothing is sent for them. */
export function closePeerSendsOfChat(chatId: string): number {
  let n = 0;
  for (const intent of [...open.values()]) {
    if (intent.chatId !== chatId) continue;
    n += 1;
    try { intent.controller.abort(new Error(PEER_INTENT_STOP_REASON)); } catch { /* the card's own end handles it */ }
  }
  return n;
}

function expireKept(now: number): void {
  for (const [key, entry] of finished) if (now - entry.at > UNCLAIMED_KEEP_MS) finished.delete(key);
  while (finished.size > MAX_KEPT) finished.delete(finished.keys().next().value as string);
}

/* ---------------------------------------------------------------------------------------------- answers the model reads */

export const waitingForOwnerAnswer = (phase?: PeerSendPhase): Record<string, unknown> => ({
  delivered: false, code: "waiting_for_owner",
  ...(phase?.phase === "asking_target" ? { asking: "pick_conversation", ...(phase.candidates?.length ? { candidates: phase.candidates.slice(0, 7) } : {}) } : {}),
  ...(phase?.phase === "asking_consent" ? { asking: "approve_send", ...(phase.toTitle ? { to: phase.toTitle } : {}) } : {}),
  message: "the owner was asked on a card in this conversation and has not answered yet; nothing was sent yet. The card stays until the owner answers it or it expires, and when it is answered the host sends the message by itself, once. Do not send it again and do not ask the owner in words; tell the owner the card is waiting, then end your turn" });
export const deliveryPendingAnswer = (): Record<string, unknown> => ({ delivered: false, pending: true, code: "delivery_pending",
  message: "the delivery has not finished yet and its outcome is not known; do not send it again. Repeat this same call to read its result (it is not sent a second time)" });
export const tooManyOpenAnswer = (): Record<string, unknown> => ({ delivered: false, code: "waiting_for_owner", asking: "other_cards_open",
  message: "earlier messages of this conversation still wait on the owner's cards; nothing was sent for this one. Tell the owner to answer or close those cards first" });

/* ---------------------------------------------------------------------------------------------- the host's line */

function say(chatId: string, result: Record<string, unknown> | null, lost: boolean): void {
  try {
    const ko = (() => { try { return (require("../ui-locale") as typeof import("../ui-locale")).currentUiLocale() === "ko"; } catch { return false; } })(); // eslint-disable-line @typescript-eslint/no-require-imports
    let text: string;
    if (!lost && result && result.delivered === true) {
      const to = typeof result.to === "string" && result.to ? result.to : "";
      text = ko ? `카드에서 답하신 메시지를 ${to ? `「${to}」 대화로 ` : ""}보냈어요.` : `The message you answered the card for was sent${to ? ` to "${to}"` : ""}.`;
    } else {
      const code = lost ? "intent_lost" : typeof result?.code === "string" ? result.code : "";
      const why = (require("../../shared/owner-remedy") as typeof import("../../shared/owner-remedy")).remedyWordsOf(code, ko ? "ko" : "en"); // eslint-disable-line @typescript-eslint/no-require-imports
      text = ko ? `보내지 않았어요${why ? ` · ${why}` : ""}.` : `Not sent${why ? ` · ${why}` : ""}.`;
    }
    (require("../chat/chat-stop") as typeof import("../chat/chat-stop")).writeAssistantUnlessStopped(chatId, text); // eslint-disable-line @typescript-eslint/no-require-imports
  } catch { /* the receipt row already says it */ }
}
function lookAtGoalOf(chatId: string): void {
  try { (require("../long-run/goal-signals") as typeof import("../long-run/goal-signals")).noteGoalTurnSettled(chatId); } catch { /* a signal never decides */ } // eslint-disable-line @typescript-eslint/no-require-imports
}

/* ---------------------------------------------------------------------------------------------- the call */

export async function answerPeerSendWithin(input: PeerSendWindowInput, ports: PeerSendWindowPorts): Promise<Record<string, unknown>> {
  const now = Date.now();
  expireKept(now);
  const key = peerIntentKey(input);
  const kept = finished.get(key);
  if (kept) { finished.delete(key); if (kept.settled.ok) return kept.settled.value; throw kept.settled.error; }
  let intent = open.get(key);
  if (intent && now - intent.startedAt > PEER_INTENT_MAX_AGE_MS) { try { intent.controller.abort(new Error("peer_intent_too_old")); } catch { /* ends itself */ } open.delete(key); intent = undefined; }
  if (!intent) {
    if (openPeerSendKeysOfChat(input.chatId).length >= PEER_INTENT_MAX_OPEN_PER_CHAT) return tooManyOpenAnswer();
    const created: Intent = { key, chatId: input.chatId, runId: input.runId, startedAt: now, controller: new AbortController(), phase: { phase: "starting" },
      toChatId: null, chars: [...input.text.trim()].length, promise: undefined as unknown as Promise<Settled>, waiters: 0, told: false };
    const late = ports.late ?? ((event) => { say(event.chatId, event.result, event.lost); });
    created.promise = Promise.resolve().then(() => ports.run({ signal: created.controller.signal, receiptKey: key, progress: (p) => {
      created.phase = p;
      if (p.phase === "asking_consent") created.toChatId = p.toChatId;
      if (p.phase === "asking_target" || p.phase === "asking_consent") writeRow(created); // a person is being asked: a restart must be able to say what happened
    } })).then<Settled, Settled>((value) => ({ ok: true, value }), (error) => ({ ok: false, error })).then((settled) => {
      if (open.get(key) === created) open.delete(key);
      dropRow(key);
      // The intent is over, whatever it ended as (sent, refused for an empty body, declined): a card of it that is still drawn has nothing behind it and closes.
      closeOrphanPeerSendCards(created.chatId);
      // Registered before any caller's wait: a caller still waiting at this moment gets the outcome directly. Only a caller that was told "waiting" and is gone is owed a line.
      if (created.told && created.waiters === 0) {
        finished.set(key, { settled, at: Date.now() }); expireKept(Date.now());
        if (settled.ok) late({ chatId: created.chatId, result: settled.value, lost: false });
        lookAtGoalOf(created.chatId);
      }
      return settled;
    });
    open.set(key, created);
    intent = created;
  }
  const current = intent;
  current.waiters += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windowEnd = new Promise<"window">((resolve) => { timer = setTimeout(() => resolve("window"), input.windowMs ?? PEER_SEND_ANSWER_WINDOW_MS); timer.unref?.(); });
  let out: Settled | "window";
  try { out = await Promise.race([current.promise, windowEnd]); }
  finally { if (timer) clearTimeout(timer); current.waiters -= 1; }
  if (out !== "window") { if (out.ok) return out.value; throw out.error; }
  current.told = true;
  const phase = current.phase;
  if (phase.phase === "asking_target" || phase.phase === "asking_consent") {
    // One row for the intent from its first card to its end (receiptKey), so a late answer turns this row into the sent / refused one.
    try { ports.receipt({ fromChatId: current.chatId, fromRunId: current.runId, toChatId: phase.phase === "asking_consent" ? phase.toChatId : null, text: input.text,
      intentId: phase.phase === "asking_consent" ? phase.intentId : null, receiptKey: key, result: { delivered: false, code: "waiting_for_owner" } }); } catch { /* the tool answer still says it */ }
    return waitingForOwnerAnswer(phase);
  }
  return deliveryPendingAnswer();
}

/* ---------------------------------------------------------------------------------------------- restart */

/**
 * A process start (the due-timer's first look): the intents a process that is gone had open lose their cards with it. Each ends as ONE honest receipt on its own row
 * ("the card closed, nothing was sent") and one line in the conversation, so the model's last words never outlive the card. A row whose process is alive (the background
 * service's) is left. Returns how many were closed. Never throws.
 */
export function reconcilePeerSendIntentsAtStart(): number {
  let closed = 0;
  try {
    const handle = db();
    if (!handle) return 0;
    const rows = handle.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?").all(PEER_INTENT_KEY_PREFIX, PEER_INTENT_KEY_PREFIX.slice(0, -1) + ";") as Array<{ key: string; value: string }>;
    for (const entry of rows) {
      let row: IntentRow | null = null;
      try { row = JSON.parse(entry.value) as IntentRow; } catch { row = null; }
      const key = entry.key.slice(PEER_INTENT_KEY_PREFIX.length);
      if (row && open.has(key)) continue;
      if (row && Number.isFinite(row.pid) && row.pid !== process.pid && pidAlive(row.pid)) continue;
      handle.prepare("DELETE FROM meta WHERE key = ?").run(entry.key);
      if (!row || typeof row.chatId !== "string" || typeof row.runId !== "string") continue;
      closed += 1;
      try {
        (require("./turn-receipts") as typeof import("./turn-receipts")).recordMessageReceipt({ fromChatId: row.chatId, fromRunId: row.runId, toChatId: row.toChatId, text: "", chars: Math.max(0, row.chars || 0), receiptKey: key, // eslint-disable-line @typescript-eslint/no-require-imports
          result: { delivered: false, code: "intent_lost" } });
      } catch { /* the line below still says it */ }
      closeOrphanPeerSendCards(row.chatId);
      say(row.chatId, null, true);
      lookAtGoalOf(row.chatId);
    }
  } catch { /* the next start looks again */ }
  return closed;
}

/**
 * A card is either live and owned by an intent, or closed. Closes every message_send card of `chatId` (the target question and the first-send approval) that no open
 * intent of this process stands behind, on every surface it was drawn (window, paired phone). Returns how many. Never throws.
 */
export function closeOrphanPeerSendCards(chatId: string): number {
  let n = 0;
  try { if (openPeerSendsOfChat(chatId).length) return 0; } catch { return 0; }
  try { n += (require("../confirm/ask-user") as typeof import("../confirm/ask-user")).closePendingAskUserOf({ chatId, askedBy: "message_send" }); } catch { /* none */ } // eslint-disable-line @typescript-eslint/no-require-imports
  try { n += (require("../runtime/tool-approval") as typeof import("../runtime/tool-approval")).closePendingToolApprovalsOf({ chatId, tool: "message_send" }); } catch { /* none */ } // eslint-disable-line @typescript-eslint/no-require-imports
  return n;
}

/** Gate-only. */
export function resetPeerSendWindowForTests(): void { for (const intent of open.values()) { try { intent.controller.abort(new Error("reset")); } catch { /* */ } } open.clear(); finished.clear(); }
