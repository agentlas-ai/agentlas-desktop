// The line of turns on one shared session, kept in the database so that every process sees it.
//
// A seat's conversations share one journal and one native session (session-scope.ts), and their turns run one after the other
// (agent-context-turn-order.ts). The first-in-first-out line of one process cannot see the other process: the window process
// and the background service share only the database file, and a turn shows there (as the journal's open delivery) only late,
// after its history import and routing. Two turns that arrived at the same instant in the two processes both passed the check,
// and the second one then failed with agent_context_delivery_busy: the dead end the wait was meant to remove. Here a turn takes
// its place in a durable line AT ARRIVAL, in one write transaction (sequence = last + 1), and may proceed when it is first among
// the live places. The head holds the session for the length of its turn and releases in `finally`; nobody can pass an earlier
// arrival, whichever process it came from, so a loop of short turns in one process cannot starve a waiter of the other.
//
// A place is a row of the `meta` table (no schema change): key `session-turn-line:<journal>:<sequence>:<token>`, value JSON.
// A place whose holder is gone must not block: it is skipped (and removed once its run is over) when
//   - its process is not alive (kill signal 0; the two processes are on one machine), or
//   - its run is over: the run-owner row of that turn is released or taken by a newer lease (store/invocation-owner-core.ts,
//     the evidence the run-owner code itself keeps), or
//   - its heartbeat has not changed for TURN_LINE_STALE_MS of the observer's monotonic time (a reused process id after a
//     reboot; monotonic so that a suspended machine, where nobody beat, is not read as a death).
// A dead holder's place whose run lease is still open stays in the table as evidence ("dead") until that lease is released
// (the next start of that kind of process releases it), so a waiter can tell a holder that died from one that is only slow.
//
// The holder also publishes what it is waiting on the owner for (a tool approval, a question): a waiter behind a parked holder
// cannot do anything but wait for a person, so the caller answers it at once in plain words instead of after the long wait.
//
// No Electron import: the background service loads this file too. All process facts come in through ports.
import { randomBytes } from "node:crypto";

export const TURN_LINE_PREFIX = "session-turn-line:";
/** A place whose beat the observer saw unchanged for this long (observer-side monotonic time) is dead. */
export const TURN_LINE_STALE_MS = 60_000;
/** The holder rewrites its place at least this often (and at once when its parked state changes). */
export const TURN_LINE_BEAT_MS = 10_000;
/** How often a live place re-reads what its process waits on. */
export const TURN_LINE_TICK_MS = 2_000;
/** A dead place whose run is not over is dropped after this long even if that never happens (a row, not a lock). */
const DEAD_PLACE_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_PLACES = 64;

export interface TurnLineWho { ownerId: string; ownerKind: string; pid: number }
export interface TurnLineTurn { chatId: string; runId: string; leaseId: string | null }

/** The subset of better-sqlite3 this file uses (real handle or a stand-in). */
export interface TurnLineDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes: number } };
  transaction<T>(fn: () => T): { immediate(): T };
}

export interface TurnLinePorts {
  db(): TurnLineDb;
  who(): TurnLineWho;
  /** Wall clock, ms. */
  now?(): number;
  /** Monotonic clock, ms (observer side). */
  monotonic?(): number;
  /** false only when the process is proven gone. */
  processAlive?(pid: number): boolean;
  /** true only when the run of that turn is proven over (released, or a newer lease took the chat). Unknown is false. */
  runEnded?(turn: TurnLineTurn): boolean;
  /** Native writers stay exclusive while their process and run are live; a missed heartbeat is not termination proof. */
  requireProcessOrRunEnd?: boolean;
  /** Physical writer tickets release explicitly after drain. A released invocation alone cannot close a quarantined writer. */
  requireProcessExit?: boolean;
  /** Recover only this exact recorded lease after independently proving its process is gone. A stale beat is not proof. */
  recoverDeadRun?(holder: { who: TurnLineWho; turn: TurnLineTurn }): void;
  /** What this process's turn of that chat waits on a person for: "approval", "question", or null. */
  parkedOn?(chatId: string): string | null;
  token?(): string;
  /** false: the owner of the handle calls tick() itself (tests). */
  autoTick?: boolean;
  onWarn?(message: string): void;
}

