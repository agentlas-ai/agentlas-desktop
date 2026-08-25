/**
 * 권한 승격 표식 계약 — 오너 결정 2026-08-25.
 *
 * "읽기 전용이라 실행 불가"는 거절이 아니라 **행동 시점 승인칩으로 승격을 묻는다**.
 * (배경: 2026-08-20 "정적 권한 제한 금지 — 행동 시점 칩 + capability_grants 가 유일한
 * 경계", 2026-08-15 "승인 카드는 경계를 넘을 때·묻는 순간·그 대화 안에서만".)
 *
 * 읽기 전용 실행은 쓰기 도구 자체가 제거되어 있어(claude-code `--disallowed-tools`,
 * 로컬 루프 minPerm 필터) 도구 호출 이벤트가 아예 생기지 않는다. 그래서 "쓰기가
 * 필요해진 순간"을 기계가 읽을 수 있는 유일한 신호는 모델이 **의도적으로 내는 표식**
 * 이다 — 산문을 파싱해 원인을 추정하는 것이 아니라, 읽기 전용 안내문이 계약으로
 * 지시한 고정 문자열 한 줄을 찾는다(런타임 실패를 표식으로 옮긴 것과 같은 원칙).
 *
 * 표식은 사용자에게 보여줄 문장이 아니다 — 감지 즉시 화면·저장 본문에서 제거되고,
 * 그 자리는 승인칩("전체 액세스로 진행할까요?")이 맡는다. 승인 없이는 아무것도
 * 승격되지 않는다: 칩 무응답은 기존 승인 계약대로 5분 뒤 거부로 닫힌다.
 *
 * 이 파일은 아무것도 import 하지 않는다 — electron 과 renderer 가 같은 한 벌을 쓴다.
 */

/** 모델이 내는 고정 표식 — 읽기 전용 안내문이 이 문자열을 그대로 지시한다. */
export const PERMISSION_ESCALATION_MARKER = "[[NEEDS-FULL-ACCESS]]";

/** 승인칩·capability_grants 에 기록되는 도구 이름(`tool:permission-escalation`). */
export const PERMISSION_ESCALATION_TOOL = "permission-escalation";

/** 표식이 줄 머리에 오는 줄이 있는가 — 승격을 물을 근거. */
export function hasPermissionEscalationMarker(text: string): boolean {
  if (!text || !text.includes(PERMISSION_ESCALATION_MARKER)) return false;
  return text
    .split("\n")
    .some((line) => line.trim().startsWith(PERMISSION_ESCALATION_MARKER));
}

/**
 * 표식 줄을 본문에서 제거한다. 표식으로 시작하는 줄 전체(뒤에 붙은 이유 포함)를
 * 지우고, 그로 인해 생긴 꼬리 공백 줄을 정리한다. 표식이 없으면 원문 그대로.
 */
export function stripPermissionEscalationMarker(text: string): string {
  if (!text || !text.includes(PERMISSION_ESCALATION_MARKER)) return text;
  const kept = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(PERMISSION_ESCALATION_MARKER));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}
