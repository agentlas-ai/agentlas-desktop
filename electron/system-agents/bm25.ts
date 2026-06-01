// 최소 BM25 랭커 — 의존성 없음, provider-portable.
// 온디맨드 모듈 디스커버리에 사용(싸고 디버깅 쉬운 키워드 검색; 임베딩은 나중에 위에 얹을 수 있음).
// 연구: Anthropic Tool Search가 쓰는 방식 중 하나가 BM25. 함수명·기술용어에 강함.

// 한/영 토큰화: 영숫자 런 + 한글 음절 런. 흔한 불용어 제거.
const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "at", "is", "it",
  "my", "me", "i", "you", "we", "please", "can", "could", "do", "does", "make",
  "build", "create", "want", "need", "with", "this", "that", "help",
  "좀", "그", "이", "저", "을", "를", "은", "는", "이런", "해줘", "하고", "에서",
]);

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+|[가-힣]+/g) ?? [];
  return raw.filter((t) => t.length > 1 && !STOP.has(t));
}

export interface Bm25Doc {
  id: string;
  tokens: string[];
}

/** 작은 코퍼스(시스템 에이전트의 모듈 목록)용 BM25. */
export class Bm25 {
  private readonly docs: Bm25Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(docs: Bm25Doc[]) {
    this.docs = docs;
    let total = 0;
    for (const d of docs) {
      total += d.tokens.length;
      for (const t of new Set(d.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = docs.length ? total / docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // BM25+ 스타일 양수 idf (희귀어 가중, 음수 방지)
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  score(queryTokens: string[], doc: Bm25Doc): number {
    const tf = new Map<string, number>();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = doc.tokens.length || 1;
    let s = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      const denom = f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1));
      s += this.idf(q) * ((f * (this.k1 + 1)) / denom);
    }
    return s;
  }

  rank(query: string): Array<{ id: string; score: number }> {
    const q = tokenize(query);
    return this.docs
      .map((d) => ({ id: d.id, score: this.score(q, d) }))
      .sort((a, b) => b.score - a.score);
  }
}
