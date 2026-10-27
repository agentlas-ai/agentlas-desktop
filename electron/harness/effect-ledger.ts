/*
 * Common pre-effect checkpoint (docs/2026-10-13-native-harness/01 §1 "효과 준비 → 효과 전 원장/체크포인트").
 *
 * Every mutating tool call that Main dispatches — the API/local Main tool loop and the CLI runtimes' MCP proxy — writes a
 * `begin` row BEFORE the effect leaves Main and a `settle` row after (settled | failed | uncertain). The logical effect
 * identity is chat + tool + canonical arguments. The rule the old recovery prompt asked the model to follow ("never
 * duplicate an uncertain external effect") is now the host's: when the newest row for the same identity is a begin from
 * another run that never settled (a crash, a cut wire) or an `uncertain` settle, the next identical call is answered
 * with EFFECT_UNCERTAIN once — the model checks the outcome with a read tool — and a `notice` row lets a deliberate
 * repeat through. A successful settle also stores a bounded, secret-redacted result in the durable tool-result store; until
 * `acknowledgeEffect` says the result reached the model, an identical call from another run is answered with that stored
 * result (`replayed`) instead of executing again (G12). Read-only calls are not checkpointed. Append-only JSONL under userData; never auto-deleted.
 * No electron import (the daemon dispatches too). Main and the daemon append to the same file: every call first reads the rows added since
 * its last read, so one process sees the other's unsettled begin, settle and ack.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type EffectSurface = "main-loop" | "mcp-proxy";
export type EffectSettleState = "settled" | "failed" | "uncertain";

type Row =
  | { t: "begin"; ref: string; key: string; at: string; surface: EffectSurface; tool: string; chatId: string | null; run: string; argsDigest: string }
  | { t: "settle"; ref: string; key: string; at: string; state: EffectSettleState; result?: EffectResultRef }
  | { t: "notice"; ref: string; key: string; at: string; priorRef: string }
  | { t: "ack"; ref: string; key: string; at: string; settleRef: string }
  | { t: "replay"; ref: string; key: string; at: string; priorRef: string };

/** A settled effect's bounded, secret-redacted result, kept in the durable tool-result store (never inline in the ledger). */
export interface EffectResultRef { ref: string; storedSha256: string; redacted: boolean; bytes: number; truncated: boolean; chatId: string | null }

const latestByKey = new Map<string, Row>();
const beginByRef = new Map<string, Extract<Row, { t: "begin" }>>();
const settledByRef = new Map<string, EffectSettleState>();
const resultByRef = new Map<string, EffectResultRef>();
const ackedRefs = new Set<string>();
/** Upper bound of a stored effect result. Longer text is cut with a visible marker, never dropped (a cut result still prevents a re-run). */
export const EFFECT_RESULT_MAX_CHARS = 262_144;
let fileOverride: string | null = null;

async function ledgerFile(): Promise<string> {
  if (fileOverride) return fileOverride;
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath(path.join("harness", "effects.jsonl"));
}

function index(row: Row): void {
  if (row.t === "ack") { ackedRefs.add(row.settleRef); return; }
  if (row.t === "replay") return;
  // A late settle of an older ref never hides a newer in-flight begin of the same effect identity.
  const latest = latestByKey.get(row.key);
  if (!(row.t === "settle" && latest?.t === "begin" && latest.ref !== row.ref)) latestByKey.set(row.key, row);
  if (row.t === "begin") beginByRef.set(row.ref, row);
  if (row.t === "settle") { settledByRef.set(row.ref, row.state); if (row.result) resultByRef.set(row.ref, row.result); else resultByRef.delete(row.ref); }
}

function resultScope(chatId: string | null) {
  return { runtimeKind: "effect-ledger", sessionKey: "effects", ...(chatId ? { chatId } : {}) };
}

