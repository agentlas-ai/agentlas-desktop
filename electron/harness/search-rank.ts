/**
 * @agent-mail
 * @browser







 */
export interface RankableHarnessItem {
  id: string; name: string; description: string;
  /** Extra id-like words an entry answers to; used for ranking only and removed from the result. */
  rankTerms?: readonly string[];
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
  if (!hasTerms) return items.slice(0, limit).map(withoutRankTerms);
  return items
    .map((item, index) => ({ item, index, score: harnessRelevance(query, [item.id, item.name, ...(item.rankTerms ?? [])], [item.description]) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => withoutRankTerms(item));
}

function withoutRankTerms<T extends RankableHarnessItem>(item: T): T {
  if (!item.rankTerms) return item;
  const { rankTerms: _rankTerms, ...shown } = item;
  return shown as T;
}
