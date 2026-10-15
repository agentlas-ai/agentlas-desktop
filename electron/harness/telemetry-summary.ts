/*
 * G21: read-only operator telemetry over the model-call ledger (run_events kind model_call_ledger) and native
 * compaction events. No model call, no write, no side effect; it is only shown in a view the owner opens.
 *
 * Rules: unknown stays unknown (null / counted separately), never 0 and never summed as 0. Cache hit ratio uses only
 * attempts where both cachedRead and totalInput are known. Cost uses costOf (model-pricing.ts); attempts without a
 * price/inputs are counted in `cost.unknown`, subscription/local attempts in their own counters.
 */
import { costOf, type ModelPriceEntry } from "../runtime/model-pricing";

// Same strings as model-call-ledger.ts MODEL_CALL_LEDGER_EVENT_KIND / native-compaction-event.ts NATIVE_COMPACTION_EVENT_KIND;
// not imported so this pure aggregation loads without the store (scripts/test-pricing-and-telemetry.cjs asserts they match).
const MODEL_CALL_LEDGER_EVENT_KIND = "model_call_ledger";
const NATIVE_COMPACTION_EVENT_KIND = "native_compaction";

export interface TelemetryRow { kind: string; runId: string; ts: string; payload: Record<string, unknown> }

export interface TelemetrySummary {
  schemaVersion: "agentlas.telemetry-summary.v1";
  scope: { chatId: string | null; since: string | null; until: string | null };
  /** Rows were cut at the read limit: counts are a lower bound. */
  truncated: boolean;
  attempts: number;
  /** Distinct model calls (callRef). */
  calls: number;
  callsByRole: Record<string, number>;
  /** Calls that needed more than one attempt, and the attempts beyond the first. */
  retries: { callsWithRetry: number; extraAttempts: number };
  failed: number;
  usage: { observedAttempts: number; unknownAttempts: number; totalInput: number | null; output: number | null };
  cache: {
    /** cachedRead / totalInput over attempts where both are known; null when none. */
    hitRatio: number | null; measuredAttempts: number; unknownAttempts: number;
  };
  compactions: number;
  /** Not recorded as run events yet. */
  generations: { rotations: null };
  modes: Record<string, number>;
  cost: {
    /** Money by currency from fully priced attempts only. */
    byCurrency: Record<string, number>;
    priced: number;
    /** Attempts that are metered but could not be priced (no price, or a missing token class). Never counted as 0. */
    unknown: number;
    unknownReasons: Record<string, number>;
    subscription: number;
    local: number;
    revisions: string[];
  };
}

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

