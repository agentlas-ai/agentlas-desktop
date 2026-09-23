/**
 * "뜻이 같으면 같은 글" — 진전 판별이 쓰는 정규화 한 벌.
 *
 * 목표 정체 판별(goal-ledger goalProgressKeyForText)이 먼저 배웠다: 원문 해시는 모델이 붙이는
 * 번호("7번째 확인") 하나로 매번 새 진전이 됐다(2026-09-14). 자동화 도구 반복 감지도 같은 함정을
 * 밟는다 — browser_find 에 스냅샷 ref 를 e826·e833·e839… 로 바꿔 넣으면 원문으로는 전부 다른
 * 호출이다(Threads 자동화 f7a61706, 2026-09-23 16:00Z). 두 자리가 같은 규칙을 쓰도록 여기 둔다.
 *
 * 순수 함수 — 해시·노드 API 없음(렌더러·계약에서도 그대로 돈다).
 */
export function normalizeProgressText(text: string): string {
  return (text ?? "")
    .replace(/## Memory Events[\s\S]*$/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
}
