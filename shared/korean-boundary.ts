/*
 * Word edges for Korean text in regular expressions.
 *
 * JavaScript's \b is ASCII-only: it sits between a [A-Za-z0-9_] character and anything else. A Hangul syllable is "anything else", so
 * between two Hangul syllables, between a space and a syllable, and between a syllable and the end of the text there is never a \b.
 * `탭\b` matches nothing but "탭" glued to an ASCII letter, and `\b포트` matches "포트" only when an ASCII letter sits right before it.
 *
 * These pieces are regular-expression SOURCE (use them in a RegExp built with the `u` flag), and they judge letters the way a reader
 * does: the edge before a word is "the previous character is not a letter or digit", the edge after it is "the text ends, or a
 * non-letter follows, or a Korean case particle follows and is itself followed by one" ("골을", "탭에서"). Text inside a longer word
 * ("골프", "서탭", "탭하세요") is not an edge. A Korean noun standing alone is START + noun + END.
 *
 * electron/harness/search-rank.ts keeps a private copy of the same two pieces (its gate compiles that file on its own); the Korean
 * word-boundary gate compares the copy with these.
 */

/** Case particles that may follow a noun without making the noun part of a longer word ("탭을", "골에서"). */
export const KOREAN_CASE_PARTICLES = "에서|에게|으로|부터|까지|처럼|에|을|를|이|가|은|는|도|로|의|과|와|만";

/** Lookbehind source: the previous character is not a letter or a digit (a Hangul syllable is a letter). */
export const KOREAN_WORD_START = "(?<![\\p{L}\\p{N}])";

/** Lookahead source: the text ends, a non-letter follows, or a case particle follows and is itself followed by one. */
export const KOREAN_WORD_END = `(?=$|[^\\p{L}\\p{N}]|(?:${KOREAN_CASE_PARTICLES})(?:$|[^\\p{L}\\p{N}]))`;
