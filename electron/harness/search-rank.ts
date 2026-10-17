/**
 * Relevance order for harness_search. Dev replay r07 (2026-10-17): Film searched "elevenlabs text to speech native owner
 * connection" and got @agent-mail, @browser, … first. Every kind was listed in a fixed order (plugins, skills, connectors,
 * tools, features, operations), any one matching word was enough, and the list was cut at 60, so the operation that
 * answered (speech.synthesize) never surfaced and the step stopped "no secure ElevenLabs path". r06 was the same for
 * media.listen.
 *
 * A query word found in an entry's id or name counts 3, found in its description counts 1. Words shorter than 3
 * characters ("to", "a") carry no signal and are ignored. Entries are ordered by score, and ties keep their original
 * order. An empty query keeps the original order.
 */
export interface RankableHarnessItem { id: string; name: string; description: string }

export function harnessRelevance(query: string, primary: readonly string[], secondary: readonly string[]): number {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter((term) => term.length >= 3))];
  if (terms.length === 0) return 0;
  const head = primary.join(" ").toLowerCase();
  const body = secondary.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) score += head.includes(term) ? 3 : body.includes(term) ? 1 : 0;
  return score;
}

/** Keep matching entries (score > 0 when the query has words), best first; a stable sort keeps ties in order. */
export function rankHarnessItems<T extends RankableHarnessItem>(query: string, items: ReadonlyArray<T>, limit = 60): T[] {
  const hasTerms = query.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).some((term) => term.length >= 3);
  if (!hasTerms) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, score: harnessRelevance(query, [item.id, item.name], [item.description]) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.item);
}
