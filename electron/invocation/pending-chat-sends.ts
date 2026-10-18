import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import {
  TRANSIENT_SEND_DEADLINE_MS,
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
export type PendingSendState = "queued" | "starting" | "started" | "uncertain" | "failed" | "gave_up" | "abandoned";

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
}

/** A settled run's placement, from durable facts only (turn-placement.ts; a completed run counts as placed). */
export type PendingSendPlacement = "placed" | "not-dispatched" | "unconfirmed";

export interface PendingChatSendsDeps<Sender> {
  db: PendingSendDb;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** 0..1, for jitter. */
  random(): number;
  /** No run active, no admission pending, no run-owner row alive for the chat, in either process. */
  isChatFree(chatId: string): boolean;
  senderAlive(sender: Sender): boolean;
  /** A live sender of this app to start from when the message's own window is gone (null: none open right now). */
  replacementSender?(chatId: string): Sender | null;
  /** "running" while the run that took a message is live (in either host); "settled" once it has a terminal. */
  runState(runId: string): "running" | "settled";
  /** Typed placement of a settled run (called only after runState says settled). */
  placement(runId: string): PendingSendPlacement;
  /** Saves the owner's message to the transcript now. Null when it could not be saved (the run will save it). */
  saveUserRow(request: McpInvocationRequest): unknown | null;
  /** Starts the run. Throws the start refusal unchanged. `userRow` is the row saved by saveUserRow. */
  start(sender: Sender, request: McpInvocationRequest, userRow: unknown | null): Promise<unknown>;
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

export function pendingSendPromptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Requests whose start depends on something that cannot be replayed later are not queued: attachment and team-preflight
 * references are consumed by a rejected start, a system-originated prompt has its own retry, and an agent app turn is
 * not a chat message. Those keep today's behavior (the start error is thrown to the caller).
 */
export function canQueuePendingSend(request: McpInvocationRequest | null | undefined): request is McpInvocationRequest {
  if (!request || typeof request.chatId !== "string" || !request.chatId) return false;
  if (typeof request.userPrompt !== "string" || !request.userPrompt.trim()) return false;
  if (request.oneAttachmentRef || request.oneTeamPreflightRef || request.agentAppMode) return false;
  if (request.promptOrigin === "system") return false;
  try { return Buffer.byteLength(JSON.stringify(request), "utf8") <= MAX_REQUEST_BYTES; } catch { return false; }
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

  const senders = new Map<string, Sender>();
  const timers = new Map<string, unknown>();
  const pumping = new Set<string>();

  const insert = deps.db.prepare(`INSERT INTO pending_chat_sends
    (id, chat_id, intent_id, request_json, user_row_json, prompt_hash, state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`);
  const setState = deps.db.prepare("UPDATE pending_chat_sends SET state = ?, last_code = COALESCE(?, last_code), updated_at = ? WHERE id = ?");
  const setAttempt = deps.db.prepare("UPDATE pending_chat_sends SET attempts = attempts + 1, last_code = COALESCE(?, last_code), updated_at = ? WHERE id = ?");
  const headOf = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND state = 'queued' ORDER BY seq LIMIT 1");
  const countOf = deps.db.prepare("SELECT COUNT(*) AS n FROM pending_chat_sends WHERE chat_id = ? AND state IN ('queued', 'starting')");
  const setStarting = deps.db.prepare("UPDATE pending_chat_sends SET state = 'starting', run_id = ?, updated_at = ? WHERE id = ?");
  const requeue = deps.db.prepare("UPDATE pending_chat_sends SET state = 'queued', run_id = NULL, dispatch_retries = dispatch_retries + 1, last_code = ?, updated_at = ? WHERE id = ?");
  const startingOf = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND state = 'starting' ORDER BY seq");
  const startingByRun = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE run_id = ? AND state = 'starting'");
  const startingChats = deps.db.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_chat_sends WHERE state = 'starting'");
  const byId = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE id = ?");
  const byIntent = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND intent_id = ? ORDER BY seq DESC LIMIT 1");
  const queuedChats = deps.db.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_chat_sends WHERE state = 'queued'");

  type Row = { id: string; seq: number; chat_id: string; intent_id: string | null; request_json: string; user_row_json: string | null;
    prompt_hash: string; state: PendingSendState; attempts: number; last_code: string | null; created_at: number;
    run_id: string | null; dispatch_retries: number };
  const record = (row: Row): PendingSendRecord => ({
    id: row.id, seq: row.seq, chatId: row.chat_id, intentId: row.intent_id, promptHash: row.prompt_hash, state: row.state,
    attempts: row.attempts, lastCode: row.last_code, createdAt: row.created_at,
    userRow: row.user_row_json ? JSON.parse(row.user_row_json) as unknown : null,
    runId: row.run_id ?? null,
  });

  // A queued message from an earlier process has no window to start it from. Its transcript row stays; it is not run
  // behind the owner's back after a restart.
  function abandonStale(): number {
    let n = 0;
    for (const entry of queuedChats.all() as { chatId: string }[]) {
      for (;;) {
        const row = headOf.get(entry.chatId) as Row | undefined;
        if (!row || senders.has(row.id)) break;
        setState.run("abandoned", "process_restarted", deps.now(), row.id); n++;
      }
    }
    return n;
  }

  /*
   * A message the runtime may or may not have placed is decided once its run has settled, from durable facts only.
   * `restarted`: the run belonged to an earlier process of this host. Its message is not re-run behind the owner's
   * back (same rule as abandonStale), but a placed one still counts as started.
   */
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
    if (placement === "placed") { finish("started", null); return "done"; }
    if (placement === "not-dispatched" && !opts.restarted && (row.dispatch_retries ?? 0) < MAX_NOT_DISPATCHED_RETRIES) {
      // Nothing reached a model: the message keeps its place (its seq) and starts again once the chat is free.
      requeue.run("not_dispatched", deps.now(), row.id);
      deps.log?.("pending send not dispatched, queued again", { chatId, sendId: row.id, runId: row.run_id });
      deps.onChange?.(chatId);
      return "done";
    }
    if (placement === "not-dispatched") {
      const code = opts.restarted ? "process_restarted" : "not_dispatched";
      finish(opts.restarted ? "abandoned" : "failed", code);
      deps.onEnded?.({ chatId, request, reason: opts.restarted ? "closed" : "permanent", code, runId: row.run_id, sendId: row.id });
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
    timers.set(chatId, deps.setTimer(() => { timers.delete(chatId); void pump(chatId); }, Math.max(0, delayMs)));
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
        const request = JSON.parse(row.request_json) as McpInvocationRequest;
        if (deps.now() - row.created_at > TRANSIENT_SEND_DEADLINE_MS) {
          setState.run("gave_up", "deadline", deps.now(), row.id);
          senders.delete(row.id);
          deps.log?.("pending send gave up", { chatId, sendId: row.id, attempts: row.attempts, code: row.last_code });
          deps.onEnded?.({ chatId, request, reason: "deadline", ...(row.last_code ? { code: row.last_code } : {}), sendId: row.id });
          deps.onChange?.(chatId);
          continue;
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
        if (!deps.isChatFree(chatId)) {
          try { deps.onBusyWait?.({ chatId, waitedMs: deps.now() - row.created_at, attempts: row.attempts }); } catch { /* diagnosis never blocks the drain */ }
          // The wiring may have just released the blocker: look again at once instead of after the poll gap.
          if (!deps.isChatFree(chatId)) { kick(chatId, BUSY_POLL_MS); return; }
        }
        const rec = record(row);
        try {
          // Every attempt is a new run: a refused start has already closed its own admission.
          const runId = randomUUID();
          const answer = await deps.start(sender as Sender, { ...request, runId, preflightSubmissionId: undefined }, rec.userRow);
          const startedRunId = answer && typeof (answer as { runId?: unknown }).runId === "string" ? (answer as { runId: string }).runId : runId;
          // Admitted, not placed: the row stays until the run's placement is known (settleStarting).
          setStarting.run(startedRunId, deps.now(), row.id);
          startingPending += 1;
          deps.log?.("pending send admitted", { chatId, sendId: row.id, runId: startedRunId, attempts: row.attempts + 1 });
          deps.onChange?.(chatId);
          continue;
        } catch (cause) {
          const code = sendRefusalCode(cause);
          if (isTransientSendRefusal(cause)) {
            setAttempt.run(code ?? null, deps.now(), row.id);
            const base = transientSendBackoffMs(row.attempts);
            deps.log?.("pending send refused, will retry", { chatId, sendId: row.id, attempt: row.attempts + 1, code });
            kick(chatId, Math.round(base * (0.8 + deps.random() * 0.4)));
            return;
          }
          setState.run("failed", code ?? "start_failed", deps.now(), row.id);
          senders.delete(row.id);
          deps.log?.("pending send ended", { chatId, sendId: row.id, code });
          deps.onEnded?.({ chatId, request, reason: "permanent", ...(code ? { code } : {}), sendId: row.id });
          deps.onChange?.(chatId);
          continue;
        }
      }
    } finally {
      pumping.delete(chatId);
    }
  }

