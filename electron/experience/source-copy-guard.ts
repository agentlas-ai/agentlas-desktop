const WORD_RE = /[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu;

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(WORD_RE)
    ?.filter(Boolean) ?? [];
}

function normalizedText(value: string): string {
  return normalizedWords(value).join(" ");
}

function containsCodeLikeToken(output: string, source: string): boolean {
  const outputTokens = new Set(normalizedWords(output));
  const sourceTokens = source.normalize("NFKC").match(WORD_RE) ?? [];
  return sourceTokens.some((raw) => {
    const normalized = raw.toLowerCase();
    if (!outputTokens.has(normalized)) return false;
    // Short customer codes and release/campaign identifiers carry more
    // re-identification risk than ordinary prose. Keep this structural: the
    // private value is never returned, logged, or persisted by the guard.
    return normalized.length >= 5 && (
      /\p{L}/u.test(normalized) && /\p{N}/u.test(normalized) ||
      /[_-]/.test(normalized) ||
      (/^[A-Z0-9]{5,}$/.test(raw) && /[A-Z]/.test(raw))
    );
  });
}

function containsCapitalizedPrivateLabel(output: string, source: string): boolean {
  const outputText = normalizedText(output);
  if (!outputText) return false;
  const phrases = source.normalize("NFKC").match(
    /\b(?:[A-Z][A-Za-z0-9_-]{2,})(?:\s+[A-Z][A-Za-z0-9_-]{2,}){1,3}\b/g,
  ) ?? [];
  return phrases.some((phrase) => {
    const normalized = normalizedText(phrase);
    return normalized.length >= 8 && outputText.includes(normalized);
  });
}

function containsDistinctPhrase(outputWords: string[], sourceWords: string[]): boolean {
  if (outputWords.length < 2 || sourceWords.length < 2) return false;
  const outputText = ` ${outputWords.join(" ")} `;
  // A two-to-five word verbatim fragment is enough to expose a private client,
  // project, campaign, or visual-system label even when the full Memory is a
  // long sentence. The character floor avoids matching tiny connective prose.
  const maxSize = Math.min(5, sourceWords.length);
  for (let size = maxSize; size >= 2; size -= 1) {
    for (let index = 0; index <= sourceWords.length - size; index += 1) {
      const phrase = sourceWords.slice(index, index + size).join(" ");
      if (phrase.length >= 12 && outputText.includes(` ${phrase} `)) return true;
    }
  }
  return false;
}

/**
 * Local-only private-source leakage guard.
 *
 * It returns one boolean and never returns the matching phrase. Callers may
 * persist the value-free `source-copy-overlap` code, but never the source
 * Memory or a derived excerpt.
 */
export function copiesPrivateSource(output: string, source: string): boolean {
  const sourceWords = normalizedWords(source);
  const outputWords = normalizedWords(output);
  if (sourceWords.length === 0 || outputWords.length === 0) return false;
  const sourceText = sourceWords.join(" ");
  const outputText = outputWords.join(" ");

  if (sourceText.length >= 8 && outputText.includes(sourceText)) return true;
  if (containsCodeLikeToken(output, source)) return true;
  if (containsCapitalizedPrivateLabel(output, source)) return true;
  if (containsDistinctPhrase(outputWords, sourceWords)) return true;

  // Fuzzy overlap only applies to longer material, preserving the existing
  // Operational guard without turning a single generic word into a match.
  if (sourceWords.length < 6 || outputWords.length < 6) return false;
  const sourceSet = new Set(sourceWords);
  const outputSet = new Set(outputWords);
  const overlap = [...sourceSet].filter((word) => outputSet.has(word)).length / sourceSet.size;
  return overlap >= 0.8 && outputWords.length >= sourceWords.length * 0.75;
}