export function summarizeTelemetry(rows: readonly TelemetryRow[], table: readonly ModelPriceEntry[],
  scope: { chatId?: string | null; since?: string | null; until?: string | null } = {}, truncated = false): TelemetrySummary {
  const callRefs = new Map<string, { role: string; attempts: number }>();
  const out: TelemetrySummary = {
    schemaVersion: "agentlas.telemetry-summary.v1",
    scope: { chatId: scope.chatId ?? null, since: scope.since ?? null, until: scope.until ?? null },
    truncated, attempts: 0, calls: 0, callsByRole: {}, retries: { callsWithRetry: 0, extraAttempts: 0 }, failed: 0,
    usage: { observedAttempts: 0, unknownAttempts: 0, totalInput: null, output: null },
    cache: { hitRatio: null, measuredAttempts: 0, unknownAttempts: 0 },
    compactions: 0, generations: { rotations: null }, modes: {},
    cost: { byCurrency: {}, priced: 0, unknown: 0, unknownReasons: {}, subscription: 0, local: 0, revisions: [] },
  };
  let cachedSum = 0; let cacheInputSum = 0; let inputSum = 0; let inputKnown = 0; let outputSum = 0; let outputKnown = 0;
  const revisions = new Set<string>();
  for (const row of rows) {
    if (row.kind === NATIVE_COMPACTION_EVENT_KIND) { out.compactions += 1; continue; }
    if (row.kind !== MODEL_CALL_LEDGER_EVENT_KIND) continue;
    const p = row.payload;
    out.attempts += 1;
    const ref = typeof p.callRef === "string" && p.callRef ? p.callRef : `${row.runId}:${out.attempts}`;
    const role = typeof p.role === "string" ? p.role : "unscoped";
    const entry = callRefs.get(ref) ?? { role, attempts: 0 };
    entry.attempts += 1; callRefs.set(ref, entry);
    if (p.status === "failed") out.failed += 1;
    const mode = typeof p.mode === "string" ? p.mode : "unknown";
    out.modes[mode] = (out.modes[mode] ?? 0) + 1;
    // usage
    const total = count(p.usageTotalInput) ?? (p.usageStatus === "observed" && !p.usageRejected ? count(p.observedInput) : undefined);
    const output = count(p.usageOutput) ?? (p.usageStatus === "observed" ? count(p.observedOutput) : undefined);
    if (p.usageStatus === "observed" && !p.usageRejected) out.usage.observedAttempts += 1; else out.usage.unknownAttempts += 1;
    if (total !== undefined) { inputSum += total; inputKnown += 1; }
    if (output !== undefined) { outputSum += output; outputKnown += 1; }
    const read = count(p.usageCachedRead);
    if (read !== undefined && count(p.usageTotalInput) !== undefined) { cachedSum += read; cacheInputSum += count(p.usageTotalInput)!; out.cache.measuredAttempts += 1; }
    else out.cache.unknownAttempts += 1;
    // cost
    const cost = costOf(p, table, row.ts);
    if (cost.kind === "money") {
      out.cost.priced += 1; out.cost.byCurrency[cost.currency] = (out.cost.byCurrency[cost.currency] ?? 0) + cost.amount; revisions.add(cost.priceRevision);
    } else if (cost.kind === "subscription") out.cost.subscription += 1;
    else if (cost.kind === "local") out.cost.local += 1;
    else { out.cost.unknown += 1; out.cost.unknownReasons[cost.unknown] = (out.cost.unknownReasons[cost.unknown] ?? 0) + 1; }
  }
  for (const entry of callRefs.values()) {
    out.callsByRole[entry.role] = (out.callsByRole[entry.role] ?? 0) + 1;
    if (entry.attempts > 1) { out.retries.callsWithRetry += 1; out.retries.extraAttempts += entry.attempts - 1; }
  }
  out.calls = callRefs.size;
  // Totals are sums over the attempts that reported; null when none reported (the unknown count says how many did not).
  out.usage.totalInput = inputKnown ? inputSum : null;
  out.usage.output = outputKnown ? outputSum : null;
  out.cache.hitRatio = cacheInputSum > 0 ? cachedSum / cacheInputSum : null;
  out.cost.revisions = [...revisions].sort();
  return out;
}

export interface TelemetryQuery { chatId?: string; since?: string; until?: string; limit?: number }

/** Read the ledger rows from the store (indexed by ts / chat) and summarise. */
export async function telemetrySummary(query: TelemetryQuery = {}): Promise<TelemetrySummary> {
  const { getDb } = await import("../store/db");
  const { activePriceTable } = await import("../runtime/model-pricing");
  const limit = Math.max(1, Math.min(50_000, query.limit ?? 20_000));
  const where = ["kind IN (?, ?)"]; const args: unknown[] = [MODEL_CALL_LEDGER_EVENT_KIND, NATIVE_COMPACTION_EVENT_KIND];
  if (query.chatId) { where.push("chat_id = ?"); args.push(query.chatId); }
  if (query.since) { where.push("ts >= ?"); args.push(query.since); }
  if (query.until) { where.push("ts < ?"); args.push(query.until); }
  const raw = getDb().prepare(
    `SELECT kind, run_id AS runId, ts, payload_json AS payloadJson FROM run_events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
  ).all(...args, limit + 1) as Array<{ kind: string; runId: string; ts: string; payloadJson: string }>;
  const truncated = raw.length > limit;
  const rows: TelemetryRow[] = [];
  for (const row of raw.slice(0, limit)) {
    try { rows.push({ kind: row.kind, runId: row.runId, ts: row.ts, payload: JSON.parse(row.payloadJson) as Record<string, unknown> }); } catch { /* skip */ }
  }
  return summarizeTelemetry(rows, activePriceTable(), query, truncated);
}
