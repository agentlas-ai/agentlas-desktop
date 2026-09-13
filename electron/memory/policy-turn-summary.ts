/**
 * 정책이 만드는 "프로젝트 기억" 문장 — 모델이 답을 못 낸 턴에 큐레이터가 대신 적는 세 문장.
 *
 * 저장 시점의 화면 언어로 적지만(curator.ts), 이미 저장된 옛 티켓은 영어 그대로 남아 있다(라운드 1·2 실측:
 * 한국어 화면의 프로젝트 기억란에 "The model turn was cancelled before a final response." 가 계속 보였다).
 * 그래서 읽을 때도 아는 문장은 현재 언어로 바꾼다 — 사용자·모델이 쓴 문장은 건드리지 않고, 이 표의 문장만.
 */
export type PolicyTurnSummaryCode = "turn-cancelled" | "curation-failed" | "turn-failed";

export const POLICY_TURN_SUMMARIES: Record<PolicyTurnSummaryCode, { ko: string; en: string }> = {
  "turn-cancelled": {
    ko: "답이 나오기 전에 이 턴이 중단되었습니다.",
    en: "The model turn was cancelled before a final response.",
  },
  "curation-failed": {
    ko: "이 턴은 끝났지만 기억 정리를 할 수 없었습니다.",
    en: "The model turn completed but its semantic memory review was unavailable.",
  },
  "turn-failed": {
    ko: "이 턴은 최종 답 없이 끝났습니다.",
    en: "The model turn ended without a final response.",
  },
};

const BY_SENTENCE = new Map<string, PolicyTurnSummaryCode>();
for (const [code, pair] of Object.entries(POLICY_TURN_SUMMARIES) as Array<[PolicyTurnSummaryCode, { ko: string; en: string }]>) {
  BY_SENTENCE.set(pair.ko, code);
  BY_SENTENCE.set(pair.en, code);
}

export function policyTurnSummary(code: PolicyTurnSummaryCode, locale: "ko" | "en"): string {
  return POLICY_TURN_SUMMARIES[code][locale];
}

/** 아는 정책 문장이면 현재 언어의 문장으로, 아니면 그대로. null/undefined 도 그대로 돌려준다. */
export function localizePolicyTurnSummary<T extends string | null | undefined>(text: T, locale: "ko" | "en"): T | string {
  if (typeof text !== "string") return text;
  const code = BY_SENTENCE.get(text.trim());
  return code ? POLICY_TURN_SUMMARIES[code][locale] : text;
}
