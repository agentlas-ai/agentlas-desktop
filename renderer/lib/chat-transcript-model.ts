/*
 * The one list model of a conversation .
 *
 * A surface draws ONE list per conversation. This pure function builds it from the three things a surface can know:
 *   stored       the rows the store holds (any role, any kind: a host system row that arrived from another conversation is a row too)
 *   ownerInputs  Main's read model of the person's sends that are not a transcript row yet (electron/chat/owner-input-queue.ts), plus the
 *                composer's own pre-write copy (a send is in this list from the press until the IPC answer, under its intent id)
 *   liveRuns     the answers being streamed right now
 *
 * The key of an item is never made from words or times:
 *   row:<stored id>       a stored row
 *   intent:<intentId>     a person's send with no stored row yet (the composer's id; Main stores it on the row as client_intent_id)
 *   run:<runId>           a live answer; it is REPLACED by the stored row once the run's end names `durableMessageId` or the run has a stored row
 * Two sends with the same words have two intents and stay two bubbles. A stored row whose clientIntentId is an owner input's intent is the same
 * bubble (the owner input only gives it its state line).
 *
 * One run, one answer (I12): several assistant rows of one run (a pass each) fold into the last row; the earlier ones are `folded`, never dropped.
 */

export type TranscriptRole = "user" | "assistant" | "system";

/** What the model needs of a stored row; a surface's own row type keeps its other fields. */
export interface TranscriptStoredRow {
  id: string;
  durableMessageId?: string;
  role: string;
  text?: string;
  createdAt?: string | null;
  /** The id the composer made for this person's message (Main stores it; absent on older rows). */
  clientIntentId?: string;
  /** The run that wrote an assistant row, when the surface knows it. */
  runId?: string;
}

export type TranscriptOwnerInputState = "accepted" | "waiting" | "starting" | "delivered" | "held" | "uncertain" | "withdrawn";

export interface TranscriptOwnerInput {
  key: string;
  state: TranscriptOwnerInputState;
  text: string | null;
  intentId: string | null;
  reason?: string | null;
  runId?: string | null;
  createdAt?: string;
}

export interface TranscriptLiveRun {
  runId: string;
  text: string;
  /** The run's end frame (any kind: final, error, cancelled, stopped) has arrived. */
  ended?: boolean;
  /** The saved row the end frame names. The live answer becomes that row. */
  durableMessageId?: string | null;
  createdAt?: string | null;
}

export interface TranscriptItem<T extends TranscriptStoredRow = TranscriptStoredRow> {
  key: string;
  role: TranscriptRole;
  text: string;
  createdAt: string | null;
  source: "stored" | "owner-input" | "live";
  row?: T;
  /** The person's send state while it is not delivered (a stored row's waiting / held line comes from here). */
  ownerInput?: TranscriptOwnerInput;
  run?: TranscriptLiveRun;
  /** An earlier pass of a run whose last row is the answer (drawn as "progress", not as its own bubble). */
  folded?: boolean;
  foldedInto?: string;
  /** On the answer row of a run that wrote several rows: how many rows the run wrote. */
  passes?: number;
}

const SHOWN_STATES: ReadonlySet<TranscriptOwnerInputState> = new Set(["accepted", "waiting", "starting", "held", "uncertain"]);
const asRole = (role: string): TranscriptRole => (role === "assistant" || role === "system" ? role : "user");

export interface BuildTranscriptInput<T extends TranscriptStoredRow> {
  stored: readonly T[];
  ownerInputs?: readonly TranscriptOwnerInput[];
  liveRuns?: readonly TranscriptLiveRun[];
}

