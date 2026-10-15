/*
 * G18: money cost of one model-call ledger attempt, from an OWNER-SUPPLIED price table.
 *
 * Rules:
 *  - The built-in table is EMPTY. This code never invents a price; a price exists only because the owner entered it,
 *    with the source they took it from, a currency, an effective date and a revision.
 *  - costOf() prices an attempt only when a price for that provider/model is in force AND every token class the call
 *    used (uncached input, cache read, cache write, output) is both observed and priced. Otherwise it returns
 *    {unknown: reason}. A partial sum is never returned and unknown is never 0.
 *  - Subscription CLIs are never priced per token ("subscription"; the quota proxy is a separate measurement).
 *    Local models cost no money ("local"; host time is a separate proxy). Neither is a price of 0 in a sum.
 * Pure functions take the table as an argument; the store (meta key) is loaded lazily so the daemon can import this.
 */

export const MODEL_PRICE_SCHEMA = "agentlas.model-price.v1";
export const MODEL_PRICE_META_KEY = "model_pricing.v1";

export interface ModelPriceEntry {
  provider: string;
  /** Exact model id, or a prefix when `prefix` is true. */
  model: string;
  prefix?: boolean;
  currency: string;
  /** ISO date (YYYY-MM-DD or full ISO). The entry applies to calls at or after this instant. */
  effectiveFrom: string;
  revision: string;
  /** Where the owner read the price (URL or note). Required: a price without a source is not accepted. */
  source: string;
  inputPerM: number;
  cachedReadPerM?: number;
  cacheWritePerM?: number;
  outputPerM: number;
}

/** Built-in table: intentionally empty. */
export const BUILT_IN_PRICES: readonly ModelPriceEntry[] = [];

export type RuntimeCostClass = "subscription" | "local" | "metered";

const SUBSCRIPTION_KINDS = new Set(["claude-code", "codex", "antigravity", "kimi", "grok", "cursor", "acp", "github-copilot-cli"]);
const LOCAL_KINDS = new Set(["ollama", "lmstudio", "mlx", "agentlas-local"]);

export function runtimeCostClass(runtimeKind: string | undefined): RuntimeCostClass {
  if (runtimeKind && SUBSCRIPTION_KINDS.has(runtimeKind)) return "subscription";
  if (runtimeKind && LOCAL_KINDS.has(runtimeKind)) return "local";
  return "metered";
}

