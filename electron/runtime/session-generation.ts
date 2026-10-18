// When a runtime's native session gives way to a new generation — one rule for every runtime.
//
// Owner decision 2026-10-13: rotate (and compact) at 80% of the model's OWN context window, for 1M-token models too; no
// fixed absolute thresholds (the former 120K input / 60 turns / 40M cumulative / 150K compaction), no rule on Goal or
// strategy changes, no model proposal (nothing added to any prompt), and the host does it in the background with nothing
// on screen. The previous rule lived only in codex.ts and was guarded by `!runtimeSessionId`, which every persistent
// agent-context conversation sets, so it never ran on exactly the long room threads (production: 0 rotations while threads
// carried 185M / 109M / 89.6M cumulative input).
//
// Mechanism: after a completed turn the agent-context layer feeds the size of the turn's LAST model request (the context
// the next request starts from) and the model's window here; on "new_generation" it bumps the binding's generation
// (store.invalidateProvider), so the next turn opens a fresh native session seeded from the Agentlas journal replay.
import { resolveEffectiveContextWindow } from "../../shared/models";

export const GENERATION_CONTEXT_RATIO = 0.8;

/*
 * Hysteresis between generations. A new native session starts from replayed host history, and a fresh provider session has
 * no prompt cache: a seed that sat near the 80% point would make the new generation's first turns rotate again, each time
 * resending a large uncached prefix. Once the claude-code window became known (1M), the CLI seed bound reached it: 80% of
 * W minus the reserve (767,232 tokens) handed to compactHistory, whose 60% share let 460,339 tokens of raw history in (the
 * session checkpoint rarely summarizes: its compactor refuses inputs over 96 KB, and production holds 2,375 verbatim
 * checkpoints against 4 semantic ones, so the seed is the journal itself). A fresh CLI seed now admits at most half the
 * rotation point (continuity.ts): about 22% of W after compactHistory's share, beside the API and local loops, which fold
 * a new generation's history to W x (1 - GENERATION_CONTEXT_RATIO) (stateless-generation.ts).
 */
export const GENERATION_SEED_RATIO = GENERATION_CONTEXT_RATIO / 2;

export interface GenerationInput {
  kind: string;
  /** The model's own context window in tokens; null when the runtime does not know it. */
  contextWindowTokens: number | null;
  /** Input tokens of the turn's last model request (cached included); null when the runtime did not report it. */
  lastInputTokens: number | null;
  /** A failure the runtime reported that a new generation cures. */
  symptom?: "resume_failed" | "context_overflow";
}

export type GenerationDecision =
  | { action: "continue" }
  | { action: "new_generation"; reason: "context_ratio" | "resume_failed" | "context_overflow" };

export function decideGeneration(input: GenerationInput): GenerationDecision {
  if (input.symptom) return { action: "new_generation", reason: input.symptom };
  const window = input.contextWindowTokens, last = input.lastInputTokens;
  if (!window || !Number.isFinite(window) || window <= 0 || last === null || !Number.isFinite(last) || last <= 0) return { action: "continue" };
  return last >= window * GENERATION_CONTEXT_RATIO ? { action: "new_generation", reason: "context_ratio" } : { action: "continue" };
}

/** The model catalog is keyed by provider; a subscription runtime names the provider its models come from. */
const RUNTIME_PROVIDER: Readonly<Record<string, string>> = {
  "claude-code": "anthropic", codex: "openai", antigravity: "google", grok: "xai", kimi: "kimi", cursor: "cursor",
};

/**
 * Windows a runtime itself reported for a model the product's table does not know (Codex app-server
 * `thread/tokenUsage/updated` → tokenUsage.modelContextWindow, codex 0.162.1 schema; Claude Code stream-json
 * `result.modelUsage[<model>].contextWindow`, SDK ModelUsage, CLI 2.1.x). Kept in memory and in the meta store, so a
 * restart keeps the observed number. Never a guess: only a positive integer the runtime sent. `evidence` names the field
 * it came from, kept beside the number in the meta store.
 *
 * Claude Code takes only the aliases opus|sonnet|haiku|fable, which no catalog row matches: before this, the 80% rotation
 * of every claude-code conversation ran on an unknown window and never fired (production 2026-10-17: native autocompact at
 * 967,014 and 968,073 tokens of a 1M window, windowProvenance "unknown"; 100/100 bindings still generation 1).
 */
const observedWindows = new Map<string, number>();
const observedKey = (kind: string, model: string): string => `runtime-observed-window:${kind}:${model}`;
type MetaApi = { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
function meta(): MetaApi | null { try { return require("../store/meta") as MetaApi; } catch { return null; } }

export function recordObservedContextWindow(kind: string, model: string | null | undefined, tokens: unknown, evidence?: string): boolean {
  if (!model || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0) return false;
  const key = observedKey(kind, model);
  if (observedWindows.get(key) === tokens) return true;
  observedWindows.set(key, tokens);
  try { meta()?.setMeta(key, JSON.stringify({ tokens, observedAt: new Date().toISOString(), ...(evidence ? { evidence } : {}) })); }
  catch { /* this process keeps it */ }
  return true;
}

export function observedContextWindow(kind: string, model: string | null | undefined): number | null {
  if (!model) return null;
  const key = observedKey(kind, model);
  const cached = observedWindows.get(key);
  if (cached) return cached;
  try {
    const raw = meta()?.getMeta(key);
    const tokens = raw ? (JSON.parse(raw) as { tokens?: unknown }).tokens : null;
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0) { observedWindows.set(key, tokens); return tokens; }
  } catch { /* unknown */ }
  return null;
}

/**
 * The model's own window and where it came from. What the runtime itself reported for this model wins (it is the window
 * that actually admits the requests: a catalog may list 1M where the account's model runs 32768); the product's table
 * (built-in, then catalog) is the fallback for a model the runtime has not reported yet.
 */
export function runtimeContextWindowProvenance(kind: string, model: string | null | undefined): { tokens: number; source: "catalog" | "observed" } | null {
  const observed = observedContextWindow(kind, model);
  if (observed) return { tokens: observed, source: "observed" };
  for (const backend of [kind, RUNTIME_PROVIDER[kind]].filter((value): value is string => Boolean(value))) {
    try {
      const window = resolveEffectiveContextWindow(backend, model, false).contextWindow;
      if (window) return { tokens: window, source: "catalog" };
    } catch { /* next candidate */ }
  }
  return null;
}

/** The model's own window as the product knows it (the runtime's own report, then the table); null when unknown. */
export function runtimeContextWindow(kind: string, model: string | null | undefined): number | null {
  return runtimeContextWindowProvenance(kind, model)?.tokens ?? null;
}

/** A native compaction threshold at the same 80% of the model's window; undefined leaves the runtime's default. */
export function compactionTokenLimit(kind: string, model: string | null | undefined): number | undefined {
  const window = runtimeContextWindow(kind, model);
  return window ? Math.floor(window * GENERATION_CONTEXT_RATIO) : undefined;
}

/**
 * The native compaction limit handed to the runtime: 80% of the model's window for every caller, the Science controller
 * included (native-harness notyet NH14). The runtime's reported window wins over the table. With the window unknown (never
 * reported by the runtime and not in the table) nothing is handed over and the runtime's own compaction, which knows its
 * model, stays in charge; a fixed number would be wrong for any model whose real window is smaller. The first `thread/tokenUsage/updated` that reports the window records it
 * (recordObservedContextWindow), and the next spawn derives 80% from that observed number.
 */
export function nativeCompactionLimit(kind: string, model: string | null | undefined): number | undefined {
  return compactionTokenLimit(kind, model);
}
