import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import { followupRequestJson } from "../../shared/followup-custody";
import {
  TRANSIENT_SEND_DEADLINE_MS,
  isTransientRunFailureCode,
  isTransientSendRefusal,
  sendRefusalCode,
  transientSendBackoffMs,
} from "../../shared/transient-send-refusal";

/**
 * Per-chat durable send queue: whatever the owner types is accepted, shown once, and run.
 *
 * A message leaves the queue only on typed placement evidence (opencode/pi: a message leaves the inbox when it is
 * placed in the transcript). Admission alone used to mark it "started" (audit 31 A5), so a run refused or lost before
 * the runtime placed the turn took the message with it. Now: admitted → "starting"; the run settles → its durable
 * placement facts (turn-placement.ts, written by mcp/client.ts) decide: placed → "started"; every attempt provably sent
 * nothing → back to "queued" once, then "failed"; anything else → "uncertain", never re-sent (receipt status "held").
 * The queue is Main-owned: a closed window no longer abandons its messages; they start from another live window of the
 * app, or wait for one until the deadline.
 *
 * A message the chat cannot take right now (a run is active, about to start, settling, or the chat is moving between
 * the app window and the background service) is saved here together with its transcript row, and started by this queue
 * the moment the chat is free, in the order it was typed. A transient refusal (see shared/transient-send-refusal.ts)
 * is retried with a bounded backoff in this process; it never reaches the renderer as text, a red notice, a card or a
 * synthetic reply. Only a refusal that needs the owner (not signed in, out of credits, ...) ends the wait.
 *
 * This generalizes the queued-steer ledger (store/invocation-steers.ts): that one waits for a run that is steerable
 * from this process; this one covers every other reason the chat is not ready.
 *
 * Pure of Electron: every side effect arrives through `deps`, so the behavior is testable end to end with a real
 * SQLite handle and a fake clock.
 */

export interface PendingSendStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface PendingSendDb {
  exec(sql: string): unknown;
  prepare(sql: string): PendingSendStatement;
}

/**
 * "starting": admitted (a run exists), placement not yet known. "started": the runtime placed the turn (or the host
 * completed the message). "uncertain": the run ended without placement evidence and without proof that nothing was
 * sent; it is never re-sent.
 */
export type PendingSendState = "queued" | "starting" | "started" | "uncertain" | "failed" | "gave_up" | "abandoned" | "held";

export interface PendingSendRecord {
  id: string;
  seq: number;
  chatId: string;
  intentId: string | null;
  promptHash: string;
  state: PendingSendState;
  attempts: number;
  lastCode: string | null;
  createdAt: number;
  userRow: unknown | null;
  /** The run that took the message (from "starting" on); null while queued. */
  runId: string | null;
  request: McpInvocationRequest;
}

/** A settled run's placement, from durable facts only (turn-placement.ts; a completed run counts as placed). */
export type PendingSendPlacement = "placed" | "not-dispatched" | "unconfirmed";

/** Main may mint this only for its own failed store read before calling the
 * original source. A provider error string or lost ACK cannot grant retry. */
export class PendingSendSourceReadBusy extends Error {
  private constructor(readonly sqliteCode: string) {
    super("pending_send_source_read_busy");
  }
  static from(error: unknown): PendingSendSourceReadBusy | null {
    const code = (error as {code?:unknown})?.code;
    return typeof code === "string" && ["SQLITE_BUSY","SQLITE_BUSY_RECOVERY","SQLITE_BUSY_SNAPSHOT","SQLITE_BUSY_TIMEOUT",
      "SQLITE_LOCKED","SQLITE_LOCKED_SHAREDCACHE","SQLITE_LOCKED_VTAB"].includes(code) ? new PendingSendSourceReadBusy(code) : null;
  }
}

