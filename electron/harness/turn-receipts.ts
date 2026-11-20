/*
 * receipts of a run: the makers' one door.
 *
 *   recordReceipt      a host code that did (or refused, or failed) something the person is told about writes ONE receipt value into the conversation as a
 *                      'view' row `view:receipt:<id>` (store/chats.ts upsertViewNoticeRow: no new table, no new file; the row goes with its conversation).
 *                      The id is derived from the effect-ledger id when the caller has one, so a retried call is one row (an upsert), never two.
 *   receiptsOfRun      the receipts of one run, read from those rows (the turn-outcome line counts them; the file card is drawn from them).
 *   receiptForAppCall  the closed table "app operation -> which receipt it is" (automations.create is a schedule, oneMemory.save is a memory...). An operation
 *                      this table does not name makes NO card: the ledger line (capability-ports.ts appendReceipt) still records it, but the person is told
 *                      nothing the host cannot point at.
 * observedWrites the file rule of a file is "written this turn" only by a typed write event or by a stat after the turn (mtime since the turn began,
 *                      inside a root the run may write). A path that only appears in the model's words is a reference, never a card.
 *   reconcileUncertainEffects  at start, an effect the ledger began and never settled becomes an `uncertain` receipt (or `done` when the object is there).
 *
 * No electron import (the background service loads this): stores are loaded lazily. No model call, no timer. Nothing here reads the model's words.
 * Retention: the rows live and die with their conversation (chat_messages FK cascade); receipts.jsonl stays the evidence ledger and is not touched here.
 */
import { createHash, randomUUID } from "node:crypto";
import nodePath from "node:path";
import {
  decodeReceiptCard, encodeReceiptCard, isReceiptId, receiptRowId, RECEIPT_ROW_LIMIT_BYTES,
  type ReceiptCardValue, type ReceiptFileRoot, type ReceiptKind, type ReceiptOutcome, type ReceiptRef, type ReceiptScope, type ReceiptVerb, type TurnOutcomeCause,
} from "../../shared/receipt-card";
import { remedyActionsOf, type RemedyAction } from "../../shared/owner-remedy";
import { AUTO_MESSAGE_GOAL_PREFIX } from "../../shared/auto-goal";

export interface RecordReceiptInput {
  kind: ReceiptKind;
  outcome: ReceiptOutcome;
  ref: ReceiptRef;
  chatId: string;
  runId: string;
  code?: string;
  verb?: ReceiptVerb;
  /** The effect-ledger ref (or any stable key of the request): the receipt id derives from it, so a repeated call is the same row. */
  effectId?: string;
  /** Update this receipt (the same row) instead of making a new id. */
  id?: string;
  /** Buttons; when absent they come from the code (shared/owner-remedy.ts). */
  actions?: RemedyAction[];
  cause?: TurnOutcomeCause;
  runner?: string;
  counts?: Partial<Record<ReceiptKind, number>>;
  /** The stamp. Absent: computed from the chat. */
  scope?: ReceiptScope;
  at?: string;
}

export interface RecordReceiptResult {
  id: string;
  rowId: string;
  /** false = the row could not be written (no such conversation, a full disk, a value over the limit): the tool result says so, never "recorded". */
  recorded: boolean;
  write: "written" | "updated" | "same" | "refused";
}

/** What the maker needs of the store. Injected by tests; production loads the real ones lazily. */
export interface ReceiptStore {
  upsert(row: { id: string; chatId: string; text: string; createdAt: string }): "written" | "updated" | "same" | "refused";
  text(rowId: string): string | null;
  /** Receipt rows of one conversation (row id + text), oldest first. */
  rowsOfChat(chatId: string): Array<{ id: string; text: string }>;
  scopeOfChat(chatId: string, runId?: string): ReceiptScope | null;
}

let override: ReceiptStore | null = null;
export function useReceiptStoreForTest(store: ReceiptStore | null): void { override = store; }

