/**
 * Hand-off, the sending side: this desktop's personal agent gives one piece of work to another of the person's agents and goes on.
 * Logic only; every effect is a port (the server call, the sleep, where an ended card is kept), so Main, the background service and a gate use the same code.
 *
 *   create   POST {op:"create", to?, brief, doneWhen?, key, origin?, replaces?} -> sent | waiting{need} | existing | refused{reason, places?} | error. The key is the turn's id: the same turn again is the same row (`existing`).
 *            The SERVER picks the place when `to` is left out (one sendable place) and answers `which_place` with the list when there are several; the desktop keeps no list of its own for that.
 *   view     the rows this desktop sent come back in the GET answer (`open[]` still going, `done[]` ended, `approvals` waiting questions): they are folded into SentCard values, in memory, replaced by every answer.
 *            Nothing is stored here: the server's row is the only copy; a restart reads it again.
 *   end      an ended row (`done[]`) is handed to the persister (the conversation's card, bundle D screens); only when it says it kept the card does `take` remove the row on the server. No persister = no take (the row waits).
 *   answer   a question of a row this desktop sent is answered from its chip: {op:"answer", id, qid, answer}; the first answer is the answer, whichever screen gave it.
 * Failures that can pass (no connection, 5xx, 429) repeat on the same ladder as the receiving side; after that the next trigger carries it on.
 */
import type { CallAnswer } from "./shared-memory-sync";
import type { AskAnswer, AskKind, FinishWhy, SentCard, SentCardState } from "./plural-handoff-wire";

export const SEND_RETRY = Object.freeze({ firstMs: 500, retries: 5, retryAfterMaxMs: 32_000 });
export const BRIEF_MAX_CHARS = 600;
export const DONE_WHEN_MAX_CHARS = 240;
const ROW_ID = /^h_[a-f0-9]{64}$/;
const QID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const TRANSIENT_WORDS = new Set(["contended", "unavailable", "error"]);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4000): string | undefined => typeof v === "string" ? v.slice(0, max) : undefined;
const KINDS: ReadonlySet<string> = new Set(["money", "delete", "send"]);
const WHYS: ReadonlySet<string> = new Set(["no_runner", "limit", "desktop_update", "error", "approval_unavailable", "permission", "phone_app", "cancelled", "stopped_here", "interrupted", "released"]);

/** What the model is told. Closed words; `place` is a name the person knows. */
export type HandOffOutcome =
  | { ok: true; state: "sent" | "waiting" | "existing"; id?: string; place?: string; need?: "desktop_on" | "phone_app" }
  | { ok: false; reason: "bad_input" | "hop_limit" | "which_place" | "no_runner" | "desktop_update" | "limit" | "unknown_place" | "no_account" | "unavailable"; places?: Array<{ to: string; agent?: string; machine?: string; on?: boolean }> };

export interface HandOffInput { to?: string; brief: string; doneWhen?: string; key: string; origin?: string | null; replaces?: string }
export interface SentPlace { id: string; agent: string; machine: string; on: boolean; v?: number }

export interface PluralSenderPorts {
  /** POST /api/desktop/plural with `{ op, hostId, ...body }`. */
  post(body: Record<string, unknown>): Promise<CallAnswer>;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
}
/** Where an ended row's card is kept (bundle D: the conversation of the sending agent). True = kept, the row may be taken. May be set later than the sender (a process that has no conversation store yet). */
export type SentEndPersister = (card: SentCard) => Promise<boolean> | boolean;
/** Where the end of a row this desktop sent is told to the person (the desktop's own notification / the bridge push): once per row, after the card was kept. */
export type SentEndNotifier = (card: SentCard) => void;

type Sent = { kind: "ok"; status: string; body: Record<string, unknown> } | { kind: "closed" } | { kind: "gave_up" } | { kind: "refused" };

const STATE_OF_OPEN: Record<string, SentCardState> = { reserved: "reserved", waiting: "reserved", claimed: "claimed", approval: "approval" };

