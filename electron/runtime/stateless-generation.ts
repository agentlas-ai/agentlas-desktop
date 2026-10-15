// Generations for runtimes that keep no provider session (native-harness notyet NH10; docs/2026-10-13-native-harness 05 §2–3).
//
// BYOK Anthropic / Gemini / OpenAI-compatible, Agentlas serving, agentlas-local, LM Studio, MLX and Ollama hold nothing on
// the provider side, so Agentlas keeps the "session". The rotation rule is the native runtimes' rule (session-generation.ts):
// the conversation gives way to a new generation when a request's INPUT reaches 80% of the window that actually admits it.
// Admission is a different check and stays with the callers: input + output reserve must fit the window, per request, by
// the existing per-request history excerpt. Admission never records a generation, and the output reserve never moves the
// rotation point.
//
// A generation is a frozen handoff (host facts ahead of an untrusted excerpt of the history up to a frontier row) plus the
// rows after the frontier, sent verbatim. It is installed only at a boundary the loop has settled — the start of a turn, or
// after a tool step whose results are all in — with one compare-and-swap on the stored generation. The record carries the
// frontier, a digest of the rows it covers, the window and where that number came from, and what triggered it. It is
// acknowledged only after the first request that used it came back complete; a response that arrives after another writer
// installed a newer generation never acknowledges. A crash between install and acknowledgement leaves the prepared handoff
// in place: the next turn starts from it, and no tool is run again. The current request, its tool call/result groups and
// owner directions after the frontier are never folded (they are the frontier's delta).
//
// No electron import, no module-level store require (the daemon runs the same loops).
import { createHash } from "node:crypto";
import type { ChatHistoryEntry } from "../../shared/types";
import type { RuntimeLocale } from "./status-i18n";
import { compactHistoryToBudget, estimateTransportTokens } from "./compact";
import { GENERATION_CONTEXT_RATIO, decideGeneration } from "./session-generation";
import { collectHostFacts, recordGenerationSwitch, renderHostFacts, statelessSessionId, withHostFactsAhead, type HostFactsSources } from "./handoff-facts";

export const STATELESS_GENERATION_SCHEMA = "agentlas.stateless-generation.v2";
/** Synthetic id of the handoff row while it is folded again into a newer generation. */
const HANDOFF_ROW_ID = "agentlas:stateless-handoff";
/** A stored handoff larger than this is not persisted (the in-memory generation still applies to this run). */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Where the window number came from. Only `known` windows move the rotation point; a default never does. */
/** `requested`: the window this host asked the endpoint for on this request (Ollama num_ctx), the one that admits it. */
export type StatelessWindowSource = "measured" | "loaded" | "requested" | "probed" | "host-ceiling" | "built-in" | "catalog" | "unknown";
export interface StatelessWindow { tokens: number; source: StatelessWindowSource; known: boolean }

export interface StatelessGenerationHead {
  schema: typeof STATELESS_GENERATION_SCHEMA;
  runtime: string;
  scope: string;
  generation: number;
  state: "installed" | "acknowledged";
  reason: "context_ratio";
  window: { tokens: number; source: StatelessWindowSource };
  trigger: { inputTokens: number; inputSource: "estimated" | "observed+estimated-delta"; boundary: "turn-start" | "tool-step"; step: number };
  /** The last history row the handoff covers, how many rows it covers, and a digest of exactly those rows (ids + text). */
  frontier: { anchorId: string; coveredRows: number; coveredDigest: string };
  /** `text` is what the request carries (host facts ahead of the excerpt); `excerpt` alone is what a later rotation folds. */
  handoff: { text: string; excerpt: string; estimatedTokens: number; representation: "host-facts+untrusted-excerpt" };
  model: string | null;
  installedAt: string;
  acknowledgedAt?: string;
  ack?: { step: number; observedInputTokens: number | null };
}

