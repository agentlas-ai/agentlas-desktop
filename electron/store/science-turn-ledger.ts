/**
 * PLAN S9 B1a: the common ledger's pairing of a Science turn with its run.
 *
 * A Science turn lives in the SDK's own DB (science_turns), but the run that executes it is a common invocation whose
 * run id is the turn's invocation_run_id (mcp/client.ts refuses a Science tool server when the two differ). Nothing in
 * the common ledger said which turn a run belonged to, so a reader had to ask the SDK. The durable start receipt
 * (invoke_started) now carries the pairing as three flat fields, and this module reads them back. No table, no schema step, no SDK change:
 * the pairing is one more field on a row the start already writes.
 *
 * Runs started before these fields existed carry none; they are not listed (their pairing is only in the SDK).
 */

/** Structural on purpose: the store layer does not import the MCP client's InvocationExecutionContext. */
export interface ScienceTurnStampSource {
  science?: Readonly<{ projectId: string; conversationId: string; turnId: string; invocationRunId: string }>;
}

export interface ScienceTurnStamp {
  projectId: string;
  conversationId: string;
  turnId: string;
}

/** The Science turn a run is the own run of, or undefined for any other run. */
export function scienceTurnStamp(context: ScienceTurnStampSource | undefined, runId: string): ScienceTurnStamp | undefined {
  const science = context?.science;
  if (!science || science.invocationRunId !== runId) return undefined;
  return { projectId: science.projectId, conversationId: science.conversationId, turnId: science.turnId };
}

/**
 * The stamp as invoke_started payload fields. Flat strings on purpose: the ledger's payload sanitizer (run-events.ts
 * safePayload) turns any nested object into a truncated JSON string, so a nested `scienceTurn: {...}` would be stored as
 * text no reader could use (found by a real-store round trip). The names match error-diagnostic.ts.
 */
export function scienceTurnPayload(context: ScienceTurnStampSource | undefined, runId: string): Record<string, string> {
  const stamp = scienceTurnStamp(context, runId);
  return stamp ? { scienceProjectId: stamp.projectId, scienceConversationId: stamp.conversationId, scienceTurnId: stamp.turnId } : {};
}

/** The ledger's terminal kinds of one invocation (same set effect-boundary-reader.ts and memory/previous-turn.ts use). */
export const SCIENCE_TURN_TERMINAL_KINDS = ["invoke_completed", "invoke_waiting", "invoke_failed", "invoke_threw",
  "invoke_cancelled", "invoke_interrupted"] as const;

export interface ScienceTurnRunFact extends ScienceTurnStamp {
  invocationRunId: string;
  chatId: string;
  startedAt: string;
  /** The newest terminal kind of the run, or null while the ledger has none (the run is still executing). */
  terminalKind: (typeof SCIENCE_TURN_TERMINAL_KINDS)[number] | null;
  terminalAt: string | null;
}

/** The slice of a SQLite handle this reader uses (better-sqlite3 and node:sqlite both fit). */
export interface ScienceTurnLedgerDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface StartRow { run_id: string; chat_id: string; ts: string; payload_json: string }
interface TerminalRow { run_id: string; kind: ScienceTurnRunFact["terminalKind"] & string; ts: string }

/**
 * The Science turns that ran in one runtime chat, newest first. Bounded by chat on purpose: a run's ledger can be tens of
 * thousands of rows, and both queries below are answered from idx_run_events_chat_kind_ts (chat_id, kind, ts DESC)
 * without opening any run. Terminal rows are read for the same chat, never per run.
 */
export function scienceTurnRunsForChat(db: ScienceTurnLedgerDb, chatId: string, limit = 20): ScienceTurnRunFact[] {
  const bound = Math.max(1, Math.min(200, Math.trunc(limit)));
  const starts = db.prepare("SELECT run_id, chat_id, ts, payload_json FROM run_events WHERE chat_id = ? AND kind = 'invoke_started' ORDER BY ts DESC LIMIT ?")
    .all(chatId, bound * 4) as StartRow[];
  const stamped: Array<{ row: StartRow; stamp: ScienceTurnStamp }> = [];
  for (const row of starts) {
    const stamp = parseStamp(row.payload_json);
    if (stamp) stamped.push({ row, stamp });
    if (stamped.length === bound) break;
  }
  if (stamped.length === 0) return [];
  // Every terminal row since the oldest listed start (not "the newest N": a run that waits and resumes many times would
  // push another run's terminal out of a count and make a finished run read as running).
  const oldestStart = stamped[stamped.length - 1].row.ts;
  const marks = SCIENCE_TURN_TERMINAL_KINDS.map(() => "?").join(",");
  const terminals = db.prepare(`SELECT run_id, kind, ts FROM run_events WHERE chat_id = ? AND kind IN (${marks}) AND ts >= ? ORDER BY ts DESC LIMIT ?`)
    .all(chatId, ...SCIENCE_TURN_TERMINAL_KINDS, oldestStart, 5000) as TerminalRow[];
  const newestTerminal = new Map<string, TerminalRow>();
  for (const row of terminals) if (!newestTerminal.has(row.run_id)) newestTerminal.set(row.run_id, row);
  return stamped.map(({ row, stamp }) => {
    const terminal = newestTerminal.get(row.run_id);
    return { ...stamp, invocationRunId: row.run_id, chatId: row.chat_id, startedAt: row.ts,
      terminalKind: terminal?.kind ?? null, terminalAt: terminal?.ts ?? null };
  });
}

function parseStamp(payloadJson: string): ScienceTurnStamp | undefined {
  let payload: Record<string, unknown> | null;
  try { payload = JSON.parse(payloadJson) as Record<string, unknown> | null; } catch { return undefined; }
  if (!payload || typeof payload !== "object") return undefined;
  const projectId = payload.scienceProjectId;
  const conversationId = payload.scienceConversationId;
  const turnId = payload.scienceTurnId;
  if (![projectId, conversationId, turnId].every((value) => typeof value === "string" && value.length > 0)) return undefined;
  return { projectId: projectId as string, conversationId: conversationId as string, turnId: turnId as string };
}
