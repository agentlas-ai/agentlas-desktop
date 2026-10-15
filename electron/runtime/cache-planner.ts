/*
 * Provider cache planner (docs/2026-10-13-native-harness/13 §4, §6, §7, §9).
 *
 * ONE pure function decides where provider cache hints go; the runners only describe the request as ordered
 * segments and apply the answer. It never reads text for meaning: placement follows each segment's declared
 * layer (S0..S5) and cacheClass, nothing else.
 *
 * Key separation (13 §4): conversation identity, prompt-module digest, cache affinity and process-pool key are four
 * different things. The planner touches only the last two on the wire: the stable-prefix digest (what the provider may
 * reuse) and the affinity scope (which cache the provider should route the request to). It does NOT change request
 * content: it chooses where existing markers land and whether an optional routing field is sent.
 *
 * Render order is the segment order the caller passes (Anthropic: tools -> system -> messages).
 */
import { createHash } from "node:crypto";
import { estimateTextTokens } from "./token-estimate";

export type CacheLayer = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";
/**
 * stable-prefix   byte-identical across turns (tools, system).
 * append-only     grows only at the end; an earlier part stays byte-identical (history, tool results).
 * volatile-tail   changes every turn (framed host context, current owner input) - never cached, always last.
 * provider-owned  the provider/server decides what to cache; the client places nothing (native CLI, serving server).
 */
export type CacheClass = "stable-prefix" | "append-only" | "volatile-tail" | "provider-owned";

export interface CacheSegment {
  /** Caller-defined id; the plan refers to breakpoints by it. */
  id: string;
  layer: CacheLayer;
  cacheClass: CacheClass;
  bytes: number;
  /** Estimated tokens of this segment (estimateTextTokens); absent = unknown. */
  tokensEst?: number;
  /** Content digest. Required on stable-prefix segments for a stable-prefix digest / OpenAI key. */
  digest?: string;
}

export const digestText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Build a segment from its rendered text (bytes, digest and token estimate are derived, never guessed). */
export function segmentOf(id: string, layer: CacheLayer, cacheClass: CacheClass, text: string): CacheSegment {
  return { id, layer, cacheClass, bytes: Buffer.byteLength(text, "utf8"), tokensEst: estimateTextTokens(text), digest: digestText(text) };
}

export type CacheProviderFamily = "anthropic" | "openai-style" | "gemini" | "agentlas-serving" | "local";

export interface CacheCapability {
  family: CacheProviderFamily;
  /** Normalized endpoint host the capability was derived from ("" when none/unparseable). */
  hostname: string;
  /** The client may place explicit cache_control markers (real Anthropic only). */
  explicitBreakpoints: boolean;
  maxBreakpoints: number;
  /** The endpoint accepts `prompt_cache_key` (api.openai.com only; hostname-qualified). */
  promptCacheKey: boolean;
  /** The endpoint accepts `session_id` provider pinning (openrouter.ai). */
  sessionId: boolean;
  /** The provider caches a stable prefix by itself (OpenAI, DeepSeek, Gemini 2.5+, local KV best effort). */
  implicit: boolean;
  /** The server in front of the model places the markers (Agentlas serving). */
  serverOwnsMarkers: boolean;
  /** Smallest prefix the provider caches at all (estimated tokens); 0 = unknown/none. */
  minPrefixTokens: number;
  /** Local runtimes: keep a static prefix; no keep_alive/KV guarantee is implied. */
  localKv: boolean;
}

const hostOf = (baseUrl: string | undefined): string => {
  if (!baseUrl) return "";
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ""; }
};

/** Anthropic prompt-cache minimum by model family (public docs; estimates only, never blocks a request). */
function anthropicMinPrefixTokens(model: string | undefined): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("haiku-4-5") || m.includes("opus-4-5") || m.includes("opus-4-6")) return 4096;
  if (m.includes("haiku")) return 2048;
  return 1024;
}

export type CacheCapabilityInput =
  | { family: "anthropic"; model?: string; baseUrl?: string; /** true = real Anthropic backend; false = Anthropic-compatible third party */ native: boolean }
  | { family: "openai-style"; baseUrl: string; model?: string }
  | { family: "gemini"; model?: string }
  | { family: "agentlas-serving"; model?: string }
  | { family: "local"; model?: string };