export interface StatelessGenerationStore {
  read(runtime: string, scope: string, chatId: string): { head: StatelessGenerationHead | null; legacyGeneration: number | null };
  /** Compare-and-swap: write `head` only when the stored generation is `expected` (null = nothing stored yet). */
  install(expected: number | null, head: StatelessGenerationHead): boolean;
  /** Compare-and-swap: the installed `generation` becomes acknowledged; false when another generation is current. */
  acknowledge(runtime: string, scope: string, generation: number, ack: NonNullable<StatelessGenerationHead["ack"]>, at: string): boolean;
}

/** Machine-readable outcomes a run keeps (tests and diagnostics read them; nothing reaches the screen). */
export type StatelessGenerationReceipt =
  | { code: "seeded"; generation: number; state: StatelessGenerationHead["state"] }
  | { code: "seed_not_applicable"; generation: number; why: "frontier_missing" | "covered_rows_changed" }
  | { code: "rotated"; from: number; to: number; boundary: "turn-start" | "tool-step"; step: number; inputTokens: number; window: number }
  | { code: "generation_conflict"; expected: number | null; boundary: "turn-start" | "tool-step"; step: number }
  | { code: "rebased"; generation: number; state: StatelessGenerationHead["state"]; step: number }
  | { code: "rotation_room_exhausted"; step: number; inputTokens: number; window: number }
  | { code: "history_not_foldable"; step: number }
  | { code: "acknowledged"; generation: number; step: number }
  | { code: "late_ack_refused"; generation: number; step: number }
  | { code: "persist_skipped"; generation: number; why: "no_conversation" | "store_unavailable" | "payload_too_large" };

export type StatelessBoundaryResult =
  | { action: "continue" }
  | { action: "rotated"; digest: string; rows: ChatHistoryEntry[]; generation: number; historyTokens: number }
  | { action: "held"; code: "generation_conflict" | "rotation_room_exhausted" | "history_not_foldable" };

export interface StatelessBoundaryInput {
  boundary: "turn-start" | "tool-step";
  step: number;
  window: StatelessWindow;
  /** Estimate of the complete request about to be sent (system, tools, history, current request, tool groups). */
  requestTokens: number;
  /** Estimate of the history slice as currently transmitted (the only part a rotation may fold). */
  historyTokens: number;
  /** The previous request's provider-reported input and the estimate of that same request, when both exist. */
  observedLastInput?: number | null;
  lastRequestTokens?: number | null;
}

export interface StatelessGenerationSession {
  /** This conversation's installed generation applied to this request's history; null = send the history as it is. */
  readonly seed: { digest: string; rows: ChatHistoryEntry[]; generation: number } | null;
  /** Rotation check at a settled boundary, before the request is sent. */
  boundary(input: StatelessBoundaryInput): Promise<StatelessBoundaryResult>;
  /** The request sent at `step` came back with a complete boundary (the only acknowledgement point). */
  completed(step: number, observedInputTokens: number | null): void;
  readonly receipts: readonly StatelessGenerationReceipt[];
  readonly generation: number | null;
}

export interface OpenStatelessGenerationInput {
  runtime: string;
  chatId: string | null | undefined;
  /** The run's session owner (agent); generations of two agents in one room never mix. */
  ownerId?: string | null;
  model?: string | null;
  /** The user/assistant rows this request carries before the current prompt, in order. */
  history: ChatHistoryEntry[];
  locale: RuntimeLocale;
  agentId?: string | null;
  /** undefined: the durable SQLite store; null: in-memory only (this run). */
  store?: StatelessGenerationStore | null;
  sources?: HostFactsSources;
  now?: () => string;
}

const rowKey = (row: ChatHistoryEntry): string => row.durableMessageId ?? row.id;
const rowCost = (text: string): number => estimateTransportTokens(text) + 12;

