/*
 * "A request of the personal agent reached an end", read in the process that did NOT write it (Agentlas 2.0 E2E-2).
 *
 * The background service hosts the personal agent's turns: the request leaves its open states in the SERVICE's process, so the in-process signal
 * `homeCauseEnded("personal_agent")` (home-signal.ts) never reached Main, where the mirror (home-mirror.ts) and the phone bridge live. Measured (desktop-e2e-2, HEAD 7fc4740f5):
 * the answer was saved at +23 s and no upload followed for 140 s, until something else read the pointer; and a turn the runner refused reached the phone with no terminal event.
 *
 * What is read: the supervisor store's own receipt log (`one_supervisor_command_events`, one row per receipt change, a monotonic cursor, written by the store's triggers in
 * every process). Two triggers, no timer: (1) Main's `data_version` watch hears another process commit (`onExternalWrite`, store/external-writer-presence.ts) and (2) this
 * process's own request leaving its open states (`onHomeCauseEnded("personal_agent")`). Each trigger reads the rows newer than the cursor (one `MAX(cursor)` read when nothing is new)
 * and hands the ends to the listeners. Nothing is stored: the cursor lives in memory; at start it is the log's newest row, so a restart reports nothing old (an end that
 * happened while this process was down is the mirror's start signal's business, and the phone reads the snapshot at reconnect).
 *
 * Who reads it: home.ts (a turn ended in another process -> the mirror's and the move's signal) and mobile-bridge/authority.ts (a reply request that failed or was cancelled with no terminal
 * event sent for its run -> one terminal `invoke.event`). Nothing here reads a word of a message: the log row's closed `state`, `kind`, `runId`, `reason` only.
 * No Electron import: the background service loads this through the same bridge runtime.
 */
import { onHomeCauseEnded } from "./home-signal";

export type PersonalRequestEndState = "completed" | "failed" | "cancelled";
export interface PersonalRequestEnd {
  commandId: string;
  kind: string;
  state: PersonalRequestEndState;
  runId: string | null;
  /** The conversation chat the request was written in (the phone's `conversationChatId`); null when the request row is gone. */
  chatId: string | null;
  /** The receipt's closed reason word when it is one (`^[a-z0-9_]{1,64}$`), else null. */
  reason: string | null;
}

/** The two statements this file needs; better-sqlite3 satisfies it, a gate drives it with a scripted store. */
export interface EndsDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}
export interface PersonalRequestEndPorts {
  db(): EndsDb | null;
  /** Another process committed (Main's data_version watch). Returns the unsubscribe. */
  onExternalWrite(listener: () => void): () => void;
  /** This process's own request left its open states. Returns the unsubscribe. */
  onLocalEnd(listener: () => void): () => void;
}
export interface PersonalRequestEndWatch {
  /** Starts listening (idempotent). The cursor is taken now; a store that cannot be read yet takes it at the first trigger that can. */
  start(): void;
  stop(): void;
  onEnded(listener: (ends: PersonalRequestEnd[]) => void): () => void;
  running(): boolean;
}

/**
 * The ONE terminal `invoke.event` a failed or cancelled reply request still owes its phone (mobile-bridge/authority.ts sends it when none went out for the run). Only a `reply` request (a word the owner
 * wrote to the personal agent) that ended `failed` or `cancelled`, with the run and the conversation known. The code is the receipt's own closed reason word, else the one every unsettled run already
 * carries (`runtime_turn_unsettled`) or `cancelled`: no new word.
 */
export function terminalEventFor(end: PersonalRequestEnd): { runId: string; chatId: string; code: string } | null {
  if (end.kind !== "reply" || (end.state !== "failed" && end.state !== "cancelled") || !end.runId || !end.chatId) return null;
  return { runId: end.runId, chatId: end.chatId, code: end.reason ?? (end.state === "cancelled" ? "cancelled" : "runtime_turn_unsettled") };
}

