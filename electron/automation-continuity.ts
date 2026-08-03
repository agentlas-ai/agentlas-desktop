// 자동화 실행 프롬프트 앞에 붙는 연속성 캡슐의 단일 정의.
//
// 캡슐은 제품이 이전 결과를 모델에게 이어주려고 만든 **내부 컨텍스트**다. 그런데 자동화
// 실행 프롬프트는 세션 chat에 사용자 턴으로 남기 때문에, 캡슐을 그대로 두면 사용자가
// 자기 대화에서 내부 복구 프롬프트("You are One's private recovery worker…")와 이전 턴
// 덤프를 통째로 읽게 된다. 생산자와 표시 계층이 같은 마커를 공유해야 이 둘이 어긋나지 않는다.

export const AUTOMATION_CONTINUITY_OPEN = "[Agentlas automation continuity capsule]";
export const AUTOMATION_CONTINUITY_CLOSE = "[/Agentlas automation continuity capsule]";

/**
 * 표시용으로 캡슐을 걷어내고 사용자가 실제로 지시한 본문만 남긴다.
 * 캡슐이 없으면 원문 그대로 돌려준다.
 */
export function stripAutomationContinuityCapsule(text: string): string {
  const start = text.indexOf(AUTOMATION_CONTINUITY_OPEN);
  if (start === -1) return text;
  const closeAt = text.indexOf(AUTOMATION_CONTINUITY_CLOSE, start);
  if (closeAt === -1) {
    // 닫는 마커가 유실된 경우: 여는 마커 앞부분만 신뢰한다. 반쪽 캡슐을 보여주지 않는다.
    return text.slice(0, start).trim();
  }
  const before = text.slice(0, start);
  const after = text.slice(closeAt + AUTOMATION_CONTINUITY_CLOSE.length);
  return `${before}${after}`.trim();
}
