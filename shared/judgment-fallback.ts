// The single plain-language line every judged site shows when NO connected model
// could reach a verdict. Owner decision (2026-07-25): the keyword-result fallback
// is removed everywhere — a disconnected judge must say so, never silently return
// the wordlist guess. Classification/routing sites surface this line; approval/risk
// sites fail closed and cite the same reason. Wordlists survive only as `hints`.

export const JUDGMENT_UNAVAILABLE_MESSAGE_KO =
  "연결된 모델이 없어 판단할 수 없어요 — 설정에서 모델을 연결해 주세요.";
export const JUDGMENT_UNAVAILABLE_MESSAGE_EN =
  "No model is connected, so I can't decide this — connect a model in settings.";

/** The connect-a-model line for the given UI locale (defaults to Korean). */
export function judgmentUnavailableMessage(locale: string | null | undefined): string {
  return String(locale ?? "").toLowerCase().startsWith("en")
    ? JUDGMENT_UNAVAILABLE_MESSAGE_EN
    : JUDGMENT_UNAVAILABLE_MESSAGE_KO;
}

/**
 * The reason string an approval/risk/publish gate records when it fails CLOSED
 * because no connected model could verify the decision. This is a safe stop, not
 * a keyword decision.
 */
export const JUDGMENT_UNAVAILABLE_GATE_REASON =
  "can't verify without a connected model";
