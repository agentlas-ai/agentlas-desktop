// 온디맨드 모듈 라우터 — 요청에 필요한 모듈만 고른다 (provider-portable BM25).
// 실패 지점은 게이트(라우터) 신뢰도뿐이라(연구: ITR miss-rate), 두 방향을 다 막는다:
//  - over-trigger 억제: 임계값(threshold) 미만 + 최대 개수 제한.
//  - under-trigger 안전: 안전·정체성(alwaysOn)은 무조건 포함. 아무것도 안 걸리면 코어만(안전한 빈 선택).
import { Bm25, tokenize } from "./bm25";
import type { OnDemandModule, SelectionResult } from "./types";

export interface SelectOptions {
  /** BM25 점수 임계값 — 미만은 선택 안 함(보수적으로 over-trigger 억제) */
  threshold?: number;
  /** 토큰 예산 — 선택 모듈 최대 개수 */
  maxModules?: number;
}

export function selectModules(
  query: string,
  modules: OnDemandModule[],
  opts: SelectOptions = {},
): SelectionResult {
  const threshold = opts.threshold ?? 0.8;
  const maxModules = opts.maxModules ?? 4;

  const forced = modules.filter((m) => m.alwaysOn);
  const gated = modules.filter((m) => !m.alwaysOn);

  const docs = gated.map((m) => ({
    id: m.id,
    // 디스커버리 신호 = 제목 + 키워드 + 설명. 키워드를 한 번 더 실어 가중.
    tokens: tokenize(`${m.title} ${m.keywords.join(" ")} ${m.keywords.join(" ")} ${m.description}`),
  }));
  const bm = new Bm25(docs);
  const ranked = bm.rank(query).filter((r) => r.score >= threshold).slice(0, maxModules);

  const byId = new Map(modules.map((m) => [m.id, m]));
  const selected: OnDemandModule[] = [
    ...forced,
    ...ranked.map((r) => byId.get(r.id)).filter((m): m is OnDemandModule => !!m),
  ];

  return { selected, scores: ranked, forced: forced.map((m) => m.id) };
}
