import fs from "node:fs";
import os from "node:os";
import type Database from "better-sqlite3";
import { ONE_DOMAIN_EVENT_TYPE_SQL } from "../store/one-domain-event-indexes";
import { compactToolPayload, compactTurnContextPayload } from "../store/agent-context-compaction";
import { keepRunToolSummary } from "./run-detail-summary";
import { RUN_DETAIL_CALL_KINDS, RUN_DETAIL_TEXT_KINDS, RUN_TERMINAL_KINDS } from "./run-detail-retention";
import {
  DB_RETENTION_CURSOR_KEY,
  DB_RETENTION_HOST,
  DB_RETENTION_LEASE_KEY,
  DB_RETENTION_LIMITS,
  SESSION_CHECKPOINTS_KEPT,
  retentionRule,
} from "./db-retention-policy";

/**
 * Enforces db-retention-policy.ts. Bounded: every slice is one short write transaction, the pass stops at
 * DB_RETENTION_LIMITS.passMs, and the next 30-minute pass continues because every sweep is self-draining (rows that are
 * gone are not found again) or keeps a cursor in `meta`.
 *
 * One host runs it: the Desktop Main process, from storage-maintenance.ts, as the store's migration owner. The daemon and
 * the terminal engine follow the store and never call it. Two Mains of different user-data folders on one store file (an
 * explicit AGENTLAS_STORE_PATH) are kept apart by a lease row in `meta`, in addition to the pid lock file.
 */

const DAY_MS = 86_400_000;
const MAX_VACUUM_LIVE_BYTES = 3 * 1024 ** 3;
const CHAT_DETAIL_KINDS = [...RUN_DETAIL_CALL_KINDS, ...RUN_DETAIL_TEXT_KINDS] as const;
/** Kinds that mark a run as ended. A run that only waits (invoke_waiting) is not ended. */
const ENDED_KINDS = [...RUN_TERMINAL_KINDS, "mcp_final", "mcp_error", "invoke_cancelled", "invoke_interrupted"] as const;
const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");
const ACTIVE_GOAL_CHATS = `SELECT chat_id FROM chat_goal_contracts WHERE status IN ('active', 'blocked')`;

export interface DbRetentionReport {
  ran: boolean;
  skipped: "none" | "wrong-host" | "not-owner" | "lease-held" | "disabled";
  chatDetail: { runs: number; deleted: number };
  stepEvents: { entities: number; deleted: number };
  toolEntries: { compacted: number };
  turnContextEntries: { compacted: number };
  sessionCheckpoints: { deleted: number };
  complete: boolean;
  checkpointedWal: boolean;
  vacuum: { ran: boolean; reason: string; fileBytesBefore: number; fileBytesAfter: number; ms: number };
  workMs: number;
  /** A rule that threw is named here and the other rules still ran (a store without one of the indexes, a locked memory file). */
  errors: string[];
}

export interface DbRetentionOptions {
  db: Database.Database;
  /** The memory store facade (memory/database.ts getMemoryDb); null when the memory store is not open. */
  memoryDb: (() => Database.Database) | null;
  host: string;
  /** openedStoreMigrationRole(): only the owner may run. */
  role: string | null;
  now?: number;
  /** True while the owner is working (an active run): file-level compaction waits. */
  busy?: () => boolean;
  yieldToLoop: () => Promise<void>;
  /** Runs one write with a short wait for another process's write lock; null when the store stayed busy. */
  shortBusy: <T>(write: () => T) => T | null;
  /** Default: on unless AGENTLAS_DB_COMPACT=0. */
  compact?: boolean;
}

interface Budget { startedAt: number; passMs: number }
const exhausted = (budget: Budget): boolean => Date.now() - budget.startedAt >= budget.passMs;

/* ------------------------------------------------------------------ lease */

interface Lease { pid: number; host: string; hostname: string; acquiredAt: number; heartbeatAt: number }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM");
  }
}

