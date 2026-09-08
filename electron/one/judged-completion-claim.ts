// Judged completion-claim detection for One Value Closures. The COMPLETION_CLAIM_RE
// wordlist in shared/one-value-closure under-fires on non-English claims, and it
// gates a trust invariant (a "this was sent/paid/published" fact needs execution or
// outcome evidence). The resident judge decides by meaning; the regex is only the
// fail-closed trust gate when no verdict has been warmed.
//
// The validators are synchronous (store transactions), so the async electron flows
// that own the statements warm the cache here and the sync sites peek.

import { ONE_COMPLETION_CLAIM_JUDGMENT_KIND } from "../../shared/one-value-closure";
import { judgeRequired, peekJudgment, runtimeSelectionCacheScope } from "../system-agents/judgment";

const COMPLETION_CLAIM_QUESTION =
  "Does this statement claim that an external or hard-to-reverse action has ALREADY been performed — something was sent, published, posted, booked, reserved, purchased, paid, delivered, submitted, deployed, or completed?";

const COMPLETION_CLAIM_GUIDANCE =
  "Answer yes only when the statement asserts the action already happened, in any language. " +
  "Plans, drafts, intentions, or descriptions of what WOULD happen are not completion claims. " +
  "Negations ('nothing was sent') are not completion claims.";

const MAX_CLAIM_INPUT = 2_000;

function claimInput(text: string): string {
  return text.slice(0, MAX_CLAIM_INPUT);
}

/** Synchronous read of an already-judged completion-claim verdict. null = not judged. */
export function judgedCompletionClaim(text: string): boolean | null {
  const verdict = peekJudgment<"yes" | "no">(ONE_COMPLETION_CLAIM_JUDGMENT_KIND, claimInput(text));
  return verdict && verdict.source === "llm" ? verdict.verdict === "yes" : null;
}

/** Warm one statement's completion-claim judgment. No model verdict stays unavailable. */
export async function prejudgeCompletionClaim(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!text.trim()) return false;
  const verdict = await judgeRequired<"yes" | "no">({
    kind: ONE_COMPLETION_CLAIM_JUDGMENT_KIND,
    question: COMPLETION_CLAIM_QUESTION,
    labels: ["yes", "no"] as const,
    input: claimInput(text),
    guidance: COMPLETION_CLAIM_GUIDANCE,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  return verdict.verdict === "yes";
}

// Only successful llm verdicts enter the judgment cache, so a failing warm would
// otherwise re-run on every weekly-reflection read. Remember attempted inputs.
const attemptedWarm = new Set<string>();
const ATTEMPTED_MAX = 500;

/** Warm several statements (async pre-pass before a synchronous validation). */
export async function prejudgeCompletionClaims(
  texts: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  for (const text of [...new Set(texts)]) {
    const key = JSON.stringify([runtimeSelectionCacheScope(), claimInput(text)]);
    if (attemptedWarm.has(key)) continue;
    attemptedWarm.add(key);
    if (attemptedWarm.size > ATTEMPTED_MAX) {
      const oldest = attemptedWarm.values().next().value;
      if (oldest !== undefined) attemptedWarm.delete(oldest);
    }
    try {
      await prejudgeCompletionClaim(text, opts);
    } catch {
      // Best-effort warm; trust gates fail closed when no verdict is available.
    }
  }
}