interface Stored {
  v: 1; token: string; who: TurnLineWho; turn: TurnLineTurn; at: number; beat: number;
  parked: { kind: string; since: number } | null;
}
export interface TurnLinePlace {
  key: string; token: string; who: TurnLineWho; turn: TurnLineTurn; at: number; beat: number;
  parked: { kind: string; since: number } | null;
  /** The holder process is gone (its place is skipped; kept until its run lease is released). */
  dead: boolean;
}
export interface TurnLineSnapshot {
  /** This turn is first among the live places: it may take the session. */
  head: boolean;
  /** The live place this turn stands behind (the head), or null when this turn is the head. */
  holder: TurnLinePlace | null;
  /** Places of holders that died and whose run lease is still open. */
  dead: readonly TurnLinePlace[];
  /** All live places in order (this turn's own included). */
  live: readonly TurnLinePlace[];
}
export interface TurnLineHandle {
  readonly token: string;
  poll(): TurnLineSnapshot;
  /** Re-read what this process waits on and rewrite the place if it changed or the beat is old. Called by the handle's timer. */
  tick(): void;
  release(): void;
}

const defaultAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string })?.code === "EPERM"; }
};

function parseStored(value: unknown): Stored | null {
  if (typeof value !== "string") return null;
  try {
    const v = JSON.parse(value) as Partial<Stored>;
    if (v?.v !== 1 || typeof v.token !== "string" || !v.who || typeof v.who.ownerId !== "string" || typeof v.who.ownerKind !== "string"
      || !Number.isInteger(v.who.pid) || !v.turn || typeof v.turn.chatId !== "string" || typeof v.turn.runId !== "string"
      || typeof v.at !== "number" || typeof v.beat !== "number") return null;
    const parked = v.parked && typeof v.parked.kind === "string" && typeof v.parked.since === "number" ? { kind: v.parked.kind, since: v.parked.since } : null;
    return { v: 1, token: v.token, who: { ownerId: v.who.ownerId, ownerKind: v.who.ownerKind, pid: v.who.pid },
      turn: { chatId: v.turn.chatId, runId: v.turn.runId, leaseId: typeof v.turn.leaseId === "string" ? v.turn.leaseId : null }, at: v.at, beat: v.beat, parked };
  } catch { return null; }
}

/** The key range of one journal's places: [prefix, prefix + "￿"). */
const rangeOf = (journal: string): { from: string; to: string } => {
  const from = `${TURN_LINE_PREFIX}${journal.slice(0, 32)}:`;
  return { from, to: `${from}￿` };
};