/** One GET answer's sender part into cards. `places` = the answer's list when it had one (names and on/off); open rows come first, ended ones after, each in the order the server sent. */
export function cardsOfAnswer(answer: { open?: unknown; done?: unknown; approvals?: unknown }, places: ReadonlyMap<string, SentPlace>): SentCard[] {
  const cards = new Map<string, SentCard>();
  const nameOf = (to: unknown): string => { const p = typeof to === "string" ? places.get(to) : undefined; return p ? p.agent || p.machine : typeof to === "string" && to === "phone" ? "phone" : ""; };
  const questions = (value: unknown): SentCard["approvals"] => (Array.isArray(value) ? value : []).flatMap((q) => {
    if (!isObject(q) || typeof q.qid !== "string" || !QID.test(q.qid) || typeof q.kind !== "string" || !KINDS.has(q.kind)) return [];
    if (q.state !== undefined && q.state !== "asked") return [];
    return [{ qid: q.qid, kind: q.kind as AskKind, target: str(q.target, 200) ?? "", ...(typeof q.preview === "string" ? { preview: q.preview.slice(0, 2000) } : {}) }];
  });
  for (const raw of Array.isArray(answer.open) ? answer.open : []) {
    if (!isObject(raw) || typeof raw.id !== "string" || !ROW_ID.test(raw.id)) continue;
    const to = typeof raw.to === "string" ? raw.to : "";
    const approvals = questions(raw.approvals);
    const on = places.get(to)?.on;
    let state: SentCardState = STATE_OF_OPEN[String(raw.state)] ?? "reserved";
    if (String(raw.state) === "waiting") state = raw.need === "phone_app" ? "waiting_phone_app" : raw.need === "desktop_on" ? "waiting_desktop_off" : "reserved";
    if (state === "claimed" && on === false) state = "claimed_desktop_off";
    if (approvals.length && (state === "claimed" || state === "claimed_desktop_off" || state === "approval")) state = "approval";
    cards.set(raw.id, { id: raw.id, to, toName: nameOf(to), brief: str(raw.brief, BRIEF_MAX_CHARS) ?? "", state, approvals });
  }
  // the older `approvals` list of the answer (one entry per question): the same questions, for an answer that has no `open` rows
  for (const raw of Array.isArray(answer.approvals) ? answer.approvals : []) {
    if (!isObject(raw) || typeof raw.id !== "string" || !ROW_ID.test(raw.id)) continue;
    const [q] = questions([raw]);
    if (!q) continue;
    const card = cards.get(raw.id) ?? { id: raw.id, to: typeof raw.to === "string" ? raw.to : "", toName: nameOf(raw.to), brief: "", state: "approval" as SentCardState, approvals: [] };
    if (!card.approvals.some((x) => x.qid === q.qid)) card.approvals.push(q);
    card.state = "approval";
    cards.set(raw.id, card);
  }
  for (const raw of Array.isArray(answer.done) ? answer.done : []) {
    if (!isObject(raw) || typeof raw.id !== "string" || !ROW_ID.test(raw.id)) continue;
    const s = String(raw.state);
    const state: SentCardState | null = s === "done" || s === "failed" || s === "stopped" || s === "expired" || s === "cancelled" ? s : null;
    if (!state) continue;
    const to = typeof raw.to === "string" ? raw.to : "";
    const why = typeof raw.why === "string" && WHYS.has(raw.why) ? raw.why as FinishWhy : undefined;
    // `lateEnd` is the end the running side reported after the sender's cancel took the row: {state, started, result, at} (the server's example file); the older shape was `true`
    const late = raw.lateEnd === true || isObject(raw.lateEnd);
    const lateText = isObject(raw.lateEnd) && typeof raw.lateEnd.result === "string" ? raw.lateEnd.result.slice(0, 2000) : undefined;
    cards.set(raw.id, { id: raw.id, to, toName: nameOf(to), brief: str(raw.brief, BRIEF_MAX_CHARS) ?? "", state, ...(why ? { why } : {}), ...(typeof raw.started === "boolean" ? { started: raw.started } : {}),
      approvals: [], ...(lateText ?? (typeof raw.result === "string" ? raw.result.slice(0, 2000) : undefined) !== undefined ? { result: lateText ?? (raw.result as string).slice(0, 2000) } : {}), ...(typeof raw.endedAt === "string" ? { endedAt: raw.endedAt } : {}), ...(late ? { lateEnd: true } : {}) });
  }
  return [...cards.values()];
}

export function placesOfAnswer(value: unknown): Map<string, SentPlace> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<string, SentPlace>();
  for (const p of value) {
    if (!isObject(p) || typeof p.id !== "string") continue;
    out.set(p.id, { id: p.id, agent: str(p.agent, 120) ?? "", machine: str(p.machine, 120) ?? "", on: p.on === true, ...(typeof p.v === "number" ? { v: p.v } : {}) });
  }
  return out;
}

const ENDED: ReadonlySet<SentCardState> = new Set(["done", "failed", "stopped", "expired", "cancelled"]);
export const isEndedCard = (card: SentCard): boolean => ENDED.has(card.state);