/** Redact, bound and commit an effect result into the durable store. Null when nothing could be kept. */
async function storeEffectResult(chatId: string | null, text: string): Promise<EffectResultRef | null> {
  try {
    const store = await import("./tool-result-store");
    const truncated = text.length > EFFECT_RESULT_MAX_CHARS;
    const bounded = truncated ? `${text.slice(0, EFFECT_RESULT_MAX_CHARS)}\n[effect result truncated by the host at ${EFFECT_RESULT_MAX_CHARS} characters]` : text;
    const redacted = store.redactToolText(bounded);
    const entry = store.writeToolResult(resultScope(chatId), redacted, false, null);
    return entry ? { ref: entry.ref, storedSha256: entry.storedSha256, redacted: entry.redacted, bytes: entry.bytes, truncated, chatId } : null;
  } catch { return null; }
}

async function readEffectResult(result: EffectResultRef): Promise<string | null> {
  try {
    const store = await import("./tool-result-store");
    const entry = store.readToolResult(resultScope(result.chatId), result.ref);
    return entry && entry.storedSha256 === result.storedSha256 ? entry.text : null;
  } catch { return null; }
}

/** A read failure other than "no ledger yet": the uncertain-effect list is then unknown, not empty (NH13). */
let loadError: string | null = null;
/** Main and the daemon append to the same file, so the index is a cursor into it, not a one-time snapshot. */
let syncedFile: string | null = null;
let readOffset = 0;
/** Own appends already indexed from memory that another process's rows interleaved with: the cursor skips them once it passes. */
const selfIndexed = new Set<string>();

function resetIndex(): void {
  latestByKey.clear(); beginByRef.clear(); settledByRef.clear(); resultByRef.clear(); ackedRefs.clear(); selfIndexed.clear();
  readOffset = 0;
}

function parseRow(text: string): { row: Row; source: string } | null {
  const parse = (source: string): { row: Row; source: string } | null => {
    try { const row = JSON.parse(source) as Row; return row && typeof row === "object" && typeof row.t === "string" ? { row, source } : null; } catch { return null; }
  };
  const whole = parse(text);
  if (whole) return whole;
  // A process that died mid-append leaves a torn fragment and the next row is glued to its end: the row is still intact.
  const glued = text.lastIndexOf('{"t":"');
  return glued > 0 ? parse(text.slice(glued)) : null;
}

function readErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "read_failed";
}

/**
 * Index every row appended to the file since the last read — by this process or by the other one (Main and the daemon
 * share it). Synchronous on purpose: a caller decides on the result with no await in between. No ledger yet is an observed
 * empty ledger; any other read failure leaves the cursor where it was (the list is unknown, not empty) and is retried.
 */
function syncLedger(file: string): void {
  if (syncedFile !== file) { resetIndex(); syncedFile = file; }
  let size: number;
  try { size = fs.statSync(file).size; } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT") { if (readOffset > 0) resetIndex(); loadError = null; } else loadError = code;
    return;
  }
  if (size < readOffset) resetIndex(); // replaced or truncated (never expected): fold again from the start
  if (size === readOffset) { loadError = null; return; }
  let chunk: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - readOffset);
      let got = 0;
      while (got < buffer.length) {
        const n = fs.readSync(fd, buffer, got, buffer.length - got, readOffset + got);
        if (n <= 0) break;
        got += n;
      }
      chunk = buffer.subarray(0, got);
    } finally { fs.closeSync(fd); }
  } catch (error) { loadError = readErrorCode(error); return; }
  loadError = null;
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const text = chunk.toString("utf8", start, newline < 0 ? chunk.length : newline);
    const parsed = text.trim() ? parseRow(text) : null;
    // An unterminated tail counts only once it parses whole; otherwise the rest of the row is still to come.
    if (newline < 0 && !parsed) break;
    if (parsed && !selfIndexed.delete(parsed.source)) index(parsed.row);
    start = newline < 0 ? chunk.length : newline + 1;
  }
  readOffset += start;
}