/** One page of the log per read; a longer backlog is read page after page in the same trigger. */
const PAGE = 200;
const CLOSED_REASON = /^[a-z0-9_]{1,64}$/;
const END_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export function createPersonalRequestEndWatch(ports: PersonalRequestEndPorts): PersonalRequestEndWatch {
  const listeners = new Set<(ends: PersonalRequestEnd[]) => void>();
  let cursor: number | null = null;
  let stops: Array<() => void> = [];
  const newest = (db: EndsDb): number => Number((db.prepare("SELECT COALESCE(MAX(cursor), 0) AS c FROM one_supervisor_command_events").get() as { c?: number } | undefined)?.c) || 0;
  const drain = (): void => {
    let db: EndsDb | null;
    try { db = ports.db(); } catch { return; }
    if (!db) return;
    try {
      // Not taken yet (the store could not be read at start): this read only takes the mark. A turn that ended before the first readable moment is the start signal's business.
      if (cursor === null) { cursor = newest(db); return; }
      const ends: PersonalRequestEnd[] = [];
      for (;;) {
        const rows = db.prepare(
          `SELECT e.cursor AS cursor, e.command_id AS commandId, e.receipt_json AS receipt, r.origin_chat_id AS chatId
             FROM one_supervisor_command_events e LEFT JOIN one_supervisor_requests r ON r.command_id = e.command_id
            WHERE e.cursor > ? ORDER BY e.cursor LIMIT ?`,
        ).all(cursor, PAGE) as Array<{ cursor: number; commandId: string; receipt: string; chatId: string | null }>;
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.cursor;
          let receipt: Record<string, unknown> | null = null;
          try { const parsed: unknown = JSON.parse(row.receipt); receipt = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null; } catch { receipt = null; }
          const state = receipt?.state;
          if (!receipt || typeof state !== "string" || !END_STATES.has(state)) continue;
          const reason = typeof receipt.reason === "string" && CLOSED_REASON.test(receipt.reason) ? receipt.reason : null;
          ends.push({ commandId: row.commandId, kind: typeof receipt.kind === "string" ? receipt.kind : "", state: state as PersonalRequestEndState,
            runId: typeof receipt.runId === "string" && receipt.runId ? receipt.runId : null, chatId: typeof row.chatId === "string" ? row.chatId : null, reason });
        }
        if (rows.length < PAGE) break;
      }
      // The log can only grow (AUTOINCREMENT). A log that was rebuilt (a migration, a restored database) reads lower than the mark kept here: take the new mark, or every later end would be passed over silently.
      if (!ends.length) { const top = newest(db); if (top < cursor) cursor = top; return; }
      for (const listener of [...listeners]) { try { listener(ends); } catch { /* a listener never decides for the others */ } }
    } catch { /* a busy or closing store: the next trigger reads from the same cursor */ }
  };
  return {
    start() {
      if (stops.length) return;
      try { const db = ports.db(); if (db) cursor = newest(db); } catch { cursor = null; }
      stops = [ports.onExternalWrite(drain), ports.onLocalEnd(drain)];
    },
    stop() { for (const stop of stops) { try { stop(); } catch { /* already gone */ } } stops = []; },
    onEnded(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    running: () => stops.length > 0,
  };
}

const realDb = (): EndsDb => (require("../store/db") as typeof import("../store/db")).getDb() as unknown as EndsDb;
const realExternal = (listener: () => void): (() => void) => (require("../store/external-writer-presence") as typeof import("../store/external-writer-presence")).onExternalWrite(listener);
let both: PersonalRequestEndWatch | null = null;
let foreign: PersonalRequestEndWatch | null = null;
/** For a reader that must hear EVERY end, whichever process wrote it (the phone bridge): the other process's commits and this process's own. Created on first use; `start()` is idempotent. */
export function personalRequestEnds(): PersonalRequestEndWatch {
  return both ??= createPersonalRequestEndWatch({ db: realDb, onExternalWrite: realExternal,
    onLocalEnd: (listener) => onHomeCauseEnded((cause) => { if (cause === "personal_agent") listener(); }) });
}
/**
 * For a reader whose own process already hears its own ends through `homeCauseEnded` (home.ts: the mirror and the move): ONLY the other process's commits. Reading this process's own
 * ends here too would make that signal fire twice for one end.
 */
export function foreignPersonalRequestEnds(): PersonalRequestEndWatch {
  return foreign ??= createPersonalRequestEndWatch({ db: realDb, onExternalWrite: realExternal, onLocalEnd: () => () => undefined });
}