/** Capability table. Hostname-qualified: a compatible server never inherits another vendor's fields. */
export function cacheCapabilityFor(input: CacheCapabilityInput): CacheCapability {
  const base: CacheCapability = { family: input.family, hostname: "", explicitBreakpoints: false, maxBreakpoints: 0,
    promptCacheKey: false, sessionId: false, implicit: false, serverOwnsMarkers: false, minPrefixTokens: 0, localKv: false };
  switch (input.family) {
    case "anthropic":
      return { ...base, hostname: hostOf(input.baseUrl), explicitBreakpoints: input.native, maxBreakpoints: input.native ? 4 : 0,
        implicit: !input.native, minPrefixTokens: input.native ? anthropicMinPrefixTokens(input.model) : 0 };
    case "openai-style": {
      const hostname = hostOf(input.baseUrl);
      return { ...base, hostname, implicit: true, promptCacheKey: hostname === "api.openai.com", sessionId: hostname === "openrouter.ai",
        minPrefixTokens: hostname === "api.openai.com" ? 1024 : 0 };
    }
    case "gemini": return { ...base, hostname: "generativelanguage.googleapis.com", implicit: true };
    case "agentlas-serving": return { ...base, serverOwnsMarkers: true };
    case "local": return { ...base, implicit: true, localKv: true };
  }
}

export interface CacheAffinityScope { chatId?: string | null; ownerId?: string | null }

export interface CachePlan {
  family: CacheProviderFamily;
  /** Segments to mark, in render order. Always <= capability.maxBreakpoints and never a volatile-tail segment. */
  anthropicBreakpoints: Array<{ segmentId: string; segmentIndex: number }>;
  /** Digest of the stable-prefix segments only (S0/S1/...), contiguous from the start. Absent = unknown. */
  stablePrefixDigest?: string;
  stablePrefixBytes: number;
  /** Estimated tokens of the stable prefix; absent when any prefix segment lacks an estimate. */
  stablePrefixTokensEst?: number;
  /** Only when the endpoint supports it and a chat scope exists. */
  openaiPromptCacheKey?: string;
  /** OpenRouter provider pin (conversation affinity, independent of the prefix). */
  sessionId?: string;
  /** Why a hint was not applied / a prefix may not be reused. Deterministic tokens, never prose. */
  lossReasons: string[];
  /** Gemini explicit cachedContent for the stable prefix (owner opt-in, gemini-explicit-cache.ts). */
  geminiExplicit?: "created" | "reused";
}

const affinity = (scope: CacheAffinityScope, tag: string, prefix: string): string =>
  createHash("sha256").update(tag).update(scope.chatId ?? "").update("\0").update(scope.ownerId ?? "").update(prefix).digest("hex").slice(0, 32);

/**
 * Stable `prompt_cache_key` and `session_id` kept apart on purpose:
 *  - OpenAI key  = hash(affinity scope): identical across turns and asset updates,
 *    survives prefix updates so unchanged leading segments can still hit.
 *  - OpenRouter session_id = hash(affinity scope) only: it pins a conversation to a provider and must survive
 *    prefix edits. Same value the pre-planner helper produced.
 */