export function acquireRetentionLease(db: Database.Database, now: number, pid = process.pid, hostLabel = DB_RETENTION_HOST): { beat(now: number): void; release(): void } | null {
  const mine: Lease = { pid, host: hostLabel, hostname: os.hostname(), acquiredAt: now, heartbeatAt: now };
  const take = db.transaction((): boolean => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(DB_RETENTION_LEASE_KEY) as { value: string } | undefined;
    if (row) {
      let held: Partial<Lease> | null = null;
      try { held = JSON.parse(row.value) as Partial<Lease>; } catch { held = null; }
      if (held && typeof held.pid === "number" && held.pid !== pid && Number.isFinite(held.heartbeatAt)
        && now - Number(held.heartbeatAt) < DB_RETENTION_LIMITS.leaseStaleMs
        && (held.hostname !== mine.hostname || pidAlive(held.pid))) return false;
    }
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DB_RETENTION_LEASE_KEY, JSON.stringify(mine));
    return true;
  });
  if (!take.immediate()) return null;
  let lastBeat = now;
  return {
    beat(at: number) {
      if (at - lastBeat < DB_RETENTION_LIMITS.leaseHeartbeatMs) return;
      lastBeat = at;
      db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...mine, heartbeatAt: at }), DB_RETENTION_LEASE_KEY);
    },
    release() {
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(DB_RETENTION_LEASE_KEY) as { value: string } | undefined;
        const held = row ? JSON.parse(row.value) as Partial<Lease> : null;
        if (held?.pid === pid) db.prepare("DELETE FROM meta WHERE key = ?").run(DB_RETENTION_LEASE_KEY);
      } catch { /* a stale lease expires by itself */ }
    },
  };
}

/* ----------------------------------------------------------- chat detail */

interface ChatScan { kind: number; ts: string }
interface ChatSweepState { goalChats: Set<string> | null; decisions: Map<string, boolean>; summarized: Set<string> }

/**
 * Tool-call, notice and reasoning rows of chat runs that have been quiet for `days`. A run is settled when its newest event is
 * older than the cutoff and it has an ended marker, or when it has been quiet for `abandonedDays` (a run that was cut off and
 * never resumed). The legacy pass (run-detail-retention.ts) walks ended markers forward from a watermark and cannot see a run
 * it already passed. This sweep walks the ROWS: one lap over the kind index per kind, oldest first, with a cursor kept in
 * `meta` so a pass that runs out of time resumes where it stopped and a finished lap starts the next one. No row is skipped
 * for good: a run that was unsettled in one lap is judged again in the next.
 */
