// Proof of what became of a codex turn the host is about to close as unsettled (no terminal receipt).
// Reads only codex's own record of the thread: `thread/turns/list` (or `thread/read`) on the live app-server
// connection, else the tail of the rollout file the session wrote. The turn is found by the client message id the
// host sent with `turn/start` (`clientUserMessageId`), which the session stores as the user message's client id
// (app-server `userMessage.clientId`, rollout `item_completed.item.client_id`). Never prose, never a model call.
import fs from "node:fs/promises";
import path from "node:path";

export type CodexTurnProofStatus =
  | "completed"          // codex finished this turn and its last agent message is the answer
  | "completed-empty"    // codex finished this turn without a final message
  | "in-progress"        // the turn is still open
  | "request-absent"     // codex's thread holds no message of ours
  | "failed"
  | "interrupted"
  | "indeterminate";     // could not be read, or could not be told

export interface CodexTurnProof {
  status: CodexTurnProofStatus;
  source: "app-server" | "rollout" | "none";
  /** The final agent message, only for "completed". */
  answer?: string;
  turnId?: string;
  /** Items the turn holds (app-server view), the measure of progress for an open turn. */
  itemCount: number;
  /** Items that are not messages (commands, file changes, tool calls...): what the turn did beyond talking. Read from codex's record, never from the notification stream. */
  actionItems?: number;
}

export const INDETERMINATE_PROOF: CodexTurnProof = Object.freeze({ status: "indeterminate", source: "none", itemCount: 0 });

/** Item types that only talk. Anything else (and any type this reader does not know) counts as an action. */
const TALK_ITEM_TYPES = new Set(["usermessage", "agentmessage", "reasoning", "plan", "hookprompt", "contextcompaction", "compaction", "enteredreviewmode", "exitedreviewmode"]);
const actionCount = (items: Json[]): number => items.filter((item) => typeof item.type !== "string" || !TALK_ITEM_TYPES.has(item.type.replace(/[_-]/g, "").toLowerCase())).length;

/** The whole proof read (connection, then file) is bounded; a slow read is "indeterminate". */
export const CODEX_PROOF_TIMEOUT_MS = 5_000;
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

type Json = Record<string, any>;
const isObj = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const typeIs = (item: Json, name: string): boolean => typeof item.type === "string" && item.type.replace(/[_-]/g, "").toLowerCase() === name.toLowerCase();
const clientIdOf = (item: Json): string | null => {
  const value = item.clientId ?? item.client_id;
  return typeof value === "string" && value ? value : null;
};

/** The turns of a list/read response, or null when the shape is not one this reader knows (never read as "no turns"). */
function turnsOf(response: unknown): Json[] | null {
  if (Array.isArray(response)) return response.filter(isObj);
  if (!isObj(response)) return null;
  for (const key of ["data", "turns", "items"]) {
    const value = response[key];
    if (Array.isArray(value)) return value.filter(isObj);
  }
  const thread = response.thread;
  if (isObj(thread) && Array.isArray(thread.turns)) return thread.turns.filter(isObj);
  return null;
}

function finalAnswerOf(items: Json[]): string {
  const messages = items.filter((item) => typeIs(item, "agentMessage") && typeof item.text === "string" && item.text.trim());
  const final = messages.filter((item) => typeof item.phase === "string" && item.phase.replace(/[_-]/g, "").toLowerCase() === "finalanswer");
  const chosen = (final.length ? final : messages).at(-1);
  return chosen ? String(chosen.text) : "";
}

/**
 * Reads `thread/turns/list` (newest first) or `thread/read` output for the turn carrying `clientUserMessageId`
 * (or `turnId` when the host already holds the receipt). Pure.
 */
