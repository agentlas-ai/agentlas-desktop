import type Database from "better-sqlite3";
import { INTAKE_DEFAULT_RETRY_MS } from "./companion-direct-intake-client";
import { TAKEN_WORK_WAIT_ENDS_MS } from "./companion-computer-gate";

type SignedReceipt = { receipt: Record<string, unknown>; signature: string; truncated?: boolean };
type SignedChunk = { chunk: Record<string, unknown>; signature: string };
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const BATCH = 50;

/** What the server (or the road to it) said to one signed submission - a status and a closed `status` word, never text.
 *   ok     recorded | existing | settled (and, for a chunk, complete): the server has it, or has nothing more to ask of it
 *   closed HTTP 403: the signature or the registration cannot be verified; sending the same bytes again cannot change that
 *   retry  429 | 5xx | no answer | anything else: the server did not take it; `afterMs` is its Retry-After
 *   skip   this side did not send (nothing to send now): not delivered, not retried by time - the next signal looks again */
export type DeliveryReply = { kind: "ok"; settled?: boolean } | { kind: "closed" } | { kind: "retry"; afterMs?: number } | { kind: "skip" };
export type ChunkReply = { kind: "ok"; status: "recorded" | "existing" | "complete" | "settled" } | { kind: "closed" } | { kind: "retry"; afterMs?: number };
export interface DeliveryClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: DeliveryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Retry interval after one more failed pass: the server's Retry-After (else `INTAKE_DEFAULT_RETRY_MS`, 60 s) on the first failure, doubled by each
 * further failure, never past `TAKEN_WORK_WAIT_ENDS_MS` (24 h). A signal starts again from nothing. */
export function nextDeliveryDelay(previous: number, retryAfterMs?: number): number {
  const base = Number.isFinite(retryAfterMs) && (retryAfterMs as number) > 0 ? Math.floor(retryAfterMs as number) : INTAKE_DEFAULT_RETRY_MS;
  return Math.min(TAKEN_WORK_WAIT_ENDS_MS, Math.max(base, previous * 2));
}

/** Per-row retry intervals for a delivery lane that is walked by an existing tick (the front lane rides the intake tick): a row is asked about again only when its
 * own interval is over (nextDeliveryDelay), a signal clears every interval. Memory only, at most 200 rows (the oldest entry goes first). */
export function createDeliveryWaits(now: () => number) {
  const waits = new Map<string, { until: number; delay: number }>();
  return Object.freeze({
    due(id: string): boolean { const wait = waits.get(id); return !wait || wait.until <= now(); },
    retry(id: string, afterMs?: number): void {
      const delay = nextDeliveryDelay(waits.get(id)?.delay ?? 0, afterMs);
      waits.delete(id); waits.set(id, { until: now() + delay, delay });
      while (waits.size > 200) waits.delete(waits.keys().next().value as string);
    },
    done(id: string): void { waits.delete(id); },
    clear(): void { waits.clear(); },
    size: () => waits.size,
  });
}

/** One durable local queue per Desktop store (direct-work-capacity R8). A terminal receipt is signed once and its same bytes are sent when it is made
 * and again only when a signal arrives or the ONE retry timer is due - there is no period. A running or unstarted task is never looked at (terminal
 * states only; the retirement lane also reads a remote-cancelled unstarted claim). The server deduplicates the signed receipt and its push.
 * Answers: ok -> a delivery row; closed (403) -> a delivery row and one log line (the result stays in the local conversation, nothing is sent again);
 * retry -> the timer, 60 s doubling to 24 h; skip -> nothing. The timer exists only while a receipt waits for a retry. */
