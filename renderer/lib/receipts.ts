// 영수증(receipt)을 1급 객체로 다루기 위한 공통 유틸.
// 기획안 가치5(독립): "추가요금 0"은 헤더 칩이 아니라 모든 영수증의 'Agentlas 마진 ₩0' 누적 숫자로
// 증명한다. 비용 자체는 사용자의 구독/키에서 빠지며 Agentlas 서버를 거치지 않는다 — 이 사실이 핵심.
//
// 주의: 실제 ₩ 비용은 프로바이더(Claude/OpenAI/Gemini) 구독 모델에 따라 데스크탑이 알 수 없는 경우가
// 많다. 따라서 비용은 토큰 등 "실측 가능한 값"만 표시하고, 추측한 ₩ 금액을 지어내지 않는다.
// 변하지 않는 사실은 단 하나: Agentlas 마진은 항상 ₩0 이다.

/** Agentlas 가 중계로 가져가는 마진. 구조적으로 항상 0 (모델 호출을 중계하지 않음). */
export const AGENTLAS_MARGIN_KRW = 0;

export const MARGIN_LINE_KO = "Agentlas 마진: ₩0";
export const MARGIN_LINE_EN = "Agentlas margin: $0";

export function marginLine(locale: "ko" | "en" = "ko"): string {
  return locale === "ko" ? MARGIN_LINE_KO : MARGIN_LINE_EN;
}

/** 토큰 수를 사람이 읽는 짧은 형태로. 실측값만 — 모르면 빈 문자열. */
export function formatTokens(tokens?: number, locale: "ko" | "en" = "ko"): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  const suffix = locale === "ko" ? "토큰" : "tokens";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k ${suffix}`;
  return `${tokens} ${suffix}`;
}

/** 비용 출처 한 줄 — "당신의 {provider} 구독에서 차감 · Agentlas 마진 ₩0". */
export function costSourceLine(provider?: string, locale: "ko" | "en" = "ko"): string {
  const who = provider && provider.trim() ? provider.trim() : locale === "ko" ? "당신의 구독" : "your subscription";
  if (locale === "ko") return `${who} 에서 차감 · ${MARGIN_LINE_KO}`;
  return `billed to ${who} · ${MARGIN_LINE_EN}`;
}