export function createPluralSender(ports: PluralSenderPorts) {
  const log = (line: string): void => { try { ports.log?.(line); } catch { /* a log never changes the answer */ } };
  let closed = false, stopped = false;
  let places = new Map<string, SentPlace>();
  let cards: SentCard[] = [];
  let persister: SentEndPersister | null = null, notifier: SentEndNotifier | null = null;
  const listeners = new Set<(cards: readonly SentCard[]) => void>();
  const taken = new Set<string>();      // rows whose take was sent in this life: a bounded memory that only saves the call (the server ignores a repeat)
  let working: Promise<void> | null = null, again: Parameters<typeof handleNow>[0] | null = null;

  async function send(body: Record<string, unknown>): Promise<Sent> {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return { kind: "gave_up" };
      const out = await ports.post(body);
      if (out.status === 404) { closed = true; return { kind: "closed" }; }
      const status = typeof out.body?.status === "string" ? out.body.status : "";
      if (out.ok && out.body && !TRANSIENT_WORDS.has(status)) { closed = false; return { kind: "ok", status, body: out.body }; }
      const transient = out.unreachable === true || out.status >= 500 || out.status === 429 || out.status === 0 || (out.ok && TRANSIENT_WORDS.has(status));
      if (!transient) return { kind: "refused" };
      if (attempt >= SEND_RETRY.retries) return { kind: "gave_up" };
      let wait = SEND_RETRY.firstMs * 2 ** attempt;
      if (out.status === 429 && out.retryAfterMs !== undefined && out.retryAfterMs > 0) { if (out.retryAfterMs > SEND_RETRY.retryAfterMaxMs) return { kind: "gave_up" }; wait = out.retryAfterMs; }
      await ports.sleep(wait);
    }
  }

  async function handOff(input: HandOffInput): Promise<HandOffOutcome> {
    const brief = typeof input.brief === "string" ? input.brief.trim() : "";
    const doneWhen = typeof input.doneWhen === "string" ? input.doneWhen.replace(/\s+/gu, " ").trim() : "";
    if (!brief || [...brief].length > BRIEF_MAX_CHARS || [...doneWhen].length > DONE_WHEN_MAX_CHARS) return { ok: false, reason: "bad_input" };
    if (input.origin) return { ok: false, reason: "hop_limit" };   // work that was itself handed over is never handed on (the server refuses it too; this saves the call)
    if (typeof input.key !== "string" || !QID.test(input.key)) return { ok: false, reason: "bad_input" };
    const to = typeof input.to === "string" ? input.to.trim().slice(0, 160) : "";
    const replaces = typeof input.replaces === "string" && ROW_ID.test(input.replaces) ? input.replaces : "";
    const out = await send({ op: "create", brief, key: input.key, ...(doneWhen ? { doneWhen } : {}), ...(to ? { to } : {}), ...(replaces ? { replaces } : {}) });
    if (out.kind !== "ok") return { ok: false, reason: "unavailable" };
    const body = out.body, id = typeof body.id === "string" ? body.id : undefined;
    const place = (() => { const p = places.get(String(body.to ?? to)); return p ? p.agent || p.machine : typeof body.place === "string" ? body.place : undefined; })();
    if (out.status === "sent" || out.status === "existing" || out.status === "waiting") {
      const need = body.need === "phone_app" || body.need === "desktop_on" ? body.need : undefined;
      return { ok: true, state: out.status, ...(id ? { id } : {}), ...(place ? { place } : {}), ...(need ? { need } : {}) };
    }
    if (out.status === "refused") {
      const reason = String(body.reason ?? "");
      if (reason === "which_place") {
        const list = (Array.isArray(body.places) ? body.places : []).flatMap((p) => isObject(p) && typeof p.to === "string"
          ? [{ to: p.to, ...(typeof p.agent === "string" ? { agent: p.agent } : {}), ...(typeof p.machine === "string" ? { machine: p.machine } : {}), ...(typeof p.on === "boolean" ? { on: p.on } : {}) }] : []);
        return { ok: false, reason: "which_place", places: list };
      }
      // every closed word the server refuses with is passed on as it is (prod test: `unknown_place` / `no_account` were folded into `bad_input` and the agent blamed its own words)
      if (reason === "hop_limit" || reason === "no_runner" || reason === "desktop_update" || reason === "limit" || reason === "unknown_place" || reason === "no_account") return { ok: false, reason };
      log(`create refused with a word this build does not know: ${reason.replace(/[^a-z_]/g, "").slice(0, 40) || "none"}`);
      return { ok: false, reason: "bad_input" };
    }
    return { ok: false, reason: "unavailable" };
  }

  async function plain(body: Record<string, unknown>): Promise<Sent> { return send(body); }

  async function handleNow(answer: { open?: unknown; done?: unknown; approvals?: unknown; places?: unknown }): Promise<void> {
    const list = placesOfAnswer(answer.places);
    if (list) places = list;   // the answer carries `places` only when the list changed; the one before stays until then
    cards = cardsOfAnswer(answer, places);
    for (const l of listeners) { try { l(cards); } catch { /* a listener cannot stop the rest */ } }
    const ended = cards.filter((c) => isEndedCard(c) && !taken.has(c.id));
    if (!ended.length || !persister) return;
    const kept: string[] = [];
    for (const card of ended) {
      if (stopped) return;
      let ok = false;
      try { ok = await persister(card); } catch (error) { log(`card ${card.id} not kept: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); }
      if (!ok) continue;
      try { notifier?.(card); } catch { /* the notice is a courtesy */ }
      kept.push(card.id);
    }
    if (!kept.length) return;
    const out = await send({ op: "take", ids: kept });
    if (out.kind === "ok") { for (const id of kept) { taken.add(id); while (taken.size > 400) taken.delete(taken.values().next().value as string); } }
    else log("take not sent, the next answer sends it again");   // the card is kept: the persister must treat a card it already kept as kept
  }

  return {
    handOff,
    /** One GET answer. Answers that arrive while one is handled are folded: the newest is handled after. */
    handle(answer: Parameters<typeof handleNow>[0]): Promise<void> {
      if (working) { again = answer; return working; }
      working = (async () => {
        let next: Parameters<typeof handleNow>[0] | null = answer;
        while (next && !stopped) { again = null; try { await handleNow(next); } catch (error) { log(`answer not handled: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); } next = again; }
      })().finally(() => { working = null; });
      return working;
    },
    /** Cancel a row this desktop sent. The server ends a row nobody started at once; a started one is asked to stop and ends with what the running side reports (`cancelled`). */
    async cancel(id: string): Promise<"ok" | "unavailable"> {
      if (!ROW_ID.test(id)) return "unavailable";
      const out = await plain({ op: "cancel", id });
      return out.kind === "ok" ? "ok" : "unavailable";
    },
    /** The rest of a long result (the card holds the first 2,000 characters). */
    async result(id: string): Promise<{ text: string } | null> {
      if (!ROW_ID.test(id)) return null;
      const out = await plain({ op: "result", id });
      return out.kind === "ok" && typeof out.body.result === "string" ? { text: out.body.result } : null;
    },
    /** The answer to one question of a row this desktop sent (a chip). The first answer is the answer: a second one gets the first back. */
    async answer(id: string, qid: string, answer: AskAnswer): Promise<{ state: string; answer?: AskAnswer } | null> {
      if (!ROW_ID.test(id) || !QID.test(qid) || !["allow", "allow_task", "deny"].includes(answer)) return null;
      const out = await plain({ op: "answer", id, qid, answer });
      if (out.kind !== "ok") return null;
      return { state: out.status, ...(out.body.answer === "allow" || out.body.answer === "allow_task" || out.body.answer === "deny" ? { answer: out.body.answer } : {}) };
    },
    cards: (): readonly SentCard[] => cards,
    onCards(listener: (cards: readonly SentCard[]) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    setPersister(fn: SentEndPersister | null): void { persister = fn; },
    setNotifier(fn: SentEndNotifier | null): void { notifier = fn; },
    stop(): void { stopped = true; },
    get switchClosed(): boolean { return closed; },
  };
}
export type PluralSender = ReturnType<typeof createPluralSender>;