export function classifyTurnList(response: unknown, input: { clientUserMessageId: string; turnId?: string }): CodexTurnProof {
  const turns = turnsOf(response);
  if (!turns) return INDETERMINATE_PROOF;
  const mine = turns.find((turn) => {
    if (input.turnId && turn.id === input.turnId) return true;
    return Array.isArray(turn.items) && turn.items.some((item: unknown) => isObj(item) && typeIs(item, "userMessage") && clientIdOf(item) === input.clientUserMessageId);
  });
  if (!mine) {
    // Another turn still open could be the one our message waits behind: that is not "never received".
    if (turns.some((turn) => turn.status === "inProgress" || turn.status === "in_progress")) return INDETERMINATE_PROOF;
    return { status: "request-absent", source: "app-server", itemCount: 0, actionItems: 0 };
  }
  const items = Array.isArray(mine.items) ? mine.items.filter(isObj) : [];
  const base = { source: "app-server" as const, turnId: typeof mine.id === "string" ? mine.id : undefined, itemCount: items.length,
    // Only the full view lists every item; any other view cannot say what the turn did.
    ...(mine.itemsView === "full" ? { actionItems: actionCount(items) } : {}) };
  switch (String(mine.status)) {
    case "completed": {
      const answer = finalAnswerOf(items);
      return answer ? { ...base, status: "completed", answer } : { ...base, status: "completed-empty" };
    }
    case "inProgress": case "in_progress": return { ...base, status: "in-progress" };
    case "failed": return { ...base, status: "failed" };
    case "interrupted": return { ...base, status: "interrupted" };
    default: return { ...base, status: "indeterminate" };
  }
}

/** Reads the (possibly partial-first-line) tail of a rollout file. `whole` = the text starts at the file's first byte. Pure. */
export function classifyRolloutTail(text: string, input: { clientUserMessageId: string; turnId?: string; whole: boolean }): CodexTurnProof {
  const rows: Json[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (i === 0 && !input.whole) continue; // a cut first line
    const line = lines[i].trim();
    if (!line) continue;
    try { const row = JSON.parse(line); if (isObj(row)) rows.push(row); } catch { /* a torn last line proves nothing */ }
  }
  let turnId = input.turnId;
  if (!turnId) {
    for (const row of rows) {
      const payload = isObj(row.payload) ? row.payload : null;
      if (row.type !== "event_msg" || !payload || payload.type !== "item_completed" || !isObj(payload.item)) continue;
      if (typeIs(payload.item, "userMessage") && clientIdOf(payload.item) === input.clientUserMessageId && typeof payload.turn_id === "string") turnId = payload.turn_id;
    }
  }
  if (!turnId) {
    return input.whole && rows.some((row) => row.type === "session_meta")
      ? { status: "request-absent", source: "rollout", itemCount: 0, actionItems: 0 }
      : INDETERMINATE_PROOF;
  }
  let started = false;
  let completed: Json | null = null;
  let aborted = false;
  let actions = 0;
  let inTurn = false;
  for (const row of rows) {
    const payload = isObj(row.payload) ? row.payload : null;
    if (!payload) continue;
    if (row.type === "event_msg" && payload.type === "task_started") inTurn = payload.turn_id === turnId;
    if (inTurn && row.type === "response_item" && typeof payload.type === "string"
      && /(_call|call)$/.test(payload.type) && !/output$/.test(payload.type)) actions += 1;
    if (inTurn && row.type === "event_msg" && (payload.type === "item_started" || payload.type === "item_completed") && isObj(payload.item)
      && payload.turn_id === turnId && actionCount([payload.item]) > 0) actions += 1;
    if (row.type !== "event_msg" || payload.turn_id !== turnId) continue;
    if (payload.type === "task_started") started = true;
    else if (payload.type === "task_complete") completed = payload;
    else if (payload.type === "turn_aborted") aborted = true;
  }
  // A tail that starts after this turn began has not shown everything the turn did.
  const base = { source: "rollout" as const, turnId, itemCount: 0, ...(input.whole || started ? { actionItems: actions } : {}) };
  if (completed) {
    const answer = typeof completed.last_agent_message === "string" ? completed.last_agent_message : "";
    return answer.trim() ? { ...base, status: "completed", answer } : { ...base, status: "completed-empty" };
  }
  if (aborted) return { ...base, status: "interrupted" };
  if (started) return { ...base, status: "in-progress" };
  // A turn id the host already holds, that the whole file never mentions (no turn row, no message of ours), is as absent as an unknown one.
  const mentioned = text.includes(input.clientUserMessageId);
  return input.whole && !mentioned && rows.some((row) => row.type === "session_meta")
    ? { status: "request-absent", source: "rollout", itemCount: 0, actionItems: 0 } : INDETERMINATE_PROOF;
}

/** The UUIDv7 prefix of a thread id is its creation time (ms). */
function uuidV7Time(id: string): number | null {
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex) || id[14] !== "7") return null;
  const ms = parseInt(hex, 16);
  return Number.isFinite(ms) ? ms : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

