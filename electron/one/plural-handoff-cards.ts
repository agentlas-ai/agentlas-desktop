/**
 * Where a hand-off card is kept: ONE quiet 'view' row of the personal agent's conversation per piece of work, replaced as its state changes.
 *   sent card      `handoff-card:<row id>`  - the work THIS desktop's agent handed to another agent. Open states come from the sender's view (plural-handoff-send.ts `onCards`), the end from its persister; the server's row is the
 *                  only other copy, and it is taken (deleted) only after this row says the end (the persister answers true).
 *   received card  `handoff-recv:<row id>`  - the work another agent handed to THIS desktop's agent: written when the Work starts and again when it ends (plural-work-real.ts calls recordReceivedCard).
 * The row is a record: the model never reads a 'view' row, it is never the conversation's last message, and it goes with the conversation (no table of its own, no timer, no new retention rule). A card whose
 * words did not change writes nothing. Pure of Electron: the daemon loads it.
 */
import type { SentCard } from "./plural-handoff-wire";
import { HANDOFF_RECV_ROW_PREFIX, HANDOFF_SENT_ROW_PREFIX, HANDOFF_RESULT_CHARS, decodeHandoffCard, encodeHandoffCard, type HandoffAnswerLine, type HandoffCardState, type HandoffCardValue } from "../../shared/plural-handoff-card";

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;
const chats = (): typeof import("../store/chats") => req<typeof import("../store/chats")>("../store/chats");

/**
 * The personal agent's conversation of THIS signed-in account on this desktop, null when it has none. A machine can hold several personal identities (one per account slot, each bound to its own conversation in
 * `one_supervisor_conversations`); a card belongs to the identity that is current now, never to "the newest bound one" (prod test: a card went to a stale slot's two-message chat and the person never saw it).
 */
export function personalAgentChatId(): string | null {
  try {
    const db = req<typeof import("../store/db")>("../store/db").getDb();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_conversations'").get()) return null;
    const oneId = req<typeof import("../store/one-profile")>("../store/one-profile").getOneProfile().oneId;
    const row = db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(oneId) as { chat_id?: string } | undefined;
    return row?.chat_id ?? null;
  } catch { return null; }
}

/** A card with no words of its own work cannot be drawn (decodeHandoffCard needs a brief) and the server's open/done rows do not carry the brief: the card keeps the one the tool wrote, else this neutral mark. */
const NO_BRIEF = "\u2014";

/** A sender's card as the value the row keeps. `placeName` is the desktop's name (the card's header); absent = the header names the agent only. */
export function valueOfSentCard(card: SentCard & { placeName?: string }, ctx: { here?: boolean } = {}): HandoffCardValue {
  const phone = card.to === "phone";
  const state: HandoffCardState = card.state as HandoffCardState;
  const result = typeof card.result === "string" && card.result.trim() ? [...card.result].slice(0, HANDOFF_RESULT_CHARS).join("") : undefined;
  return {
    v: 1, k: "sent", id: card.id, agent: card.toName, brief: card.brief, state,
    ...(phone ? { phone: true as const } : card.placeName ? { place: card.placeName } : {}),
    ...(card.why ? { why: card.why } : {}),
    ...(typeof card.started === "boolean" ? { started: card.started } : {}),
    ...(card.state === "approval" ? { n: Math.max(1, card.approvals.length) } : {}),
    ...(result ? { result } : {}),
    // the server keeps the head of a result (2,000 characters): a result that reached it is not known to be the whole
    ...(result && [...result].length >= HANDOFF_RESULT_CHARS ? { more: true as const } : {}),
    ...(card.endedAt ? { at: card.endedAt } : {}),
    ...(card.lateEnd ? { late: true as const } : {}),
    ...(ctx.here ? { here: true as const } : {}),
    ...(card.to ? { to: card.to } : {}),
    ...(card.state === "approval" && card.approvals.length ? { q: card.approvals.slice(0, 8).map((a) => ({ qid: a.qid, kind: a.kind, target: a.target, ...(a.preview ? { preview: a.preview } : {}) })) } : {}),
  };
}

export type CardWrite = "written" | "updated" | "same" | "refused";

