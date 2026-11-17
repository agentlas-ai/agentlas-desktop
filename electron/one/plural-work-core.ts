/**
 * the desktop's side of a hand-off row - receive work another agent (the phone's, another desktop's) sent, run it as ordinary Work, end the row, keep the left words.
 * This file is the logic only; every effect (the server call, the supervisor, the store reads) is a port, so Main, the background service and a gate use the same code.
 *
 *   rows `work`     claim {id, run} -> `claimed`: start ONE ordinary Work from the brief and the done-when line alone (no frozen conversation); `taken`: another run holds it, nothing starts.
 *                   The command id of the Work and the `run` of the claim are the SAME deterministic word (`plural_<row id>`): Main and the background service that both hear the same row claim the same `run`
 *                   and start the same command - the store admits a command once, so one of them starts it and the other finds it started.
 *                   The Work carries `remoteAsk` {rowId, askVia, from, fromName}: with askVia `row` every question about money / delete / send goes up to the row (see plural-remote-ask.ts); with `local` (an older phone sent the row) it stays on this desktop.
 *   rows `message`  the items of ONE row are ONE message of the person to the personal agent (the same entry a phone message uses), in the order received with their original times; then claim {upTo: last k}; `left` > 0 reads again.
 *   `cancel`        the server asks to stop a row (the sender cancelled it, the row ended there, the place was released): a queued Work is taken out, a running one gets the supervisor's stop request; the end the run then has is sent.
 *   `removed`       the phone disconnected this desktop: every plural Work still going is stopped (the server ended its rows already).
 *   `held`          a row this desktop claimed: no local job = ended `failed / interrupted` (not started); a job that ended = its own end sent (this is also how an end that could not be sent is sent again); a job still going = nothing.
 *                   `held[].approvals` = answers the row has for questions of that run: each closes the local card of that request id (Main's or the service's).
 * The end is a machine value read from the Work's own end (storeEndOf in plural-work-real.ts): done / failed{why} / stopped{why} + `started`; no model word decides it.
 * Every request that fails for a reason that can pass (no connection, a time-out, 5xx, 429) is repeated 0.5 s doubling, five times after the first; after that the next trigger (wake, connect) carries it on - the end is
 * computed again from the store, nothing is kept in a table of its own.
 */
import type { CallAnswer } from "./shared-memory-sync";
import type { AskAnswer, AskKind, CloseWhy, PluralEnd, PluralQuestion, RemoteAsk } from "./plural-handoff-wire";

export const PLURAL_RETRY = Object.freeze({ firstMs: 500, retries: 5, retryAfterMaxMs: 32_000 });
export const PLURAL_COMMAND_PREFIX = "plural_";
const ROW_ID = /^h_[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9_.:@-]{1,128}$/;
const TRANSIENT_WORDS = new Set(["contended", "unavailable", "error"]);
/** The head the server keeps of a result (its RESULT_HEAD_CHARS). */
export const RESULT_HEAD_CHARS = 2000;
/** The unsent `close` lines one process keeps for its next request: the server's row is closed by the end of the row anyway, so a lost one costs a card line only. */
export const PLURAL_UNSENT_CLOSES_MAX = 50;
/** The row ids of running plural Work sent on a GET (`running`): the URL stays short; a desktop with more Works going sends the oldest first and the rest on the next read. */
export const PLURAL_RUNNING_IDS_MAX = 40;

export interface LocalJob { phase: "queued" | "claimed" | "starting" | "running" | "held" | "completed" | "failed" | "cancelled"; }
export type Outcome = PluralEnd;
export interface WorkRow { id: string; kind: "work"; from: string; fromName: string; brief: string; doneWhen: string; askVia: "row" | "local" }
export interface MessageRow { id: string; kind: "message"; from: string; items: Array<{ k: string; t: string; at?: string | number }> }
export interface PluralAnswerLike { rows: unknown[]; held?: unknown[]; cancel?: unknown[]; more?: boolean; removed?: boolean }

