// Script-based language signal. This is NOT a wordlist — it counts Unicode script
// ranges, which is language-independent and finite, the one kind of "list" that is
// genuinely correct (format, not meaning). The bug it replaces was everywhere the same:
// `/[가-힣]/.test(x)` treated a SINGLE Korean codepoint as "this is Korean", so one
// Korean brand name in an English sentence flipped the whole reply language — or the
// currency — to Korean. Here Korean must actually dominate before we call it Korean.
//
// Truly ambiguous cases that hinge on meaning ("translate 안녕 to English") are the job
// of the resident judgment service, not of any heuristic; call sites that need that
// nuance should ask the judge. This helper is the fast, deterministic default for the
// hot render/route paths where a synchronous answer is required.

/** Count characters in the main scripts we route on. */
function scriptCounts(text: string): { hangul: number; latin: number; cjk: number } {
  return {
    hangul: (text.match(/[가-힣]/g) ?? []).length,
    latin: (text.match(/[A-Za-z]/g) ?? []).length,
    cjk: (text.match(/[぀-ヿ一-鿿]/g) ?? []).length,
  };
}

/**
 * True when Korean is the dominant script of `text`, not merely present.
 * Dominant = a meaningful amount of Hangul (>= 12, e.g. a paragraph), OR at least a
 * few Hangul syllables that outnumber the Latin letters (e.g. a short Korean prompt).
 * A lone Korean word inside English prose no longer counts.
 */
export function isPrimarilyKorean(text: string | null | undefined, opts: { minHangul?: number } = {}): boolean {
  if (!text) return false;
  const { hangul, latin } = scriptCounts(text);
  if (hangul === 0) return false;
  if (hangul >= 12) return true;
  const minHangul = opts.minHangul ?? 3;
  return hangul >= minHangul && hangul >= latin;
}

/** Preferred reply/UI locale from the dominant script. */
export function preferredLocaleFromText(text: string | null | undefined): "ko" | "en" {
  return isPrimarilyKorean(text) ? "ko" : "en";
}
