import { createHash } from "node:crypto";
import { getDb } from "../store/db";

export interface LongRunUsageInput {
  /** Host identity for one actual provider result, reused by every consumer. */
  sourceId: string;
  invocationRunId: string;
  scopeAnchorId?: string;
  attemptId?: string;
  observedUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  costUsd?: number;
  /** Actual billing receipt reference; model names or estimated tokens are not prices. */
  costSourceRef?: string;
}

export interface LongRunUsageReceipt {
  schemaVersion: "agentlas.long-run-usage.v1";
  sourceId: string;
  invocationRunId: string;
  scopeAnchorId?: string;
  attemptId: string | null;
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  cost: { status: "measured" | "unknown"; usd: number | null; sourceRef: string | null; reasonCode: string | null };
  digest: string;
}

export function normalizeLongRunUsage(input: LongRunUsageInput): LongRunUsageReceipt {
  if (!input.sourceId?.trim() || input.sourceId.length > 500 || !input.invocationRunId?.trim()) {
    throw new Error("long_run_usage_identity_required");
  }
  if (input.costUsd !== undefined && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) {
    throw new Error("long_run_usage_cost_invalid");
  }
  const measuredCost = input.costUsd !== undefined && Boolean(input.costSourceRef?.trim());
  const tokens = input.observedUsage
    && Number.isSafeInteger(input.observedUsage.inputTokens) && input.observedUsage.inputTokens >= 0
    && Number.isSafeInteger(input.observedUsage.outputTokens) && input.observedUsage.outputTokens >= 0
    ? { inputTokens: input.observedUsage.inputTokens, outputTokens: input.observedUsage.outputTokens,
      ...(Number.isSafeInteger(input.observedUsage.cachedInputTokens) && input.observedUsage.cachedInputTokens! >= 0
        && input.observedUsage.cachedInputTokens! <= input.observedUsage.inputTokens
        ? { cachedInputTokens: input.observedUsage.cachedInputTokens } : {}) } : null;
  const receipt = {
    schemaVersion: "agentlas.long-run-usage.v1" as const,
    sourceId: input.sourceId,
    invocationRunId: input.invocationRunId,
    ...(input.scopeAnchorId ? { scopeAnchorId: input.scopeAnchorId } : {}),
    attemptId: input.attemptId ?? null,
    tokens,
    cost: { status: measuredCost ? "measured" as const : "unknown" as const,
      usd: measuredCost ? input.costUsd! : null,
      sourceRef: measuredCost ? input.costSourceRef!.trim() : null,
      reasonCode: measuredCost ? null : input.costUsd !== undefined ? "cost_receipt_missing" : "provider_cost_unavailable" },
  };
  return { ...receipt, digest: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") };
}

export interface LongRunCostAccounting {
  status: "measured" | "unknown";
  /** Only amounts supported by explicit billing receipts. Never a total when status is unknown. */
  knownSubtotalUsd: number;
  receiptCount: number;
  unknownCount: number;
}

// rowToLongRun calls this for every long run the screen reads, and the room screen polls
// several of those reads every few seconds. Recomputing from the event log each time parsed
// every usage receipt of a months-long Goal (1.6k receipts, 6.5k events in the Youtube room,
// 2026-10-10) and pinned Main at ~45% CPU. The event log is append-only per run, so its newest
// seq is an exact version for the derived totals.
const COST_ACCOUNTING_CACHE_LIMIT = 256;
const costAccountingCache = new WeakMap<object, Map<string, { version: number; cycleCount: number; value: LongRunCostAccounting }>>();

export function readLongRunCostAccounting(runId: string, cycleCount: number): LongRunCostAccounting {
  const db = getDb();
  const version = (db.prepare("SELECT MAX(seq) AS v FROM long_run_events WHERE run_id = ?").get(runId) as { v: number | null }).v ?? 0;
  let cache = costAccountingCache.get(db);
  if (!cache) { cache = new Map(); costAccountingCache.set(db, cache); }
  const hit = cache.get(runId);
  if (hit && hit.version === version && hit.cycleCount === cycleCount) {
    cache.delete(runId); cache.set(runId, hit);
    return { ...hit.value };
  }
  const value = computeLongRunCostAccounting(runId, cycleCount);
  cache.delete(runId);
  cache.set(runId, { version, cycleCount, value });
  while (cache.size > COST_ACCOUNTING_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return { ...value };
}

function computeLongRunCostAccounting(runId: string, cycleCount: number): LongRunCostAccounting {
  const db = getDb();
  const rows = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.usage_recorded'")
    .all(runId) as { payload_json: string }[];
  let knownSubtotalUsd = 0;
  let receiptCount = 0;
  const cycles = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(payload_json, '$.usage.schemaVersion') = 'agentlas.long-run-usage.v1' THEN 0 ELSE 1 END) AS legacy FROM long_run_events WHERE run_id = ? AND kind = 'run.cycle_recorded'")
    .get(runId) as { total: number; legacy: number | null };
  let unknownCount = Math.max(0, cycleCount - cycles.total) + (cycles.legacy ?? 0);
  const recordedSources = new Set<unknown>();
  for (const row of rows) {
    const receipt = JSON.parse(row.payload_json).usage as LongRunUsageReceipt | undefined;
    if (receipt && receipt.sourceId !== undefined && receipt.sourceId !== null) recordedSources.add(receipt.sourceId);
    if (receipt?.schemaVersion === "agentlas.long-run-usage.v1") receiptCount += 1;
    if (receipt?.cost?.status === "measured" && Number.isFinite(receipt.cost.usd) && receipt.cost.usd! >= 0 && receipt.cost.sourceRef) {
      knownSubtotalUsd += receipt.cost.usd!;
    } else unknownCount += 1;
  }
  // A started usage without a recorded result for the same source stays unknown. Matched in
  // memory: the previous correlated NOT EXISTS re-parsed every recorded receipt per start.
  const starts = db.prepare("SELECT json_extract(payload_json,'$.sourceId') AS sourceId FROM long_run_events WHERE run_id=? AND kind='run.usage_started'")
    .all(runId) as { sourceId: unknown }[];
  for (const start of starts) if (start.sourceId === null || !recordedSources.has(start.sourceId)) unknownCount += 1;
  return { status: unknownCount ? "unknown" : "measured", knownSubtotalUsd, receiptCount, unknownCount };
}

export function longRunMonetaryRefusal(run: {
  budget: { maxCostUsd: number | null };
  costUsedUsd: number;
  costAccounting?: LongRunCostAccounting;
  cycleCount: number;
}): "budget_cost_unavailable" | "budget_cost_exhausted" | null {
  // The user elected continuous Goals. Keep measured/unknown accounting above;
  // reaching an allowance is advisory and does not terminate independent work.
  void run;
  return null;
}
