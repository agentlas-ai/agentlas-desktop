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
export interface RankableHarnessItem {
  id: string; name: string; description: string;
  /** Extra id-like words an entry answers to; used for ranking only and removed from the result. */
  rankTerms?: readonly string[];
  /** Words that say what the entry IS (group, fields, artifact kinds), for meaning recall; removed from the result. Not the
   *  query-derived rankTerms of the app entries: those name what answered this query and would make any query look near. */
  meaningTerms?: readonly string[];
  /** Leads the ranking (the caller knows it answers this query); removed from the result. */
  pinned?: boolean;
}

/** True when the text contains Hangul: a Korean query, as opposed to any text that merely has accents or other non-ASCII letters. */
export function hasHangul(text: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/u.test(text);
}

/*
 * A Korean noun standing alone ("폰", "골"), not the start or end of a longer word ("골프", "폰트", "마이크로폰"). JavaScript's \b
 * is ASCII-only: between two Hangul syllables there is never a boundary, so \b폰\b and 골\b matched nothing. Instead it must not
 * follow a letter or digit, and must be followed by the end, a non-letter, or a case particle that is itself followed by one
 * ("폰에서 보고 싶어", "골을 만들어줘"). No match inside a word, so "골프" and "폰트" stay out.
 */
const KOREAN_CASE_PARTICLES = "에서|에게|으로|부터|까지|처럼|에|을|를|이|가|은|는|도|로|의|과|와|만";
function koreanNounAlone(noun: string): string {
  return `(?<![\\p{L}\\p{N}])${noun}(?=$|[^\\p{L}\\p{N}]|(?:${KOREAN_CASE_PARTICLES})(?:$|[^\\p{L}\\p{N}]))`;
}
const koreanPattern = (source: string): RegExp => new RegExp(source, "u");

/*
 * The app's operation catalog is English. Map Korean feature nouns to the catalog's English terms for app-operation
 * lookup only (capability-ports.ts appOperationPaths). Other ranking keeps the original query.
 */
const KOREAN_APP_TERMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/허브|마켓|마켓플레이스|에이전트\s*(?:검색|찾|추천|목록)/u, "marketplace search agents hub"],
  [/클라우드\s*에이전트|내\s*에이전트/u, "cloudAgents agents"],
  [/자동화|오토메이션/u, "automations"],
  [/실행\s*기록|실행\s*내역|로그|이력|히스토리/u, "runs history ledger"],
  [/일정|예약|스케줄|반복|매일|매주|매월/u, "schedule automations"],
  [/설정|환경\s*설정|옵션/u, "settings config preferences"],
  [/언어|테마|다크\s*모드/u, "language theme settings"],
  [/모델|런타임|api\s*키/u, "runtime model provider"],
  [/로컬\s*모델/u, "localModelHub models"],
  [/대화|채팅|메시지/u, "chats messages"],
  [/프로젝트|작업\s*폴더|폴더/u, "projects folder workspace"],
  [/파일|산출물|결과물/u, "files fs artifacts outputs"],
  [/문서|워드|엑셀|스프레드시트|슬라이드|발표|한글\s*문서/u, "document liveDocument"],
  [/브라우저|웹\s*페이지|웹사이트/u, "browser"],
  [/커넥터|연동|연결/u, "mcpTools connectors"],
  [koreanPattern(`모바일|휴대폰|스마트폰|${koreanNounAlone("폰")}`), "mobileBridge mobile"],
  [/기억|메모리/u, "oneMemory memory"],
  [koreanPattern(`목표|${koreanNounAlone("골")}`), "goalPanel goal"],
  [/텔레그램/u, "telegram"],
  [/메일|이메일|편지/u, "agentMail mail"],
  [/업데이트|새\s*버전/u, "updater"],
  [/금융|재무|파이낸스|주식/u, "finance"],
  [/팀원|팀\s*구성|태스크포스|펌/u, "team firms taskforces"],
  [/구독|결제|요금|플랜/u, "billing usage seats"],
];