export function createTurnLine(ports: TurnLinePorts) {
  const now = ports.now ?? Date.now, mono = ports.monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const alive = ports.processAlive ?? defaultAlive, newToken = ports.token ?? (() => randomBytes(6).toString("hex"));
  const warn = ports.onWarn ?? ((message: string) => console.warn(`[session-turn-line] ${message}`));
  /** Observer-side memory: the beat last seen on a place and when (monotonic) this observer first saw that value. */
  const seen = new Map<string, { beat: number; at: number }>();

  function read(journal: string): Array<{ key: string; raw: string; stored: Stored | null }> {
    const { from, to } = rangeOf(journal);
    return (ports.db().prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key").all(from, to) as Array<{ key: string; value: string }>)
      .map(row => ({ key: row.key, raw: row.value, stored: parseStored(row.value) }));
  }

  /** Whether the place of ANOTHER holder is dead, by evidence only. */
  function deadHolder(key: string, place: Stored, self: TurnLineWho): boolean {
    if (place.who.ownerId === self.ownerId && place.who.pid === self.pid) return false;
    if (!alive(place.who.pid)) return true;
    if (ports.requireProcessExit) return false;
    let ended = false;
    try { ended = ports.runEnded?.(place.turn) === true; } catch { ended = false; }
    if (ended) return true;
    if (ports.requireProcessOrRunEnd) return false;
    const watched = seen.get(key), at = mono();
    if (!watched || watched.beat !== place.beat) { seen.set(key, { beat: place.beat, at }); return false; }
    return at - watched.at >= TURN_LINE_STALE_MS;
  }

  function enqueue(journal: string, turn: TurnLineTurn): TurnLineHandle {
    const token = newToken(), self = ports.who(), startedAt = now();
    const { from } = rangeOf(journal);
    let key = "";
    let released = false;
    let writtenAt = startedAt, writtenParked: string | null = null;
    let parked: { kind: string; since: number } | null = null;
    const place = (): Stored => ({ v: 1, token, who: self, turn, at: startedAt, beat: writtenAt, parked });

    function insert(): string {
      return ports.db().transaction(() => {
        const last = ports.db().prepare("SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT 1").get(from, `${from}￿`) as { key: string } | undefined;
        const lastSeq = last ? Number(last.key.slice(from.length).split(":")[0]) : 0;
        const next = `${from}${String((Number.isInteger(lastSeq) ? lastSeq : 0) + 1).padStart(10, "0")}:${token}`;
        ports.db().prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(next, JSON.stringify(place()));
        return next;
      }).immediate();
    }
    key = insert();

    function write(): void {
      if (released) return;
      writtenAt = now(); writtenParked = parked ? parked.kind : null;
      try {
        const wrote = ports.db().prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(place()), key);
        // The place is gone: an observer read a long gap in this holder's beat (a suspended machine, failing writes) as a death and
        // removed it while the turn is still running. Take a place again, at the end of the line, so the next waiter sees this turn.
        if (wrote.changes === 0) key = insert();
      } catch { /* the next tick writes it again */ }
    }
    function tick(): void {
      if (released) return;
      let kind: string | null = null;
      try { kind = ports.parkedOn?.(turn.chatId) ?? null; } catch { kind = null; }
      if (kind && !parked) parked = { kind, since: now() };
      else if (!kind && parked) parked = null;
      else if (kind && parked && parked.kind !== kind) parked = { kind, since: parked.since };
      if ((parked ? parked.kind : null) !== writtenParked || now() - writtenAt >= TURN_LINE_BEAT_MS) write();
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    if (ports.autoTick !== false) {
      timer = setInterval(tick, TURN_LINE_TICK_MS);
      (timer as { unref?: () => void }).unref?.();
    }

    function poll(): TurnLineSnapshot {
      for (let attempt = 0; ; attempt += 1) {
        const rows = read(journal);
        const toDelete: Array<{ key: string; raw: string }> = [];
        const live: TurnLinePlace[] = [], dead: TurnLinePlace[] = [];
        let mine = false;
        for (const row of rows) {
          const stored = row.stored;
          if (!stored) { toDelete.push({ key: row.key, raw: row.raw }); continue; }
          const asPlace = (isDead: boolean): TurnLinePlace => ({ key: row.key, token: stored.token, who: stored.who, turn: stored.turn,
            at: stored.at, beat: stored.beat, parked: stored.parked, dead: isDead });
          if (stored.token === token) { mine = true; live.push(asPlace(false)); continue; }
          if (!deadHolder(row.key, stored, self)) { live.push(asPlace(false)); continue; }
          let ended = false;
          try { ended = ports.runEnded?.(stored.turn) === true; } catch { ended = false; }
          if (!ended && stored.turn.leaseId && !alive(stored.who.pid) && ports.recoverDeadRun) {
            try {
              ports.recoverDeadRun({ who: stored.who, turn: stored.turn });
              ended = ports.runEnded?.(stored.turn) === true;
            } catch { /* Keep the evidence and retry on the next poll; unknown ownership never releases a lease. */ }
          }
          // The evidence stays while the dead holder's run lease is still open; it goes once that lease is released.
          if (ended || now() - stored.at > DEAD_PLACE_KEEP_MS || (!alive(stored.who.pid) && !stored.turn.leaseId)) toDelete.push({ key: row.key, raw: row.raw });
          else dead.push(asPlace(true));
        }
        if (toDelete.length) {
          try {
            ports.db().transaction(() => {
              const del = ports.db().prepare("DELETE FROM meta WHERE key = ? AND value = ?");
              for (const item of toDelete) del.run(item.key, item.raw);
            }).immediate();
          } catch { /* a busy store: the next poll prunes */ }
        }
        for (const watched of [...seen.keys()]) if (watched.startsWith(from) && !rows.some(row => row.key === watched)) seen.delete(watched);
        if (!mine) {
          // Our place is gone (removed by hand, or by an observer that took this process for dead): a new place at the back.
          if (attempt > 0 || released) throw new Error("turn_line_place_unavailable");
          warn(`the place of a turn in the line was lost; taking a new place at the back (${token})`);
          key = insert();
          continue;
        }
        const first = live[0];
        return { head: first.token === token, holder: first.token === token ? null : first, dead, live };
      }
    }

    function release(): void {
      if (released) return;
      released = true;
      if (timer) { clearInterval(timer); timer = null; }
      const remove = () => ports.db().prepare("DELETE FROM meta WHERE key = ?").run(key);
      try { remove(); } catch (error) {
        warn(`a place could not be removed (${error instanceof Error ? error.message : String(error)}); it is skipped once this process ends`);
        // A strict native ticket cannot be skipped from run-end alone. Retry exact-key cleanup after transient store
        // failure, without reopening a provider or widening any grant. Process death remains independently measurable.
        if (ports.requireProcessExit) {
          const retry = setInterval(() => { try { remove(); clearInterval(retry); } catch { /* retain until cleanup or process exit */ } }, 250);
          retry.unref?.();
        }
      }
    }
    return { token, poll, tick, release };
  }

  return {
    enqueue,
    /** Diagnostics and tests: the places of one journal in order. */
    places(journal: string): TurnLinePlace[] {
      return read(journal).flatMap(row => row.stored ? [{ key: row.key, token: row.stored.token, who: row.stored.who, turn: row.stored.turn,
        at: row.stored.at, beat: row.stored.beat, parked: row.stored.parked, dead: false }] : []).slice(0, MAX_PLACES);
    },
  };
}