/* ------------------------------------------------------------------ the process's own sender (lazy; effects only here) */
/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;
let own: PluralSender | null = null;
/** One sender per process: the tool's `hand_off` and the GET subscription use the same one, so the view and the persister are one. */
export function pluralSender(): PluralSender {
  if (own) return own;
  const real = req<typeof import("./plural-work-real")>("./plural-work-real");
  const deps = real.realRequestDeps();
  own = createPluralSender({
    post: real.realPluralPort(() => real.readHostId(), deps),
    sleep: (ms) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
    log: (line) => console.info(`[plural-send] ${line}`),
  });
  return own;
}
/** In the process that holds the bridge: the sender hears every GET answer. Returns the stop. */
export function startPluralSenderIntake(): { stop(): void; sender: PluralSender } {
  const sender = pluralSender();
  const places = req<typeof import("../mobile-bridge/places-link")>("../mobile-bridge/places-link");
  const onAnswer = (a: unknown): void => { void sender.handle(a as Parameters<PluralSender["handle"]>[0]).catch(() => undefined); };
  const off = places.onPluralAnswer(onAnswer);
  const last = places.lastPluralAnswer();
  if (last) onAnswer(last);
  return { sender, stop: () => off() };
}
/** Test hook. */
export function __resetPluralSenderForTest(): void { own?.stop(); own = null; }

/**
 * The lineage of a conversation: the row id when its Work was started from a hand-off row (a received Work), else null. A received Work never hands on (and has no `hand_off` in its list; this is the second lock).
 */
export function pluralOriginOfChat(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  try {
    const db = req<typeof import("../store/db")>("../store/db").getDb();
    const row = db.prepare("SELECT command_id FROM one_supervisor_work_jobs WHERE chat_id=? AND command_id LIKE 'plural\\_h\\_%' ESCAPE '\\' LIMIT 1").get(chatId) as { command_id: string } | undefined;
    return row ? row.command_id.slice("plural_".length) : null;
  } catch { return null; }
}