function sweepChatDetail(db: Database.Database, now: number, scan: ChatScan, state: ChatSweepState): { runs: number; deleted: number; done: boolean } {
  const rule = retentionRule("run_events.chat-call-detail");
  if (rule.action.type !== "delete-settled") throw new Error("db_retention_rule_shape");
  const cutoff = new Date(now - rule.action.days * DAY_MS).toISOString();
  const abandonedCutoff = new Date(now - rule.action.abandonedDays * DAY_MS).toISOString();
  const out = { runs: 0, deleted: 0, done: false };
  if (scan.kind >= CHAT_DETAIL_KINDS.length) { scan.kind = 0; scan.ts = ""; out.done = true; return out; }
  state.goalChats ??= new Set((db.prepare(ACTIVE_GOAL_CHATS).all() as Array<{ chat_id: string }>).map((row) => row.chat_id));
  // INDEXED BY: without it the planner picks the automation index and reads every row of every kind to find these four.
  const rows = db.prepare(`SELECT id, run_id, ts, chat_id, automation_id FROM run_events INDEXED BY idx_run_events_kind_ts
    WHERE kind = ? AND ts > ? AND ts < ? ORDER BY ts LIMIT 400`).all(CHAT_DETAIL_KINDS[scan.kind], scan.ts, cutoff) as
    Array<{ id: string; run_id: string; ts: string; chat_id: string | null; automation_id: string | null }>;
  if (!rows.length) { scan.kind += 1; scan.ts = ""; return out; }
  scan.ts = rows[rows.length - 1]!.ts;
  // The run's own index (+kind keeps the planner off the kind index, which would read every marker of the whole ledger).
  const lastEventTs = db.prepare("SELECT ts FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1");
  const hasEnded = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND +kind IN (${sqlList(ENDED_KINDS)}) LIMIT 1`);
  const settled = (runId: string): boolean => {
    let value = state.decisions.get(runId);
    if (value === undefined) {
      const last = (lastEventTs.get(runId) as { ts: string } | undefined)?.ts ?? "";
      value = last < cutoff && (last < abandonedCutoff || Boolean(hasEnded.get(runId)));
      if (state.decisions.size > 4000) state.decisions.clear();
      state.decisions.set(runId, value);
    }
    return value;
  };
  const doomed: string[] = []; const runs = new Set<string>();
  for (const row of rows) {
    if (row.automation_id !== null || (row.chat_id !== null && state.goalChats.has(row.chat_id)) || !settled(row.run_id)) continue;
    doomed.push(row.id); runs.add(row.run_id);
  }
  if (doomed.length) {
    db.transaction(() => {
      // The revision comparison reads this summary once the rows are gone (run-detail-summary.ts).
      for (const runId of runs) {
        if (state.summarized.has(runId)) continue;
        try { keepRunToolSummary(db, runId); } catch { /* best effort, as in the legacy pass */ }
        state.summarized.add(runId);
      }
      out.deleted = db.prepare("DELETE FROM run_events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(doomed)).changes;
    }).immediate();
    out.runs = runs.size;
  }
  return out;
}

/* ------------------------------------------------------ domain step events */

function trimStepEvents(db: Database.Database, now: number, budget: Budget, queue: { entities: Array<{ run_id: string }> | null; at: number }): { entities: number; deleted: number; done: boolean } {
  const rule = retentionRule("run_events.one_domain_event.run.step_changed");
  if (rule.action.type !== "keep-newest-per-key") throw new Error("db_retention_rule_shape");
  const window = Math.max(rule.action.keepRows, DB_RETENTION_LIMITS.domainEventReadWindow);
  const cutoff = new Date(now - (rule.action.days ?? 0) * DAY_MS).toISOString();
  if (queue.entities === null) {
    // Covered by the partial index on (run_id, version): a few tens of ms for the whole ledger.
    queue.entities = db.prepare(`SELECT run_id FROM run_events INDEXED BY idx_one_domain_event_entity_version
      WHERE kind = 'one_domain_event' GROUP BY run_id HAVING COUNT(*) > ?`).all(window) as Array<{ run_id: string }>;
    queue.at = 0;
  }
  // The seq of the 500th newest row of the entity: every reader's window starts there, nothing older can be reached.
  const edge = db.prepare("SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?");
  const remove = db.prepare(`DELETE FROM run_events WHERE id IN (
    SELECT id FROM run_events WHERE run_id = ? AND seq < ? AND ts < ? AND kind = 'one_domain_event'
      AND instr(payload_json, 'run.step_changed') > 0 AND ${ONE_DOMAIN_EVENT_TYPE_SQL} = 'run.step_changed' LIMIT ?)`);
  const result = { entities: 0, deleted: 0, done: false };
  while (queue.at < queue.entities.length) {
    const runId = queue.entities[queue.at]!.run_id;
    const limit = (edge.get(runId, window - 1) as { seq: number } | undefined)?.seq;
    if (limit === undefined) { queue.at += 1; continue; }
    const started = Date.now();
    for (;;) {
      const removed = remove.run(runId, limit, cutoff, DB_RETENTION_LIMITS.sliceRows).changes;
      result.deleted += removed;
      if (removed < DB_RETENTION_LIMITS.sliceRows) { queue.at += 1; result.entities += 1; break; }
      if (Date.now() - started > DB_RETENTION_LIMITS.sliceMs || exhausted(budget)) return result;
    }
    if (exhausted(budget)) return result;
  }
  result.done = true;
  return result;
}

/* -------------------------------------------------- agent context journal */

interface JournalRow { rid: number; context_key: string; seq: number; kind: string; payload_json: string; through_seq: number }

function compactJournal(db: Database.Database, now: number, cursor: { rowid: number }): { tools: number; turnContexts: number; done: boolean } {
  const toolRule = retentionRule("agent_context_entries.tool");
  if (toolRule.action.type !== "compact-payload") throw new Error("db_retention_rule_shape");
  const toolCutoff = new Date(now - toolRule.action.days * DAY_MS).toISOString();
  const select = db.prepare(`SELECT e.rowid AS rid, e.context_key, e.seq, e.kind, e.payload_json, h.through_seq
    FROM agent_context_entries e JOIN agent_context_heads h ON h.context_key = e.context_key
    WHERE e.rowid > ? AND e.kind IN ('tool', 'turn-context') ORDER BY e.rowid LIMIT 100`);
  const update = db.prepare("UPDATE agent_context_entries SET payload_json = ? WHERE rowid = ?");
  const out = { tools: 0, turnContexts: 0, done: false };
  const batch = select.all(cursor.rowid) as JournalRow[];
  if (!batch.length) { out.done = true; return out; }
  // A start row is superseded when a later row of the same call sits in this batch (the end row follows within a turn).
  const callOf = (payload: string): string | undefined => /"callId":"((?:[^"\\]|\\.)*)"/.exec(payload)?.[1];
  const lastOfCall = new Map<string, number>();
  for (const row of batch) {
    if (row.kind !== "tool") continue;
    const callId = callOf(row.payload_json);
    if (callId) lastOfCall.set(`${row.context_key}\u0000${callId}`, row.seq);
  }
  const started = Date.now();
  let reached = cursor.rowid;
  db.transaction(() => {
    for (const row of batch) {
      let next: string | null = null;
      if (row.kind === "tool") {
        const createdAt = /"createdAt":"([^"]+)"/.exec(row.payload_json)?.[1];
        if (!createdAt || createdAt < toolCutoff) {
          const callId = callOf(row.payload_json);
          const superseded = Boolean(callId) && (lastOfCall.get(`${row.context_key}\u0000${callId}`) ?? row.seq) > row.seq;
          next = compactToolPayload(row.payload_json, superseded);
          if (next !== null) out.tools += 1;
        }
      } else if (row.through_seq - row.seq >= 200) {
        // turn-context has no clock: it is old when it lies 200 entries behind its journal's head (about 30 turns).
        next = compactTurnContextPayload(row.payload_json);
        if (next !== null) out.turnContexts += 1;
      }
      if (next !== null) update.run(next, row.rid);
      reached = row.rid;
      if (Date.now() - started > DB_RETENTION_LIMITS.sliceMs) break;
    }
  }).immediate();
  cursor.rowid = reached;
  return out;
}

/* ------------------------------------------------- session checkpoints */

function trimSessionCheckpoints(memory: Database.Database, budget: Budget): { deleted: number; done: boolean } {
  // The head stays, plus the newest SESSION_CHECKPOINTS_KEPT - 1 others of its namespace: the same rule the writer applies on save.
  const select = memory.prepare(`SELECT rid FROM (
      SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY namespace ORDER BY through_seq DESC, rowid DESC) AS rn FROM memory_session_checkpoints
      WHERE rowid NOT IN (SELECT c.rowid FROM memory_session_checkpoint_heads h JOIN memory_session_checkpoints c ON c.checkpoint_id = h.checkpoint_id))
    WHERE rn > ? LIMIT 24`);
  const remove = memory.prepare("DELETE FROM memory_session_checkpoints WHERE rowid = ?");
  const out = { deleted: 0, done: false };
  const started = Date.now();
  while (!exhausted(budget) && Date.now() - started < DB_RETENTION_LIMITS.sliceMs) {
    const rows = select.all(SESSION_CHECKPOINTS_KEPT - 1) as Array<{ rid: number }>;
    if (!rows.length) { out.done = true; return out; }
    memory.transaction(() => { for (const row of rows) out.deleted += remove.run(row.rid).changes; }).immediate();
  }
  return out;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/* ---------------------------------------------------------------- vacuum */

function fileBytes(db: Database.Database): number {
  const pages = Number(db.pragma("page_count", { simple: true }) ?? 0);
  const size = Number(db.pragma("page_size", { simple: true }) ?? 4096);
  return pages * size;
}

/**
 * Deleted rows only join the freelist: the file keeps its size. When enough of the file is free, one VACUUM gives it back
 * and switches the store to auto_vacuum=INCREMENTAL; afterwards each pass returns freed pages in bounded steps.
 * VACUUM holds the write lock for its whole run, so it waits for a quiet moment (no active run, no checkpoint blocked by a
 * reader) and enough disk for the copy.
 */
function reclaim(db: Database.Database, options: DbRetentionOptions, passEnded: boolean): DbRetentionReport["vacuum"] {
  const rule = retentionRule("store.vacuum");
  if (rule.action.type !== "vacuum") throw new Error("db_retention_rule_shape");
  const before = fileBytes(db);
  const out = { ran: false, reason: "not-needed", fileBytesBefore: before, fileBytesAfter: before, ms: 0 };
  const free = Number(db.pragma("freelist_count", { simple: true }) ?? 0) * Number(db.pragma("page_size", { simple: true }) ?? 4096);
  const mode = Number(db.pragma("auto_vacuum", { simple: true }) ?? 0);
  if (mode === 2 && free > 0) {
    // Steady state: give back at most 16 MB of freed pages per call.
    db.pragma("incremental_vacuum(4096)");
    return { ...out, ran: true, reason: "incremental", fileBytesAfter: fileBytes(db) };
  }
  if (options.compact === false || process.env.AGENTLAS_DB_COMPACT === "0") return { ...out, reason: "disabled" };
  if (!passEnded) return { ...out, reason: "retention-not-complete" };
  if (free < rule.action.minFreeBytes || free / Math.max(1, before) < rule.action.minFreeRatio) return out;
  if (options.busy?.()) return { ...out, reason: "owner-busy" };
  let spare = Number.POSITIVE_INFINITY;
  try { const stat = fs.statfsSync(options.db.name); spare = stat.bavail * stat.bsize; } catch { /* unknown: let VACUUM fail cleanly */ }
  if (spare < before - free + 512 * 1024 * 1024) return { ...out, reason: "disk-too-small" };
  // VACUUM holds the write lock for the whole copy (12 s for 1.8 GB live on the owner clone) while the daemon and the terminal wait
  // with a 15 s busy timeout: stores whose live data would not copy in time are left to the bounded incremental path.
  if (before - free > MAX_VACUUM_LIVE_BYTES) return { ...out, reason: "too-large-for-in-place" };
  const wal = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
  if (wal[0]?.busy) return { ...out, reason: "readers-active" };
  const started = Date.now();
  try {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  } catch (error) {
    return { ...out, reason: `vacuum-failed:${(error as { code?: string }).code ?? "error"}`, ms: Date.now() - started };
  }
  return { ...out, ran: true, reason: "vacuum", fileBytesAfter: fileBytes(db), ms: Date.now() - started };
}

function vacuumMemory(db: Database.Database, free: number, before: number): { ran: boolean; reason: string } {
  // The memory store journals in rollback mode: VACUUM of an attached store needs no WAL handshake.
  if (free < 256 * 1024 * 1024 || free / Math.max(1, before) < 0.25) return { ran: false, reason: "not-needed" };
  try { db.exec("PRAGMA agentlas_memory.auto_vacuum = INCREMENTAL; VACUUM agentlas_memory;"); return { ran: true, reason: "vacuum" }; }
  catch (error) { return { ran: false, reason: `vacuum-failed:${(error as { code?: string }).code ?? "error"}` }; }
}

/* ------------------------------------------------------------------ pass */

interface Cursors { agentContext: { rowid: number }; chat: ChatScan }

function readCursors(db: Database.Database): Cursors {
  const fresh: Cursors = { agentContext: { rowid: 0 }, chat: { kind: 0, ts: "" } };
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(DB_RETENTION_CURSOR_KEY) as { value: string } | undefined;
    const parsed = row ? JSON.parse(row.value) as { agentContext?: { rowid?: number }; chat?: Partial<ChatScan> } : null;
    const rowid = Number(parsed?.agentContext?.rowid);
    const kind = Number(parsed?.chat?.kind);
    return {
      agentContext: { rowid: Number.isSafeInteger(rowid) && rowid >= 0 ? rowid : 0 },
      chat: { kind: Number.isSafeInteger(kind) && kind >= 0 && kind <= CHAT_DETAIL_KINDS.length ? kind : 0, ts: typeof parsed?.chat?.ts === "string" ? parsed.chat.ts : "" },
    };
  } catch { return fresh; }
}

function writeCursors(db: Database.Database, cursors: Cursors): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(DB_RETENTION_CURSOR_KEY, JSON.stringify(cursors));
}

export async function runDbRetentionPass(options: DbRetentionOptions): Promise<DbRetentionReport> {
  const report: DbRetentionReport = {
    ran: false, skipped: "none", chatDetail: { runs: 0, deleted: 0 }, stepEvents: { entities: 0, deleted: 0 },
    toolEntries: { compacted: 0 }, turnContextEntries: { compacted: 0 }, sessionCheckpoints: { deleted: 0 }, complete: false,
    checkpointedWal: false, vacuum: { ran: false, reason: "not-run", fileBytesBefore: 0, fileBytesAfter: 0, ms: 0 }, workMs: 0, errors: [],
  };
  const skipped = (reason: DbRetentionReport["skipped"]): DbRetentionReport => ({ ...report, skipped: reason });
  if (options.host !== DB_RETENTION_HOST) return skipped("wrong-host");
  if (options.role !== "owner") return skipped("not-owner");
  const now = options.now ?? Date.now();
  const { db } = options;
  const lease = options.shortBusy(() => acquireRetentionLease(db, now));
  if (!lease) return skipped("lease-held");
  const budget: Budget = { startedAt: Date.now(), passMs: DB_RETENTION_LIMITS.passMs };
  const cursors = readCursors(db);
  const chatState: ChatSweepState = { goalChats: null, decisions: new Map(), summarized: new Set() };
  const stepQueue: { entities: Array<{ run_id: string }> | null; at: number } = { entities: null, at: 0 };
  const done = { chat: false, steps: false, journal: false, checkpoints: false };
  try {
    report.ran = true;
    const memory = options.memoryDb ? (() => { try { return options.memoryDb!(); } catch { return null; } })() : null;
    const hasCheckpoints = memory !== null && tableExists(memory, "memory_session_checkpoints") && tableExists(memory, "memory_session_checkpoint_heads");
    const sliceLoop = async <T extends { done: boolean }>(rule: string, step: () => T, fold: (value: T) => void): Promise<boolean> => {
      while (!exhausted(budget)) {
        await options.yieldToLoop();
        let value: T | null;
        try { value = options.shortBusy(step); } catch (error) {
          report.errors.push(`${rule}:${(error as { code?: string }).code ?? (error as Error).message?.slice(0, 80) ?? "error"}`);
          return false;
        }
        if (value === null) return false;
        fold(value);
        options.shortBusy(() => lease.beat(Date.now()));
        if (value.done) return true;
      }
      return false;
    };
    done.checkpoints = !hasCheckpoints || await sliceLoop("memory_session_checkpoints", () => trimSessionCheckpoints(memory!, budget), (value) => { report.sessionCheckpoints.deleted += value.deleted; });
    done.chat = await sliceLoop("run_events.chat-call-detail", () => sweepChatDetail(db, now, cursors.chat, chatState), (value) => { report.chatDetail.runs += value.runs; report.chatDetail.deleted += value.deleted; });
    done.steps = await sliceLoop("run_events.one_domain_event.run.step_changed", () => trimStepEvents(db, now, budget, stepQueue), (value) => { report.stepEvents.entities += value.entities; report.stepEvents.deleted += value.deleted; });
    done.journal = await sliceLoop("agent_context_entries", () => compactJournal(db, now, cursors.agentContext), (value) => {
      report.toolEntries.compacted += value.tools; report.turnContextEntries.compacted += value.turnContexts;
    });
    // A finished walk starts again from the beginning next time: rows written after it passed are found on the next lap.
    if (done.journal) cursors.agentContext.rowid = 0;
    options.shortBusy(() => writeCursors(db, cursors));
    report.complete = done.chat && done.steps && done.journal && done.checkpoints && report.errors.length === 0;
    const changed = report.chatDetail.deleted + report.stepEvents.deleted + report.toolEntries.compacted
      + report.turnContextEntries.compacted + report.sessionCheckpoints.deleted;
    if (changed > 0) {
      const checkpoint = options.shortBusy(() => db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>);
      report.checkpointedWal = Boolean(checkpoint && !checkpoint[0]?.busy);
    }
    await options.yieldToLoop();
    report.vacuum = reclaim(db, options, report.complete);
    if (memory) {
      const free = Number(db.pragma("agentlas_memory.freelist_count", { simple: true }) ?? 0) * Number(db.pragma("agentlas_memory.page_size", { simple: true }) ?? 4096);
      const total = Number(db.pragma("agentlas_memory.page_count", { simple: true }) ?? 0) * Number(db.pragma("agentlas_memory.page_size", { simple: true }) ?? 4096);
      if (report.complete && !options.busy?.() && options.compact !== false && process.env.AGENTLAS_DB_COMPACT !== "0") {
        const memoryVacuum = vacuumMemory(db, free, total);
        if (memoryVacuum.ran || memoryVacuum.reason !== "not-needed") report.vacuum = { ...report.vacuum, reason: `${report.vacuum.reason}; memory:${memoryVacuum.reason}` };
      }
    }
    return report;
  } finally {
    report.workMs = Date.now() - budget.startedAt;
    options.shortBusy(() => lease.release());
  }
}