  abandonStale();
  recoverStarting();

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
    enqueue(sender: Sender, request: McpInvocationRequest, options: { intentId?: string; cause?: unknown } = {}): PendingSendRecord {
      const id = randomUUID();
      let userRow: unknown | null = null;
      try { userRow = deps.saveUserRow(request); } catch { userRow = null; }
      const now = deps.now();
      const stored = { ...request, runId: undefined, preflightSubmissionId: undefined };
      insert.run(id, request.chatId, options.intentId ?? null, JSON.stringify(stored),
        userRow === null ? null : JSON.stringify(userRow), pendingSendPromptHash(request.userPrompt), now, now);
      senders.set(id, sender);
      const code = options.cause === undefined ? undefined : sendRefusalCode(options.cause);
      deps.log?.("pending send accepted", { chatId: request.chatId, sendId: id, code });
      deps.onChange?.(request.chatId);
      kick(request.chatId, options.cause === undefined ? 0 : transientSendBackoffMs(0));
      return record(byId.get(id) as Row);
    },
    find(chatId: string, intentId: string): PendingSendRecord | null {
      const row = byIntent.get(chatId, intentId) as Row | undefined;
      return row ? record(row) : null;
    },
    get(id: string): PendingSendRecord | null {
      const row = byId.get(id) as Row | undefined;
      return row ? record(row) : null;
    },
    abandonStale,
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