/** Writes (or replaces) the card row of a sent row. The chat is the one the row already lives in, else `chatId`, else the personal agent's conversation. */
export function recordSentCard(card: SentCard & { placeName?: string }, opts: { chatId?: string | null; createdAt?: string } = {}): CardWrite {
  try {
    const id = `${HANDOFF_SENT_ROW_PREFIX}${card.id}`;
    const c = chats();
    const chatId = c.chatOfViewRow(id) ?? opts.chatId ?? personalAgentChatId();
    if (!chatId) return "refused";
    // what this desktop answered here stays on the card (the new value is made from the server's row, which does not say it)
    const prior = decodeHandoffCard(c.getViewRowText(id));
    const kept = prior?.log;
    // the server's answer names no brief: the words the tool wrote at hand-off time stay (a card whose brief is empty is not drawn at all)
    const value = valueOfSentCard(card.brief.trim() ? card : { ...card, brief: prior?.brief || NO_BRIEF });
    return c.upsertViewNoticeRow({ id, chatId, text: encodeHandoffCard(kept?.length ? { ...value, log: kept } : value), createdAt: opts.createdAt ?? new Date().toISOString() });
  } catch { return "refused"; }
}

/** This desktop answered a question of a sent row: one quiet line on the card (allowed / denied here), the question's chip goes. */
export function recordAnswerLine(rowId: string, line: HandoffAnswerLine & { qid: string }): CardWrite {
  try {
    const id = `${HANDOFF_SENT_ROW_PREFIX}${rowId}`;
    const c = chats();
    const chatId = c.chatOfViewRow(id);
    const value = decodeHandoffCard(c.getViewRowText(id));
    if (!chatId || !value) return "refused";
    const { qid, ...entry } = line;
    const log = [...(value.log ?? []).filter((l) => !(l.kind === entry.kind && l.target === entry.target && l.at === entry.at)), entry].slice(-10);
    const q = (value.q ?? []).filter((x) => x.qid !== qid);
    const { q: _q, ...rest } = value;
    return c.upsertViewNoticeRow({ id, chatId, text: encodeHandoffCard({ ...rest, ...(q.length ? { q } : {}), log }), createdAt: new Date().toISOString() });
  } catch { return "refused"; }
}

/** The persister of the sender: an ended card is kept in the conversation, and only then may the server's row be taken. A card already kept is kept. */
export function sentCardPersister(card: SentCard & { placeName?: string }): boolean {
  const out = recordSentCard(card);
  return out === "written" || out === "updated" || out === "same";
}

/** What a received card is made from: the work's own facts, never model words. `end` is the end the host read from the Work's machine state (plural-work-real.ts outcome). */
export interface ReceivedCardInput {
  rowId: string;
  fromName: string;
  brief: string;
  /** The personal agent's conversation that received it (the request's origin chat). */
  chatId: string | null;
  phase: "running" | "approval" | "end";
  n?: number;
  end?: { state: "done" | "failed" | "stopped"; why?: string; started: boolean; text?: string };
  endedAt?: string;
  createdAt?: string;
}
export function recordReceivedCard(input: ReceivedCardInput): CardWrite {
  try {
    const id = `${HANDOFF_RECV_ROW_PREFIX}${input.rowId}`;
    const c = chats();
    const chatId = c.chatOfViewRow(id) ?? input.chatId ?? personalAgentChatId();
    if (!chatId) return "refused";
    const e = input.end;
    const result = e?.text && e.text.trim() ? [...e.text].slice(0, HANDOFF_RESULT_CHARS).join("") : undefined;
    const value: HandoffCardValue = {
      v: 1, k: "recv", id: input.rowId, agent: input.fromName, brief: input.brief,
      state: input.phase === "running" ? "claimed" : input.phase === "approval" ? "approval" : e!.state,
      ...(input.phase === "approval" ? { n: Math.max(1, input.n ?? 1) } : {}),
      ...(e?.why ? { why: e.why } : {}),
      ...(e ? { started: e.started } : {}),
      ...(result ? { result } : {}),
      ...(input.phase === "end" ? { at: input.endedAt ?? new Date().toISOString() } : {}),
      here: true,
    };
    return c.upsertViewNoticeRow({ id, chatId, text: encodeHandoffCard(value), createdAt: input.createdAt ?? new Date().toISOString() });
  } catch { return "refused"; }
}

/**
 * Wire the sender to the conversation: every answer's cards (open ones included) are written when their words changed, the persister keeps the ended ones. Returns the stop.
 * `sender` is the process's own sender (plural-handoff-send.ts pluralSender()).
 */
export function startSentCardRows(sender: { onCards(listener: (cards: readonly SentCard[]) => void): () => void; setPersister(fn: ((card: SentCard) => boolean) | null): void }): () => void {
  sender.setPersister((card) => sentCardPersister(card));
  const off = sender.onCards((cards) => { for (const card of cards) recordSentCard(card); });
  return () => { off(); sender.setPersister(null); };
}

/** The process that holds the bridge: the sender hears the GET answers and keeps the cards. Returns the stop. (The one call the bridge's start makes; see plural-handoff-send.ts startPluralSenderIntake.) */
export function startSentCardsIntake(): { stop(): void } {
  const { startPluralSenderIntake } = req<typeof import("./plural-handoff-send")>("./plural-handoff-send");
  const intake = startPluralSenderIntake();
  const offRows = startSentCardRows(intake.sender as never);
  return { stop: () => { offRows(); intake.stop(); } };
}

