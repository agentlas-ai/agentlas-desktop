// 시스템 에이전트 = CORE + 모듈. 오너 2026-10-13: 호스트는 단어장(키워드·BM25)으로 무엇을 실을지 정하지 않는다.
// 모듈은 전부 짧아서 시스템 에이전트가 쓰일 때 함께 실린다(assemble.ts). 판단은 모델이 한다.

export interface OnDemandModule {
  /** 안정적 식별자 */
  id: string;
  /** 사람이 읽는 짧은 제목 */
  title: string;
  /** 한 줄 설명 */
  description: string;
  /** 주입 텍스트 */
  load: () => string;
}

export interface SystemAgentSpec {
  id: string;
  /** 최소 항상-켜진 코어(정체성·안전·출력계약·발견 힌트) */
  core: string;
  /** 함께 실리는 모듈 */
  modules: OnDemandModule[];
}

