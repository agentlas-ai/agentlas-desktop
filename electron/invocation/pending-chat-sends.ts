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

export type PendingSendState = "queued" | "started" | "failed" | "gave_up" | "abandoned";

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
  senderAlive(sender: Sender): boolean;
  /** Saves the owner's message to the transcript now. Null when it could not be saved (the run will save it). */
  saveUserRow(request: McpInvocationRequest): unknown | null;
  /** Starts the run. Throws the start refusal unchanged. `userRow` is the row saved by saveUserRow. */
  start(sender: Sender, request: McpInvocationRequest, userRow: unknown | null): Promise<unknown>;
  /** The wait ended without a run: a permanent refusal, or the deadline. Never called for a transient refusal. */
  onEnded?(event: { chatId: string; request: McpInvocationRequest; reason: "permanent" | "deadline" | "closed"; code?: string }): void;
  onChange?(chatId: string): void;
  log?(message: string, detail: Record<string, unknown>): void;
}

const MAX_REQUEST_BYTES = 1_000_000;
/** While the chat is busy we only look; a look is cheap and writes nothing. */
const BUSY_POLL_MS = 750;

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

  const senders = new Map<string, Sender>();
  const timers = new Map<string, unknown>();
  const pumping = new Set<string>();

  const insert = deps.db.prepare(`INSERT INTO pending_chat_sends
    (id, chat_id, intent_id, request_json, user_row_json, prompt_hash, state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`);
  const setState = deps.db.prepare("UPDATE pending_chat_sends SET state = ?, last_code = COALESCE(?, last_code), updated_at = ? WHERE id = ?");
  const setAttempt = deps.db.prepare("UPDATE pending_chat_sends SET attempts = attempts + 1, last_code = COALESCE(?, last_code), updated_at = ? WHERE id = ?");
  const headOf = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND state = 'queued' ORDER BY seq LIMIT 1");
  const countOf = deps.db.prepare("SELECT COUNT(*) AS n FROM pending_chat_sends WHERE chat_id = ? AND state = 'queued'");
  const byId = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE id = ?");
  const byIntent = deps.db.prepare("SELECT * FROM pending_chat_sends WHERE chat_id = ? AND intent_id = ? ORDER BY seq DESC LIMIT 1");
  const queuedChats = deps.db.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_chat_sends WHERE state = 'queued'");

  type Row = { id: string; seq: number; chat_id: string; intent_id: string | null; request_json: string; user_row_json: string | null;
    prompt_hash: string; state: PendingSendState; attempts: number; last_code: string | null; created_at: number };
  const record = (row: Row): PendingSendRecord => ({
    id: row.id, seq: row.seq, chatId: row.chat_id, intentId: row.intent_id, promptHash: row.prompt_hash, state: row.state,
    attempts: row.attempts, lastCode: row.last_code, createdAt: row.created_at,
    userRow: row.user_row_json ? JSON.parse(row.user_row_json) as unknown : null,
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
      for (;;) {
        const row = headOf.get(chatId) as Row | undefined;
        if (!row) return;
        const request = JSON.parse(row.request_json) as McpInvocationRequest;
        const sender = senders.get(row.id);
        if (sender === undefined || !deps.senderAlive(sender)) {
          setState.run("abandoned", "window_closed", deps.now(), row.id);
          senders.delete(row.id);
          deps.onEnded?.({ chatId, request, reason: "closed" });
          continue;
        }
        if (deps.now() - row.created_at > TRANSIENT_SEND_DEADLINE_MS) {
          setState.run("gave_up", "deadline", deps.now(), row.id);
          senders.delete(row.id);
          deps.log?.("pending send gave up", { chatId, sendId: row.id, attempts: row.attempts, code: row.last_code });
          deps.onEnded?.({ chatId, request, reason: "deadline", ...(row.last_code ? { code: row.last_code } : {}) });
          deps.onChange?.(chatId);
          continue;
        }
        if (!deps.isChatFree(chatId)) { kick(chatId, BUSY_POLL_MS); return; }
        const rec = record(row);
        try {
          // Every attempt is a new run: a refused start has already closed its own admission.
          await deps.start(sender, { ...request, runId: randomUUID(), preflightSubmissionId: undefined }, rec.userRow);
          setState.run("started", null, deps.now(), row.id);
          senders.delete(row.id);
          deps.log?.("pending send started", { chatId, sendId: row.id, attempts: row.attempts + 1 });
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
          deps.onEnded?.({ chatId, request, reason: "permanent", ...(code ? { code } : {}) });
          deps.onChange?.(chatId);
          continue;
        }
      }
    } finally {
      pumping.delete(chatId);
    }
  }

  abandonStale();

  return Object.freeze({
    /** The chat already has messages waiting. A new message goes behind them so the order the owner typed is kept. */
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
    /** For gates and shutdown: stop timers without touching the persisted rows. */
    dispose(): void { for (const chatId of [...timers.keys()]) clearTimerFor(chatId); },
    /** For gates: run a drain pass now. */
    pumpNow: pump,
  });
}

export type PendingChatSends<Sender> = ReturnType<typeof createPendingChatSends<Sender>>;
