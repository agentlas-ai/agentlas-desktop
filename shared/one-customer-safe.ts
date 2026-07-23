// One is a single, calm chief-of-staff surface. A person using One must never
// see the machinery underneath it: which CLI or runtime executed, which internal
// studio/agent was borrowed, a run/session id, or a raw result-schema term.
//
// This module is the ONE customer-safe boundary the beta feedback asked for
// ("a single customer-safe renderer in front of every progress, error, result,
// and confirmation surface"). It is a pure string layer with no imports so it
// can run in the renderer, the main process, and the regression test alike.

export type OneSafeLocale = "ko" | "en";

/**
 * Internal execution vocabulary. Anything matching these must be stripped from,
 * or must fully suppress, a customer-visible One string. The list is derived
 * from the concrete leaks captured in the official v2 beta cut
 * (betatester/03-audit/official-v2-cut-feedback.md): `Calling Codex CLI...`,
 * `runtime-session`, `Agentlas Orchestrator`, `Meme Shorts Studio`,
 * `exactly one safe Surface`, `structured result`, and the disabled-workbench copy.
 */
const INTERNAL_TOKEN_PATTERNS: RegExp[] = [
  // "Calling Codex CLI..." / "Calling {backend}..." and the Korean "…CLI 호출 중…"
  /calling\s+[^\n.]*?\bcli\b[.…]*/gi,
  /[^\n.]*?\bcli\b\s*호출\s*(?:중)?[.…]*/g,
  // Bare backend/CLI runtime names.
  /\b(?:codex|claude code|claude|gemini|grok|ollama|kimi|glm)\s+cli\b/gi,
  // Session / run identifiers.
  /\bruntime[-\s]?session\b[:\w-]*/gi,
  /\brun[-\s]?id\b\s*[:=]?\s*[\w-]{6,}/gi,
  // Orchestration internals.
  /\bagentlas\s+orchestrator\b/gi,
  /\bagentlas\s*오케스트레이터\b/g,
  /\bstormbreaker(?:\s+loop)?\b/gi,
  /\bscope[-\s]?lock\b/gi,
  // Result-transport schema terms that must never read as product copy.
  /\bsafe\s+one\s+surface\b/gi,
  /\bone\s+surface\b/gi,
  /(?:exactly\s+)?one\s+safe\s+surface/gi,
  /\bsurface\s+manifest\b/gi,
  /\bstructured\s+result\b/gi,
  /\bworkbench\s+generation\b/gi,
];

/** Full developer-facing sentences that, if seen, are replaced wholesale. */
const INTERNAL_SENTENCE_PATTERNS: RegExp[] = [
  /automatic app\s*\/?\s*workbench generation is disabled[^.\n]*\.?/gi,
  /앱\s*\/?\s*패널 자동 생성은 꺼져 있습니다[^.\n]*\.?/g,
  /the (?:team run completed, but its )?structured result[^.\n]*\.?/gi,
  /구조화(?:된)? 결과[^.\n]*(?:않았습니다|검증되지 않아 표시하지 않았습니다)\.?/g,
];

/** True when a progress status is purely internal and should not be shown at all. */
export function isInternalProgressStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return INTERNAL_TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(status);
  });
}

/**
 * Reduce a raw runtime status into a customer-safe progress hint, or "" when
 * nothing safe survives. One already shows a calm five-stage label, so dropping
 * an internal detail is always safe — it is never the only progress signal.
 */
export function customerSafeProgressDetail(status: string | null | undefined): string {
  if (!status) return "";
  // A status like "Meme Shorts Studio · Calling Codex CLI..." carries an agent
  // name prefix and an internal call. Strip the prefix, then the internal parts.
  const withoutPrefix = status.includes(" · ") ? status.slice(status.lastIndexOf(" · ") + 3) : status;
  if (isInternalProgressStatus(withoutPrefix) || isInternalProgressStatus(status)) return "";
  return withoutPrefix.trim();
}

/**
 * Strip internal execution vocabulary from any customer-visible One text
 * (final answer, system note, error). Whole developer sentences are replaced
 * with a neutral fallback so a leaked schema line never reads as product copy.
 */
export function toCustomerSafeText(
  text: string | null | undefined,
  locale: OneSafeLocale = "en",
): string {
  if (!text) return "";
  let out = text;
  for (const pattern of INTERNAL_SENTENCE_PATTERNS) {
    out = out.replace(pattern, "");
  }
  for (const pattern of INTERNAL_TOKEN_PATTERNS) {
    out = out.replace(pattern, "");
  }
  // A clean customer answer must pass through byte-for-byte: only touch spacing
  // and fall back to neutral copy when we actually removed internal vocabulary.
  if (out === text) return text;
  // Collapse the whitespace / empty bullets a removal can leave behind.
  out = out
    .replace(/^[ \t]*[·\-*]\s*$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (out) return out;
  return locale === "ko"
    ? "이 결과는 여기서 완성되지 않았어요. 지금까지 확인된 내용만 남겨뒀어요."
    : "This result was not completed here. Only what was verified so far is kept.";
}
