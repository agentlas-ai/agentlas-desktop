import type { RunnerFailure } from "./runner";

export type LocalContextCode = "local_context_limit_exceeded" | "local_context_measurement_unavailable";
export function localContextFailure(code: LocalContextCode, runtime: string, locale: string): RunnerFailure {
  return { kind: "refused", runtime, source: "marker", providerCode: code,
    message: code === "local_context_limit_exceeded"
      ? locale === "ko" ? "현재 모델의 대화 용량을 넘었습니다. 새 대화를 시작하거나 모델 용량을 늘려 주세요." : "This request exceeds the model context. Start a new conversation or increase its context capacity."
      : locale === "ko" ? "현재 모델의 대화 용량을 확인하지 못했습니다. 모델 상태를 확인해 주세요." : "The model context could not be verified. Check the model status." };
}

/** Structured provider markers only. HTTP 400 alone never means tools are unsupported. */
export function localHttpFailureClass(text: string): "context" | "tools" | "other" {
  let error: Record<string, unknown>;
  try { const value = JSON.parse(text); error = value?.error; if (!error || typeof error !== "object" || Array.isArray(error)) return "other"; } catch { return "other"; }
  if (["exceed_context_size_error", "context_length_exceeded"].includes(String(error.type))
    || error.code === "context_length_exceeded") return "context";
  if (error.code === "unsupported_parameter" && ["tools", "tool_choice"].includes(String(error.param))) return "tools";
  return "other";
}

/** Same resident llama.cpp template and tokenizer as inference; no approximation or fallback. */
export async function measureLocalContext(input: {
  host: string; headers?: Record<string,string>; signal?: AbortSignal; contextWindow: number; body: Record<string,unknown>;
}): Promise<{ inputTokens: number; reserveTokens: number; maxOutputTokens: number; fits: boolean }> {
  if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 512 || input.contextWindow > 131072) throw new Error("local_context_measurement_unavailable");
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const post = async (route: string, body: unknown): Promise<any> => {
    const response = await fetch(`${input.host}${route}`, {method:"POST",headers:{"content-type":"application/json",...input.headers},body:JSON.stringify(body),signal});
    if (!response.ok) throw new Error("local_context_measurement_unavailable");
    return response.json();
  };
  const properties = await fetch(`${input.host}/props`, {headers:input.headers,signal});
  if (!properties.ok || (await properties.json()).default_generation_settings?.n_ctx !== input.contextWindow) throw new Error("local_context_measurement_unavailable");
  const formatted = await post("/apply-template", input.body);
  if (typeof formatted.prompt !== "string") throw new Error("local_context_measurement_unavailable");
  const tokenized = await post("/tokenize", {content:formatted.prompt,add_special:false,parse_special:true});
  if (!Array.isArray(tokenized.tokens) || tokenized.tokens.some((id:unknown)=>!Number.isSafeInteger(id) || Number(id)<0)) throw new Error("local_context_measurement_unavailable");
  const inputTokens = tokenized.tokens.length;
  // Reserve useful answer space. Never trim a message/tool schema to force a fit.
  const reserveTokens = Math.min(1024, Math.floor(input.contextWindow / 4));
  const maxOutputTokens = input.contextWindow - inputTokens;
  return {inputTokens,reserveTokens,maxOutputTokens,fits:maxOutputTokens >= reserveTokens};
}