export interface PendingChatSendsDeps<Sender> {
  db: PendingSendDb;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** 0..1, for jitter. */
  random(): number;
  /** No run active, no admission pending, no run-owner row alive for the chat, in either process. */
  isChatFree(chatId: string): boolean;
  /** Durable owner input waits for its original authenticated account. */
  /** Main still owns exact original input; elapsed time never consumes it. */
  persistentInput?(sendId: string, request: McpInvocationRequest): boolean;
  onHeld?(sendId: string, code: string): void;
  inputReady?(sendId: string, request: McpInvocationRequest): boolean;
  senderAlive(sender: Sender): boolean;
  /**
   * An owner text accepted here as a refused steer (its row has the steer's intent id) that the process hosting the turn already
   * recorded under that same intent: it is delivered there, so this row must not start it a second time (a lost reply made the
   * refusal look like "nothing was recorded"). Never throws into the queue; unreadable counts as not recorded.
   */
  alreadyDelivered?(chatId: string, intentId: string): boolean;
  /** A live sender of this app to start from when the message's own window is gone (null: none open right now). */
  replacementSender?(chatId: string): Sender | null;
  /**
   * True when a start refusal is about the SENDER (a window that is not, or no longer, a trusted app page: the startup
   * page right after a restart, a window that navigated away), not about the message. The message keeps its place and
   * waits for a usable window instead of failing (no-dead-end sweep 2026-10-25, found live: after a restart the first
   * re-homed window was refused untrusted-site-publish-ipc-sender and the message ended "could not run").
   */
  senderRefused?(cause: unknown): boolean;
  /** "running" while the run that took a message is live (in either host); "settled" once it has a terminal. */
  runState(runId: string): "running" | "settled";
  /** Typed placement of a settled run (called only after runState says settled). */
  placement(runId: string): PendingSendPlacement;
  /**
   * The settled run's machine failure code (its receipt's errorCode), null when it has none. A run refused before dispatch
   * for a "chat or session occupied" code (shared/transient-send-refusal.ts isTransientRunFailureCode) is started again.
   */
  failureCode?(runId: string): string | null;
  /** Saves the owner's message to the transcript now. Null when it could not be saved (the run will save it). */
  saveUserRow(request: McpInvocationRequest): unknown | null;
  /** Starts the run. Throws the start refusal unchanged. `userRow` is the row saved by saveUserRow. */
  start(sender: Sender, request: McpInvocationRequest, userRow: unknown | null, sendId: string): Promise<unknown>;
  /** A Main custody adapter can veto a transient retry whose effect is unknown. */
  reserveStart?(sendId: string, request: McpInvocationRequest, markStarting: () => void): void;
  /** V2 follow-up custody reserves its cancellation target before the first
   * asynchronous source wait. Legacy plain sends retain their prior contract. */
  reservePlainStart?(sendId: string, request: McpInvocationRequest, markStarting: () => void): void;
  canRetryStart?(request: McpInvocationRequest, runId: string): boolean;
  onPlaced?(sendId: string, runId: string): void;
  /**
   * The wait ended without a placed run: a permanent refusal, the deadline, a restart, or a run that ended with its
   * placement unconfirmed ("uncertain": never re-sent; `runId` names that run). Never called for a transient refusal.
   */
  onEnded?(event: { chatId: string; request: McpInvocationRequest; reason: "permanent" | "deadline" | "closed" | "uncertain"; code?: string; runId?: string;
    /** The pending_chat_sends row id: the message's identity when no run ever took it (ID-8). */
    sendId: string }): void;
  onChange?(chatId: string): void;
  /**
   * Called on every look while the head message waits for a busy chat (cheap, no writes expected). Lets the wiring
   * explain why it is still waiting and release a lease whose owner is provably gone. Never throws into the queue.
   */
  onBusyWait?(info: { chatId: string; waitedMs: number; attempts: number }): void;
  log?(message: string, detail: Record<string, unknown>): void;
}

const MAX_REQUEST_BYTES = 1_000_000;
/** While the chat is busy we only look; a look is cheap and writes nothing. */
const BUSY_POLL_MS = 750;
/** While no window of the app is open, a waiting message looks for one this often (bounded by the deadline). */
const SENDER_WAIT_POLL_MS = 2_000;
/** A started message whose run has not settled is looked at this often (a settle notification usually comes first). */
const STARTING_POLL_MS = 2_000;
/** Re-queues after a run that provably sent nothing (R-084: keep the message, retry once). */
const MAX_NOT_DISPATCHED_RETRIES = 1;
/** Immediate tries to write down a run that started, before it is kept in memory and written at the next look. */
const START_RECORD_TRIES = 3;

export function pendingSendPromptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One-use attachment/team refs can wait only after Main has captured exact
 * durable input custody. The flag is a host decision, never a request field.
 * System-originated and agent-app turns keep their separate execution lanes.
 */
export function canQueuePendingSend(request: McpInvocationRequest | null | undefined, durableInputCustody = false): request is McpInvocationRequest {
  if (!request || typeof request.chatId !== "string" || !request.chatId) return false;
  if (typeof request.userPrompt !== "string" || !request.userPrompt.trim()) return false;
  if (request.agentAppMode || (request.oneAttachmentRef || request.oneTeamPreflightRef) && !durableInputCustody) return false;
  if (request.promptOrigin === "system") return false;
  try { return Buffer.byteLength(JSON.stringify(request), "utf8") <= MAX_REQUEST_BYTES; } catch { return false; }
}