/** Digest of exactly these rows (role + identity + text), in order. A deleted or edited row changes it. */
export function coveredRowsDigest(rows: readonly ChatHistoryEntry[]): string {
  const hash = createHash("sha256").update("stateless-generation-covered.v1");
  for (const row of rows) hash.update("\u0001").update(row.role).update("\0").update(rowKey(row)).update("\0").update(row.text ?? "");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The input the rotation rule reads for the request about to be sent: the previous request's provider-reported input plus
 * the growth since (tool results, owner directions), with the growth scaled by how far the estimator was off on that same
 * previous request — so the estimator's bias moves neither the 80% point nor the fold. `scale` = reported / estimated for
 * the previous request (1 with nothing reported); history budgets are converted into estimate units with it. With no
 * reported input, the estimate of the whole request.
 */
export function boundaryInputTokens(input: Pick<StatelessBoundaryInput, "requestTokens" | "observedLastInput" | "lastRequestTokens">):
  { tokens: number; source: "estimated" | "observed+estimated-delta"; scale: number } {
  const observed = input.observedLastInput, last = input.lastRequestTokens;
  if (typeof observed === "number" && Number.isFinite(observed) && observed > 0 && typeof last === "number" && Number.isFinite(last) && last > 0) {
    const scale = observed / last;
    return { tokens: Math.ceil(observed + Math.max(0, input.requestTokens - last) * scale), source: "observed+estimated-delta", scale };
  }
  return { tokens: input.requestTokens, source: "estimated", scale: 1 };
}

/** Durable store: one head row per (runtime, conversation scope) in the main store, written under an IMMEDIATE transaction. */
export function sqliteStatelessGenerationStore(): StatelessGenerationStore | null {
  type Db = import("better-sqlite3").Database;
  let db: Db;
  try { db = (require("../store/db") as typeof import("../store/db")).getDb() as unknown as Db; } catch { return null; }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_stateless_generations (
      runtime TEXT NOT NULL, scope TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('installed','acknowledged')),
      payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (runtime, scope))`);
  } catch { return null; }
  const parse = (raw: string): StatelessGenerationHead | null => {
    try {
      const value = JSON.parse(raw) as StatelessGenerationHead;
      return value?.schema === STATELESS_GENERATION_SCHEMA && Number.isSafeInteger(value.generation) && typeof value.handoff?.text === "string"
        && typeof value.handoff?.excerpt === "string" && typeof value.frontier?.anchorId === "string" ? value : null;
    } catch { return null; }
  };
  return {
    read(runtime, scope, chatId) {
      const row = db.prepare("SELECT generation, payload_json FROM runtime_stateless_generations WHERE runtime = ? AND scope = ?")
        .get(runtime, scope) as { generation: number; payload_json: string } | undefined;
      let legacyGeneration: number | null = null;
      try {
        // Builds before NH10 kept only a generation counter and host facts per (runtime, chat) in the meta table.
        const legacy = db.prepare("SELECT value FROM meta WHERE key = ?").get(`runtime-generation:${runtime}:${chatId}`) as { value: string } | undefined;
        const parsed = legacy ? JSON.parse(legacy.value) as { generation?: unknown } : null;
        legacyGeneration = parsed && Number.isSafeInteger(parsed.generation) ? Number(parsed.generation) : null;
      } catch { legacyGeneration = null; }
      return { head: row ? parse(row.payload_json) : null, legacyGeneration };
    },
    install(expected, head) {
      return db.transaction(() => {
        const row = db.prepare("SELECT generation FROM runtime_stateless_generations WHERE runtime = ? AND scope = ?")
          .get(head.runtime, head.scope) as { generation: number } | undefined;
        if ((row ? row.generation : null) !== expected) return false;
        db.prepare(`INSERT INTO runtime_stateless_generations (runtime, scope, generation, state, payload_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runtime, scope) DO UPDATE SET generation = excluded.generation,
          state = excluded.state, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
          .run(head.runtime, head.scope, head.generation, head.state, JSON.stringify(head), head.installedAt);
        return true;
      }).immediate();
    },
    acknowledge(runtime, scope, generation, ack, at) {
      return db.transaction(() => {
        const row = db.prepare("SELECT generation, state, payload_json FROM runtime_stateless_generations WHERE runtime = ? AND scope = ?")
          .get(runtime, scope) as { generation: number; state: string; payload_json: string } | undefined;
        if (!row || row.generation !== generation) return false;
        if (row.state === "acknowledged") return true;
        const head = parse(row.payload_json);
        if (!head) return false;
        const next: StatelessGenerationHead = { ...head, state: "acknowledged", acknowledgedAt: at, ack };
        db.prepare("UPDATE runtime_stateless_generations SET state = 'acknowledged', payload_json = ?, updated_at = ? WHERE runtime = ? AND scope = ? AND generation = ?")
          .run(JSON.stringify(next), at, runtime, scope, generation);
        return true;
      }).immediate();
    },
  };
}