export function createCompanionWorkDelivery(options: {
  db: Database.Database; read(commandId: string): Promise<SignedReceipt | null>;
  send(value: SignedReceipt): Promise<DeliveryReply>; assertCurrent(): void;
  /** "terminal": the ordinary lane. "retirement": also an unstarted claim whose remote cancellation may be confirmed. */
  candidates?: "terminal" | "retirement";
  /** The retirement lane's read answers null for "nothing to send" (the server said the task is not cancelled): that is no failure and no retry. */
  unreadableIsIdle?: boolean;
  readFullChunk?(commandId: string, index: number): Promise<SignedChunk | null>;
  sendFullChunk?(value: SignedChunk): Promise<ChunkReply>;
  clock?: DeliveryClock; log?(line: string): void;
}) {
  const { db } = options, clock = options.clock ?? realClock;
  const log = options.log ?? ((line: string) => { try { console.warn(line); } catch { /* no log sink */ } });
  const terminalOnly = (options.candidates ?? "terminal") === "terminal";
  db.exec(`CREATE TABLE IF NOT EXISTS one_companion_work_delivery (
    command_id TEXT PRIMARY KEY REFERENCES one_supervisor_requests(command_id) ON DELETE CASCADE,
    result_digest TEXT NOT NULL, sent_at TEXT NOT NULL, full_result_pending INTEGER NOT NULL DEFAULT 0, next_chunk INTEGER NOT NULL DEFAULT 0
  );
  CREATE TRIGGER IF NOT EXISTS one_companion_delivery_delete AFTER DELETE ON one_supervisor_requests BEGIN
    DELETE FROM one_companion_work_delivery WHERE command_id=OLD.command_id;
  END;`);
  if (!(db.prepare("PRAGMA table_info(one_companion_work_delivery)").all() as Array<{name: string}>).some((column) => column.name === "full_result_pending"))
    db.exec("ALTER TABLE one_companion_work_delivery ADD COLUMN full_result_pending INTEGER NOT NULL DEFAULT 0");
  if (!(db.prepare("PRAGMA table_info(one_companion_work_delivery)").all() as Array<{name: string}>).some((column) => column.name === "next_chunk"))
    db.exec("ALTER TABLE one_companion_work_delivery ADD COLUMN next_chunk INTEGER NOT NULL DEFAULT 0");

  type Mode = "signal" | "timer" | "poke";
  const rank: Record<Mode, number> = { poke: 0, timer: 1, signal: 2 };
  // Memory only, bounded by the receipts that wait: the commands this process tried and the server did not take, the interval, the one timer.
  const failing = new Set<string>();
  let running: Promise<void> | null = null, rerun: Mode | null = null, timer: unknown = null, delay = 0, stopped = false;

  const where = terminalOnly
    ? "r.state IN ('completed','failed','cancelled')"
    : `(r.state IN ('completed','failed','cancelled') OR (r.state='stored' AND EXISTS(SELECT 1 FROM one_supervisor_work_jobs q WHERE q.command_id=h.command_id AND q.phase IN ('queued','claimed'))))`;
  let pendingStatement: ReturnType<Database.Database["prepare"]> | null = null;
  // Prepared after the handoff table exists (a store that never took a phone's work has none).
  const pendingRows = (after: number) => (pendingStatement ??= db.prepare(`SELECT h.rowid AS sequence,h.command_id FROM one_companion_handoffs h JOIN one_supervisor_requests r ON r.command_id=h.command_id
    LEFT JOIN one_companion_work_delivery d ON d.command_id=h.command_id
    WHERE r.kind='work' AND ${where} AND d.command_id IS NULL AND h.rowid>? ORDER BY h.rowid LIMIT ${BATCH}`)).all(after) as Array<{ command_id: string; sequence: number }>;
  /** The host no longer owns this domain (or the account is gone): nothing is wrong with the receipt, so nothing is retried by time - a signal looks again. */
  class OwnerChanged extends Error {}
  const current = () => { try { options.assertCurrent(); } catch { throw new OwnerChanged("companion_work_delivery_owner_changed"); } };

  function clearTimer() { if (timer !== null) { clock.clearTimeout(timer); timer = null; } }
  function arm(ms: number) { clearTimer(); timer = clock.setTimeout(() => { timer = null; void run("timer").catch(() => undefined); }, ms); }
  const record = (commandId: string, digest: string, pending: boolean) => {
    db.prepare("INSERT OR IGNORE INTO one_companion_work_delivery(command_id,result_digest,sent_at,full_result_pending) VALUES(?,?,?,?)")
      .run(commandId, digest, new Date().toISOString(), pending ? 1 : 0);
    const saved = db.prepare("SELECT result_digest FROM one_companion_work_delivery WHERE command_id=?").get(commandId) as { result_digest: string } | undefined;
    if (!saved || saved.result_digest !== digest) throw new Error("companion_work_delivery_conflict");
  };

  interface Pass { failed: boolean; service: boolean; afterMs: number | undefined; progressed: boolean }
  async function pass(mode: Mode): Promise<Pass> {
    const out: Pass = { failed: false, service: false, afterMs: undefined, progressed: false };
    const fail = (id: string, reply?: { afterMs?: number }, service = false) => {
      failing.add(id); out.failed = true;
      if (service) { out.service = true; if (reply?.afterMs !== undefined) out.afterMs = Math.max(out.afterMs ?? 0, reply.afterMs); }
    };
    current();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_handoffs'").get()) return out;
    let after = 0;
    for (;;) {
      const rows = pendingRows(after);
      for (const row of rows) {
        if (stopped) return out;
        after = row.sequence;
        if (mode === "poke" && failing.has(row.command_id)) continue;
        try {
          current();
          const value = await options.read(row.command_id);
          if (!value || value.receipt.commandId !== row.command_id || typeof value.receipt.state !== "string" || !TERMINAL.has(value.receipt.state) ||
              typeof value.receipt.resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.receipt.resultDigest)) {
            if (!options.unreadableIsIdle) fail(row.command_id);
            continue;
          }
          current();
          const reply = await options.send(value);
          current();
          if (reply.kind === "skip") continue;
          if (reply.kind === "retry") { fail(row.command_id, reply, true); return out; }
          if (reply.kind === "closed") log(`[companion-delivery] receipt not deliverable (HTTP 403): command ${row.command_id} - the result stays in the local conversation, nothing is sent again`);
          record(row.command_id, value.receipt.resultDigest, reply.kind === "ok" && !reply.settled && value.truncated === true);
          failing.delete(row.command_id); out.progressed = true;
        } catch (error) { if (error instanceof OwnerChanged) return out; fail(row.command_id); /* Keep the durable row unsent for a later retry. */ }
      }
      if (rows.length < BATCH) break;
    }
    if (!options.readFullChunk || !options.sendFullChunk || stopped) return out;
    const pendingFull = db.prepare(`SELECT d.rowid AS sequence,d.command_id,d.next_chunk FROM one_companion_work_delivery d
      WHERE d.full_result_pending=1 AND d.rowid>? ORDER BY d.rowid LIMIT ${BATCH}`);
    let fullAfter = 0;
    for (;;) {
      const rows = pendingFull.all(fullAfter) as Array<{ sequence: number; command_id: string; next_chunk: number }>;
      for (const row of rows) {
        if (stopped) return out;
        fullAfter = row.sequence;
        if (mode === "poke" && failing.has(row.command_id)) continue;
        try {
          for (let n = 0, index = row.next_chunk; n < 32 && !stopped; n++, index++) {
            current();
            const value = await options.readFullChunk(row.command_id, index);
            if (!value || value.chunk.commandId !== row.command_id || value.chunk.index !== index || !Number.isSafeInteger(value.chunk.count) || Number(value.chunk.count) <= index) { fail(row.command_id); break; }
            current();
            const reply = await options.sendFullChunk(value);
            current();
            if (reply.kind === "retry") { fail(row.command_id, reply, true); return out; }
            if (reply.kind === "closed") {
              log(`[companion-delivery] result chunks not deliverable (HTTP 403): command ${row.command_id} - the result stays in the local conversation, nothing is sent again`);
              db.prepare("UPDATE one_companion_work_delivery SET full_result_pending=0 WHERE command_id=? AND full_result_pending=1").run(row.command_id);
              failing.delete(row.command_id); break;
            }
            out.progressed = true;
            if (reply.status === "complete" || reply.status === "settled") {
              db.prepare("UPDATE one_companion_work_delivery SET full_result_pending=0 WHERE command_id=? AND full_result_pending=1").run(row.command_id);
              failing.delete(row.command_id);
              break;
            }
            const next = index + 1 < Number(value.chunk.count) ? index + 1 : 0;
            db.prepare("UPDATE one_companion_work_delivery SET next_chunk=? WHERE command_id=? AND full_result_pending=1 AND next_chunk=?").run(next, row.command_id, index);
            if (!next) break;
          }
        } catch (error) { if (error instanceof OwnerChanged) return out; fail(row.command_id); /* Resume from the last acknowledged chunk. */ }
      }
      if (rows.length < BATCH) break;
    }
    return out;
  }

  async function runOnce(mode: Mode): Promise<void> {
    if (mode === "signal") { delay = 0; failing.clear(); clearTimer(); }
    let result: Pass;
    try { result = await pass(mode); } catch (error) { result = { failed: !(error instanceof OwnerChanged), service: false, afterMs: undefined, progressed: false }; }
    if (stopped) { clearTimer(); return; }
    // A receipt the server did not take keeps ONE timer; with nothing left to retry there is none.
    if (result.failed) {
      if (mode === "poke" && timer !== null) return;       // a new receipt that failed does not move the interval already running
      delay = nextDeliveryDelay(mode === "poke" ? 0 : delay, result.afterMs);
      arm(delay);
    } else if (!failing.size) { clearTimer(); delay = 0; }
    else if (mode !== "poke") { failing.clear(); clearTimer(); delay = 0; }
  }
  function run(mode: Mode): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) { if (!rerun || rank[mode] > rank[rerun]) rerun = mode; return running; }
    running = (async () => {
      let next: Mode | null = mode;
      while (next && !stopped) { rerun = null; await runOnce(next); next = rerun; }
    })().finally(() => { running = null; });
    return running;
  }
  /** Looks for receipts nobody tried yet; it does not touch the interval of the ones waiting for a retry (a store write, not a reason to ask again). */
  function poke(): Promise<void> { return run("poke"); }
  /** A signal: ask now for everything that is waiting, the interval starts again. */
  function sweep(): Promise<void> { return run("signal"); }
  function start() { if (stopped) return; void sweep().catch(() => undefined); }
  async function stop() { stopped = true; clearTimer(); failing.clear(); await running?.catch(() => undefined); }
  return Object.freeze({ start, stop, sweep, poke, idle: (): Promise<void> => running ?? Promise.resolve(), state: () => ({ timerArmed: timer !== null, delayMs: delay, failing: failing.size }) });
}
