import { MODEL_REQUIRES_CREDITS_CODE } from "./runtime-failure-scope";

/**
 * The line a turn shows when it moves to another runtime after the chosen one refused it. It names the cause the runner typed
 * (failure kind and provider code), never a blanket "unavailable": that word told the owner a model that works could not be
 * used, beside an answer that came from another AI. Labels are "kind · model" as the notice already names them.
 */
export interface RuntimeFallbackCause { kind?: string | null; providerCode?: string | null }

export function runtimeFallbackNoticeText(input: { from: string; to: string; cause: RuntimeFallbackCause | null | undefined; locale: "ko" | "en" }): string {
  const { from, to } = input;
  const kind = input.cause?.kind ?? null;
  const ko = input.locale === "ko";
  if (input.cause?.providerCode === MODEL_REQUIRES_CREDITS_CODE) {
    return ko ? `선택한 모델(${from})은 사용량 크레딧이 있어야 쓸 수 있어 ${to}에서 이어갑니다. 저장된 선택은 그대로예요.`
      : `The selected model (${from}) needs usage credits, so the turn continues on ${to}. Your saved choice is unchanged.`;
  }
  if (kind === "quota") {
    return ko ? `선택한 모델(${from})의 사용량 한도에 닿아 ${to}에서 이어갑니다. 저장된 선택은 그대로예요.`
      : `The selected model (${from}) reached its usage limit, so the turn continues on ${to}. Your saved choice is unchanged.`;
  }
  if (kind === "rate_limit") {
    return ko ? `선택한 모델(${from})에 요청이 몰려 ${to}에서 이어갑니다. 저장된 선택은 그대로예요.`
      : `The selected model (${from}) is receiving too many requests, so the turn continues on ${to}. Your saved choice is unchanged.`;
  }
  if (kind === "auth") {
    return ko ? `선택한 모델(${from})의 로그인이 풀려 ${to}에서 이어갑니다. 저장된 선택은 그대로예요.`
      : `The selected model (${from}) is signed out, so the turn continues on ${to}. Your saved choice is unchanged.`;
  }
  return ko ? `선택한 모델(${from})이 응답하지 못해 ${to}에서 이어갑니다. 저장된 선택은 그대로예요.`
    : `The selected model (${from}) did not answer, so the turn continues on ${to}. Your saved choice is unchanged.`;
}
