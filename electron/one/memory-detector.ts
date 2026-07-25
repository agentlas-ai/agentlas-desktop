import { createHash } from "node:crypto";
import { isSafeOneMemoryText, type OneMemoryProposalBasis } from "../../shared/one-memory";
import { judgeBoolean, peekJudgment } from "../system-agents/judgment";

export interface ExplicitOneMemoryIntent {
  normalizedPreview: string;
  suppressionKey: string;
  basis: Extract<OneMemoryProposalBasis, "explicit_user_statement" | "user_correction">;
}

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LEADING_CORRECTION_RE = /^(?:아니(?:요)?[,.!]?\s*|no[,!.]?\s*)/i;
const KOREAN_PREFIX_RE = /^(?:(?:아니(?:요)?[,.!]?\s*)?)(?:이(?:걸|건|것은)\s*)?(?:꼭\s*)?(?:기억해(?:\s*줘)?|기억해둬|앞으로(?:는)?|다음부터(?:는)?)(?:\s*[:：,–—-]\s*|\s+)([\s\S]+)$/i;
const KOREAN_SUFFIX_RE = /^([\s\S]+?)(?:라는?\s*(?:걸|것을)?\s*)?(?:꼭\s*)?기억해(?:\s*줘)?[.!]?$/i;
const ENGLISH_PREFIX_RE = /^(?:(?:no[,!.]?\s*)?)(?:please\s+)?(?:remember\s+that|from\s+now\s+on|going\s+forward)(?:\s*[:;,–—-]\s*|\s+)([\s\S]+)$/i;

/** Judgment-cache kind shared by the async warm pass and the synchronous peek. */
export const ONE_MEMORY_INTENT_JUDGMENT_KIND = "one-memory-explicit-intent";

const ONE_MEMORY_INTENT_QUESTION =
  "Did the user EXPLICITLY instruct the assistant to remember something for the future (a durable preference, rule, or fact), in any language or phrasing?";

const ONE_MEMORY_INTENT_GUIDANCE =
  "Answer yes ONLY for an explicit instruction to remember/keep in mind going forward. " +
  "An ordinary preference statement, a one-off request, or a question is NOT an instruction to remember. " +
  "The instruction may be phrased in any language, without any of the reference words.";

function memoryIntentJudgmentInput(prompt: string): string {
  return prompt.trim().slice(0, 2_000);
}

function normalizeCandidateText(value: string): string {
  return value
    .replace(/^[\s:：,;–—-]+/, "")
    .replace(/[\s]+/g, " ")
    .replace(/[.!?。]+$/, "")
    .trim();
}

function intentFromPreview(prompt: string, preview: string): ExplicitOneMemoryIntent | null {
  const normalizedPreview = normalizeCandidateText(preview);
  if (!isSafeOneMemoryText(normalizedPreview)) return null;
  const basis = LEADING_CORRECTION_RE.test(prompt)
    ? "user_correction" as const
    : "explicit_user_statement" as const;
  const digest = createHash("sha256").update(normalizedPreview.toLocaleLowerCase()).digest("hex").slice(0, 32);
  return {
    normalizedPreview,
    suppressionKey: `memory-key:${digest}`,
    basis,
  };
}

/**
 * This deliberately detects only an explicit user instruction to remember.
 * Ordinary preferences, model inferences, and long transcripts fail quiet.
 *
 * The connected model is the SOLE decider: `judged` is a synchronous reader
 * (electron passes the peek warmed by `prejudgeOneMemoryIntent`). It fires ONLY
 * on a judged "yes" — a judged "no" or NO verdict (no model / cache miss) never
 * creates a memory proposal from the wordlists. Not creating a proposal is the
 * safe non-acting default when no model is connected; the prefix/suffix
 * wordlists survive only as the judge's hint and as preview extraction once the
 * model has said yes. The safety line stays deterministic: every preview must
 * pass isSafeOneMemoryText.
 */
export function detectExplicitOneMemoryIntent(
  userPrompt: unknown,
  judged: (prompt: string) => boolean | null = judgedOneMemoryIntent,
): ExplicitOneMemoryIntent | null {
  if (typeof userPrompt !== "string" || userPrompt.length < 4 || userPrompt.length > 2_000) return null;
  if (CONTROL_RE.test(userPrompt)) return null;
  const prompt = userPrompt.trim();
  // Only the connected model decides intent. A missing verdict (no model / not
  // warmed) is treated as "no explicit remember instruction", never a keyword
  // decision.
  if (judged?.(prompt) !== true) return null;
  // The model recognized an explicit remember instruction. Use the wordlist
  // match (if any) only to extract the durable preview; otherwise the whole
  // normalized prompt is the preview. The closed-form safety check still
  // decides whether it may be stored.
  const match = KOREAN_PREFIX_RE.exec(prompt)
    ?? ENGLISH_PREFIX_RE.exec(prompt)
    ?? KOREAN_SUFFIX_RE.exec(prompt);
  return intentFromPreview(prompt, match ? match[1] : prompt);
}

/** Synchronous read of an already-judged explicit-memory verdict. */
export function judgedOneMemoryIntent(prompt: string): boolean | null {
  const verdict = peekJudgment<"yes" | "no">(
    ONE_MEMORY_INTENT_JUDGMENT_KIND,
    memoryIntentJudgmentInput(prompt),
  );
  return verdict && verdict.source === "llm" ? verdict.verdict === "yes" : null;
}

/** Warm the judgment cache before the synchronous invocation start path peeks it. */
export async function prejudgeOneMemoryIntent(
  request: { oneMode?: boolean; userPrompt?: string },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (request.oneMode !== true) return;
  const prompt = typeof request.userPrompt === "string" ? request.userPrompt.trim() : "";
  if (prompt.length < 4 || prompt.length > 2_000 || CONTROL_RE.test(prompt)) return;
  const lexical = Boolean(
    KOREAN_PREFIX_RE.exec(prompt) ?? ENGLISH_PREFIX_RE.exec(prompt) ?? KOREAN_SUFFIX_RE.exec(prompt),
  );
  try {
    await judgeBoolean({
      kind: ONE_MEMORY_INTENT_JUDGMENT_KIND,
      question: ONE_MEMORY_INTENT_QUESTION,
      input: memoryIntentJudgmentInput(prompt),
      guidance:
        `A deterministic pre-pass ${lexical ? "matched" : "did not match"} the remember-instruction wordlists. ` +
        "Treat that as a prior, not a fact. " + ONE_MEMORY_INTENT_GUIDANCE,
      hints: "words that may hint an explicit remember instruction: 기억해, 기억해줘, 앞으로는, 다음부터는, remember that, from now on, going forward",
      fallback: lexical,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  } catch {
    // Best-effort warm; the sync site keeps the deterministic fallback.
  }
}
