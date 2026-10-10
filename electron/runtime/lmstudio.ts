// LM Studio 로컬 LLM — 감지 + 실호출.
// LM Studio는 OpenAI 호환 서버를 localhost:1234에 띄운다(GUI의 "Local Server").
// 감지·채팅 모두 local-openai.ts의 공용 로직을 재사용한다.
import { makeLocalOpenAiRunner, normalizeLocalHost, probeOpenAiLocal, type LoadedInstanceContextLengthRequest } from "./local-openai";
import type { Runner } from "./runner";

/** 기본 로컬 호스트. env LMSTUDIO_HOST로 재정의 가능(원격 LM Studio도 지원). */
export function lmStudioHost(): string {
  return normalizeLocalHost(process.env.LMSTUDIO_HOST, "http://localhost:1234");
}

/** 로컬 LM Studio 서버 감지. 서버가 안 떠 있으면 null. */
export function probeLMStudio(timeoutMs?: number) {
  return probeOpenAiLocal(lmStudioHost(), timeoutMs);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function loadedCapacityFailure(code: string): never {
  throw Object.assign(new Error(code), { code });
}
/** Select only a unique exact loaded ID, or a unique model key with one loaded
 * instance. Architecture max_context_length never describes its loaded C. */
function loadedContextLength(value: unknown, selected: string): number | undefined {
  if (!object(value) || !Array.isArray(value.models)) return undefined;
  const models = value.models.filter(row => object(row) && row.type === "llm");
  const exact = models.flatMap(row => Array.isArray(row.loaded_instances)
    ? row.loaded_instances.filter((instance: unknown) => object(instance) && instance.id === selected) : []);
  let instance: unknown;
  if (exact.length > 1) loadedCapacityFailure("lmstudio_loaded_model_ambiguous");
  if (exact.length === 1) instance = exact[0];
  else {
    const keys = models.filter(row => row.key === selected);
    if (keys.length > 1) loadedCapacityFailure("lmstudio_loaded_model_ambiguous");
    if (!keys.length || !Array.isArray(keys[0].loaded_instances) || !keys[0].loaded_instances.length) return undefined;
    if (keys[0].loaded_instances.length !== 1) loadedCapacityFailure("lmstudio_loaded_model_ambiguous");
    instance = keys[0].loaded_instances[0];
  }
  if (!object(instance) || typeof instance.id !== "string" || !instance.id.trim())
    loadedCapacityFailure("lmstudio_loaded_context_invalid");
  const capacity = object(instance.config) ? instance.config.context_length : undefined;
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0)
    loadedCapacityFailure("lmstudio_loaded_context_invalid");
  return capacity;
}

/** Optional GET-only observation, bounded through fetch and body consumption.
 * Unavailable/older REST metadata retains the existing labelled estimate;
 * cancellation, original-authority revocation and ambiguous C never do. */
export async function observeLMStudioLoadedContextLength(input: Readonly<LoadedInstanceContextLengthRequest>): Promise<number | undefined> {
  input.assertCurrent();
  let url: URL;
  try { url = new URL(input.host); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  const timeout = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  let interrupted!: () => void;
  const aborted = new Promise<undefined>(resolve => { interrupted = () => resolve(undefined); });
  signal.addEventListener("abort", interrupted, { once: true });
  const timer = setTimeout(() => timeout.abort(), 1500);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let pending: Promise<Response> | undefined;
    try { pending = fetch(`${input.host}/api/v1/models`, { method: "GET", signal, redirect: "error" }); }
    catch { /* Synchronous transport refusal; authority is checked below. */ }
    const response = pending ? await Promise.race([pending.then(value => value, () => undefined), aborted]) : undefined;
    input.assertCurrent();
    if (!response?.ok || !response.body) { void response?.body?.cancel().catch(() => undefined); return undefined; }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "", bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read().then(value => value, () => undefined), aborted]);
      input.assertCurrent();
      if (!part) return undefined;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) return undefined;
      try { text += decoder.decode(part.value, { stream: true }); }
      catch { return undefined; }
    }
    let value: unknown;
    try { text += decoder.decode(); value = JSON.parse(text); }
    catch { return undefined; }
    input.assertCurrent();
    const capacity = loadedContextLength(value, input.model);
    input.assertCurrent();
    return capacity;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupted);
    timeout.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

export const runLMStudio: Runner = makeLocalOpenAiRunner(lmStudioHost, "lmstudio", {
  loadedInstanceContextLengthFn: observeLMStudioLoadedContextLength,
});