/** English catalog words for the Korean feature nouns in a query; "" when there are none (or the query is already English). */
export function englishAppTerms(query: string): string {
  if (!hasHangul(query)) return "";
  const lower = query.toLowerCase();
  return [...new Set(KOREAN_APP_TERMS.filter(([pattern]) => pattern.test(lower)).flatMap(([, english]) => english.split(" ")))].join(" ");
}

/*
 * A query word carries signal at 3 characters, or at 2 when it is Hangul: a two-syllable Korean noun is a whole word
 * ("구조" structure, "화학" chemistry, "주식" stock), where a two-letter Latin token ("to", "3d") is not. Dropping them made
 * every short Korean query rank by nothing (2026-10-28 TOOL-EXPOSURE-3D §2.3: "화학 구조" → 0 results).
 */
function signalTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter((term) => term.length >= 3 || (term.length === 2 && hasHangul(term))))];
}

export function harnessRelevance(query: string, primary: readonly string[], secondary: readonly string[]): number {
  const terms = signalTerms(query);
  if (terms.length === 0) return 0;
  const head = primary.join(" ").toLowerCase();
  const body = secondary.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) score += head.includes(term) ? 3 : body.includes(term) ? 1 : 0;
  return score;
}

/** Keep matching entries (score > 0 when the query has words), best first; a stable sort keeps ties in order. */
export function rankHarnessItems<T extends RankableHarnessItem>(query: string, items: ReadonlyArray<T>, limit = 60): T[] {
  const hasTerms = signalTerms(query).length > 0;
  if (!hasTerms) return items.slice(0, limit).map(withoutRankTerms);
  return items
    .map((item, index) => ({ item, index, score: harnessRelevance(query, [item.id, item.name, ...(item.rankTerms ?? [])], [item.description]) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => withoutRankTerms(item));
}

function withoutRankTerms<T extends RankableHarnessItem>(item: T): T {
  if (!item.rankTerms && !item.meaningTerms && item.pinned === undefined) return item;
  const { rankTerms: _rankTerms, meaningTerms: _meaningTerms, pinned: _pinned, ...shown } = item;
  return shown as T;
}

/** The app's local multilingual embedding (memory/local-embedding.ts), injected so this module stays import-free. */
export interface MeaningEmbedder {
  autoLocalEmbedding(text: string): { vector: number[]; degraded: boolean; modelSha256: string | null };
  cosineSimilarity(left: readonly number[], right: readonly number[]): number;
}

/*
 * Words and meaning, ranked together. A Korean query shares no word with an English tool description ("단백질 구조 3D"
 * against "Create a durable source-bound Mol* artifact ... Molecular Structure Lab"), and a paraphrase ("drug-likeness")
 * shares none with the tool that answers it (TOOL-EXPOSURE-3D §2.3), so the app's local Model2Vec (potion-multilingual, the
 * same embedding memory recall uses) carries meaning.
 *
 * Until word matches always came first and meaning only filled the slots words left. With a catalogue of
 * hundreds of entries a common word ("send", "file") filled every slot, so meaning never ran. Measured on 114 Hub plugins
 * among 9,886 real MCP registry servers with 45 labelled tasks (output/tool-search-at-scale-20261105): word-first found
 * the answer in the top 10 for 24/45 model-written queries; words and meaning fused by reciprocal rank (RRF, k = 60, the
 * same fusion the engine's local agent routing uses: workforce/index.py) found 36/45, at 2.7 ms per query.
 *
 * Rules (each one a broken case from THOUGHT-EXPERIMENTS.md F1):
 * - An entry whose id or name IS the query comes first (an exact name is never outranked by a near meaning).
 * - An entry is a candidate only when a query word reaches it or its meaning clears the floor: a nonsense query returns
 *   nothing rather than the eight nearest of everything.
 * - No verified Model2Vec asset (the hashing fallback is not meaning) = word ranking exactly as before.
 * - No diversity cap: a request about one area ("automation runs") should see that area's entries first.
 * - An empty query keeps the original order (listing).
 */
const MEANING_FLOOR = 0.15;
const MEANING_FLOOR_HANGUL = 0.12;
const RRF_K = 60;
/** Vectors of entry texts; an installed catalogue is a few thousand entries, so the cap only stops a runaway. */
const MEANING_CACHE_MAX = 20_000;
const meaningVectors = new Map<string, Float32Array>();

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let dot = 0, a = 0, b = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) { dot += left[i]! * right[i]!; a += left[i]! * left[i]!; b += right[i]! * right[i]!; }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : 0;
}

