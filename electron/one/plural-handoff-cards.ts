/**
 * Where a hand-off card is kept: ONE quiet 'view' row of the personal agent's conversation per piece of work, replaced as its state changes.
 *   sent card      `handoff-card:<row id>`  - the work THIS desktop's agent handed to another agent. Open states come from the sender's view (plural-handoff-send.ts `onCards`), the end from its persister; the server's row is the
 *                  only other copy, and it is taken (deleted) only after this row says the end (the persister answers true).
 *   received card  `handoff-recv:<row id>`  - the work another agent handed to THIS desktop's agent: written when the Work starts and again when it ends (plural-work-real.ts calls recordReceivedCard).
 * The row is a record: the model never reads a 'view' row, it is never the conversation's last message, and it goes with the conversation (no table of its own, no timer, no new retention rule). A card whose
 * words did not change writes nothing. Pure of Electron: the daemon loads it.
 */
import type { SentCard } from "./plural-handoff-wire";
import { HANDOFF_RECV_ROW_PREFIX, HANDOFF_SENT_ROW_PREFIX, HANDOFF_RESULT_CHARS, decodeHandoffCard, encodeHandoffCard, handoffStages, type HandoffConsentStage, type HandoffDeliveryStage, type HandoffAnswerLine, type HandoffCardState, type HandoffCardValue, type HandoffConsentEnd } from "../../shared/plural-handoff-card";

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
    // Only the signed-in account's slot: the app shows the signed-out slot's One ("One", "Checking connection") for a moment while the session settles, and a card written then went to that slot's conversation
    // (the stray two-message chat of the prod test). Signed out = no card now; the row waits on the server and the next answer keeps it.
    const profile = req<typeof import("../store/one-profile")>("../store/one-profile");
    const peek = profile.peekOneProfile();   // the signed-in account's own slot, never created here
    let oneId: string | null = peek.state === "present" ? peek.oneId : null;
    if (!oneId && profile.getOneProfileOrigin() !== "signed-out") oneId = profile.getOneProfile().oneId;
    if (!oneId) return null;
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
    ...(card.consent ? { consent: card.consent } : {}),
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
  | { op: "answer"; id: string; qid: string; answer: "allow" | "allow_task" | "deny" }
  /** The consent chip: the button carries the row id only; the same op answers a chip on the sending card and one on the receiving desktop's screen. */
  | { op: "consent"; id: string; answer: "allow" | "always" | "deny" };
export interface HandoffActResult { ok: boolean; state?: string; answer?: string }

const ROW = /^h_[a-f0-9]{64}$/;
const QIDRE = /^[A-Za-z0-9_.:@-]{1,128}$/;
export function parseHandoffAct(raw: unknown): HandoffActInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ROW.test(r.id)) return null;
  if (r.op === "cancel" || r.op === "retry") return Object.keys(r).length === 2 ? { op: r.op, id: r.id } : null;
  if (r.op === "consent" && (r.answer === "allow" || r.answer === "always" || r.answer === "deny") && Object.keys(r).length === 3) return { op: "consent", id: r.id, answer: r.answer };
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
  if (input.op === "consent") {
    // Before the card lookup: a chip on the RECEIVING desktop has no card row of its own. The server writes the first answer and sends; this side only reports what the server said.
    const got = await sender.consent(input.id, input.answer);
    if (!got) return { ok: false, state: "unreachable" };
    if (got.status !== "answered" && got.status !== "existing") return { ok: false, state: got.status };
    const first = got.answer ?? (got.status === "answered" ? input.answer : undefined);
    // The sending card (when this desktop sent the row) reads the server's word at once; the next answer replaces it with the server's own row.
    if (first && value && value.k === "sent" && value.state === "asking") {
      const chatId = c.chatOfViewRow(rowKey);
      if (chatId) {
        const next: HandoffCardValue = first === "deny" ? { ...value, state: "cancelled", consent: "deny" }
          : { ...value, state: got.state === "waiting" ? (got.need === "phone_app" ? "waiting_phone_app" : "waiting_desktop_off") : "reserved" };
        c.upsertViewNoticeRow({ id: rowKey, chatId, text: encodeHandoffCard(next), createdAt: new Date().toISOString() });
      }
    }
    return { ok: true, state: got.status, ...(first ? { answer: first } : {}) };
  }
  if (!value || value.k !== "sent") return { ok: false, state: "unknown_card" };
  if (input.op === "cancel") {
    // "Cancel" on a card that is already OVER is the card's Dismiss (a failed card had no way off the screen): its record row goes and the server's row is taken. An open card is cancelled, never hidden:
    // the person does not lose sight of work that is still running. One op for both keeps the bridge's closed op list as it was (older phones and the app-control schema).
    if (!OPEN_STATES.has(value.state)) {
      void sender.take(input.id).catch(() => false);
      return { ok: c.deleteHandoffCardRow(rowKey), state: "dismissed" };
    }
    return { ok: (await sender.cancel(input.id)) === "ok" };
  }
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
 * A chip of a row THIS desktop handed over opened while the person was not in the turn (a scheduled or confirmed task): told once per row, for the sender's phone (the server sends none for a row a desktop sent). The in-process sender
 * view is the only source (`away` is set when the hand-off is made), so a chip that opened with the person present, or one read back after a restart, tells nothing. `stillAsking` lets the push sender drop it if it was answered first.
 */