/* ------------------------------------------------------------------------------------------------ the card's buttons (renderer -> Main) */
export type HandoffActInput =
  | { op: "cancel"; id: string }
  | { op: "retry"; id: string }
  | { op: "answer"; id: string; qid: string; answer: "allow" | "allow_task" | "deny" };
export interface HandoffActResult { ok: boolean; state?: string }

const ROW = /^h_[a-f0-9]{64}$/;
const QIDRE = /^[A-Za-z0-9_.:@-]{1,128}$/;
export function parseHandoffAct(raw: unknown): HandoffActInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ROW.test(r.id)) return null;
  if (r.op === "cancel" || r.op === "retry") return Object.keys(r).length === 2 ? { op: r.op, id: r.id } : null;
  if (r.op === "answer" && typeof r.qid === "string" && QIDRE.test(r.qid) && (r.answer === "allow" || r.answer === "allow_task" || r.answer === "deny") && Object.keys(r).length === 4) return { op: "answer", id: r.id, qid: r.qid, answer: r.answer };
  return null;
}

/** What a button does, in Main. The card row is the only state read (the buttons carry ids, never words). */
export async function actOnHandoffCard(raw: unknown): Promise<HandoffActResult> {
  const input = parseHandoffAct(raw);
  if (!input) return { ok: false, state: "invalid" };
  const send = req<typeof import("./plural-handoff-send")>("./plural-handoff-send");
  const sender = send.pluralSender();
  const rowKey = `${HANDOFF_SENT_ROW_PREFIX}${input.id}`;
  const c = chats();
  const value = decodeHandoffCard(c.getViewRowText(rowKey));
  if (!value || value.k !== "sent") return { ok: false, state: "unknown_card" };
  if (input.op === "cancel") return { ok: (await sender.cancel(input.id)) === "ok" };
  if (input.op === "retry") {
    // only a card that still has its place can be retried; once the same words were handed over again the card loses it (one retry, one new row)
    if (!value.to || (value.state !== "failed" && value.state !== "expired")) return { ok: false, state: "not_retryable" };
    const out = await sender.handOff({ to: value.to, brief: value.brief, key: `retry_${input.id.slice(2, 34)}` });
    if (!out.ok) return { ok: false, state: out.reason };
    const chatId = c.chatOfViewRow(rowKey);
    const { to: _to, ...rest } = value;
    if (chatId) c.upsertViewNoticeRow({ id: rowKey, chatId, text: encodeHandoffCard(rest), createdAt: new Date().toISOString() });
    return { ok: true, state: out.state };
  }
  const q = (value.q ?? []).find((x) => x.qid === input.qid);
  if (!q) return { ok: false, state: "not_waiting" };
  const got = await sender.answer(input.id, input.qid, input.answer);
  if (!got) return { ok: false, state: "unreachable" };
  if (got.state === "answered" || got.state === "existing") {
    const first = got.answer ?? input.answer;
    recordAnswerLine(input.id, { qid: input.qid, kind: q.kind, target: q.target, result: first === "deny" ? "denied" : "allowed", at: new Date().toISOString() });
    return { ok: true, state: got.state };
  }
  return { ok: false, state: got.state };
}

/**
 * A question of a row THIS desktop sent appears (or is seen for the first time in this process): told once per question (the bridge's approval push for the sender's phone; the server sends none for a row a desktop sent).
 * `stillWaiting` lets the push sender drop it if the question was answered before it went out. The seen set is bounded (400 ids): a repeat only costs a push that the push sender's dedupe key drops.
 */
export function onSentQuestion(listener: (q: { rowId: string; qid: string; chatId: string | null }, stillWaiting: () => boolean) => void): () => void {
  const send = req<typeof import("./plural-handoff-send")>("./plural-handoff-send");
  const sender = send.pluralSender();
  const seen = new Set<string>();
  return sender.onCards((cards) => {
    for (const card of cards) {
      for (const a of card.approvals) {
        if (seen.has(a.qid)) continue;
        seen.add(a.qid);
        while (seen.size > 400) seen.delete(seen.values().next().value as string);
        const qid = a.qid, rowId = card.id;
        let chatId: string | null = null;
        try { chatId = chats().chatOfViewRow(`${HANDOFF_SENT_ROW_PREFIX}${rowId}`); } catch { /* no card row yet */ }
        listener({ rowId, qid, chatId }, () => sender.cards().some((c) => c.id === rowId && c.approvals.some((x) => x.qid === qid)));
      }
    }
  });
}
