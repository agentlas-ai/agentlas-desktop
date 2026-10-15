export interface ObservedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** A measured subset of input, never added to it. Absent means unknown. */
  cachedInputTokens?: number;
}

/** A total is complete only when every actual provider attempt reported both
 * sides. Output-only counters and missing attempts cannot become spend proof. */
export function createObservedUsageAccumulator(): {
  record(usage: ObservedTokenUsage | null | undefined): void;
  total(): ObservedTokenUsage | undefined;
} {
  let attempts = 0;
  let incomplete = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheIncomplete = false;
  return {
    record(usage): void {
      attempts += 1;
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
        || !Number.isSafeInteger(inputTokens + outputTokens + usage.inputTokens + usage.outputTokens)) {
        incomplete = true;
        return;
      }
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens! < 0
        || usage.cachedInputTokens! > usage.inputTokens) cacheIncomplete = true;
      else cachedInputTokens += usage.cachedInputTokens!;
    },
    total(): ObservedTokenUsage | undefined {
      return attempts > 0 && !incomplete ? { inputTokens, outputTokens,
        ...(!cacheIncomplete ? { cachedInputTokens } : {}) } : undefined;
    },
  };
}

/** One runner can dispatch several native attempts. Missing or conflicting
 * attempt receipts must not be hidden by its last returned usage pair. */
export function createRuntimeUsageCollector(): {
  start(attemptId: string): void;
  recordTerminal(usage: ObservedTokenUsage | null | undefined, attemptId?: string): void;
  total(returnedUsage?: ObservedTokenUsage | null): ObservedTokenUsage | undefined;
} {
  const attempts = new Map<string, ObservedTokenUsage | undefined>();
  const knownCached = new Map<string, number>();
  let uncertain = false;
  let legacySeen = false;
  let legacyUsage: ObservedTokenUsage | undefined;
  const valid = (usage: ObservedTokenUsage): boolean =>
    Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
    && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
    && Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
    && (usage.cachedInputTokens === undefined || (Number.isSafeInteger(usage.cachedInputTokens)
      && usage.cachedInputTokens >= 0 && usage.cachedInputTokens <= usage.inputTokens));
  const merge = (a: ObservedTokenUsage | undefined, b: ObservedTokenUsage): ObservedTokenUsage | undefined => {
    if (!a) return { ...b };
    if (a.inputTokens !== b.inputTokens || a.outputTokens !== b.outputTokens
      || (a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined
        && a.cachedInputTokens !== b.cachedInputTokens)) return undefined;
    return { inputTokens: a.inputTokens, outputTokens: a.outputTokens,
      ...(a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined
        ? { cachedInputTokens: a.cachedInputTokens } : {}) };
  };
  return {
    start(attemptId): void {
      if (typeof attemptId !== "string" || !attemptId.trim() || legacySeen) { uncertain = true; return; }
      if (!attempts.has(attemptId)) attempts.set(attemptId, undefined);
    },
    recordTerminal(usage, attemptId): void {
      if (attemptId !== undefined) {
        if (!attempts.has(attemptId)) { uncertain = true; return; }
      } else {
        if (attempts.size > 0) { uncertain = true; return; }
        legacySeen = true;
      }
      if (usage == null) return;
      if (!valid(usage)) { uncertain = true; return; }
      const cacheKey = attemptId ?? "";
      if (usage.cachedInputTokens !== undefined) {
        if (knownCached.has(cacheKey) && knownCached.get(cacheKey) !== usage.cachedInputTokens) { uncertain = true; return; }
        knownCached.set(cacheKey, usage.cachedInputTokens);
      }
      const combined = merge(attemptId === undefined ? legacyUsage : attempts.get(attemptId), usage);
      if (!combined) { uncertain = true; return; }
      if (attemptId === undefined) legacyUsage = combined;
      else attempts.set(attemptId, combined);
    },
    total(returnedUsage): ObservedTokenUsage | undefined {
      if (uncertain || (returnedUsage != null && !valid(returnedUsage))) return undefined;
      if (attempts.size <= 1) {
        const receipt = attempts.size === 1 ? attempts.values().next().value : legacyUsage;
        const cacheKey = attempts.size === 1 ? attempts.keys().next().value! : "";
        if (returnedUsage?.cachedInputTokens !== undefined && knownCached.has(cacheKey)
          && knownCached.get(cacheKey) !== returnedUsage.cachedInputTokens) return undefined;
        return returnedUsage == null ? receipt && { ...receipt } : merge(receipt, returnedUsage);
      }
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens: number | undefined = 0;
      for (const usage of attempts.values()) {
        if (!usage || !Number.isSafeInteger(inputTokens + outputTokens + usage.inputTokens + usage.outputTokens)) return undefined;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cachedInputTokens = cachedInputTokens !== undefined && usage.cachedInputTokens !== undefined
          ? cachedInputTokens + usage.cachedInputTokens : undefined;
      }
      return { inputTokens, outputTokens, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) };
    },
  };
}

// ── G16: one provider-usage normalizer ───────────────────────────────────────────────────────────────────────
// Providers disagree on what "input" means. Anthropic: input_tokens EXCLUDES cache; total = input + creation + read.
// OpenAI chat / Responses and Ollama: the cached part is a SUBSET of the input. Gemini: promptTokenCount already
// includes cachedContentTokenCount. Everything is mapped to one shape; a field the provider did not report stays
// undefined (never 0), and an impossible report is rejected as a whole with a machine reason.

