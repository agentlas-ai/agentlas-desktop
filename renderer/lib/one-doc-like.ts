// 대화창 안의 "문서형" 발화 판별 — 계획서/PRD/보고서처럼 구조 있는 장문은 말풍선이 아니라
// 렌더된 문서(서브스택 카드)로 보여준다(오너 지시 2026-08-23). 판별은 마크다운 구조 신호로만 한다.
export function isDocumentLikeText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 350) return false;
  const headingCount = (trimmed.match(/^#{1,4}\s+\S/gm) || []).length;
  const boldSectionCount = (trimmed.match(/^\*\*[^*\n]{2,60}\*\*\s*$/gm) || []).length;
  const listCount = (trimmed.match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) || []).length;
  if (headingCount >= 2) return true;
  if (boldSectionCount >= 2 && listCount >= 3) return true;
  return trimmed.length >= 1200 && listCount >= 6;
}