export interface PluralWorkPorts {
  /** POST /api/desktop/plural with `{ op, hostId, ...body }`. */
  post(body: Record<string, unknown>): Promise<CallAnswer>;
  sleep(ms: number): Promise<void>;
  /** One more GET of the place link (no wake id). */
  readAgain(): void;
  /** Can this process hand a Work to the supervisor now (the personal domain is here or reachable)? */
  ready(): boolean;
  jobOf(commandId: string): LocalJob | null;
  startWork(input: { commandId: string; text: string; doneWhen: string[]; remoteAsk: RemoteAsk }): Promise<void>;
  sendMessage(input: { commandId: string; text: string }): Promise<void>;
  /** Take a queued Work out / ask a running one to stop. */
  stopWork(commandId: string): Promise<"removed" | "requested" | "none">;
  /** The row ids of the plural Works going in this desktop's store now (not ended). */
  runningRows(): string[];
  /** What the ended job's own end says (null while it has none readable). */
  outcomeOf(commandId: string): PluralEnd | null;
  /** Close the local card of a request with the row's answer (Main's or the background service's card). True = the card is closed (or was already closed with this decision). */
  answerLocal(qid: string, answer: AskAnswer): Promise<boolean>;
  log?(line: string): void;
}

export const commandOf = (rowId: string): string => `${PLURAL_COMMAND_PREFIX}${rowId}`;
export const isPluralCommand = (commandId: string): boolean => commandId.startsWith(PLURAL_COMMAND_PREFIX) && ROW_ID.test(commandId.slice(PLURAL_COMMAND_PREFIX.length));
export const rowIdOfCommand = (commandId: string): string => commandId.slice(PLURAL_COMMAND_PREFIX.length);
const messageCommand = (rowId: string, k: string): string => `pluralmsg_${rowId.slice(2, 34)}_${k.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 60) || "0"}`;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ASK_ANSWERS: ReadonlySet<string> = new Set(["allow", "allow_task", "deny"]);

/** The one fixed line a received Work starts with (a model input: prompt-audit/composition-ledger.json `desktop.plural-work.received`). The sender's name is the person's own word: one short line, no control characters. */
export function receivedWorkText(fromName: string, brief: string): string {
  const name = fromName.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `다른 기기에서 맡긴 일${name ? ` — ${name}` : ""}. 삭제·보내기는 연결 앱 도구로 한다.\n${brief}`;
}

export function parseWorkRow(raw: unknown): WorkRow | MessageRow | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !ROW_ID.test(raw.id) || typeof raw.from !== "string") return null;
  if (raw.kind === "work") {
    if (typeof raw.brief !== "string" || !raw.brief.trim() || typeof raw.doneWhen !== "string") return null;
    return { id: raw.id, kind: "work", from: raw.from, fromName: typeof raw.fromName === "string" ? raw.fromName : "", brief: raw.brief, doneWhen: raw.doneWhen, askVia: raw.askVia === "row" ? "row" : "local" };
  }
  if (raw.kind === "message" && Array.isArray(raw.items)) {
    const items = raw.items.filter((i): i is { k: string; t: string; at?: string | number } => isObject(i) && typeof i.k === "string" && REF.test(i.k) && typeof i.t === "string" && i.t.trim() !== "")
      .map(i => ({ k: i.k, t: i.t, ...(typeof i.at === "string" || typeof i.at === "number" ? { at: i.at } : {}) }));
    return items.length === raw.items.length && items.length > 0 ? { id: raw.id, kind: "message", from: raw.from, items } : null;
  }
  return null;
}

/** `held[]`: the row's answers to the questions of this desktop's run. A shape that is not exact is dropped. */
export function parseHeld(raw: unknown): { id: string; run: string | undefined; approvals: Array<{ qid: string; answer: AskAnswer }>; taskAllow: AskKind[] } | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !ROW_ID.test(raw.id)) return null;
  const approvals = Array.isArray(raw.approvals) ? raw.approvals.filter((a): a is { qid: string; answer: AskAnswer } => isObject(a) && typeof a.qid === "string" && REF.test(a.qid) && typeof a.answer === "string" && ASK_ANSWERS.has(a.answer)).map(a => ({ qid: a.qid, answer: a.answer })) : [];
  const taskAllow = Array.isArray(raw.taskAllow) ? raw.taskAllow.filter((k): k is AskKind => k === "money" || k === "delete" || k === "send") : [];
  return { id: raw.id, run: typeof raw.run === "string" ? raw.run : undefined, approvals, taskAllow };
}