function meaningText(item: RankableHarnessItem): string {
  // What an entry IS (its name words, group, fields, artifact kinds) and the first sentence of what it does. A whole
  // description dilutes the meaning with provenance and argument prose: measured on the Science catalogue (
  // 7 Korean/English structure queries) whole descriptions put a structure tool in the top 5 for 5 of 7, this for 7 of 7.
  const words = (value: string) => value.replace(/[_./:-]+/g, " ");
  const first = item.description.split(/(?<=[.!?。])\s/u)[0]!.slice(0, 120);
  return [words(item.name), ...(item.meaningTerms ?? []).map(words), first].join(". ").slice(0, 600);
}

export function rankHarnessItemsByMeaning<T extends RankableHarnessItem>(query: string, items: ReadonlyArray<T>, limit = 60,
  embedder?: MeaningEmbedder | null): T[] {
  const trimmed = query.trim();
  if (!trimmed || items.length === 0) return items.slice(0, limit).map(withoutRankTerms);
  const exact = trimmed.toLowerCase();
  // `pinned`: an entry the caller already knows answers this query (app.call / app.operations when the app catalogue
  // matched it, capability-ports.ts) leads like an exact name; its order among pinned entries is the caller's.
  const isExact = (item: T) => item.pinned === true || item.id.toLowerCase() === exact || item.name.toLowerCase() === exact
    || item.id.toLowerCase().replace(/^[a-z]+:/, "") === exact;
  const word = items.map((item) => harnessRelevance(query, [item.id, item.name, ...(item.rankTerms ?? [])], [item.description]));
  let meaning: number[] | null = null;
  if (embedder) {
    try {
      const q = embedder.autoLocalEmbedding(trimmed.slice(0, 500));
      if (!q.degraded) {
        const qv = Float32Array.from(q.vector);
        meaning = items.map((item) => {
          const text = meaningText(item);
          const key = `${q.modelSha256 ?? ""}\u0000${text}`;
          let vector = meaningVectors.get(key);
          if (!vector) {
            try { vector = Float32Array.from(embedder.autoLocalEmbedding(text).vector); } catch { return 0; }
            meaningVectors.set(key, vector);
            if (meaningVectors.size > MEANING_CACHE_MAX) meaningVectors.delete(meaningVectors.keys().next().value!);
          }
          return cosine(qv, vector);
        });
      }
    } catch { meaning = null; }
  }
  if (!meaning) {
    // No meaning available: word ranking as before, an exact name first.
    const ranked = rankHarnessItems(query, items, items.length);
    const exactHits = items.filter(isExact).map(withoutRankTerms);
    const exactIds = new Set(exactHits.map((item) => item.id));
    return [...exactHits, ...ranked.filter((item) => !exactIds.has(item.id))].slice(0, limit);
  }
  const floor = hasHangul(query) ? MEANING_FLOOR_HANGUL : MEANING_FLOOR;
  const rankBy = (scores: number[], eligible: (index: number) => boolean) => {
    const order = scores.map((score, index) => ({ score, index })).filter(({ index }) => eligible(index))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const rank = new Map<number, number>();
    order.forEach(({ index }, position) => rank.set(index, position + 1));
    return rank;
  };
  const wordRank = rankBy(word, (index) => word[index]! > 0);
  const meaningRank = rankBy(meaning, (index) => meaning![index]! >= floor);
  const scored = items.map((item, index) => ({
    item, index, exact: isExact(item),
    score: (wordRank.has(index) ? 1 / (RRF_K + wordRank.get(index)!) : 0) + (meaningRank.has(index) ? 1 / (RRF_K + meaningRank.get(index)!) : 0),
  })).filter((row) => row.exact || row.score > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((row) => withoutRankTerms(row.item));
}