async function findRolloutFile(codexHome: string, threadId: string): Promise<string | null> {
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(threadId)) return null;
  const created = uuidV7Time(threadId);
  const days: Date[] = [];
  const anchor = created ?? Date.now();
  // A resumed thread keeps the file of the day it was created; local and UTC days can differ by one.
  for (const offset of created ? [0, -1, 1] : [0, -1, -2, -3]) days.push(new Date(anchor + offset * 86_400_000));
  for (const day of days) {
    for (const root of ["sessions", "archived_sessions"]) {
      const dir = path.join(codexHome, root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
      let names: string[];
      try { names = await fs.readdir(dir); } catch { continue; }
      const hit = names.find((name) => name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`));
      if (hit) return path.join(dir, hit);
    }
  }
  return null;
}

export async function readRolloutProof(input: { codexHome: string; threadId: string; clientUserMessageId: string; turnId?: string }): Promise<CodexTurnProof> {
  if (!input.codexHome || !path.isAbsolute(input.codexHome)) return INDETERMINATE_PROOF;
  const file = await findRolloutFile(input.codexHome, input.threadId);
  if (!file) return INDETERMINATE_PROOF;
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return classifyRolloutTail(buffer.toString("utf8"), { clientUserMessageId: input.clientUserMessageId, turnId: input.turnId, whole: size <= ROLLOUT_TAIL_BYTES });
  } finally { await handle.close().catch(() => {}); }
}

export type CodexProofRequest = (method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal: AbortSignal }) => Promise<any>;

/**
 * One bounded read. Stop is checked before and after; a Stop, an error or the deadline is "indeterminate" so the
 * caller falls back to its existing path. `request` is absent when the connection is gone (rollout file only).
 */
export async function readCodexTurnProof(input: {
  request?: CodexProofRequest;
  threadId: string | null;
  clientUserMessageId: string | null;
  turnId?: string;
  codexHome: string;
  signal?: AbortSignal;
  stopped?: () => boolean;
  timeoutMs?: number;
}): Promise<CodexTurnProof> {
  const stopped = (): boolean => input.signal?.aborted === true || input.stopped?.() === true;
  if (stopped() || !input.threadId || !input.clientUserMessageId) return INDETERMINATE_PROOF;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), input.timeoutMs ?? CODEX_PROOF_TIMEOUT_MS);
  timer.unref?.();
  const onStop = (): void => budget.abort();
  input.signal?.addEventListener("abort", onStop, { once: true });
  const ids = { clientUserMessageId: input.clientUserMessageId, ...(input.turnId ? { turnId: input.turnId } : {}) };
  try {
    let proof: CodexTurnProof = INDETERMINATE_PROOF;
    if (input.request) {
      const perCall = input.timeoutMs ?? CODEX_PROOF_TIMEOUT_MS;
      const attempts: Array<[string, Record<string, unknown>]> = [
        // "full": the default view is "summary", which need not carry command / file / tool items, and the proof of "nothing acted" needs them.
        ["thread/turns/list", { threadId: input.threadId, limit: input.turnId ? 1 : 2, sortDirection: "desc", itemsView: "full" }],
        ["thread/turns/list", { threadId: input.threadId, limit: input.turnId ? 1 : 2, sortDirection: "desc" }],
        ["thread/read", { threadId: input.threadId, includeTurns: true }],
      ];
      for (const [method, params] of attempts) {
        if (budget.signal.aborted) break;
        try {
          const response = await input.request(method, params, { timeoutMs: perCall, signal: budget.signal });
          const read = classifyTurnList(response, ids);
          // A list that shows the turn without its items cannot say what it holds: ask the next view.
          if (read.status !== "indeterminate" && !(read.status === "completed-empty" && read.itemCount === 0)) { proof = read; break; }
        } catch { /* the next view, then the file */ }
      }
    }
    if (proof.status === "indeterminate" && !budget.signal.aborted) {
      try { proof = await readRolloutProof({ codexHome: input.codexHome, threadId: input.threadId, ...ids }); } catch { proof = INDETERMINATE_PROOF; }
    } else if (proof.status === "request-absent" && !budget.signal.aborted) {
      // "Never received" needs both records to agree: the app-server's list and the rollout file. A file that holds the turn,
      // or that cannot be read, is not "absent".
      let file: CodexTurnProof = INDETERMINATE_PROOF;
      try { file = await readRolloutProof({ codexHome: input.codexHome, threadId: input.threadId, ...ids }); } catch { /* unreadable */ }
      proof = file.status === "request-absent" ? proof : file.status === "indeterminate" ? INDETERMINATE_PROOF : file;
    }
    return stopped() || budget.signal.aborted ? INDETERMINATE_PROOF : proof;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onStop);
  }
}
