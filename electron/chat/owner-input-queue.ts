/**
 * The owner's sent words that are not (yet) a transcript row, read as ONE state machine.
 * Stage 1: nothing is written here and no table is added. The four tables that each hold a part of this
 * (pending_chat_sends, one_preflight_submissions + one_preflight_steers, invocation_steers) keep their own rules, which carry incident history
 * (custody recovery, the new-process-generation hold, the stale-open hold); this module only PROJECTS them onto the sheet's states:
 *
 *   accepted   - handed to Main, nothing waits on it yet (a message being prepared in the window)
 *   waiting    - queued behind a busy chat, a retry, or the next turn (reason says which)
 *   starting   - a run took it, placement not known yet
 *   delivered  - a run placed it (or the turn it steered recorded it): a normal bubble from here on
 *   held       - refused with a typed code; the person decides (resend / fix)
 *   uncertain  - a run ended without proof the runtime took it; never re-sent by itself
 *   withdrawn  - the person's Stop (or Cancel) took it back; its text went to the input box; never comes back
 *
 * The screen's waiting / held / failed lines are drawn from these states only; the window's local outbox is a write-ahead copy until the
 * IPC answer comes, never a source of lines. Read-only SQL, never throws (a table this store does not have has nothing waiting).
 */
export type OwnerInputState = "accepted" | "waiting" | "starting" | "delivered" | "held" | "uncertain" | "withdrawn";
export type OwnerInputSource = "pending_chat_send" | "preflight_submission" | "preflight_steer" | "invocation_steer";

export interface OwnerInputItem {
  /** `intent:<intentId>` when the send carries one, else `<source>:<id>` - the one key a surface matches on (never the text). */
  key: string;
  source: OwnerInputSource;
  id: string;
  chatId: string;
  state: OwnerInputState;
  /** waiting: busy | retry | next_turn | preparing | restart. held: the machine code. */
  reason: string | null;
  /** The words, when Main holds them (a message being prepared keeps its words in the window only: null). */
  text: string | null;
  intentId: string | null;
  runId: string | null;
  /** ISO time. */
  createdAt: string;
}

type Statement = { all(...p: unknown[]): unknown[] };
export interface OwnerInputDb { prepare(sql: string): Statement }

const iso = (ms: number): string => new Date(ms).toISOString();
const keyOf = (source: OwnerInputSource, id: string, intentId: string | null): string => (intentId ? `intent:${intentId}` : `${source}:${id}`);

function readAll<T>(db: OwnerInputDb, sql: string, ...params: unknown[]): T[] {
  try { return db.prepare(sql).all(...params) as T[]; } catch { return []; }
}

/**
 * Every open or just-settled owner input of a chat, oldest first. `withdrawn` items are listed only with `includeWithdrawn` (they draw
 * nothing; a window that needs to clear its copy asks for them). `delivered` items are listed only with `includeDelivered` (they are
 * ordinary bubbles now).
 */
