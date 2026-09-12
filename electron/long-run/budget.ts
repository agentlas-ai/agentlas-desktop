import { createHash } from "node:crypto";
import { getDb } from "../store/db";

export interface LongRunUsageInput {
  /** Host identity for one actual provider result, reused by every consumer. */
  sourceId: string;
  invocationRunId: string;
  scopeAnchorId?: string;
  attemptId?: string;
  observedUsage?: { inputTokens: number; outputTokens: number } | null;
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
  tokens: { inputTokens: number; outputTokens: number } | null;
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
    ? { inputTokens: input.observedUsage.inputTokens, outputTokens: input.observedUsage.outputTokens } : null;
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

export function readLongRunCostAccounting(runId: string, cycleCount: number): LongRunCostAccounting {
  const rows = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.usage_recorded'")
    .all(runId) as { payload_json: string }[];
  let knownSubtotalUsd = 0;
  let receiptCount = 0;
  const cycles = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(payload_json, '$.usage.schemaVersion') = 'agentlas.long-run-usage.v1' THEN 0 ELSE 1 END) AS legacy FROM long_run_events WHERE run_id = ? AND kind = 'run.cycle_recorded'")
    .get(runId) as { total: number; legacy: number | null };
  let unknownCount = Math.max(0, cycleCount - cycles.total) + (cycles.legacy ?? 0);
  for (const row of rows) {
    const receipt = JSON.parse(row.payload_json).usage as LongRunUsageReceipt | undefined;
    if (receipt?.schemaVersion === "agentlas.long-run-usage.v1") receiptCount += 1;
    if (receipt?.cost?.status === "measured" && Number.isFinite(receipt.cost.usd) && receipt.cost.usd! >= 0 && receipt.cost.sourceRef) {
      knownSubtotalUsd += receipt.cost.usd!;
    } else unknownCount += 1;
  }
  const pending = getDb().prepare("SELECT COUNT(*) AS n FROM long_run_events starts WHERE starts.run_id=? AND starts.kind='run.usage_started' AND NOT EXISTS (SELECT 1 FROM long_run_events ends WHERE ends.run_id=starts.run_id AND ends.kind='run.usage_recorded' AND json_extract(ends.payload_json,'$.usage.sourceId')=json_extract(starts.payload_json,'$.sourceId'))")
    .get(runId) as { n: number };
  unknownCount += pending.n;
  return { status: unknownCount ? "unknown" : "measured", knownSubtotalUsd, receiptCount, unknownCount };
}

export function longRunMonetaryRefusal(run: {
  budget: { maxCostUsd: number | null };
  costUsedUsd: number;
  costAccounting?: LongRunCostAccounting;
  cycleCount: number;
}): "budget_cost_unavailable" | "budget_cost_exhausted" | null {
  if (run.budget.maxCostUsd == null) return null;
  if (run.costUsedUsd >= run.budget.maxCostUsd) return "budget_cost_exhausted";
  if (run.costAccounting?.status === "unknown" || (!run.costAccounting && run.cycleCount > 0)) return "budget_cost_unavailable";
  return null;
}