export function onSentConsent(listener: (q: { rowId: string; chatId: string | null }, stillAsking: () => boolean) => void): () => void {
  const send = req<typeof import("./plural-handoff-send")>("./plural-handoff-send");
  const sender = send.pluralSender();
  const seen = new Set<string>();
  return sender.onCards((cards) => {
    for (const card of cards) {
      if (card.state !== "asking" || card.away !== true || seen.has(card.id)) continue;
      seen.add(card.id);
      while (seen.size > 400) seen.delete(seen.values().next().value as string);
      const rowId = card.id;
      let chatId: string | null = null;
      try { chatId = chats().chatOfViewRow(`${HANDOFF_SENT_ROW_PREFIX}${rowId}`); } catch { /* no card row yet */ }
      listener({ rowId, chatId }, () => sender.cards().some((c) => c.id === rowId && c.state === "asking"));
    }
  });
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

/* ------------------------------------------------------------------------------------------------ the model's read of the hand-offs */
/**
 * One hand-off as the model reads it: closed words, no prose. `state` is the card's own state; `open` = it can still change or be taken back; `sent` = the other agent was handed it (false for
 * asking, denied and unanswered: nothing reached it). The model used to answer "still waiting" from its earlier `asking` result after the person denied or allowed; this is
 * the one record it reads instead: the sender's live rows (the server's word) over the card rows of this conversation (what the person sees).
 */
export interface HandOffStateView { id: string; state: HandoffCardState; consent_stage: HandoffConsentStage; delivery: HandoffDeliveryStage; open: boolean; sent: boolean; place?: string; consent?: HandoffConsentEnd; brief: string; at?: string }
const OPEN_STATES: ReadonlySet<string> = new Set(["asking", "reserved", "waiting_desktop_off", "waiting_phone_app", "claimed", "claimed_desktop_off", "approval"]);
const BRIEF_FOR_MODEL = 80;

function stateViewOf(value: HandoffCardValue): HandOffStateView {
  const neverSent = value.state === "asking" || (value.state === "cancelled" && value.consent === "deny") || (value.state === "expired" && value.consent === "unanswered");
  const place = value.phone ? "phone" : value.place;
  return { id: value.id, state: value.state, ...(() => { const g = handoffStages(value); return { consent_stage: g.consent, delivery: g.delivery }; })(), open: OPEN_STATES.has(value.state), sent: !neverSent,
    ...(place ? { place } : {}), ...(value.consent ? { consent: value.consent } : {}),
    brief: [...value.brief.replace(/\s+/g, " ").trim()].slice(0, BRIEF_FOR_MODEL).join(""), ...(value.at ? { at: value.at } : {}) };
}

/** What the model's read and cancel need from the world; production wires the sender and the store, a test hands its own. */
export interface HandOffToolPorts {
  cards(): readonly SentCard[];
  cancel(id: string): Promise<"ok" | "unavailable">;
  db(): { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
  getViewRowText(id: string): string | null;
  chatOfViewRow(id: string): string | null;
  upsertViewNoticeRow(input: { id: string; chatId: string; text: string; createdAt: string }): unknown;
}
function productionToolPorts(): HandOffToolPorts {
  const sender = req<typeof import("./plural-handoff-send")>("./plural-handoff-send").pluralSender();
  const c = chats();
  return { cards: () => sender.cards(), cancel: (id) => sender.cancel(id), db: () => req<typeof import("../store/db")>("../store/db").getDb() as never,
    getViewRowText: (id) => c.getViewRowText(id), chatOfViewRow: (id) => c.chatOfViewRow(id), upsertViewNoticeRow: (input) => c.upsertViewNoticeRow(input) };
}

/** The hand-offs of one conversation, newest first: its card rows, each replaced by the sender's live row when the sender holds one (the server's word is newer than the last card write). */
export function listHandOffStates(chatId: string, live: readonly SentCard[] = [], limit = 12, db: HandOffToolPorts["db"] = productionToolPorts().db): HandOffStateView[] {
  const out: HandOffStateView[] = [];
  try {
    const rows = db().prepare("SELECT id, text FROM chat_messages WHERE chat_id = ? AND row_scope = 'view' AND id LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(chatId, `${HANDOFF_SENT_ROW_PREFIX}%`, limit) as Array<{ id: string; text: string }>;
    for (const row of rows) {
      const value = decodeHandoffCard(row.text);
      if (!value || value.k !== "sent") continue;
      const card = live.find((c) => c.id === value.id);
      out.push(stateViewOf(card ? { ...value, ...valueOfSentCard({ ...card, brief: value.brief || card.brief }) } : value));
    }
  } catch { /* an unreadable store leaves the list short; the model is told what is known */ }
  return out;
}

export type HandOffToolActionResult =
  | { ok: true; state: "list"; handoffs: HandOffStateView[] }
  | { ok: true; state: "cancelled"; id: string }
  | { ok: false; reason: "unknown_id" | "not_open" | "unavailable" | "bad_input" };

/** The model's `hand_off` with action list | cancel. A cancel names an id of THIS conversation's own list (never another conversation's row) that is still open. */
export async function handOffToolAction(input: { action: "list" | "cancel"; id?: string }, chatId: string, ports: HandOffToolPorts = productionToolPorts()): Promise<HandOffToolActionResult> {
  const list = listHandOffStates(chatId, ports.cards(), 12, ports.db);
  if (input.action === "list") return { ok: true, state: "list", handoffs: list };
  if (typeof input.id !== "string" || !ROW.test(input.id)) return { ok: false, reason: "bad_input" };
  const found = list.find((h) => h.id === input.id);
  if (!found) return { ok: false, reason: "unknown_id" };
  if (!found.open) return { ok: false, reason: "not_open" };
  if ((await ports.cancel(input.id)) !== "ok") return { ok: false, reason: "unavailable" };
  // A row nobody started ends at once on the server: the card says so now (a started one ends with what the running side reports, and the next answer writes it).
  if (found.state === "asking" || found.state === "reserved" || found.state === "waiting_desktop_off" || found.state === "waiting_phone_app") {
    try {
      const key = `${HANDOFF_SENT_ROW_PREFIX}${input.id}`;
      const value = decodeHandoffCard(ports.getViewRowText(key));
      const cardChat = ports.chatOfViewRow(key);
      if (value && cardChat) { const { q: _q, ...rest } = value; ports.upsertViewNoticeRow({ id: key, chatId: cardChat, text: encodeHandoffCard({ ...rest, state: "cancelled" }), createdAt: new Date().toISOString() }); }
    } catch { /* the card follows the server's next answer */ }
  }
  return { ok: true, state: "cancelled", id: input.id };
}

/** Hand-offs shown to the model each turn: the open ones and the ones that ended in the last day; at most this many. */
export const HANDOFF_FACTS_MAX = 5;
const HANDOFF_FACTS_WINDOW_MS = 24 * 3_600_000;

/**
 * The host's current record of this conversation's hand-offs, for the next turn. A chip's answer (allow, always, deny) rewrites the card row, and this block is read from those rows at every turn:
 * the model cannot answer "waiting" after an allow or "already pending" after a deny from an old tool result, and a duplicate claim has the row id to point at. Null when there is nothing recent (no words spent).
 * Reads card rows only (no sender, no network): the card rows follow the server's answers and the person's chip.
 */
export function handOffFactsSection(chatId: string | null | undefined, now = Date.now(), db: HandOffToolPorts["db"] = () => req<typeof import("../store/db")>("../store/db").getDb() as never): string | null {
  if (!chatId) return null;
  try {
    const recent = listHandOffStates(chatId, [], 12, db).filter((h) => h.open || !h.at || now - Date.parse(h.at) < HANDOFF_FACTS_WINDOW_MS).slice(0, HANDOFF_FACTS_MAX);
    if (!recent.length) return null;
    const lines = recent.map((h) => `- ${h.id} -> ${h.place ?? "another agent"}: consent=${h.consent_stage}; delivery=${h.delivery}; "${h.brief.slice(0, 50)}"`);
    return ["Hand-offs of this conversation, the host's record right now (newer than anything said earlier, tool results included). consent = the person's chip answer, delivery = where the work is (allowed + running/sent/done is delivered, not waiting for the chip). Ask or cancel through hand_off; call a request a duplicate only when a row below has the same words, and name its id.", ...lines].join("\n");
  } catch { return null; }
}