export type CostResult =
  | { kind: "money"; amount: number; currency: string; priceRevision: string }
  | { kind: "subscription" }
  | { kind: "local" }
  | { kind: "unknown"; unknown: string };

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const rate = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The entry in force for provider+model at `ts`: exact beats prefix (longest prefix first), then newest effectiveFrom. */
export function findPrice(table: readonly ModelPriceEntry[], provider: string, model: string, ts?: string): ModelPriceEntry | undefined {
  const at = ts ? Date.parse(ts) : Date.now();
  const candidates = table.filter((e) => e.provider === provider
    && (e.prefix ? model.startsWith(e.model) : e.model === model)
    && (Number.isNaN(at) || Date.parse(e.effectiveFrom) <= at));
  candidates.sort((a, b) => Number(!!a.prefix) - Number(!!b.prefix)
    || (b.model.length - a.model.length)
    || Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
  return candidates[0];
}

/** Price one ledger payload (the run_events payload of a model_call_ledger attempt). */
export function costOf(payload: Record<string, unknown>, table: readonly ModelPriceEntry[], ts?: string): CostResult {
  const kind = text(payload.runtimeKind);
  const cls = runtimeCostClass(kind);
  if (cls === "subscription") return { kind: "subscription" };
  if (cls === "local") return { kind: "local" };
  const provider = text(payload.runtimeBackend) || kind;
  const model = text(payload.reportedModel) || text(payload.model);
  if (!provider || !model) return { kind: "unknown", unknown: "model_unidentified" };
  const price = findPrice(table, provider, model, ts);
  if (!price) return { kind: "unknown", unknown: "no_price" };
  if (payload.usageStatus !== "observed") return { kind: "unknown", unknown: "usage_not_observed" };
  if (payload.usageRejected) return { kind: "unknown", unknown: "usage_rejected" };
  const total = count(payload.usageTotalInput); const uncached = count(payload.usageUncached); const output = count(payload.usageOutput);
  if (total === undefined || uncached === undefined) return { kind: "unknown", unknown: "input_split_unknown" };
  if (output === undefined) return { kind: "unknown", unknown: "output_unknown" };
  const read = count(payload.usageCachedRead); const write = count(payload.usageCacheWrite);
  // A cache class that was not reported is zero only when the parts already add up without it.
  if (total - uncached - (read ?? 0) - (write ?? 0) !== 0) return { kind: "unknown", unknown: "cache_split_unknown" };
  const rates = rate(price.inputPerM) !== undefined && rate(price.outputPerM) !== undefined;
  if (!rates) return { kind: "unknown", unknown: "price_incomplete" };
  let amount = (uncached * price.inputPerM + output * price.outputPerM) / 1e6;
  if ((read ?? 0) > 0) {
    if (rate(price.cachedReadPerM) === undefined) return { kind: "unknown", unknown: "cache_read_price_missing" };
    amount += (read! * price.cachedReadPerM!) / 1e6;
  }
  if ((write ?? 0) > 0) {
    if (rate(price.cacheWritePerM) === undefined) return { kind: "unknown", unknown: "cache_write_price_missing" };
    amount += (write! * price.cacheWritePerM!) / 1e6;
  }
  return { kind: "money", amount, currency: price.currency, priceRevision: price.revision };
}

// ── owner-supplied entries (meta table) ──────────────────────────────────────────────────────────────────────────

export type PriceValidation = { ok: true; entry: ModelPriceEntry } | { ok: false; reason: string };

export function validatePriceEntry(raw: Record<string, unknown>): PriceValidation {
  const provider = text(raw.provider); const model = text(raw.model); const source = text(raw.source);
  const currency = text(raw.currency).toUpperCase();
  if (!provider || !model) return { ok: false, reason: "provider_and_model_required" };
  if (!source) return { ok: false, reason: "source_required" };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: "currency_invalid" };
  const effectiveFrom = text(raw.effectiveFrom);
  if (!effectiveFrom || Number.isNaN(Date.parse(effectiveFrom))) return { ok: false, reason: "effective_from_invalid" };
  const inputPerM = rate(raw.inputPerM); const outputPerM = rate(raw.outputPerM);
  if (inputPerM === undefined || outputPerM === undefined) return { ok: false, reason: "input_and_output_price_required" };
  for (const key of ["cachedReadPerM", "cacheWritePerM"] as const) {
    if (raw[key] !== undefined && raw[key] !== null && rate(raw[key]) === undefined) return { ok: false, reason: `${key}_invalid` };
  }
  const cachedReadPerM = rate(raw.cachedReadPerM); const cacheWritePerM = rate(raw.cacheWritePerM);
  const revision = text(raw.revision) || `${effectiveFrom.slice(0, 10)}#${[inputPerM, cachedReadPerM ?? "-", cacheWritePerM ?? "-", outputPerM].join("/")}`;
  return {
    ok: true,
    entry: {
      provider, model, ...(raw.prefix === true ? { prefix: true } : {}), currency, effectiveFrom, revision, source: source.slice(0, 300),
      inputPerM, ...(cachedReadPerM !== undefined ? { cachedReadPerM } : {}), ...(cacheWritePerM !== undefined ? { cacheWritePerM } : {}), outputPerM,
    },
  };
}

const sameKey = (a: ModelPriceEntry, b: ModelPriceEntry): boolean =>
  a.provider === b.provider && a.model === b.model && !!a.prefix === !!b.prefix && a.effectiveFrom === b.effectiveFrom;

export function readOwnerPrices(): ModelPriceEntry[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMeta } = require("../store/meta") as typeof import("../store/meta");
    const parsed = JSON.parse(getMeta(MODEL_PRICE_META_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => validatePriceEntry(row as Record<string, unknown>)).flatMap((v) => (v.ok ? [v.entry] : []));
  } catch { return []; }
}

/** Built-in table plus the owner's entries. */
export function activePriceTable(): ModelPriceEntry[] { return [...BUILT_IN_PRICES, ...readOwnerPrices()]; }

export function upsertOwnerPrice(entry: ModelPriceEntry): ModelPriceEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setMeta } = require("../store/meta") as typeof import("../store/meta");
  const next = [...readOwnerPrices().filter((e) => !sameKey(e, entry)), entry];
  setMeta(MODEL_PRICE_META_KEY, JSON.stringify(next));
  return next;
}

export function removeOwnerPrice(key: { provider: string; model: string; prefix?: boolean; effectiveFrom: string }): ModelPriceEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setMeta } = require("../store/meta") as typeof import("../store/meta");
  const probe = { ...key, currency: "", revision: "", source: "", inputPerM: 0, outputPerM: 0 } as ModelPriceEntry;
  const next = readOwnerPrices().filter((e) => !sameKey(e, probe));
  setMeta(MODEL_PRICE_META_KEY, JSON.stringify(next));
  return next;
}
