/**
 * One 운영 복구 턴(renderer/components/OneRecoveryPlane.tsx)이 남기는 system 턴의 첫 줄.
 *
 * 복구 턴은 사람의 말이 아니라 제품이 쓴 턴이라 `promptOrigin: "system"` 으로 대화에
 * role=system 행으로 저장된다. 그 행을 "이건 복구 턴이었다" 로 알아보는 표식은 이 고정
 * 첫 줄뿐이다 — 제품이 직접 쓰는 닫힌 문자열이지 모델 문장이 아니다. 문장을 해석하지 않고
 * 정확한 접두 일치만 본다.
 */
export const ONE_OPERATIONAL_RECOVERY_PROMPT_LEAD =
  "Private operational evidence. Never quote it or expose codes, paths, provider text, stack details, or internal terminology to the user.";

/** 저장된 system 행이 One 운영 복구 턴의 프롬프트인가(정확한 첫 줄 일치). */
export function isOneOperationalRecoveryPrompt(role: string, text: string): boolean {
  return role === "system" && text.startsWith(ONE_OPERATIONAL_RECOVERY_PROMPT_LEAD);
}