/** Why the last ledger read failed (null when it was read or does not exist yet). */
export function effectLedgerReadError(): string | null { return loadError; }

/** The ledger path, or null when it cannot be resolved (the in-memory index alone then guards this process). */
async function resolveLedgerFile(): Promise<string | null> {
  try { return await ledgerFile(); } catch { loadError = "path_unavailable"; return null; }
}

/** Index in memory at once (this process's guard), then append; callers sync the file just before so the append is not a blind one. */
function appendRow(file: string | null, row: Row): void {
  index(row);
  if (!file) return;
  const line = JSON.stringify(row);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch { return; /* the in-memory index still guards this process */ }
  // Nothing was written between the last read and this append: our row is already behind the cursor. Otherwise skip it when the cursor passes.
  let size = -1;
  try { size = fs.statSync(file).size; } catch { /* the cursor path below stays correct */ }
  if (syncedFile === file && size === readOffset + Buffer.byteLength(line) + 1) readOffset = size;
  else selfIndexed.add(line);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function effectArgsDigest(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(args)) ?? "undefined").digest("hex");
}

export function effectKey(chatId: string | null | undefined, tool: string, args: unknown): string {
  return createHash("sha256").update(chatId ?? "").update("\0").update(tool).update("\0").update(effectArgsDigest(args)).digest("hex");
}

export type BeginOutcome =
  | { status: "begun"; ref: string }
  | { status: "uncertain_prior"; priorRef: string; priorAt: string; content: string }
  /** The identical effect already settled successfully in another run and its result never reached the model (no ack). Do not execute;
   * hand `content` back as the result, then acknowledgeEffect(priorRef). */
  | { status: "replayed"; priorRef: string; priorAt: string; content: string; replayed: true };

/** Checkpoint before a mutating effect leaves Main. `run` is the caller's opaque run identity. */
export async function beginEffect(input: { surface: EffectSurface; chatId?: string | null; run: string; tool: string; args: unknown }): Promise<BeginOutcome> {
  const file = await resolveLedgerFile();
  if (file) syncLedger(file); // the other process (Main <-> daemon) may have left an unsettled begin since the last call
  const key = effectKey(input.chatId, input.tool, input.args);
  let latest = latestByKey.get(key);
  if (latest?.t === "settle" && latest.state === "settled" && latest.result && !ackedRefs.has(latest.ref)) {
    const begin = beginByRef.get(latest.ref);
    if (begin && begin.run !== input.run) {
      const text = await readEffectResult(latest.result);
      if (file) syncLedger(file); // the read yielded: the result may have been acknowledged or superseded meanwhile
      const fresh = latestByKey.get(key);
      if (text !== null && fresh === latest && !ackedRefs.has(latest.ref)) {
        appendRow(file, { t: "replay", ref: randomUUID(), key, at: new Date().toISOString(), priorRef: latest.ref });
        return { status: "replayed", priorRef: latest.ref, priorAt: begin.at, content: text, replayed: true };
      }
      latest = fresh;
    }
  }
  // From here to the begin append nothing awaits, so the decision is made on the file as it was read.
  const prior = latest?.t === "begin" && latest.run !== input.run ? latest
    : latest?.t === "settle" && latest.state === "uncertain" ? beginByRef.get(latest.ref) ?? null
      : null;
  if (prior) {
    appendRow(file, { t: "notice", ref: randomUUID(), key, at: new Date().toISOString(), priorRef: prior.ref });
    return {
      status: "uncertain_prior", priorRef: prior.ref, priorAt: prior.at,
      content: `EFFECT_UNCERTAIN: an identical ${input.tool} call started at ${prior.at} and its outcome was never confirmed. `
        + "Check whether it already happened with a read tool; call again only if it did not.",
    };
  }
  const ref = randomUUID();
  appendRow(file, { t: "begin", ref, key, at: new Date().toISOString(), surface: input.surface, tool: input.tool, chatId: input.chatId ?? null,
    run: input.run, argsDigest: effectArgsDigest(input.args) });
  return { status: "begun", ref };
}