function realStore(): ReceiptStore {
  if (override) return override;
  const chats = require("../store/chats") as typeof import("../store/chats");
  return {
    upsert: (row) => chats.upsertViewNoticeRow(row),
    text: (rowId) => chats.getViewRowText(rowId),
    rowsOfChat: (chatId) => (require("../store/db") as typeof import("../store/db")).getDb()
      .prepare("SELECT id, text FROM chat_messages WHERE chat_id = ? AND row_scope = 'view' AND id LIKE 'view:receipt:%' ORDER BY created_at ASC, rowid ASC").all(chatId) as Array<{ id: string; text: string }>,
    scopeOfChat: (chatId, runId) => {
      try { return (require("../runtime/approval-scope") as typeof import("../runtime/approval-scope")).scopeStampOfChat(chatId, runId ?? null); } catch { return null; }
    },
  };
}

/** "rc_<uuid>" derived from a stable seed (a retried request is one receipt), or random when there is none. */
export function receiptIdFor(seed?: string | null): string {
  if (!seed) return `rc_${randomUUID()}`;
  const h = createHash("sha256").update(`receipt:${seed}`).digest("hex");
  return `rc_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A chat id a receipt can live in: a real conversation, not the app-wide "ui" caller and not a phone-side run id. */
const writableChat = (chatId: string): boolean => Boolean(chatId) && chatId !== "ui" && !chatId.startsWith("mobile:");

/**
 * The conversation a receipt is DRAWN in. A member of a group room (lead model) works in a hidden session of its own; a card written there is in a conversation nobody
 * opens - a schedule, a file, a message the member made for the room's owner had no card in the room. Those receipts live in the room; the member session
 * keeps only its own run bookkeeping (the end-of-turn line, the wait for a reply). Any other conversation is its own home.
 */
export function receiptHomeChat(chatId: string, kind?: ReceiptKind): string {
  if (kind === "turn-outcome" || kind === "wait") return chatId;
  try {
    const db = (require("../store/db") as typeof import("../store/db")).getDb();
    const row = db.prepare("SELECT kind, parent_chat_id AS parentId FROM chats WHERE id = ?").get(chatId) as { kind: string | null; parentId: string | null } | undefined;
    if (!row || row.kind !== "division" || !row.parentId) return chatId;
    return (require("../runtime/session-scope") as typeof import("../runtime/session-scope")).isLeadRoomMemberChat(db, chatId) ? row.parentId : chatId; // eslint-disable-line @typescript-eslint/no-require-imports
  } catch { return chatId; }
}

/** Writes (or updates) one receipt row. Never throws: a receipt that cannot be written is reported as `recorded: false`, and the tool result carries that. */
export function recordReceipt(input: RecordReceiptInput): RecordReceiptResult {
  const id = input.id && isReceiptId(input.id) ? input.id : receiptIdFor(input.effectId);
  const rowId = receiptRowId(id);
  const fail: RecordReceiptResult = { id, rowId, recorded: false, write: "refused" };
  if (!writableChat(input.chatId)) return fail;
  try {
    const store = realStore();
    const scope = input.scope ?? store.scopeOfChat(input.chatId, input.runId) ?? { account: null, project: null, chat: input.chatId, ...(input.runId ? { run: input.runId } : {}) };
    const actions = input.actions ?? (input.outcome === "refused" || input.outcome === "failed" ? remedyActionsOf(input.code) : []);
    const value: ReceiptCardValue = {
      v: 1, id, kind: input.kind, outcome: input.outcome, ...(input.code ? { code: input.code } : {}), ref: input.ref,
      // A repeated call keeps the first write's time: the same request is the same row, not a new moment.
      runId: input.runId, chatId: input.chatId, scope, at: input.at ?? decodeReceiptCard(store.text(rowId))?.at ?? new Date().toISOString(),
      ...(input.verb ? { verb: input.verb } : {}), ...(actions.length ? { actions } : {}),
      ...(input.cause ? { cause: input.cause } : {}), ...(input.runner ? { runner: input.runner } : {}), ...(input.counts ? { counts: input.counts } : {}),
    };
    const home = override ? input.chatId : receiptHomeChat(input.chatId, input.kind);
    if (home !== input.chatId) value.chatId = home;
    const text = encodeReceiptCard(value);
    // A value that does not decode back (a bad id, a ref this build refuses) is not written: a card nobody can draw is worse than none.
    if (text.length > RECEIPT_ROW_LIMIT_BYTES || !decodeReceiptCard(text)) return fail;
    const write = store.upsert({ id: rowId, chatId: home, text, createdAt: value.at });
    return { id, rowId, recorded: write !== "refused", write };
  } catch {
    return fail;
  }
}

/** The receipt behind a row id / receipt id, or null. */
export function readReceipt(id: string): ReceiptCardValue | null {
  try { return decodeReceiptCard(realStore().text(isReceiptId(id) ? receiptRowId(id) : id)); } catch { return null; }
}

/** Every receipt of a conversation (oldest first). */
export function receiptsOfChat(chatId: string): ReceiptCardValue[] {
  try { return realStore().rowsOfChat(chatId).flatMap((row) => { const v = decodeReceiptCard(row.text); return v ? [v] : []; }); } catch { return []; }
}

/** The receipts one run wrote (what the end-of-turn line counts). */
export function receiptsOfRun(chatId: string, runId: string): ReceiptCardValue[] {
  const own = receiptsOfChat(chatId).filter((v) => v.runId === runId);
  if (override) return own;
  // A member session's effect receipts live in its room (receiptHomeChat): the run's receipts are both.
  const room = receiptHomeChat(chatId);
  return room === chatId ? own : [...own, ...receiptsOfChat(room).filter((v) => v.runId === runId && !own.some((o) => o.id === v.id))];
}

/** How many receipts of each kind a run wrote (turn-outcome lines excluded: the end line does not count itself). */
/**
 * Receipts of this run that say a message is not sent because a person has not chosen yet (waiting_for_owner) or did not (not_picked, owner_declined): typed, read
 * from the host's own rows, never from what the model wrote. A Goal turn that has one hands the next move to the person instead of sending again.
 */
export const PEER_SEND_OWNER_PENDING_CODES: ReadonlySet<string> = new Set(["waiting_for_owner", "not_picked", "owner_declined"]);
export function peerSendOwnerPendingReceiptIds(chatId: string, runId: string): string[] {
  try { return receiptsOfRun(chatId, runId).filter((v) => v.kind === "message" && v.outcome === "refused" && typeof v.code === "string" && PEER_SEND_OWNER_PENDING_CODES.has(v.code)).map((v) => v.id); } catch { return []; }
}

/**
 * What a run's effects came to, read from the host's own receipts and never from the model's words. `notDone` are the receipts that say an effect was
 * refused or failed; `done` the effect receipts that were carried out; `onlyMessages` is true when every effect receipt of the run is a message to another conversation.
 * A line that claims "finished" or a Goal that stops adding turns follows this, so a request nobody carried out is never reported as done.
 */
export function effectOutcomeOfRun(chatId: string, runId: string): { done: string[]; notDone: string[]; onlyMessages: boolean } {
  const done: string[] = [], notDone: string[] = [];
  let onlyMessages = true;
  try {
    for (const v of receiptsOfRun(chatId, runId)) {
      if (v.kind === "turn-outcome") continue;
      if (v.kind !== "message") onlyMessages = false;
      if (v.outcome === "done") done.push(v.id);
      else notDone.push(v.id); // refused, failed, uncertain, cancelled, expired: none of them is "carried out"
    }
  } catch { return { done: [], notDone: [], onlyMessages: false }; }
  return { done, notDone, onlyMessages };
}

/**
 * A Goal the host opened from one owner message, whose pass carried out nothing but messages to other conversations, all of them done by the host's own receipts, with
 * no "continue" marker and no question to the person, is satisfied: the pass is its completion claim, and the ledger does not keep it alive for one more turn
 * (a delivered send was followed by a "goal unmet, pass 2" turn that only described the delivery again). A pass with any other effect, or any effect that was not carried
 * out, is left exactly as before. Receipts decide; the model's words do not.
 */
export function hostDeliveryClaim<T extends { claimed: boolean; evidence: string | null }>(claim: T, pass: { goalId: string | null; chatId: string; runId: string | null; continues: boolean; asksOwner: boolean; aborted: boolean }): T {
  if (claim.claimed || !pass.goalId || !pass.goalId.startsWith(AUTO_MESSAGE_GOAL_PREFIX) || !pass.runId || pass.continues || pass.asksOwner || pass.aborted) return claim;
  const effects = effectOutcomeOfRun(pass.chatId, pass.runId);
  if (!effects.onlyMessages || effects.done.length === 0 || effects.notDone.length > 0) return claim;
  return { ...claim, claimed: true, evidence: claim.evidence ?? `host receipt: ${effects.done.join(", ").slice(0, 200)} delivered` };
}

export function receiptCountsOfRun(chatId: string, runId: string): Partial<Record<ReceiptKind, number>> {
  const counts: Partial<Record<ReceiptKind, number>> = {};
  for (const v of receiptsOfRun(chatId, runId)) if (v.kind !== "turn-outcome") counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  return counts;
}

/* ------------------------------------------------------------------------------------------------ app operation -> receipt */

export interface AppCallReceiptFacts {
  operation: string;
  /** The arguments as the operation took them. */
  named: Record<string, unknown>;
  status: "ok" | "refused" | "failed";
  code?: string;
  /** The handler's own result (the object the person is told about), when there was one. */
  result?: unknown;
  chatId: string;
  runId: string;
  /** The workspace roots of the conversation, to place a file under project / chat-workspace / outside. */
  roots?: FileRoots;
  platform?: NodeJS.Platform;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const idOf = (...values: unknown[]): string | null => { for (const v of values) if (typeof v === "string" && /^[A-Za-z0-9_.:@+=/-]{1,200}$/.test(v)) return v; return null; };

/**
 * The closed table of app operations that tell the person something happened, and the receipt each makes. Not a list of words: operation ids of the catalog
 * (electron/app-control/catalog.generated.ts). An operation that is not here makes no card.
 */
export function receiptForAppCall(f: AppCallReceiptFacts): Omit<RecordReceiptInput, "effectId"> | null {
  const result = asRecord(f.result);
  const outcome: ReceiptOutcome = f.status === "ok" ? (result?.canceled === true || result?.cancelled === true ? "cancelled" : "done") : f.status === "refused" ? "refused" : "failed";
  const base = { outcome, chatId: f.chatId, runId: f.runId, ...(f.code && outcome !== "done" ? { code: f.code } : {}) };
  // A refusal or a failure has no object to point at: its ref is the run (the request of that run), and the card says "not done". A success with no id has no card.
  const pointer = (id: string | null, make: (id: string) => ReceiptRef): ReceiptRef | null => id ? make(id) : outcome === "done" || outcome === "cancelled" ? null : { runId: f.runId };
  const scheduleOf = (verb: ReceiptVerb, id: string | null) => { const ref = pointer(id, (v) => ({ automationId: v })); return ref ? { kind: "schedule" as const, verb, ref, ...base } : null; };
  switch (f.operation) {
    case "automations.create": return scheduleOf("create", idOf(result?.id, asRecord(result?.monitor)?.id, f.named.id));
    case "automations.update": return scheduleOf("update", idOf(f.named.id, result?.id));
    case "automations.toggle": return scheduleOf(f.named.enabled === false ? "pause" : "resume", idOf(f.named.id, result?.id));
    case "automations.remove": return scheduleOf("delete", idOf(f.named.id));
    case "oneMemory.save": case "oneMemory.editAndSave": {
      const id = idOf(result?.id, result?.entryId, result?.assetId, result?.candidateId, f.named.id, f.named.candidateId);
      const ref = pointer(id, (v) => ({ memoryId: v }));
      return ref ? { kind: "memory", ref, ...base } : null;
    }
    case "agentMail.send": return { kind: "mail", verb: "send", ref: { runId: f.runId }, ...base };
    case "liveDocument.save": return { kind: "document", verb: "save", ref: { runId: f.runId }, ...base };
    case "fs.saveTextFile": {
      const p = typeof result?.path === "string" && result.path ? result.path : typeof result?.filePath === "string" ? result.filePath : "";
      if (!p) return outcome === "done" ? null : { kind: "document", verb: "save", ref: { runId: f.runId }, ...base };
      return { kind: "file", ref: { path: p, root: rootOfPath(p, f.roots, f.platform), wroteThisTurn: outcome === "done" }, ...base };
    }
    default: return null;
  }
}

/**
 * The one call app-control makes after a dispatched, non-read operation: the card of the receipt table above, written into the conversation the call came from.
 * Returns the receipt (id + whether it was recorded) or null when the operation makes no card or the call did not come from a conversation.
 */
export function recordAppCallReceiptCard(facts: AppCallReceiptFacts & { effectId?: string }): RecordReceiptResult | null {
  if (!facts.chatId || !facts.runId) return null;
  const made = receiptForAppCall(facts);
  return made ? recordReceipt({ ...made, ...(facts.effectId ? { effectId: facts.effectId } : {}) }) : null;
}

/* ------------------------------------------------------------------------------------------------ files */

export interface FileRoots { project?: string | null; chatWorkspace?: string | null }

const pathApi = (platform: NodeJS.Platform | undefined) => ((platform ?? process.platform) === "win32" ? nodePath.win32 : nodePath.posix);
const foldCase = (platform: NodeJS.Platform | undefined, p: string): string => ((platform ?? process.platform) === "win32" ? p.toLowerCase() : p);

function inside(api: typeof nodePath.posix, platform: NodeJS.Platform | undefined, root: string, target: string): boolean {
  const rel = api.relative(foldCase(platform, api.resolve(root)), foldCase(platform, api.resolve(target)));
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

/** Which root a file sits in. Compared with the platform's own path functions (case folding on Windows), the path itself is kept as written. */
export function rootOfPath(file: string, roots: FileRoots | undefined, platform?: NodeJS.Platform): ReceiptFileRoot {
  const api = pathApi(platform);
  if (!api.isAbsolute(file)) return "outside";
  if (roots?.chatWorkspace && inside(api, platform, roots.chatWorkspace, file)) return "chat-workspace";
  if (roots?.project && inside(api, platform, roots.project, file)) return "project";
  return "outside";
}

/**
 * The correction for file systems whose time is coarse (FAT keeps two seconds): a file counts as written this turn when its mtime is not older than the turn's start
 * minus this. A resolution fix, not a limit.
 */
export const FILE_MTIME_RESOLUTION_MS = 2000;

export interface ObservedWriteInput {
  /** Paths to look at (the ones the answer named, or the ones a shell command touched). They are only CANDIDATES: nothing becomes a card without the stat. */
  candidates: readonly string[];
  /** When the run's turn began (ms). */
  turnStartedAtMs: number;
  roots: FileRoots;
  platform?: NodeJS.Platform;
  /** Paths a typed write event already receipted this run: not counted again. */
  alreadyReceipted?: ReadonlySet<string>;
  stat?: (file: string) => { isFile(): boolean; mtimeMs: number } | null;
}

/** The files that were really written this turn, seen from the disk: inside a root the run may write, and modified since the turn began. */
export function observedWrites(input: ObservedWriteInput): Array<{ path: string; root: Exclude<ReceiptFileRoot, "outside"> }> {
  const api = pathApi(input.platform);
  const stat = input.stat ?? ((file: string) => { try { return (require("node:fs") as typeof import("node:fs")).statSync(file); } catch { return null; } });
  const out: Array<{ path: string; root: Exclude<ReceiptFileRoot, "outside"> }> = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates.slice(0, 64)) {
    if (!api.isAbsolute(candidate)) continue;
    const key = foldCase(input.platform, api.normalize(candidate));
    if (seen.has(key) || input.alreadyReceipted?.has(key)) continue;
    seen.add(key);
    const root = rootOfPath(candidate, input.roots, input.platform);
    if (root === "outside") continue;
    const info = stat(candidate);
    if (!info || !info.isFile() || info.mtimeMs < input.turnStartedAtMs - FILE_MTIME_RESOLUTION_MS) continue;
    out.push({ path: candidate, root });
  }
  return out;
}

/** The key under which a receipted path is remembered for `alreadyReceipted`. */
export const receiptPathKey = (file: string, platform?: NodeJS.Platform): string => foldCase(platform, pathApi(platform).normalize(file));

/** A file receipt from a typed write event (claude `onTool` artifact, codex `file_change`, ACP `tool_call` location, a harness port's `produced`, the local loop's ledger). */
export function recordFileWriteReceipt(input: { path: string; chatId: string; runId: string; roots?: FileRoots; platform?: NodeJS.Platform; effectId?: string; observed?: boolean }): RecordReceiptResult {
  const root = rootOfPath(input.path, input.roots, input.platform);
  return recordReceipt({ kind: "file", outcome: "done", chatId: input.chatId, runId: input.runId,
    ref: { path: input.path, root, wroteThisTurn: true, ...(input.observed ? { observed: true as const } : {}) },
    effectId: input.effectId ?? `${input.runId}|file|${receiptPathKey(input.path, input.platform)}` });
}

/* ------------------------------------------------------------------------------------------------ uncertain (restart) */

export interface UncertainEffect { ref: string; tool: string; at: string; chatId: string | null }
export interface UncertainProbe {
  /** Which receipt the effect would have made and whether its object is there now (judged by the object's id only). null = no card for this tool. */
  (effect: UncertainEffect): { kind: ReceiptKind; ref: ReceiptRef; runId: string; exists: boolean | null; verb?: ReceiptVerb } | null;
}

/**
 * At start: an effect the ledger began and never settled becomes ONE receipt in its conversation: `done` when the object it would have made is there,
 * `uncertain` otherwise (it is never run again; the person checks). Idempotent by the effect's ref. Returns how many rows it wrote.
 */
export async function reconcileUncertainEffects(deps: { list: () => Promise<UncertainEffect[]>; probe: UncertainProbe }): Promise<{ written: number; skipped: number }> {
  let written = 0, skipped = 0;
  for (const effect of await deps.list()) {
    const chatId = effect.chatId ?? "";
    const probed = writableChat(chatId) ? deps.probe(effect) : null;
    if (!probed) { skipped += 1; continue; }
    const result = recordReceipt({ kind: probed.kind, outcome: probed.exists ? "done" : "uncertain", ref: probed.ref, chatId, runId: probed.runId,
      ...(probed.verb ? { verb: probed.verb } : {}), effectId: effect.ref, at: effect.at });
    if (result.write === "written") written += 1; else skipped += 1;
  }
  return { written, skipped };
}

const EFFECT_RECONCILE_META_KEY = "effect-reconcile:at";
interface ReconcileDb { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } }

/**
 * At start (the `sweepRunsLeftRunning` marker pattern, invocation/turn-outcome-line.ts): an effect the ledger began AFTER the previous start and never settled
 * (a crash or a close mid-call; harness/effect-ledger.ts uncertainEffects) leaves ONE `effect-outcome` receipt per conversation, `uncertain` (the ledger holds only an
 * argument digest, so there is no object to probe: the card says it could not be confirmed and never that it was or was not done). It is never run again.
 *  - the marker is one `meta` row, the time of the last start (overwritten each start): the first start after this change writes the marker and no card, and an effect
 *    older than the previous start is never told about (no retroactive flood); a run is looked at once, never on every start;
 *  - a conversation with a run alive in another process (`isLive`: the daemon) is skipped: its effect is not left, it is running;
 *  - the card is the same row as long as the first unsettled effect of the conversation is the same (idempotent by its ref).
 * Returns how many rows it wrote. Never throws.
 */
export async function reconcileEffectsLeftUncertain(input: { db: ReconcileDb; list: () => Promise<UncertainEffect[]>; isLive?: (chatId: string) => boolean; now?: () => number }): Promise<number> {
  const now = new Date((input.now ?? Date.now)()).toISOString();
  let written = 0;
  try {
    const marker = (input.db.prepare("SELECT value FROM meta WHERE key = ?").get(EFFECT_RECONCILE_META_KEY) as { value?: string } | undefined)?.value ?? null;
    if (marker && Number.isFinite(Date.parse(marker))) {
      const since = Date.parse(marker);
      const firstOfChat = new Map<string, UncertainEffect>();
      for (const effect of await input.list()) {
        const at = Date.parse(effect.at);
        if (!effect.chatId || !Number.isFinite(at) || at <= since) continue;
        const known = firstOfChat.get(effect.chatId);
        if (!known || at < Date.parse(known.at)) firstOfChat.set(effect.chatId, effect);
      }
      const effects = [...firstOfChat.values()].filter((effect) => { try { return input.isLive?.(effect.chatId as string) !== true; } catch { return false; } });
      const result = await reconcileUncertainEffects({
        list: async () => effects,
        probe: (effect) => ({ kind: "effect-outcome", ref: { runId: effect.ref }, runId: "", exists: false }),
      });
      written = result.written;
    }
    input.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(EFFECT_RECONCILE_META_KEY, now);
  } catch { /* a start that cannot reconcile starts anyway; the marker is not moved, so the next start looks again */ }
  return written;
}

/* ------------------------------------------------------------------------------------------------ the harness port door */

/**
 * A refusal that says the REQUEST was malformed (a wrong name, a missing detail): the model sends it again right, so it is not an event the person is told about.
 * Closed machine codes (harness/plain-outcome.ts REASON_SENTENCES: "the call itself was malformed: not the owner's problem"); everything else is a real refusal.
 */
export const MALFORMED_REQUEST_CODES: ReadonlySet<string> = new Set([
  "operation_unknown", "id_unknown", "feature_unknown", "arguments_missing", "arguments_misplaced", "arguments_invalid", "invalid-arguments", "dry_run",
  "unknown-operation", "operation-unknown",
  // A schedule the model saved with an id it guessed (automation-target-check.ts): it sends the call again right, and one request is not told twice - first "refused", then
  // "done" (a guessed monitor.originChatId, then the same reminder registered). A time the host cannot read stays a refusal the person is told.
  "automation_origin_chat_unknown", "automation_target_unknown", "automation_target_required",
]);

/** The workspace roots of a conversation: its own working folder and its project's folder. When both are the same folder it is the project's. */
export function rootsOfChat(chatId: string): FileRoots {
  try {
    const row = (require("../store/db") as typeof import("../store/db")).getDb()
      .prepare("SELECT c.working_folder AS w, p.folder_path AS p FROM chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?").get(chatId) as { w: string | null; p: string | null } | undefined;
    if (!row) return {};
    return { project: row.p ?? null, chatWorkspace: row.w && row.w !== row.p ? row.w : null };
  } catch { return {}; }
}

const DOCUMENT_PORTS: Readonly<Record<string, ReceiptVerb>> = { "document.create": "create", "document.save": "save" };

/**
 * Called once by harness/capability-ports.ts callHarnessPort for every command port after its handler answered, whatever runtime made the call (the same door for
 * claude-code, codex, antigravity, grok, kimi, cursor, copilot, byok, serving, local models; Main and the daemon). It writes the receipts the person is told about:
 *   app.call            the table of receiptForAppCall, from the handler's own result
 *   document.create/save   one `document` receipt
 *   any port's `produced`  one `file` receipt per path the port itself wrote (media, speech...), never from the model's words
 * A call the host has not finished (a pending answer) writes nothing: its end is the receipt of the call asked again.
 * Never throws; returns the card ids it wrote (for tests and the model result that may carry them later).
 */
export async function recordPortReceipts(input: {
  operationId: string;
  args: Record<string, unknown>;
  outcome: { status: "ok" | "refused" | "unavailable"; data?: unknown; reason?: string; produced?: readonly string[] };
  chatId: string;
  runId: string;
}): Promise<string[]> {
  const ids: string[] = [];
  try {
    if (!writableChat(input.chatId) || !input.runId) return ids;
    const { outcome } = input;
    const data = asRecord(outcome.data);
    if (data?.pending === true || data?.status === "running" && data?.operation !== undefined && data?.ok === undefined) return ids;
    const status: "ok" | "refused" | "failed" = outcome.status === "ok" ? (data?.ok === false ? "refused" : "ok") : "refused";
    const code = outcome.status === "ok" ? (typeof data?.code === "string" ? data.code : undefined) : outcome.reason;
    if (status !== "ok" && code && MALFORMED_REQUEST_CODES.has(code)) return ids;
    const roots = rootsOfChat(input.chatId);
    if (input.operationId === "app.call") {
      const aliases = await import("../app-control/call-aliases");
      const read = aliases.resolveAppCallRequest(input.args.operation, aliases.appCallInputOf(input.args), { chatId: input.chatId, harnessPorts: new Set<string>() });
      if (read.kind !== "call" || typeof read.operation !== "string") return ids;
      const named = asRecord(read.args) ?? {};
      const made = recordAppCallReceiptCard({ operation: read.operation, named, status, ...(code ? { code } : {}), result: data?.result, chatId: input.chatId, runId: input.runId, roots });
      if (made?.recorded) ids.push(made.id);
      return ids;
    }
    const verb = DOCUMENT_PORTS[input.operationId];
    if (verb) {
      const made = recordReceipt({ kind: "document", verb, outcome: status === "ok" ? "done" : "refused", ...(status !== "ok" && code ? { code } : {}),
        ref: { runId: input.runId }, chatId: input.chatId, runId: input.runId });
      if (made.recorded) ids.push(made.id);
      return ids;
    }
    if (status === "ok" && outcome.produced?.length) {
      for (const file of outcome.produced) {
        if (typeof file !== "string" || !file) continue;
        const made = recordFileWriteReceipt({ path: file, chatId: input.chatId, runId: input.runId, roots });
        if (made.recorded) ids.push(made.id);
      }
    }
  } catch { /* a receipt that cannot be made never turns the call into a failure; the call result stays as it was */ }
  return ids;
}

/* ------------------------------------------------------------------------------------------------ message_send */

export interface MessageReceiptInput {
  fromChatId: string;
  fromRunId: string;
  /** The conversation it was sent to, when the target was resolved (absent: the call never found one - no_peer, not_found, ambiguous). */
  toChatId?: string | null;
  text: string;
  /** The delivery's intent id (harness/deliver-runtime.ts peerIntentId), when known. */
  intentId?: string | null;
  /** What deliver() / sendPeerMessageTo answered: `{ok:true,...}` for deliver, `{delivered:boolean, code?}` for the tool answer. */
  result: { ok?: boolean; delivered?: boolean; code?: string };
  /** The message_send intent's own key (harness/peer-send-window.ts): every receipt of one intent - from its first card to its end - is this one row, whatever the target was at the time. */
  receiptKey?: string;
  /** The text's length when the text itself is not at hand (a receipt written after a restart). */
  chars?: number;
}

/**
 * The receipt of one message_send: `done` when the message was delivered (the receiving conversation's row exists), `refused` with the typed code otherwise
 * (not_same_project, no_peer, target_not_allowed, repeated, ...). The sender's conversation draws "sent N characters to <name>" or "not sent"; the words come from the
 * receipt and the live conversation names (shared/receipt-card.ts), never from what the model says it did. A refusal a person can clear carries the buttons of
 * shared/owner-remedy.ts (hand the work to the personal agent). The id derives from the call (run + target + intent), so a repeat of the same call is the same row.
 */
export function recordMessageReceipt(input: MessageReceiptInput): RecordReceiptResult {
  const delivered = input.result.ok === true || input.result.delivered === true;
  const chars = input.chars ?? [...(input.text ?? "").trim()].length;
  const to = input.toChatId && /^[A-Za-z0-9_.:@+=/-]{1,200}$/.test(input.toChatId) ? input.toChatId : null;
  const ref: ReceiptRef = to ? { toChatId: to, intentId: (input.intentId ?? "").slice(0, 200), chars } : { runId: input.fromRunId };
  return recordReceipt({
    kind: "message", outcome: delivered ? "done" : "refused", ...(!delivered && input.result.code ? { code: input.result.code } : {}),
    ref, chatId: input.fromChatId, runId: input.fromRunId,
    effectId: input.receiptKey ? `${input.fromRunId}|message|intent|${input.receiptKey}`
      : `${input.fromRunId}|message|${to ?? "unresolved"}|${input.intentId ?? createHash("sha256").update(input.text ?? "").digest("hex").slice(0, 16)}`,
  });
}

/**
 * The receipt writer of a peer-reply wait (harness/peer-reply-wait.ts builds the value; this is the one door that puts it in the sender's conversation).
 * The wait id is the receipt id, so every state of one wait (waiting -> answered | expired | ...) is the same row. Never throws.
 */
export function recordPeerWaitReceipt(value: { id: string; outcome: ReceiptOutcome; code?: string; ref: ReceiptRef; chatId: string; runId: string; scope?: unknown; at?: string }): RecordReceiptResult {
  return recordReceipt({ id: value.id, kind: "wait", outcome: value.outcome, ...(value.code ? { code: value.code } : {}), ref: value.ref, chatId: value.chatId, runId: value.runId,
    ...(value.scope && typeof value.scope === "object" ? { scope: value.scope as ReceiptScope } : {}), effectId: value.id });
}
