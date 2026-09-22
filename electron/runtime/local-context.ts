import type { RunnerFailure } from "./runner";

export type LocalContextCode = "local_context_limit_exceeded" | "local_context_measurement_unavailable" | "local_output_limit_exceeded";

export function boundedLocalOutputTokens(available: number, requested?: number): number {
  if (!Number.isSafeInteger(available) || available < 1) return 0;
  if (!Number.isSafeInteger(requested) || requested === undefined || requested < 1) return available;
  return Math.min(available, requested);
}
export function localContextFailure(code: LocalContextCode, runtime: string, locale: string): RunnerFailure {
  return { kind: "refused", runtime, source: "marker", providerCode: code,
    message: code === "local_context_limit_exceeded"
      ? locale === "ko" ? "보존해야 할 지시와 도구 정보를 포함한 요청이 현재 모델의 문맥 한도를 넘습니다. 원문을 삭제하지 말고, 더 큰 문맥을 지원하는 모델이나 용량 설정을 선택해 주세요." : "The request, including preserved instructions and tool information, exceeds this model's context capacity. Keep the original conversation and choose a larger context setting or model."
      : code === "local_output_limit_exceeded"
        ? locale === "ko" ? "로컬 모델이 계획 응답 한도 안에 결과를 끝내지 못했습니다." : "The local model did not finish its planning response within the admitted output budget."
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