export function buildTranscript<T extends TranscriptStoredRow>(input: BuildTranscriptInput<T>): TranscriptItem<T>[] {
  const seen = new Set<string>();
  const items: TranscriptItem<T>[] = [];
  for (const row of input.stored) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({ key: `row:${row.id}`, role: asRole(row.role), text: row.text ?? "", createdAt: row.createdAt ?? null, source: "stored", row });
  }

  // The person's sends. The intent id ties them to their stored row; a send with no row yet is its own item under its intent.
  const rowByIntent = new Map<string, TranscriptItem<T>>();
  for (const item of items) if (item.role === "user" && item.row?.clientIntentId) rowByIntent.set(item.row.clientIntentId, item);
  const extra: TranscriptItem<T>[] = [];
  const intentsDrawn = new Set<string>();
  for (const owner of input.ownerInputs ?? []) {
    if (!SHOWN_STATES.has(owner.state)) continue;
    const stored = owner.intentId ? rowByIntent.get(owner.intentId) : undefined;
    if (stored) { stored.ownerInput = owner; continue; }
    // No stored row and no intent: the input has no words the model can draw as a bubble by key (Main's row for it is matched by its row id).
    if (!owner.intentId || owner.text === null || intentsDrawn.has(owner.intentId)) continue;
    intentsDrawn.add(owner.intentId);
    extra.push({ key: `intent:${owner.intentId}`, role: "user", text: owner.text, createdAt: owner.createdAt ?? null, source: "owner-input", ownerInput: owner });
  }

  // One run, one answer.
  const lastByRun = new Map<string, TranscriptItem<T>>();
  const countByRun = new Map<string, number>();
  for (const item of items) {
    if (item.role !== "assistant" || !item.row?.runId) continue;
    lastByRun.set(item.row.runId, item);
    countByRun.set(item.row.runId, (countByRun.get(item.row.runId) ?? 0) + 1);
  }
  for (const item of items) {
    const runId = item.role === "assistant" ? item.row?.runId : undefined;
    if (!runId) continue;
    const last = lastByRun.get(runId)!;
    if (last !== item) { item.folded = true; item.foldedInto = `run:${runId}`; }
    else if ((countByRun.get(runId) ?? 0) > 1) item.passes = countByRun.get(runId);
  }

  // A live answer is a stored row as soon as the run's end names it, or the run already has a stored row and has ended.
  const storedIds = new Set<string>();
  for (const item of items) { storedIds.add(item.row!.id); if (item.row!.durableMessageId) storedIds.add(item.row!.durableMessageId); }
  const live: TranscriptItem<T>[] = [];
  for (const run of input.liveRuns ?? []) {
    if (run.durableMessageId && storedIds.has(run.durableMessageId)) continue;
    if (run.ended && lastByRun.has(run.runId)) continue;
    if (!run.text && run.ended) continue;
    live.push({ key: `run:${run.runId}`, role: "assistant", text: run.text, createdAt: run.createdAt ?? null, source: "live", run });
  }
  return [...items, ...extra, ...live];
}

/** What a surface draws as bubbles: the folded passes of a run are progress, not bubbles. */
export function bubblesOf<T extends TranscriptStoredRow>(items: readonly TranscriptItem<T>[]): TranscriptItem<T>[] {
  return items.filter((item) => !item.folded);
}

/*
 * The same send rules for a surface whose list is its own rows (a Work or One window holds optimistic rows next to the stored ones and keeps its richer row type, so it cannot
 * be rebuilt from `buildTranscript`'s output). a person's send is ONE bubble under its intent id - the optimistic copy goes the moment a stored row carries its id -
 * and Main's owner-input state (waiting / not sent / not confirmed) rides on that bubble as a line under it, never as words guessed from the text.
 */
export interface SendRuleRow { id: string; role: string; text?: string; clientIntentId?: string; ownerInputState?: TranscriptOwnerInputState }

export function applySendRules<T extends SendRuleRow>(rows: readonly T[], options: {
  /** The intent id of a row this window drew before Main stored it (`steer:<id>`, `followup:<id>`...); null for any other row. */
  optimisticIntentOf?: (row: T) => string | null;
  ownerInputs?: readonly TranscriptOwnerInput[];
  /** Draws a send Main holds that this window has no row for (a send from the phone, a waiting retry after a reload). Omit to leave such sends to Main's own lines. */
  makeRow?: (input: TranscriptOwnerInput) => T;
} = {}): T[] {
  const storedIntents = new Set<string>();
  for (const row of rows) if (row.role === "user" && row.clientIntentId && !options.optimisticIntentOf?.(row)) storedIntents.add(row.clientIntentId);
  const inputs = new Map<string, TranscriptOwnerInput>();
  for (const input of options.ownerInputs ?? []) if (input.intentId && SHOWN_STATES.has(input.state)) inputs.set(input.intentId, input);
  const drawn = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const intent = row.role === "user" ? (row.clientIntentId ?? options.optimisticIntentOf?.(row) ?? null) : null;
    if (intent && options.optimisticIntentOf?.(row) && storedIntents.has(intent)) continue; // the stored row is this send
    if (intent) drawn.add(intent);
    const state = intent ? inputs.get(intent)?.state : undefined;
    out.push(state && state !== row.ownerInputState ? { ...row, ownerInputState: state } : row);
  }
  if (options.makeRow) for (const [intent, input] of inputs) if (!drawn.has(intent) && !storedIntents.has(intent) && input.text !== null) out.push({ ...options.makeRow(input), ownerInputState: input.state });
  return out;
}