/** In-memory store with the same compare-and-swap semantics (tests, and runs with no conversation). */
export function memoryStatelessGenerationStore(): StatelessGenerationStore & { heads: Map<string, StatelessGenerationHead> } {
  const heads = new Map<string, StatelessGenerationHead>();
  const key = (runtime: string, scope: string) => `${runtime}\u0000${scope}`;
  return {
    heads,
    read(runtime, scope) { const head = heads.get(key(runtime, scope)); return { head: head ? structuredClone(head) : null, legacyGeneration: null }; },
    install(expected, head) {
      const current = heads.get(key(head.runtime, head.scope));
      if ((current ? current.generation : null) !== expected) return false;
      heads.set(key(head.runtime, head.scope), structuredClone(head));
      return true;
    },
    acknowledge(runtime, scope, generation, ack, at) {
      const current = heads.get(key(runtime, scope));
      if (!current || current.generation !== generation) return false;
      if (current.state !== "acknowledged") heads.set(key(runtime, scope), { ...current, state: "acknowledged", acknowledgedAt: at, ack });
      return true;
    },
  };
}

export function openStatelessGeneration(input: OpenStatelessGenerationInput): StatelessGenerationSession {
  const now = input.now ?? (() => new Date().toISOString());
  const chatId = input.chatId ?? null;
  const scope = chatId ? `${chatId}\u0000${input.ownerId ?? ""}` : "";
  const store = chatId ? (input.store === undefined ? sqliteStatelessGenerationStore() : input.store) : null;
  const history = input.history.filter((row) => row.role === "user" || row.role === "assistant");
  const receipts: StatelessGenerationReceipt[] = [];

  let stored: { head: StatelessGenerationHead | null; legacyGeneration: number | null } = { head: null, legacyGeneration: null };
  try { if (store && chatId) stored = store.read(input.runtime, scope, chatId); } catch { stored = { head: null, legacyGeneration: null }; }
  /** The generation number the store holds (CAS expectation) and the highest number ever used (monotonic numbering). */
  let expected: number | null = stored.head ? stored.head.generation : null;
  let generation: number | null = stored.head ? stored.head.generation : stored.legacyGeneration;
  /** The handoff now in effect (sent text and its excerpt) and the index of the last history row it covers (-1: none). */
  let digest: string | null = null;
  let excerpt: string | null = null;
  let anchorIndex = -1;
  let pendingAck: number | null = null;
  let seed: StatelessGenerationSession["seed"] = null;

  /** Where a stored head's frontier sits in this request's history, or why its excerpt must not be used here. */
  const applicable = (head: StatelessGenerationHead): { index: number } | { why: "frontier_missing" | "covered_rows_changed" } => {
    const index = history.findIndex((row) => rowKey(row) === head.frontier.anchorId);
    if (index < 0) return { why: "frontier_missing" };
    // A deleted or edited row the handoff covered: its excerpt must not come back. Start from the rows as they are now.
    if (index + 1 !== head.frontier.coveredRows || coveredRowsDigest(history.slice(0, index + 1)) !== head.frontier.coveredDigest)
      return { why: "covered_rows_changed" };
    return { index };
  };
  const adopt = (head: StatelessGenerationHead, index: number): void => {
    digest = head.handoff.text;
    excerpt = head.handoff.excerpt;
    anchorIndex = index;
    generation = head.generation;
    expected = head.generation;
    // Installed but never acknowledged (the run that installed it stopped): this run's first complete request acknowledges.
    pendingAck = head.state === "installed" ? head.generation : null;
  };
  const head = stored.head;
  if (head) {
    const at = applicable(head);
    if ("why" in at) receipts.push({ code: "seed_not_applicable", generation: head.generation, why: at.why });
    else {
      adopt(head, at.index);
      seed = { digest: head.handoff.text, rows: history.slice(at.index + 1), generation: head.generation };
      receipts.push({ code: "seeded", generation: head.generation, state: head.state });
    }
  }

  const boundary = async (b: StatelessBoundaryInput): Promise<StatelessBoundaryResult> => {
    // An unknown window is never a reason to rotate: a default is not evidence (admission still applies per request).
    if (!b.window.known || !(b.window.tokens > 0)) return { action: "continue" };
    const measured = boundaryInputTokens(b);
    const decision = decideGeneration({ kind: input.runtime, contextWindowTokens: b.window.tokens, lastInputTokens: measured.tokens });
    if (decision.action !== "new_generation") return { action: "continue" };
    // Everything outside the history slice stays as it is; the folded history must bring the request under 80%. The
    // budgets are in estimate units: the window divided by the previous request's reported/estimated scale.
    const windowEstimate = b.window.tokens / measured.scale;
    const nonHistory = Math.max(0, b.requestTokens - b.historyTokens);
    const room = Math.floor(windowEstimate * GENERATION_CONTEXT_RATIO) - nonHistory - 1;
    const target = Math.min(Math.floor(windowEstimate * (1 - GENERATION_CONTEXT_RATIO)), room);
    if (target <= 0) {
      receipts.push({ code: "rotation_room_exhausted", step: b.step, inputTokens: measured.tokens, window: b.window.tokens });
      return { action: "held", code: "rotation_room_exhausted" };
    }
    const tail = history.slice(anchorIndex + 1);
    // The previous excerpt is folded again; its host-facts block is not (the new generation gets current facts).
    const foldInput: ChatHistoryEntry[] = excerpt !== null
      ? [{ id: HANDOFF_ROW_ID, role: "user", text: excerpt, createdAt: history[anchorIndex]?.createdAt ?? new Date(0).toISOString() }, ...tail]
      : tail;
    const compacted = compactHistoryToBudget(foldInput, { historyBudgetTokens: target, locale: input.locale });
    if (!compacted.fits || !compacted.digest || compacted.droppedCount <= 0) {
      receipts.push({ code: "history_not_foldable", step: b.step });
      return { action: "held", code: "history_not_foldable" };
    }
    const foldedReal = compacted.droppedCount - (excerpt !== null ? 1 : 0);
    const nextAnchor = anchorIndex + Math.max(0, foldedReal);
    if (nextAnchor < 0) {
      receipts.push({ code: "history_not_foldable", step: b.step });
      return { action: "held", code: "history_not_foldable" };
    }
    const from = generation ?? 0, to = from + 1;
    const covered = history.slice(0, nextAnchor + 1);
    const facts = await collectHostFacts({ chatId, agentId: input.agentId ?? null, runtime: input.runtime, kind: "host-replay",
      fromGeneration: from, toGeneration: to, reason: "context_ratio", deliveredHistory: covered, sources: input.sources });
    const handoff = withHostFactsAhead(renderHostFacts(facts), compacted.digest);
    const at = now();
    const next: StatelessGenerationHead = {
      schema: STATELESS_GENERATION_SCHEMA, runtime: input.runtime, scope, generation: to, state: "installed", reason: "context_ratio",
      window: { tokens: b.window.tokens, source: b.window.source },
      trigger: { inputTokens: measured.tokens, inputSource: measured.source, boundary: b.boundary, step: b.step },
      frontier: { anchorId: rowKey(history[nextAnchor]), coveredRows: nextAnchor + 1, coveredDigest: coveredRowsDigest(covered) },
      handoff: { text: handoff, excerpt: compacted.digest, estimatedTokens: rowCost(handoff), representation: "host-facts+untrusted-excerpt" },
      model: input.model ?? null, installedAt: at,
    };
    if (store) {
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PAYLOAD_BYTES) receipts.push({ code: "persist_skipped", generation: to, why: "payload_too_large" });
      else {
        let installed = false;
        try { installed = store.install(expected, next); } catch { installed = false; }
        if (!installed) {
          // Another writer moved this conversation's generation since this run read it. Its head is the authority: when
          // its frontier lies in this request's history, continue from it (rebase); otherwise keep this request as it is.
          receipts.push({ code: "generation_conflict", expected, boundary: b.boundary, step: b.step });
          let other: StatelessGenerationHead | null = null;
          try { other = chatId ? store.read(input.runtime, scope, chatId).head : null; } catch { other = null; }
          const at = other ? applicable(other) : null;
          if (other && at && !("why" in at)) {
            adopt(other, at.index);
            receipts.push({ code: "rebased", generation: other.generation, state: other.state, step: b.step });
            const rows = history.slice(at.index + 1);
            return { action: "rotated", digest: other.handoff.text, rows, generation: other.generation,
              historyTokens: rowCost(other.handoff.text) + rows.reduce((sum, row) => sum + rowCost(row.text), 0) };
          }
          return { action: "held", code: "generation_conflict" };
        }
        expected = to;
      }
    } else receipts.push({ code: "persist_skipped", generation: to, why: chatId ? "store_unavailable" : "no_conversation" });
    // The same generation ledger as CLI thread rotations (handoff-facts.ts recordGenerationSwitch, docs 07 G07).
    if (chatId) recordGenerationSwitch({ chatId, runtime: input.runtime, previousSessionId: statelessSessionId(input.runtime, chatId, from),
      reason: "context_ratio", facts, reportedInputTokens: measured.source === "estimated" ? null : measured.tokens, rotatedAt: at });
    generation = to; digest = handoff; excerpt = compacted.digest; anchorIndex = nextAnchor; pendingAck = to;
    receipts.push({ code: "rotated", from, to, boundary: b.boundary, step: b.step, inputTokens: measured.tokens, window: b.window.tokens });
    const rows = history.slice(nextAnchor + 1);
    return { action: "rotated", digest: handoff, rows, generation: to,
      historyTokens: rowCost(handoff) + rows.reduce((sum, row) => sum + rowCost(row.text), 0) };
  };

  const completed = (step: number, observedInputTokens: number | null): void => {
    if (pendingAck === null) return;
    const acked = pendingAck;
    pendingAck = null;
    if (!store) return;
    let ok = false;
    try { ok = store.acknowledge(input.runtime, scope, acked, { step, observedInputTokens }, now()); } catch { ok = false; }
    receipts.push(ok ? { code: "acknowledged", generation: acked, step } : { code: "late_ack_refused", generation: acked, step });
  };

  return {
    get seed() { return seed; },
    boundary,
    completed,
    get receipts() { return receipts; },
    get generation() { return generation; },
  };
}

/** The history slice cost the callers keep for admission: the handoff row plus each verbatim row. */
export function statelessHistoryTokens(digest: string | null, rows: readonly ChatHistoryEntry[]): number {
  return (digest ? rowCost(digest) : 0) + rows.reduce((sum, row) => sum + rowCost(row.text), 0);
}
