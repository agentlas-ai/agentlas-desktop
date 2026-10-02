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