/** Automatic work yields to accepted owner input without making the queue's
 * own chatIsFree check see itself as busy. Held/unknown inputs grant no drain
 * and must not block a newer owner direction. No schema is created here. */
export function hasQueuedOwnerChatSend(db: Pick<PendingSendDb,"prepare">, chatId:string): boolean {
  if (!chatId) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_chat_sends'").get()) return false;
  return Boolean(db.prepare("SELECT 1 FROM pending_chat_sends WHERE chat_id=? AND state IN ('queued','starting') LIMIT 1").get(chatId));
}

export function createPendingChatSends<Sender>(deps: PendingChatSendsDeps<Sender>) {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS pending_chat_sends (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    intent_id TEXT,
    request_json TEXT NOT NULL,
    user_row_json TEXT,
    prompt_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_chat_sends_chat_state ON pending_chat_sends(chat_id, state, seq);`);
  // Additive columns (older stores keep their rows): the run that took the message, and its not-dispatched re-queues.
  const columns = new Set((deps.db.prepare("PRAGMA table_info(pending_chat_sends)").all() as { name: string }[]).map((row) => row.name));
  if (!columns.has("run_id")) deps.db.exec("ALTER TABLE pending_chat_sends ADD COLUMN run_id TEXT");
  if (!columns.has("dispatch_retries")) deps.db.exec("ALTER TABLE pending_chat_sends ADD COLUMN dispatch_retries INTEGER NOT NULL DEFAULT 0");
  // When the current run of transient refusals began (null while none, or after the chat was seen busy: waiting for a busy
  // chat is not a failure and never counts toward the deadline), and the earliest time the next attempt may start.
  if (!columns.has("refused_since")) deps.db.exec("ALTER TABLE pending_chat_sends ADD COLUMN refused_since INTEGER");
  if (!columns.has("not_before")) deps.db.exec("ALTER TABLE pending_chat_sends ADD COLUMN not_before INTEGER");

  const senders = new Map<string, Sender>();
  const timers = new Map<string, unknown>();
  const pumping = new Set<string>();
  // sendId -> runId of a run that STARTED while its row could not be updated (a locked or full store). The row still reads "queued";
  // this is what keeps it from being started a second time until the write lands (recordStart).
  const unrecorded = new Map<string, string>();

  const insert = deps.db.prepare(`INSERT INTO pending_chat_sends
    (id, chat_id, intent_id, request_json, user_row_json, prompt_hash, state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`);
  const setState = deps.db.prepare("UPDATE pending_chat_sends SET state = ?, last_code = COALESCE(?, last_code), updated_at = ? WHERE id = ?");
  const setAttempt = deps.db.prepare("UPDATE pending_chat_sends SET attempts = attempts + 1, last_code = COALESCE(?, last_code), refused_since = COALESCE(refused_since, ?), updated_at = ? WHERE id = ?");
  const clearRefusedSince = deps.db.prepare("UPDATE pending_chat_sends SET refused_since = NULL WHERE id = ? AND refused_since IS NOT NULL");
  // A run refused before dispatch because the chat or its session was occupied: back in its own place, after a backoff.
  const requeueOccupied = deps.db.prepare(`UPDATE pending_chat_sends SET state = 'queued', run_id = NULL, attempts = attempts + 1,
    last_code = ?, refused_since = COALESCE(refused_since, ?), not_before = ?, updated_at = ? WHERE id = ?`);
  const resumeQueued = deps.db.prepare("UPDATE pending_chat_sends SET refused_since = NULL, not_before = NULL, updated_at = ? WHERE state = 'queued'");
  const headOf = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND state = 'queued' ORDER BY seq LIMIT 1");
  const countOf = deps.db.prepare("SELECT COUNT(*) AS n FROM pending_chat_sends WHERE chat_id = ? AND state IN ('queued', 'starting')");
  const setStarting = deps.db.prepare("UPDATE pending_chat_sends SET state = 'starting', run_id = ?, updated_at = ? WHERE id = ?");
  // After a SUCCESSFUL start: only a row still waiting (or already marked starting by the custody reservation) takes the run; a row the
  // owner cancelled meanwhile is never brought back.
  const recordStarted = deps.db.prepare("UPDATE pending_chat_sends SET state = 'starting', run_id = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'starting')");
  const requeue = deps.db.prepare("UPDATE pending_chat_sends SET state = 'queued', run_id = NULL, dispatch_retries = dispatch_retries + 1, last_code = ?, updated_at = ? WHERE id = ?");
  const startingOf = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND state = 'starting' ORDER BY seq");
  const startingByRun = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE run_id = ? AND state = 'starting'");
  const startingChats = deps.db.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_chat_sends WHERE state = 'starting'");
  const byId = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE id = ?");
  const byIntent = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND intent_id = ? ORDER BY seq DESC LIMIT 1");
  const queuedChats = deps.db.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_chat_sends WHERE state = 'queued'");

  type Row = { id: string; seq: number; chat_id: string; intent_id: string | null; request_json: string; user_row_json: string | null;
    prompt_hash: string; state: PendingSendState; attempts: number; last_code: string | null; created_at: number;
    run_id: string | null; dispatch_retries: number; refused_since: number | null; not_before: number | null };
  const record = (row: Row): PendingSendRecord => ({
    id: row.id, seq: row.seq, chatId: row.chat_id, intentId: row.intent_id, promptHash: row.prompt_hash, state: row.state,
    attempts: row.attempts, lastCode: row.last_code, createdAt: row.created_at,
    userRow: row.user_row_json ? JSON.parse(row.user_row_json) as unknown : null,
    runId: row.run_id ?? null,
    request: JSON.parse(row.request_json) as McpInvocationRequest,
  });

  /*
   * A message accepted by an earlier process (the app quit, crashed, or installed an update while it waited) is still the
   * owner's message: it was accepted, shown, and never placed. It used to be marked "abandoned" here with no notice, so the
   * owner's text sat in the transcript with no reply for good (no-dead-end sweep 2026-10-25). It now keeps its place and
   * starts from the first live window of this process, in the order it was typed. The refusal clock restarts: the downtime
   * was not the chat refusing it.
   */
  function resumeAfterRestart(): number {
    resumeQueued.run(deps.now());
    let n = 0;
    for (const entry of queuedChats.all() as { chatId: string }[]) { kick(entry.chatId, 0); n++; }
    return n;
  }

  /*
   * A message the runtime may or may not have placed is decided once its run has settled, from durable facts only.
   * `restarted`: the run belonged to an earlier process of this host. A run that provably sent nothing is started
   * again (resumeAfterRestart); one whose placement is unconfirmed is never re-sent; a placed one counts as started.
   */
  function persistent(row: Row, request: McpInvocationRequest): boolean {
    try { return deps.persistentInput?.(row.id,request) === true; }
    catch { return Boolean(request.oneAttachmentRef || request.oneTeamPreflightRef); }
  }

  function settleStarting(row: Row, opts: { restarted?: boolean } = {}): "pending" | "done" {
    const request = JSON.parse(row.request_json) as McpInvocationRequest;
    const chatId = row.chat_id;
    const finish = (state: PendingSendState, code: string | null): void => {
      setState.run(state, code, deps.now(), row.id);
      senders.delete(row.id);
      deps.log?.(`pending send ${state}`, { chatId, sendId: row.id, runId: row.run_id, ...(code ? { code } : {}) });
      deps.onChange?.(chatId);
    };
    if (!row.run_id) {
      finish("uncertain", "run_unknown");
      deps.onEnded?.({ chatId, request, reason: "uncertain", code: "run_unknown", sendId: row.id });
      return "done";
    }
    let runState: "running" | "settled";
    try { runState = deps.runState(row.run_id); } catch { runState = "running"; }
    if (runState === "running") return "pending";
    let placement: PendingSendPlacement;
    try { placement = deps.placement(row.run_id); } catch { placement = "unconfirmed"; }
    if (placement === "placed") { finish("started", null); deps.onPlaced?.(row.id, row.run_id); return "done"; }
    let failureCode: string | null = null;
    if (placement === "not-dispatched") { try { failureCode = deps.failureCode?.(row.run_id) ?? null; } catch { failureCode = null; } }
    if (placement === "not-dispatched" && (!opts.restarted || persistent(row,request)) && isTransientRunFailureCode(failureCode)) {
      // Refused before dispatch because the chat or its shared session was occupied (another chat of the Work project, a
      // turn of another conversation on the same seat session, a locked store). Nothing reached a model; the message keeps
      // its place and starts again after a backoff. This is not one of the bounded not-dispatched retries below.
      const now = deps.now();
      requeueOccupied.run(failureCode, now, now + transientSendBackoffMs(row.attempts), now, row.id);
      deps.log?.("pending send refused before dispatch (occupied), queued again", { chatId, sendId: row.id, runId: row.run_id, code: failureCode });
      deps.onChange?.(chatId);
      return "done";
    }
    if (placement === "not-dispatched" && persistent(row,request) && failureCode && !isTransientRunFailureCode(failureCode)) {
      finish("held",failureCode);
      deps.onHeld?.(row.id,failureCode);
      return "done";
    }
    // After a restart nothing of that run reached a model either: it is the same message, started again (never silently dropped).
    if (placement === "not-dispatched" && (row.dispatch_retries ?? 0) < MAX_NOT_DISPATCHED_RETRIES) {
      // Nothing reached a model: the message keeps its place (its seq) and starts again once the chat is free.
      requeue.run("not_dispatched", deps.now(), row.id);
      deps.log?.("pending send not dispatched, queued again", { chatId, sendId: row.id, runId: row.run_id });
      deps.onChange?.(chatId);
      return "done";
    }
    if (placement === "not-dispatched" && persistent(row,request)) {
      finish("held",failureCode ?? "not_dispatched");
      deps.onHeld?.(row.id,failureCode ?? "not_dispatched");
      return "done";
    }
    if (placement === "not-dispatched") {
      finish("failed", "not_dispatched");
      deps.onEnded?.({ chatId, request, reason: "permanent", code: failureCode ?? "not_dispatched", runId: row.run_id, sendId: row.id });
      return "done";
    }
    // Sent without an acknowledgement we can prove, or by a path that leaves no placement fact: never re-sent.
    const code = opts.restarted ? "process_restarted" : "placement_unconfirmed";
    finish("uncertain", code);
    deps.onEnded?.({ chatId, request, reason: "uncertain", code, runId: row.run_id, sendId: row.id });
    return "done";
  }

  /** Settle the chat's started messages whose runs have ended; the number still running. */
  function settleStartingRows(chatId: string, opts: { restarted?: boolean } = {}): number {
    let pending = 0;
    for (const row of startingOf.all(chatId) as Row[]) {
      if (settleStarting(row, opts) === "pending") pending += 1;
    }
    return pending;
  }

  function recoverStarting(): void {
    for (const entry of startingChats.all() as { chatId: string }[]) {
      try { if (settleStartingRows(entry.chatId, { restarted: true }) > 0) kick(entry.chatId, STARTING_POLL_MS); }
      catch (error) { deps.log?.("pending send recovery failed", { chatId: entry.chatId, code: String((error as Error)?.message ?? error).slice(0, 80) }); }
    }
  }

  function clearTimerFor(chatId: string): void {
    const handle = timers.get(chatId);
    if (handle !== undefined) { deps.clearTimer(handle); timers.delete(chatId); }
  }
  function kick(chatId: string, delayMs: number): void {
    clearTimerFor(chatId);
    timers.set(chatId, deps.setTimer(() => {
      timers.delete(chatId);
      // A pass that dies on a bookkeeping error (a locked store) is not the end of the drain: look again, nothing is dropped.
      void pump(chatId).catch((error) => {
        deps.log?.("pending send drain failed, looking again", { chatId, code: String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? error).slice(0, 80) });
        kick(chatId, STARTING_POLL_MS);
      });
    }, Math.max(0, delayMs)));
  }

  /**
   * A run was admitted for this row: write it down. Only a refused START is a refusal; a failed write after a successful start is
   * bookkeeping (it used to be classified as a refused start: the live run's message ended "failed", or stayed queued and started
   * again). The run is remembered here, so the row is never started a second time, until the write lands.
   */
  function recordStart(row: Row, runId: string): boolean {
    for (let attempt = 0; attempt < START_RECORD_TRIES; attempt += 1) {
      try {
        const current = byId.get(row.id) as Row | undefined;
        if (!current || !["queued","starting"].includes(current.state)) { unrecorded.delete(row.id); return true; }
        recordStarted.run(runId, deps.now(), row.id); unrecorded.delete(row.id); return true;
      }
      catch { /* a locked or full store: try again, then keep the run in memory */ }
    }
    if (!unrecorded.has(row.id)) deps.log?.("pending send admitted, record deferred", { chatId: row.chat_id, sendId: row.id, runId });
    unrecorded.set(row.id, runId);
    return false;
  }

  async function pump(chatId: string): Promise<void> {
    if (pumping.has(chatId)) return;
    pumping.add(chatId);
    try {
      // Started messages are decided first: a message whose run provably sent nothing goes back to its own place.
      let startingPending = settleStartingRows(chatId);
      for (;;) {
        const row = headOf.get(chatId) as Row | undefined;
        if (!row) {
          if (startingPending > 0) kick(chatId, STARTING_POLL_MS);
          return;
        }
        // Its run already started and only the row's update is missing (a locked store): write the run down, never start it again.
        const remembered = unrecorded.get(row.id);
        if (remembered !== undefined) {
          if (!recordStart(row, remembered)) { kick(chatId, STARTING_POLL_MS); return; }
          startingPending += 1;
          deps.onChange?.(chatId);
          continue;
        }
        const request = JSON.parse(row.request_json) as McpInvocationRequest;
        // Only continuous refusals count: a message waiting for a busy chat, a window or a restart never gives up.
        if (row.refused_since !== null && row.refused_since !== undefined && deps.now() - row.refused_since > TRANSIENT_SEND_DEADLINE_MS) {
          if (persistent(row,request)) {
            clearRefusedSince.run(row.id);
            deps.log?.("pending owner input retained after refusal window",{chatId,sendId:row.id,code:row.last_code});
          } else {
            setState.run("gave_up", "deadline", deps.now(), row.id);
            senders.delete(row.id);
            deps.log?.("pending send gave up", { chatId, sendId: row.id, attempts: row.attempts, code: row.last_code });
            deps.onEnded?.({ chatId, request, reason: "deadline", ...(row.last_code ? { code: row.last_code } : {}), sendId: row.id });
            deps.onChange?.(chatId);
            continue;
          }
        }
        // Recorded by the host of the turn under this very intent: delivered there, never started again here. Checked before any
        // wait (a window, a busy chat) so the duplicate leaves at once; the row stays for the receipt that answers by intent id.
        if (row.intent_id && deps.alreadyDelivered) {
          let recorded = false;
          try { recorded = deps.alreadyDelivered(chatId, row.intent_id) === true; } catch { recorded = false; }
          if (recorded) {
            setState.run("abandoned", "steer_recorded", deps.now(), row.id);
            senders.delete(row.id);
            deps.log?.("pending send already recorded as a steer", { chatId, sendId: row.id });
            deps.onChange?.(chatId);
            continue;
          }
        }
        // The queue is Main's, not the window's: a closed window hands its messages to another live window of the app,
        // and with none open the message waits for one (bounded by the deadline above) instead of being dropped.
        let sender = senders.get(row.id);
        if (sender === undefined || !deps.senderAlive(sender)) {
          let replacement: Sender | null = null;
          try { replacement = deps.replacementSender?.(chatId) ?? null; } catch { replacement = null; }
          if (replacement === null || !deps.senderAlive(replacement)) { kick(chatId, SENDER_WAIT_POLL_MS); return; }
          senders.set(row.id, replacement);
          sender = replacement;
          deps.log?.("pending send re-homed to a live window", { chatId, sendId: row.id });
        }
        if (row.not_before !== null && row.not_before !== undefined && row.not_before > deps.now()) {
          kick(chatId, row.not_before - deps.now()); return;
        }
        if (deps.inputReady && !deps.inputReady(row.id, request)) {
          clearRefusedSince.run(row.id);
          if (persistent(row,request)) {
            setState.run("held","queued_input_authority_unavailable",deps.now(),row.id);
            deps.onHeld?.(row.id,"queued_input_authority_unavailable");
            senders.delete(row.id);
            deps.onChange?.(chatId);
            continue; // Retain this input without blocking a newer owner direction.
          }
          kick(chatId, SENDER_WAIT_POLL_MS); return;
        }
        if (!deps.isChatFree(chatId)) {
          try { deps.onBusyWait?.({ chatId, waitedMs: deps.now() - row.created_at, attempts: row.attempts }); } catch { /* diagnosis never blocks the drain */ }
          // The wiring may have just released the blocker: look again at once instead of after the poll gap.
          if (!deps.isChatFree(chatId)) {
            // A busy chat is the ordinary wait, not a refusal: the deadline clock stops.
            if (row.refused_since !== null && row.refused_since !== undefined) clearRefusedSince.run(row.id);
            kick(chatId, BUSY_POLL_MS); return;
          }
        }
        const rec = record(row);
        let startedRunId = "";
        let attemptedRunId: string | undefined;
        try {
          // Every attempt is a new run: a refused start has already closed its own admission.
          const runId = randomUUID();
          attemptedRunId = runId;
          if (request.oneAttachmentRef || request.oneTeamPreflightRef) {
            const markStarting = () => { setStarting.run(runId, deps.now(), row.id); };
            if (deps.reserveStart) deps.reserveStart(row.id,{...request,runId},markStarting);
            else markStarting();
          } else deps.reservePlainStart?.(row.id,{...request,runId},() => { setStarting.run(runId,deps.now(),row.id); });
          const answer = await deps.start(sender as Sender, { ...request, runId }, rec.userRow, row.id);
          startedRunId = answer && typeof (answer as { runId?: unknown }).runId === "string" ? (answer as { runId: string }).runId : runId;
        } catch (cause) {
          const code = sendRefusalCode(cause);
          const current = byId.get(row.id) as Row | undefined;
          // Stop may run while start awaits. Its exact held row and known run
          // identity win over late success/refusal, including transient errors.
          if (!current || !["queued","starting"].includes(current.state)) { senders.delete(row.id); continue; }
          if (cause instanceof PendingSendSourceReadBusy && attemptedRunId) {
            // This caller never entered its source. Preserve FIFO and input;
            // store availability is not a model refusal and has no deadline.
            // If this write is locked too, the outer pump retries observation;
            // a restart never guesses about an unrecorded v2 closure.
            const delay = transientSendBackoffMs(row.attempts);
            deps.db.prepare(`UPDATE pending_chat_sends SET state='queued',run_id=NULL,last_code=?,attempts=attempts+1,
              refused_since=NULL,not_before=?,updated_at=? WHERE id=? AND state IN ('queued','starting')
              AND (run_id IS NULL OR run_id=?)`).run(cause.message,deps.now()+delay,deps.now(),row.id,attemptedRunId);
            deps.log?.("pending send waits for source store",{chatId,sendId:row.id,code:cause.sqliteCode});
            kick(chatId,delay);
            return;
          }
          // A source may report a native failure after delivery. Queue transport
          // is already complete; its separate run receipt owns the failure UI.
          const failedRun=(byId.get(row.id) as Row).run_id;
          let failedPlacement:PendingSendPlacement="unconfirmed";
          try { if (failedRun) failedPlacement=deps.placement(failedRun); } catch { /* Unknown never grants replay. */ }
          if (failedRun && failedPlacement==="placed") {
            setState.run("started",null,deps.now(),row.id);
            senders.delete(row.id);
            deps.onPlaced?.(row.id,failedRun);
            deps.onChange?.(chatId);
            continue;
          }
          let refusedSender = false;
          try { refusedSender = deps.senderRefused?.(cause) === true; } catch { refusedSender = false; }
          if (refusedSender) {
            deps.db.prepare("UPDATE pending_chat_sends SET run_id=NULL WHERE id=?").run(row.id);
            setState.run("queued", null, deps.now(), row.id);
            senders.delete(row.id);
            deps.log?.("pending send waits for a usable window", { chatId, sendId: row.id, code });
            kick(chatId, SENDER_WAIT_POLL_MS);
            return;
          }
          if (isTransientSendRefusal(cause) && (!deps.canRetryStart || deps.canRetryStart(request, (byId.get(row.id) as Row).run_id ?? ""))) {
            deps.db.prepare("UPDATE pending_chat_sends SET run_id=NULL WHERE id=?").run(row.id);
            setState.run("queued", null, deps.now(), row.id);
            setAttempt.run(code ?? null, deps.now(), deps.now(), row.id);
            const base = transientSendBackoffMs(row.attempts);
            deps.log?.("pending send refused, will retry", { chatId, sendId: row.id, attempt: row.attempts + 1, code });
            kick(chatId, Math.round(base * (0.8 + deps.random() * 0.4)));
            return;
          }
          if (persistent(row,request)) {
            const runId=(byId.get(row.id) as Row).run_id;
            let fact: PendingSendPlacement="unconfirmed";
            try { if (runId) fact=deps.placement(runId); } catch { /* Unknown never grants retry. */ }
            const state=fact === "not-dispatched" ? "held" : "uncertain";
            setState.run(state,code ?? "start_failed",deps.now(),row.id);
            deps.onHeld?.(row.id,code ?? "start_failed");
            senders.delete(row.id);
            deps.onChange?.(chatId);
            continue;
          }
          setState.run("failed", code ?? "start_failed", deps.now(), row.id);
          senders.delete(row.id);
          deps.log?.("pending send ended", { chatId, sendId: row.id, code });
          deps.onEnded?.({ chatId, request, reason: "permanent", ...(code ? { code } : {}), sendId: row.id });
          deps.onChange?.(chatId);
          continue;
        }
        // Reached only when the start succeeded (every refusal above leaves the loop body). Admitted, not placed: the row stays until
        // the run's placement is known (settleStarting). A failed write here is bookkeeping, never a refused start (recordStart).
        if (!recordStart(row, startedRunId)) { kick(chatId, STARTING_POLL_MS); return; }
        startingPending += 1;
        deps.log?.("pending send admitted", { chatId, sendId: row.id, runId: startedRunId, attempts: row.attempts + 1 });
        deps.onChange?.(chatId);
      }
    } finally {
      pumping.delete(chatId);
    }
  }

  recoverStarting();
  resumeAfterRestart();

  return Object.freeze({
    /**
     * The chat already has messages waiting, or one admitted whose placement is not known yet. A new message goes behind
     * them so the order the owner typed is kept (an admitted one that sent nothing goes back to its own place).
     */
    hasQueued(chatId: string): boolean {
      return ((countOf.get(chatId) as { n: number }).n ?? 0) > 0;
    },
    /**
     * Accept the message: save its transcript row, persist the request, and start the drain. Returns at once.
     * `cause` is the refusal that sent it here (logged, never shown).
     */
    enqueue(sender: Sender, request: McpInvocationRequest, options: { intentId?: string; cause?: unknown; userRow?: unknown; requireUserRow?: boolean } = {}): PendingSendRecord {
      const prior = options.intentId ? byIntent.get(request.chatId, options.intentId) as Row | undefined : undefined;
      if (prior) {
        if (followupRequestJson(JSON.parse(prior.request_json) as McpInvocationRequest) !== followupRequestJson(request)) throw new Error("pending_send_identity_conflict");
        return record(prior);
      }
      const id = randomUUID();
      let userRow: unknown | null = null;
      try { userRow = options.userRow ?? deps.saveUserRow(request); } catch (error) { if (options.requireUserRow) throw error; }
      if (options.requireUserRow && (!userRow || typeof (userRow as {id?:unknown}).id !== "string")) throw new Error("pending_send_message_custody_missing");
      const now = deps.now();
      const stored = { ...request, runId: undefined };
      insert.run(id, request.chatId, options.intentId ?? null, JSON.stringify(stored),
        userRow === null ? null : JSON.stringify(userRow), pendingSendPromptHash(request.userPrompt), now, now);
      senders.set(id, sender);
      const code = options.cause === undefined ? undefined : sendRefusalCode(options.cause);
      deps.log?.("pending send accepted", { chatId: request.chatId, sendId: id, code });
      deps.onChange?.(request.chatId);
      kick(request.chatId, options.cause === undefined ? 0 : transientSendBackoffMs(0));
      return record(byId.get(id) as Row);
    },
    /** Main may retain an unstarted input whose capability still needs repair.
     * This is storage only: held rows cannot enter the drain or block a new turn. */
    hold(id:string,code:string,runId?:string):void {
      const row=byId.get(id) as Row|undefined;
      if (!row || row.state!=="queued" || row.run_id) throw new Error("pending_send_hold_changed");
      deps.db.prepare("UPDATE pending_chat_sends SET state='held',last_code=?,run_id=?,updated_at=? WHERE id=?")
        .run(code,runId ?? null,deps.now(),id);
      senders.delete(id);
      deps.onChange?.(row.chat_id);
    },
    find(chatId: string, intentId: string): PendingSendRecord | null {
      const row = byIntent.get(chatId, intentId) as Row | undefined;
      return row ? record(row) : null;
    },
    get(id: string): PendingSendRecord | null {
      const row = byId.get(id) as Row | undefined;
      return row ? record(row) : null;
    },
    resumeAfterRestart,
    /** A run settled (in this process): decide the message it took now instead of at the next look. */
    settleRun(runId: string): void {
      const row = startingByRun.get(runId) as Row | undefined;
      if (row) kick(row.chat_id, 0);
    },
    /** For gates and shutdown: stop timers without touching the persisted rows. */
    dispose(): void { for (const chatId of [...timers.keys()]) clearTimerFor(chatId); },
    /** For gates: run a drain pass now. */
    pumpNow: pump,
  });
}

export type PendingChatSends<Sender> = ReturnType<typeof createPendingChatSends<Sender>>;