/** `HH:MM` of an item's original time in the person's clock, with the day when it is not today; "" when the server gave none or a value that is no instant. */
function stamp(at: string | number | undefined, now: Date): string {
  if (at === undefined) return "";
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  const day = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate() ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `;
  return `${day}${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function messageBatchText(items: ReadonlyArray<{ t: string; at?: string | number }>, now: Date = new Date()): string {
  return items.map(i => { const s = stamp(i.at, now); return s ? `[${s}] ${i.t}` : i.t; }).join("\n\n");
}

export type Sent = { kind: "ok"; status: string; body: Record<string, unknown> } | { kind: "closed" } | { kind: "gave_up" } | { kind: "refused" };

/** What the host gate asks of the row (plural-remote-ask.ts `PluralRowAsker`, B's interface; structurally the same). */
export interface PluralRowAskerLike {
  ask(remote: RemoteAsk, q: PluralQuestion): Promise<"asked" | "allowed" | "refused">;
  answer(remote: RemoteAsk, qid: string, answer: AskAnswer): Promise<AskAnswer | null>;
  close(remote: RemoteAsk, qid: string, why: CloseWhy, answer?: AskAnswer): Promise<void>;
}

export function createPluralWorkReceiver(ports: PluralWorkPorts) {
  const log = (line: string): void => { try { ports.log?.(line); } catch { /* a log never changes the answer */ } };
  const inFlight = new Set<string>();   // rows this process claimed and has not yet handed to the supervisor (a `held` read must not call them lost)
  const delivered = new Set<string>();  // `<row>/<k>` of left words this process placed whose claim did not go through (bounded): an item added meanwhile does not bring the earlier ones again
  let closed = false, stopped = false;
  let running: Promise<void> | null = null, again: PluralAnswerLike | null = null;
  const unsentCloses: Array<{ id: string; qid: string; why: CloseWhy; answer?: AskAnswer }> = [];

  /** One request with the retry ladder. `closed` = the server's switch is closed (404). */
  async function send(body: Record<string, unknown>): Promise<Sent> {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return { kind: "gave_up" };
      const out = await ports.post(body);
      if (out.status === 404) { closed = true; return { kind: "closed" }; }
      const status = typeof out.body?.status === "string" ? out.body.status : "";
      if (out.ok && out.body && !TRANSIENT_WORDS.has(status)) { closed = false; return { kind: "ok", status, body: out.body }; }
      const transient = out.unreachable === true || out.status >= 500 || out.status === 429 || out.status === 0 || (out.ok && TRANSIENT_WORDS.has(status));
      if (!transient) return { kind: "refused" };
      if (attempt >= PLURAL_RETRY.retries) return { kind: "gave_up" };
      let wait = PLURAL_RETRY.firstMs * 2 ** attempt;
      if (out.status === 429 && out.retryAfterMs !== undefined && out.retryAfterMs > 0) { if (out.retryAfterMs > PLURAL_RETRY.retryAfterMaxMs) return { kind: "gave_up" }; wait = out.retryAfterMs; }
      await ports.sleep(wait);
    }
  }

  /** The end of one row, sent. Idempotent on the server; a row the server already ended answers a quiet non-`claimed` status. */
  async function finishRow(commandId: string, end: PluralEnd): Promise<void> {
    const id = rowIdOfCommand(commandId);
    const result = [...(end.text ?? "")].slice(0, RESULT_HEAD_CHARS).join("");
    const body: Record<string, unknown> = { op: "finish", id, run: commandId, state: end.state, ...(end.why ? { why: end.why } : {}), started: end.started, ...(result ? { result } : {}) };
    const out = await send(body);
    if (out.kind === "gave_up") log(`finish ${commandId}: not sent, the next read sends it again`);
  }

  /** Closes a question could not tell the row about are told again by the next request of this process. */
  async function flushCloses(): Promise<void> {
    while (unsentCloses.length && !stopped) {
      const line = unsentCloses[0]!;
      const out = await send({ op: "close", id: line.id, qid: line.qid, why: line.why, ...(line.answer ? { answer: line.answer } : {}) });
      if (out.kind === "gave_up") return;
      unsentCloses.shift();
    }
  }
  const keepClose = (line: { id: string; qid: string; why: CloseWhy; answer?: AskAnswer }): void => { unsentCloses.push(line); while (unsentCloses.length > PLURAL_UNSENT_CLOSES_MAX) unsentCloses.shift(); };

  /** The questions of one run, up to the row and back (the host gate's port). */
  const asker: PluralRowAskerLike = {
    async ask(remote, q) {
      void flushCloses();
      const out = await send({ op: "ask", id: remote.rowId, run: commandOf(remote.rowId), qid: q.qid, kind: q.kind, target: q.target.slice(0, 200), ...(q.preview ? { preview: q.preview } : {}) });
      if (out.kind === "gave_up") return "asked";   // the row cannot be reached: the card of this desktop stays and its answer is the answer (told to the row at the next request)
      if (out.kind !== "ok") return "refused";
      if (out.status === "asked" || out.status === "existing") return "asked";
      if (out.status === "allowed") return "allowed";
      return "refused";                              // the row ended / is gone / taken by another run: the call is refused and the Work stops by the row's own end
    },
    async answer(remote, qid, answer) {
      const out = await send({ op: "answer", id: remote.rowId, qid, answer });
      if (out.kind === "gave_up") { keepClose({ id: remote.rowId, qid, why: "answered_here", answer }); return null; }
      if (out.kind !== "ok") return null;
      if (out.status === "answered") return answer;
      if (out.status === "existing" && typeof out.body.answer === "string" && ASK_ANSWERS.has(out.body.answer)) return out.body.answer as AskAnswer;   // the first answer is the answer
      return null;
    },
    async close(remote, qid, why, answer) {
      const out = await send({ op: "close", id: remote.rowId, qid, why, ...(answer ? { answer } : {}) });
      if (out.kind === "gave_up") keepClose({ id: remote.rowId, qid, why, ...(answer ? { answer } : {}) });
    },
  };

  async function reconcileHeld(raw: unknown): Promise<void> {
    const entry = parseHeld(raw);
    if (!entry) return;
    const commandId = commandOf(entry.id);
    if (entry.run !== undefined && entry.run !== commandId) return;   // a run number this code did not make (another version of the desktop): not ours to end
    if (inFlight.has(entry.id)) return;
    const job = ports.jobOf(commandId);
    if (!job) { await finishRow(commandId, { state: "failed", why: "interrupted", started: false }); return; }   // nobody of this desktop runs it
    for (const a of entry.approvals) {
      try { await ports.answerLocal(a.qid, a.answer); } catch (error) { log(`answer ${a.qid} not placed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); }
    }
    if (!TERMINAL.has(job.phase)) return;                                                                 // still going (or waiting its turn): nothing more to say
    const end = ports.outcomeOf(commandId);
    if (end) await finishRow(commandId, end);
  }

  async function handleWork(row: WorkRow): Promise<void> {
    const commandId = commandOf(row.id);
    if (!ports.ready()) return;
    inFlight.add(row.id);
    try {
      const claimed = await send({ op: "claim", id: row.id, run: commandId });
      if (claimed.kind !== "ok" || claimed.status !== "claimed") return;                                  // taken / expired / refused / not reached: nothing starts
      if (ports.jobOf(commandId)) return;                                                                 // already started (the same row heard twice, or by the other process)
      try {
        await ports.startWork({ commandId, text: receivedWorkText(row.fromName, row.brief), doneWhen: row.doneWhen.trim() ? [row.doneWhen] : [], remoteAsk: { rowId: row.id, askVia: row.askVia, from: row.from, fromName: row.fromName } });
      } catch (error) {
        if (ports.jobOf(commandId)) return;                                                               // the other process admitted it first
        log(`work ${commandId} did not start: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
        await finishRow(commandId, { state: "failed", why: "error", started: false });
      }
    } finally { inFlight.delete(row.id); }
  }

  async function handleMessage(row: MessageRow): Promise<void> {
    if (!ports.ready()) return;
    const fresh = row.items.filter(i => !delivered.has(`${row.id}/${i.k}`));
    if (fresh.length) {
      try { await ports.sendMessage({ commandId: messageCommand(row.id, fresh[fresh.length - 1]!.k), text: messageBatchText(fresh) }); }
      catch (error) { log(`message ${row.id} not placed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); return; }   // nothing is acknowledged: the next read brings the same words again, placed once
      for (const i of fresh) delivered.add(`${row.id}/${i.k}`);
      while (delivered.size > 200) delivered.delete(delivered.values().next().value as string);
    }
    const done = await send({ op: "claim", id: row.id, upTo: row.items[row.items.length - 1]!.k });
    if (done.kind === "ok") { for (const i of row.items) delivered.delete(`${row.id}/${i.k}`); if (typeof done.body.left === "number" && done.body.left > 0) ports.readAgain(); }
  }

  async function cancelRow(id: string): Promise<void> {
    if (typeof id !== "string" || !ROW_ID.test(id)) return;
    const commandId = commandOf(id), job = ports.jobOf(commandId);
    if (!job) return;
    if (TERMINAL.has(job.phase)) return;   // its end is sent by the `held` pass of the same answer
    const stop = await ports.stopWork(commandId);
    if (stop === "removed") { const end = ports.outcomeOf(commandId); if (end) await finishRow(commandId, end); }
    // "requested": the run's own end (stopped / cancelled) is what the row ends with, sent when that end is read
  }

  /** The phone disconnected this desktop: the server ended every row of it already, so the Works are stopped and nothing is sent. */
  async function stopEverything(): Promise<void> {
    for (const id of ports.runningRows()) { if (stopped) return; try { await ports.stopWork(commandOf(id)); } catch (error) { log(`stop ${id}: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); } }
  }

  async function run(answer: PluralAnswerLike): Promise<void> {
    if (answer.removed === true) { await stopEverything(); return; }
    const rows = answer.rows.map(parseWorkRow).filter((r): r is WorkRow | MessageRow => r !== null);
    const cancelIds = new Set((answer.cancel ?? []).filter((x): x is string => typeof x === "string"));
    for (const row of rows) { if (stopped) return; if (row.kind === "work") await handleWork(row); else await handleMessage(row); }
    for (const id of cancelIds) { if (stopped) return; await cancelRow(id); }
    for (const entry of answer.held ?? []) { if (stopped) return; await reconcileHeld(entry); }
    await flushCloses();
    if (answer.more === true) ports.readAgain();
  }

  return {
    /** One answer of the place link's GET. Answers that arrive while one is handled are folded: the newest is handled after. */
    handle(answer: PluralAnswerLike): Promise<void> {
      if (running) { again = answer; return running; }
      running = (async () => {
        let next: PluralAnswerLike | null = answer;
        while (next && !stopped) { again = null; try { await run(next); } catch (error) { log(`plural answer not handled: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`); } next = again; }
      })().finally(() => { running = null; });
      return running;
    },
    /** A Work of this desktop ended here (the host that ran it says so): its end goes out now. */
    async ended(commandId: string): Promise<void> {
      if (!isPluralCommand(commandId) || stopped || closed) return;
      const job = ports.jobOf(commandId);
      if (!job || !TERMINAL.has(job.phase)) return;
      const end = ports.outcomeOf(commandId);
      if (end) { await finishRow(commandId, end); void flushCloses(); }
    },
    /** This desktop's account signed out: the server ends the rows of this place and frees it. One request, the ladder, never an error to the caller. */
    async gone(): Promise<void> { try { await send({ op: "gone" }); } catch { /* a sign-out never waits for it; the server's own sweep frees the place */ } },
    asker,
    flushCloses,
    stop(): void { stopped = true; },
    get switchClosed(): boolean { return closed; },
  };
}
export type PluralWorkReceiver = ReturnType<typeof createPluralWorkReceiver>;
