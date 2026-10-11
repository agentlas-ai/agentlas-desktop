/*
 * Agentlas serving — 캐시되는 앞부분(도구 → system → 이전 대화)을 턴마다 흔들지 않는다.
 *
 * 서버(/api/one/serving/chat)는 Anthropic Messages API 의 프롬프트 캐시를 쓴다. 렌더 순서는
 * tools → system → messages 이고 앞의 한 바이트가 바뀌면 그 뒤는 전부 무효다.
 *
 * 세션을 못 쓰는 러너(serving 포함)에는 예전에 턴마다 바뀌는 호스트 컨텍스트(기억 회상·MCP 자동선택·
 * 목표 계획·소유자 지시·진행 권고 …)를 system 꼬리에 붙였다. 그러면 system 이 매 턴 달라져
 * 도구+system+대화 전체가 매 턴 새로 입력 요금으로 청구된다(2026-10-11 코드 점검).
 *
 * 그래서 상태 없는 호스트 루프(serving·BYOK·로컬 모델)에는 같은 내용을 **현재 사용자 메시지 앞**에 프레임으로 싣는다. BYOK·로컬 호스트 루프가
 * 영속 컨텍스트 경로(agent-context.ts HOST_MESSAGE_CONTEXT_KINDS)에서 이미 그렇게 한다.
 */
import { composeResumeTurnPrompt } from "./continuity";

/** Stateless API / local host loops: they resend the whole prefix every request (server cache or local KV-cache reuse). */
const STATELESS_HOST_LOOP_KINDS = new Set(["agentlas", "byok", "lmstudio", "mlx", "agentlas-local", "ollama"]);

export function placeTurnContextForRuntime(input: {
  runtimeKind: string;
  /** 세션 지원 러너는 turnContext 를 따로 받는다 — 여기서 건드리지 않는다. */
  sessionCapable: boolean;
  systemPrompt: string;
  turnContext: string;
  userPrompt: string;
  locale: Parameters<typeof composeResumeTurnPrompt>[2];
}): { systemPrompt: string; userPrompt: string; placement: "system-tail" | "user-message" | "session" } {
  const { runtimeKind, sessionCapable, systemPrompt, turnContext, userPrompt, locale } = input;
  if (!turnContext.trim()) return { systemPrompt, userPrompt, placement: sessionCapable ? "session" : "system-tail" };
  if (sessionCapable) return { systemPrompt, userPrompt, placement: "session" };
  if (STATELESS_HOST_LOOP_KINDS.has(runtimeKind)) {
    return { systemPrompt, userPrompt: composeResumeTurnPrompt(userPrompt, turnContext, locale), placement: "user-message" };
  }
  return { systemPrompt: `${systemPrompt}\n\n${turnContext}`, userPrompt, placement: "system-tail" };
}
