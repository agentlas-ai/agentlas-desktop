import { createHash } from "node:crypto";
import { isSafeOneMemoryText, type OneMemoryProposalBasis } from "../../shared/one-memory";

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

function normalizeCandidateText(value: string): string {
  return value
    .replace(/^[\s:：,;–—-]+/, "")
    .replace(/[\s]+/g, " ")
    .replace(/[.!?。]+$/, "")
    .trim();
}

/**
 * This deliberately detects only an explicit user instruction to remember.
 * Ordinary preferences, model inferences, and long transcripts fail quiet.
 */
export function detectExplicitOneMemoryIntent(userPrompt: unknown): ExplicitOneMemoryIntent | null {
  if (typeof userPrompt !== "string" || userPrompt.length < 4 || userPrompt.length > 2_000) return null;
  if (CONTROL_RE.test(userPrompt)) return null;
  const prompt = userPrompt.trim();
  const match = KOREAN_PREFIX_RE.exec(prompt)
    ?? ENGLISH_PREFIX_RE.exec(prompt)
    ?? KOREAN_SUFFIX_RE.exec(prompt);
  if (!match) return null;
  const normalizedPreview = normalizeCandidateText(match[1]);
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