export function planCache(input: {
  capability: CacheCapability;
  segments: readonly CacheSegment[];
  model?: string;
  scope?: CacheAffinityScope;
}): CachePlan {
  const { capability, segments } = input;
  const lossReasons: string[] = [];

  // Stable prefix: leading stable-prefix segments (a volatile or provider-owned segment ends the cacheable region).
  let prefixEnd = 0;
  while (prefixEnd < segments.length && segments[prefixEnd].cacheClass === "stable-prefix") prefixEnd += 1;
  const prefix = segments.slice(0, prefixEnd);
  const stablePrefixBytes = prefix.reduce((sum, s) => sum + s.bytes, 0);
  const stablePrefixTokensEst = prefix.length && prefix.every((s) => typeof s.tokensEst === "number")
    ? prefix.reduce((sum, s) => sum + (s.tokensEst as number), 0) : undefined;
  let stablePrefixDigest: string | undefined;
  if (prefix.length && prefix.every((s) => s.digest)) {
    const h = createHash("sha256");
    for (const s of prefix) h.update(s.id).update("\0").update(s.layer).update("\0").update(s.digest as string).update("\0");
    stablePrefixDigest = h.digest("hex").slice(0, 16);
  } else if (prefix.length) lossReasons.push("stable_prefix_digest_unknown");
  else lossReasons.push("no_stable_prefix");

  // Anthropic: breakpoints at the end of the cacheable region's anchors.
  let anchors: Array<{ segmentId: string; segmentIndex: number; bytes: number }> = [];
  if (capability.explicitBreakpoints) {
    // The cacheable region ends at the first volatile-tail / provider-owned segment: nothing after it is marked.
    let end = segments.findIndex((s) => s.cacheClass === "volatile-tail" || s.cacheClass === "provider-owned");
    if (end < 0) end = segments.length;
    for (let i = 0; i < end; i += 1) {
      const s = segments[i];
      if (s.bytes <= 0) continue;
      // Adjacent stable-prefix segments share one anchor at the end of the run (tools + system -> one marker on system).
      if (s.cacheClass === "stable-prefix" && i + 1 < end && segments[i + 1].cacheClass === "stable-prefix") continue;
      anchors.push({ segmentId: s.id, segmentIndex: i, bytes: s.bytes });
    }
    if (anchors.length > capability.maxBreakpoints) {
      // Keep the segments that cover the most bytes (ties: the later one - a longer prefix); report what was dropped.
      const ranked = anchors.map((a) => a).sort((a, b) => b.bytes - a.bytes || b.segmentIndex - a.segmentIndex);
      const keep = new Set(ranked.slice(0, capability.maxBreakpoints).map((a) => a.segmentIndex));
      for (const a of anchors) if (!keep.has(a.segmentIndex)) lossReasons.push(`slot_overflow:${a.segmentId}`);
      anchors = anchors.filter((a) => keep.has(a.segmentIndex));
    }
    if (segments.some((s) => s.cacheClass === "volatile-tail")) lossReasons.push("volatile_tail_not_cached");
    if (capability.minPrefixTokens && stablePrefixTokensEst !== undefined && stablePrefixTokensEst < capability.minPrefixTokens) {
      lossReasons.push("prefix_below_min_cacheable_tokens_est");
    }
  } else if (capability.family === "anthropic") lossReasons.push("compatible_endpoint_no_explicit_markers");

  let openaiPromptCacheKey: string | undefined;
  let sessionId: string | undefined;
  if (capability.family === "openai-style") {
    const hasScope = Boolean(input.scope?.chatId);
    if (capability.promptCacheKey) {
      if (!hasScope) lossReasons.push("no_affinity_scope");
      else if (!stablePrefixDigest) lossReasons.push("no_prefix_digest_for_cache_key");
      else openaiPromptCacheKey = affinity(input.scope as CacheAffinityScope, "agentlas-cache-affinity-v1\0", "");
    } else if (capability.sessionId) {
      if (!hasScope) lossReasons.push("no_affinity_scope");
      else sessionId = affinity(input.scope as CacheAffinityScope, "agentlas-cache-affinity-v1\0", "");
    } else lossReasons.push("endpoint_no_cache_routing_field");
  }
  if (capability.family === "gemini") lossReasons.push("gemini_implicit_only");
  if (capability.serverOwnsMarkers) lossReasons.push("server_owned_markers");
  if (capability.localKv) lossReasons.push("local_kv_no_guarantee");

  return {
    family: capability.family,
    anthropicBreakpoints: anchors.map(({ segmentId, segmentIndex }) => ({ segmentId, segmentIndex })),
    ...(stablePrefixDigest ? { stablePrefixDigest } : {}),
    stablePrefixBytes,
    ...(stablePrefixTokensEst !== undefined ? { stablePrefixTokensEst } : {}),
    ...(openaiPromptCacheKey ? { openaiPromptCacheKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    lossReasons,
  };
}

/** Wire fields an OpenAI-style request may carry for this plan (empty object = send nothing extra). */
export function planRequestFields(plan: CachePlan): Record<string, string> {
  if (plan.openaiPromptCacheKey) return { prompt_cache_key: plan.openaiPromptCacheKey };
  if (plan.sessionId) return { session_id: plan.sessionId };
  return {};
}

// ── Ledger projection (13 §9) ──────────────────────────────────────────────────────────────────────────────────
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/**
 * Flat ledger fields. Unknown stays absent, never 0. `cacheReadTokens` is the provider-observed cached subset of this
 * call's input; `cacheLossReason` is set only when a planned stable prefix was observably not (fully) read:
 *   prefix_not_read              cached = 0 although a stable prefix was planned. A conversation's first call is
 *                                 legitimately cold; the field reports the observation, not a defect.
 *   prefix_partially_read        0 < cached < half the expected stable-prefix tokens.
 *   prefix_below_min_cacheable   as prefix_not_read but the prefix is under the provider minimum.
 */
export function cacheLedgerFields(plan: CachePlan | null | undefined, observedCachedInput: unknown): Record<string, unknown> {
  if (!plan) return {};
  const out: Record<string, unknown> = { cachePlannedBreakpoints: plan.anthropicBreakpoints.length };
  if (plan.stablePrefixDigest) out.cacheStablePrefixDigest = plan.stablePrefixDigest;
  if (plan.stablePrefixTokensEst !== undefined) out.cacheExpectedPrefixTokens = plan.stablePrefixTokensEst;
  if (plan.lossReasons.length) out.cachePlanNotes = plan.lossReasons.join(",");
  if (plan.geminiExplicit) out.cacheGeminiExplicit = plan.geminiExplicit;
  const cached = count(observedCachedInput);
  if (cached === undefined) return out;
  out.cacheReadTokens = cached;
  const expected = plan.stablePrefixTokensEst;
  if (expected !== undefined && expected > 0 && plan.stablePrefixDigest) {
    if (cached === 0) out.cacheLossReason = plan.lossReasons.includes("prefix_below_min_cacheable_tokens_est")
      ? "prefix_below_min_cacheable" : "prefix_not_read";
    else if (cached < expected / 2) out.cacheLossReason = "prefix_partially_read";
  }
  return out;
}