export function listOwnerInputs(db: OwnerInputDb, chatId: string, options: { includeDelivered?: boolean; includeWithdrawn?: boolean } = {}): OwnerInputItem[] {
  const items: OwnerInputItem[] = [];
  const add = (item: OwnerInputItem): void => {
    if (item.state === "withdrawn" && !options.includeWithdrawn) return;
    if (item.state === "delivered" && !options.includeDelivered) return;
    items.push(item);
  };

  for (const row of readAll<{ id: string; intent_id: string | null; request_json: string; state: string; attempts: number; last_code: string | null; created_at: number; run_id: string | null }>(db,
    "SELECT id, intent_id, request_json, state, attempts, last_code, created_at, run_id FROM pending_chat_sends WHERE chat_id = ? ORDER BY seq", chatId)) {
    let text: string | null = null;
    // The composer's own id (McpInvocationRequest.clientIntentId) names the send when the queue row carries no steer intent: it is also the id on the saved row.
    let requestIntent: string | null = null;
    try {
      const parsed = JSON.parse(row.request_json) as { userPrompt?: unknown; clientIntentId?: unknown };
      if (typeof parsed.userPrompt === "string") text = parsed.userPrompt;
      if (typeof parsed.clientIntentId === "string" && parsed.clientIntentId) requestIntent = parsed.clientIntentId;
    } catch { /* words unreadable: none */ }
    const intentId = row.intent_id ?? requestIntent;
    let state: OwnerInputState; let reason: string | null = null;
    switch (row.state) {
      case "queued": state = "waiting"; reason = row.attempts > 0 ? "retry" : "busy"; break;
      case "starting": state = "starting"; break;
      case "started": state = "delivered"; break;
      case "uncertain": state = "uncertain"; break;
      case "held": case "failed": case "gave_up": state = "held"; reason = row.last_code ?? row.state; break;
      case "abandoned":
        // "steer_recorded": the turn that was running already recorded this very direction - it is delivered there, not taken back.
        state = row.last_code === "steer_recorded" ? "delivered" : "withdrawn"; break;
      default: continue;
    }
    add({ key: keyOf("pending_chat_send", row.id, intentId), source: "pending_chat_send", id: row.id, chatId, state, reason, text,
      intentId, runId: row.run_id, createdAt: iso(row.created_at) });
  }

  // A message being prepared: its words stay in the window that prepares it (Main stores a digest). open/reserved = accepted; bound = a run took it.
  for (const row of readAll<{ submission_id: string; state: string; parent_run_id: string | null; created_at: string }>(db,
    "SELECT submission_id, state, parent_run_id, created_at FROM one_preflight_submissions WHERE chat_id = ? AND state IN ('open','reserved','held','cancelled') ORDER BY created_at", chatId)) {
    const state: OwnerInputState = row.state === "held" ? "held" : row.state === "cancelled" ? "withdrawn" : "accepted";
    add({ key: keyOf("preflight_submission", row.submission_id, null), source: "preflight_submission", id: row.submission_id, chatId, state,
      reason: state === "held" ? "preflight_held" : state === "accepted" ? "preparing" : null, text: null, intentId: null, runId: row.parent_run_id, createdAt: row.created_at });
  }
  for (const row of readAll<{ steer_id: string; prompt_text: string; status: string; parent_run_id: string | null; created_at: string }>(db,
    "SELECT steer_id, prompt_text, status, parent_run_id, created_at FROM one_preflight_steers WHERE chat_id = ? ORDER BY created_at", chatId)) {
    const state: OwnerInputState = row.status === "queued" ? "waiting" : row.status === "claimed" ? "starting" : row.status === "attached" ? "delivered"
      : row.status === "held" ? "held" : "withdrawn";
    add({ key: keyOf("preflight_steer", row.steer_id, null), source: "preflight_steer", id: row.steer_id, chatId, state,
      reason: state === "waiting" ? "preparing" : state === "held" ? "preflight_held" : null, text: row.prompt_text, intentId: null,
      runId: row.parent_run_id, createdAt: row.created_at });
  }

  // Directions queued behind the running turn (next turn).
  for (const row of readAll<{ id: string; prompt_text: string; status: string; drained_run_id: string | null; recovery_state: string; recovery_reason: string | null; queued_at: string }>(db,
    "SELECT id, prompt_text, status, drained_run_id, recovery_state, recovery_reason, queued_at FROM invocation_steers WHERE chat_id = ? AND status IN ('queued','draining','started','cancelled') ORDER BY queued_at, id", chatId)) {
    const state: OwnerInputState = row.recovery_state === "held" ? "held" : row.status === "queued" ? "waiting" : row.status === "draining" ? "starting"
      : row.status === "started" ? "delivered" : "withdrawn";
    add({ key: keyOf("invocation_steer", row.id, null), source: "invocation_steer", id: row.id, chatId, state,
      reason: state === "waiting" ? "next_turn" : state === "held" ? (row.recovery_reason ?? "held") : null, text: row.prompt_text, intentId: null,
      runId: row.drained_run_id, createdAt: row.queued_at });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

/** Items that draw a bubble the store does not have yet: the sheet's count. */
export function bubbleOwnerInputs(items: readonly OwnerInputItem[]): OwnerInputItem[] {
  return items.filter((item) => item.state === "accepted" || item.state === "waiting" || item.state === "starting" || item.state === "held" || item.state === "uncertain");
}
