// 컨텍스트 엔지니어링 1급 객체 — 시스템 에이전트 = 최소 항상-켜진 CORE + 저빈도 ON-DEMAND 모듈.
// 패턴: Instruction-Tool Retrieval (ITR) / Anthropic Tool Search.
// provider-portable: claude(네이티브 defer_loading) / codex / gemini 모두 이 파일 기반 BM25로 균일 동작.
//
// 설계 규칙(연구 근거):
// - CORE에 남길 최소 집합: 정체성/역할 · 안전·정책 규칙 · 매 턴 필요한 출력 계약 · 발견 메커니즘(힌트) · 최빈 도구 3~5.
// - 안전·정체성 규칙은 절대 게이트 뒤로 보내지 않는다(트리거 미스 시 통째로 빠지는 사고 방지) → alwaysOn.
// - 저빈도·비핵심(도메인 절차·장황한 예시·참조 문서)은 ON-DEMAND.

export interface OnDemandModule {
  /** 안정적 식별자 */
  id: string;
  /** 사람이 읽는 짧은 제목 */
  title: string;
  /** 디스커버리 신호 — 이 모듈을 트리거해야 하는 키워드/예시쿼리(영문+한글 혼용 가능) */
  keywords: string[];
  /** 한 줄 설명(디스커버리 매칭에도 사용) */
  description: string;
  /** 선택됐을 때만 호출되는 지연 로더 — 실제 주입 텍스트 반환 */
  load: () => string;
  /** true면 디스커버리 게이트 무시하고 항상 포함(안전·정체성 전용) */
  alwaysOn?: boolean;
}

export interface SystemAgentSpec {
  id: string;
  /** 최소 항상-켜진 코어(정체성·안전·출력계약·발견 힌트) */
  core: string;
  /** 저빈도 온디맨드 모듈 — 요청별로 검색해 선택 */
  modules: OnDemandModule[];
}

export interface SelectionResult {
  selected: OnDemandModule[];
  scores: Array<{ id: string; score: number }>;
  /** alwaysOn으로 강제 포함된 모듈 id */
  forced: string[];
}
