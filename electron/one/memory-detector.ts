import type { OneMemoryProposalBasis } from "../../shared/one-memory";
import type { RuntimeSelection } from "../../shared/types";

export interface ExplicitOneMemoryIntent {
  normalizedPreview: string;
  suppressionKey: string;
  basis: Extract<OneMemoryProposalBasis, "explicit_user_statement" | "user_correction">;
}

/** Retained for older Main, mobile and Telegram callers. No cache is consulted. */
export const ONE_MEMORY_INTENT_JUDGMENT_KIND = "one-memory-explicit-intent";
export type JudgedOneMemoryIntent = boolean | "correction" | null;

/**
 * Automatic memory is admitted from completed-turn tickets by the common
 * curator. Input admission must not wait for a separate remember-intent model
 * or create a Task-acceptance/Save gate. These compatibility exports are inert
 * until older callers are removed; ordinary Task intent has its own owner.
 */
export function detectExplicitOneMemoryIntent(
  _userPrompt: unknown,
  _judged: (prompt: string) => JudgedOneMemoryIntent = judgedOneMemoryIntent,
): ExplicitOneMemoryIntent | null {
  return null;
}

export function judgedOneMemoryIntent(_prompt: string, _runtimeSelection?: RuntimeSelection): JudgedOneMemoryIntent {
  return null;
}

export async function prejudgeOneMemoryIntent(
  _request: { oneMode?: boolean; userPrompt?: string; runtimeSelection?: RuntimeSelection },
  _opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  return;
}