export type UsageDialect = "anthropic" | "openai-chat" | "openai-responses" | "gemini" | "ollama" | "unknown";
export type UsageRejection = "not_an_object" | "negative" | "not_integer" | "nan" | "cache_exceeds_total" | "missing_input";

export interface NormalizedProviderUsage {
  dialect: UsageDialect;
  /** Logical input: everything the model read, cached or not. */
  totalInput?: number;
  /** Served from cache. A subset of totalInput. */
  cachedRead?: number;
  /** Written to cache this call (Anthropic only). A subset of totalInput. */
  cacheWrite?: number;
  /** Fresh input at full price: totalInput - cachedRead - cacheWrite. Undefined when either side is unknown. */
  uncached?: number;
  output?: number;
  rejected?: UsageRejection;
}

type RawRecord = Record<string, unknown>;
const asRecord = (value: unknown): RawRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : undefined;

/** Reads one counter: absent -> {absent}, invalid -> {bad: reason}, else the value. */
function readCount(value: unknown): { absent: true } | { bad: UsageRejection } | { value: number } {
  if (value === undefined || value === null) return { absent: true };
  if (typeof value !== "number") return { bad: "not_integer" };
  if (Number.isNaN(value)) return { bad: "nan" };
  if (!Number.isFinite(value) || !Number.isInteger(value)) return { bad: "not_integer" };
  if (value < 0) return { bad: "negative" };
  if (!Number.isSafeInteger(value)) return { bad: "not_integer" };
  return { value };
}

export function normalizeProviderUsage(dialect: UsageDialect, raw: unknown): NormalizedProviderUsage {
  const reject = (rejected: UsageRejection): NormalizedProviderUsage => ({ dialect, rejected });
  const u = asRecord(raw);
  if (!u) return reject("not_an_object");
  let inputRaw: unknown; let cacheReadRaw: unknown; let cacheWriteRaw: unknown; let outputRaw: unknown;
  switch (dialect) {
    case "anthropic":
      inputRaw = u.input_tokens; cacheReadRaw = u.cache_read_input_tokens;
      cacheWriteRaw = u.cache_creation_input_tokens; outputRaw = u.output_tokens; break;
    case "openai-chat":
      inputRaw = u.prompt_tokens; cacheReadRaw = asRecord(u.prompt_tokens_details)?.cached_tokens;
      outputRaw = u.completion_tokens; break;
    case "openai-responses":
      inputRaw = u.input_tokens; cacheReadRaw = asRecord(u.input_tokens_details)?.cached_tokens;
      outputRaw = u.output_tokens; break;
    case "gemini":
      // usageMetadata: promptTokenCount includes the cached part; candidatesTokenCount excludes thoughts, so the
      // billed output is candidates + thoughts when thoughts are reported.
      inputRaw = u.promptTokenCount; cacheReadRaw = u.cachedContentTokenCount; outputRaw = u.candidatesTokenCount; break;
    case "ollama":
      inputRaw = u.prompt_eval_count; outputRaw = u.eval_count; break;
    default:
      // Already-logical shape (CLI runtimes, accumulated receipts).
      inputRaw = u.inputTokens; cacheReadRaw = u.cachedInputTokens; cacheWriteRaw = u.cacheCreationInputTokens;
      outputRaw = u.outputTokens;
  }
  const input = readCount(inputRaw); const read = readCount(cacheReadRaw);
  const write = readCount(cacheWriteRaw); let output = readCount(outputRaw);
  if (dialect === "gemini" && "value" in output) {
    const thoughts = readCount(u.thoughtsTokenCount);
    if ("bad" in thoughts) return reject(thoughts.bad);
    if ("value" in thoughts) output = { value: output.value + thoughts.value };
  }
  for (const field of [input, read, write, output]) if ("bad" in field) return reject(field.bad);
  const base = "value" in input ? input.value : undefined;
  const cachedRead = "value" in read ? read.value : undefined;
  const cacheWrite = "value" in write ? write.value : undefined;
  const out = "value" in output ? output.value : undefined;
  if (base === undefined && cachedRead === undefined && cacheWrite === undefined && out === undefined) return reject("missing_input");
  let totalInput: number | undefined;
  let fresh: number | undefined;
  if (dialect === "anthropic") {
    // total = input + creation + read, only when the three parts are all reported (a missing part is not 0).
    if (base !== undefined && cachedRead !== undefined && cacheWrite !== undefined) {
      totalInput = base + cachedRead + cacheWrite; fresh = base;
    } else if (base !== undefined && cachedRead === undefined && cacheWrite === undefined) {
      // Neither cache field reported: the raw input is all we know; do not claim it is the logical total's complement.
      totalInput = undefined; fresh = base;
    }
    if (!Number.isSafeInteger(totalInput ?? 0)) return reject("not_integer");
  } else {
    totalInput = base;
    if (totalInput !== undefined) {
      if ((cachedRead ?? 0) + (cacheWrite ?? 0) > totalInput) return reject("cache_exceeds_total");
      // Cached is a subset of input: fresh is derivable only when the cached side was reported.
      if (cachedRead !== undefined) fresh = totalInput - cachedRead - (cacheWrite ?? 0);
    }
  }
  return {
    dialect, ...(totalInput !== undefined ? { totalInput } : {}), ...(cachedRead !== undefined ? { cachedRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}), ...(fresh !== undefined ? { uncached: fresh } : {}),
    ...(out !== undefined ? { output: out } : {}),
  };
}
