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

/** The model's own window as the product knows it (built-in table, then the model catalog); null when unknown. */
export function runtimeContextWindow(kind: string, model: string | null | undefined): number | null {
  for (const backend of [kind, RUNTIME_PROVIDER[kind]].filter((value): value is string => Boolean(value))) {
    try {
      const window = resolveEffectiveContextWindow(backend, model, false).contextWindow;
      if (window) return window;
    } catch { /* next candidate */ }
  }
  return null;
}

/** A native compaction threshold at the same 80% of the model's window; undefined leaves the runtime's default. */
export function compactionTokenLimit(kind: string, model: string | null | undefined): number | undefined {
  const window = runtimeContextWindow(kind, model);
  return window ? Math.floor(window * GENERATION_CONTEXT_RATIO) : undefined;
}
