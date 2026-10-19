












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