/**
 * The outcome of a checkpointed effect. An abort or a cut wire after dispatch is `uncertain`, never `failed`.
 * The first settle of a ref is final: a late or duplicate terminal callback (a response that arrives after the wire was
 * already recorded as cut, a second finish hook) never flips `uncertain` into `settled`/`failed` or a result into
 * `uncertain`. Only an explicit `{ resolveUncertain: true }` settle (an owner/read-tool verification) may resolve an
 * `uncertain` row. Returns whether the row was written.
 */
export async function settleEffect(ref: string, state: EffectSettleState, options?: { resolveUncertain?: boolean; result?: string }): Promise<boolean> {
  const file = await resolveLedgerFile();
  if (file) syncLedger(file);
  const begin = beginByRef.get(ref);
  if (!begin) return false;
  const final = (): boolean => {
    const prior = settledByRef.get(ref);
    return Boolean(prior) && !(prior === "uncertain" && options?.resolveUncertain === true && state !== "uncertain");
  };
  if (final()) return false;
  const result = state === "settled" && typeof options?.result === "string" ? await storeEffectResult(begin.chatId, options.result) : null;
  if (file) syncLedger(file); // storing the result yielded: the first settle of a ref stays final across both processes
  if (final()) return false;
  appendRow(file, { t: "settle", ref, key: begin.key, at: new Date().toISOString(), state, ...(result ? { result } : {}) });
  return true;
}

/**
 * The settled result of `ref` reached the model (or the CLI's wire). From now on an identical call is a new, deliberate effect
 * again. Idempotent; a ref without a stored result, an unknown ref or an already acknowledged one is a no-op (false).
 */
export async function acknowledgeEffect(ref: string): Promise<boolean> {
  const file = await resolveLedgerFile();
  if (file) syncLedger(file);
  const begin = beginByRef.get(ref);
  if (!begin || !resultByRef.has(ref) || ackedRefs.has(ref)) return false;
  appendRow(file, { t: "ack", ref: randomUUID(), key: begin.key, at: new Date().toISOString(), settleRef: ref });
  return true;
}

/** Effects whose newest row is an unsettled begin or an uncertain settle (for status and recovery views). */
export async function uncertainEffects(chatId?: string | null): Promise<Array<{ ref: string; tool: string; at: string; chatId: string | null; surface: EffectSurface }>> {
  const file = await resolveLedgerFile();
  if (file) syncLedger(file);
  const out: Array<{ ref: string; tool: string; at: string; chatId: string | null; surface: EffectSurface }> = [];
  for (const row of latestByKey.values()) {
    // A notice only tells the model once; it never resolves the prior effect, so that effect stays listed until a settle says otherwise.
    const begin = row.t === "begin" ? row : row.t === "settle" && row.state === "uncertain" ? beginByRef.get(row.ref)
      : row.t === "notice" && (settledByRef.get(row.priorRef) ?? "uncertain") === "uncertain" ? beginByRef.get(row.priorRef) : undefined;
    if (!begin || (chatId !== undefined && begin.chatId !== chatId)) continue;
    out.push({ ref: begin.ref, tool: begin.tool, at: begin.at, chatId: begin.chatId, surface: begin.surface });
  }
  return out;
}

/** Test seam: a private ledger file and a cold index. */
export function useEffectLedgerFileForTest(file: string | null): void {
  fileOverride = file; syncedFile = null; loadError = null; resetIndex();
}

/** Opaque per-run identity for a dispatcher object (an approval context or a proxy gate). */
const runIds = new WeakMap<object, string>();
export function effectRunId(owner: object): string {
  let id = runIds.get(owner);
  if (!id) { id = randomUUID(); runIds.set(owner, id); }
  return id;
}
