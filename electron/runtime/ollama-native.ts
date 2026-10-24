// Ollama native chat transport for the shared local tool loop.
//
// Why: Ollama's OpenAI-compatible /v1/chat/completions ignores every way of asking for a context
// window (measured 2026-10-11 on ollama 0.31.1: options.num_ctx, a top-level num_ctx and extra_body
// all left /api/ps at the 32768 default, and a preloaded 8192 window was reloaded at 32768 by the
// next /v1 request). On a small-VRAM machine that default is 4096, so a ~6k-token prompt is silently
// truncated. Only the native /api/chat accepts options.num_ctx per request.
//
// The tool loop keeps speaking OpenAI Chat Completions; this module is a fetch-compatible adapter
// that translates one request to /api/chat and the NDJSON reply back into the SSE chunks that
// streamChatTurn parses, including the single terminal usage chunk (prompt_eval_count /
// eval_count), which the /v1 route never reported for Ollama.
import os from "node:os";
import { estimateAdmissionTokens } from "./token-estimate";

/** Context tiers a plan may pick; each step doubles the KV cache, so the smallest fitting tier wins. */
export const OLLAMA_CONTEXT_TIERS = [4096, 8192, 16384, 32768, 65536, 131072, 262144] as const;
/** Default ceiling for a requested window: bigger asks reload slowly and can exhaust VRAM. */
export const OLLAMA_DEFAULT_CONTEXT_CEILING = 65536;
/**
 * Share of this machine's memory the KV cache of one requested window may take (loopback servers only). The weights,
 * the OS and the app need the rest; a window past it makes the load fail or crawl instead of answering.
 */
export const OLLAMA_KV_MEMORY_SHARE = 0.35;

export interface OllamaContextLimits {
  /** Largest window the model was trained for (model_info "<arch>.context_length"). */
  modelMax?: number;
  /** Window the server currently has loaded for this model (/api/ps), if it is loaded. */
  loaded?: number;
  /** f16 KV-cache bytes one token of window costs (model_info layers × KV heads × key+value width × 2 bytes). */
  kvBytesPerToken?: number;
}

/** KV-cache bytes per token of window from /api/show model_info; undefined when the model does not report its shape. */
export function ollamaKvBytesPerToken(info: Record<string, unknown>): number | undefined {
  const field = (suffix: string): number | undefined => {
    for (const [name, raw] of Object.entries(info)) {
      if (!name.endsWith(suffix)) continue;
      // Per-layer arrays (some architectures vary heads by layer): the widest layer bounds the cost.
      const value = Array.isArray(raw) ? Math.max(...raw.filter((n): n is number => Number.isSafeInteger(n))) : raw;
      if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
    }
    return undefined;
  };
  const layers = field(".block_count");
  const kvHeads = field(".attention.head_count_kv") ?? field(".attention.head_count");
  const heads = field(".attention.head_count");
  const embedding = field(".embedding_length");
  const keyWidth = field(".attention.key_length") ?? (embedding && heads ? Math.floor(embedding / heads) : undefined);
  const valueWidth = field(".attention.value_length") ?? keyWidth;
  if (!layers || !kvHeads || !keyWidth || !valueWidth) return undefined;
  return layers * kvHeads * (keyWidth + valueWidth) * 2;
}

/** True for a server on this machine, the only case where this machine's memory bounds the window. */
export function ollamaHostIsLoopback(host: string): boolean {
  try {
    const name = new URL(host).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return name === "localhost" || name === "::1" || /^127\./.test(name);
  } catch { return false; }
}

/**
 * Largest window this machine can hold for the model, or undefined when unknown (remote server, shape not reported).
 * Never below the smallest tier: a model that cannot hold 4096 tokens fails on its own, not on our arithmetic.
 */
export function ollamaMemoryCeiling(host: string, limits: OllamaContextLimits, totalMemoryBytes = os.totalmem()): number | undefined {
  if (!limits.kvBytesPerToken || !ollamaHostIsLoopback(host) || !(totalMemoryBytes > 0)) return undefined;
  return Math.max(OLLAMA_CONTEXT_TIERS[0], Math.floor((totalMemoryBytes * OLLAMA_KV_MEMORY_SHARE) / limits.kvBytesPerToken));
}

export interface OllamaContextPlan {
  /** num_ctx to request. */
  numCtx: number;
  modelMax?: number;
  loaded?: number;
  /** This machine's memory bound on the window, when known. */
  memoryMax?: number;
  ceiling: number;
  /** The plan could not fit the prompt even at the ceiling. */
  insufficient: boolean;
  /** Estimated tokens the plan was sized for (prompt + output reserve, before headroom). */
  needTokens: number;
}

/** Sticky per host+model: shrinking would make the next request reload the model for nothing. */
const chosenWindow = new Map<string, number>();

/** The model maximum the sticky choice was made against: a different maximum means a different model behind the tag. */
const chosenBasis = new Map<string, { modelMax?: number }>();

export function resetOllamaContextChoices(): void { chosenWindow.clear(); chosenBasis.clear(); limitsCache.clear(); }

/**
 * G32: forget everything measured for host+model (probed limits and the sticky window). Called when a context failure
 * says the measured window was wrong, so the next plan re-measures instead of reusing a bigger remembered window.
 */
export function invalidateOllamaContext(host: string, model: string): void {
  const key = `${host}\0${model}`;
  chosenWindow.delete(key); chosenBasis.delete(key); limitsCache.delete(key);
}

export function planOllamaContext(input: {
  host: string;
  model: string;
  /** Estimated tokens of everything already in the request (system, history, tools, current prompt). */
  promptTokens: number;
  /** Tokens to leave for the answer (and any reasoning). */
  outputReserve: number;
  limits: OllamaContextLimits;
  ceiling?: number;
  /** This machine's memory bound (ollamaMemoryCeiling); undefined = not known, the model maximum alone bounds. */
  memoryMax?: number;
}): OllamaContextPlan {
  const modelMax = input.limits.modelMax;
  const memoryMax = input.memoryMax && input.memoryMax > 0 ? input.memoryMax : undefined;
  const ceiling = Math.max(OLLAMA_CONTEXT_TIERS[0], Math.min(input.ceiling ?? OLLAMA_DEFAULT_CONTEXT_CEILING,
    modelMax && modelMax > 0 ? modelMax : Number.MAX_SAFE_INTEGER, memoryMax ?? Number.MAX_SAFE_INTEGER));
  const need = input.promptTokens + input.outputReserve;
  // 1.25x headroom: every tool step appends its call and result to the same window.
  const wanted = Math.ceil(need * 1.25);
  const key = `${input.host}\0${input.model}`;
  let previous = chosenWindow.get(key) ?? 0;
  // A smaller trained maximum than the remembered window, or a maximum that differs from the one the choice was made
  // against, is a different (smaller) model behind the same tag: the remembered bigger window is stale, not a floor.
  const basis = chosenBasis.get(key);
  if (previous > 0 && input.limits.modelMax !== undefined
    && (input.limits.modelMax < previous || (basis?.modelMax !== undefined && basis.modelMax !== input.limits.modelMax))) previous = 0;
  const tier = OLLAMA_CONTEXT_TIERS.find((candidate) => candidate >= wanted) ?? OLLAMA_CONTEXT_TIERS[OLLAMA_CONTEXT_TIERS.length - 1];
  const numCtx = Math.min(ceiling, Math.max(tier, previous));
  chosenWindow.set(key, numCtx);
  chosenBasis.set(key, modelMax ? { modelMax } : {});
  return {
    numCtx, ...(modelMax ? { modelMax } : {}), ...(input.limits.loaded ? { loaded: input.limits.loaded } : {}),
    ...(memoryMax ? { memoryMax } : {}), ceiling, insufficient: need > numCtx, needTokens: need,
  };
}

const limitsCache = new Map<string, { at: number; value: OllamaContextLimits }>();
const LIMITS_TTL_MS = 60_000;

/** Read the model's trained maximum (/api/show) and the currently loaded window (/api/ps). Best effort. */
export async function probeOllamaContextLimits(
  host: string,
  model: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  options: { fresh?: boolean } = {},
): Promise<OllamaContextLimits> {
  const key = `${host}\0${model}`;
  const cached = limitsCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < LIMITS_TTL_MS) return cached.value;
  const value: OllamaContextLimits = {};
  const timeout = (ms: number) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);
  try {
    const show = await fetchImpl(`${host}/api/show`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }), signal: timeout(4000) });
    if (show.ok) {
      const info = ((await show.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
      for (const [name, raw] of Object.entries(info)) {
        if (name.endsWith(".context_length") && Number.isSafeInteger(raw) && Number(raw) > 0) { value.modelMax = Number(raw); break; }
      }
      const kvBytesPerToken = ollamaKvBytesPerToken(info);
      if (kvBytesPerToken) value.kvBytesPerToken = kvBytesPerToken;
    }
  } catch { /* an old or remote server may not expose it; the plan then uses the ceiling alone */ }
  try {
    const ps = await fetchImpl(`${host}/api/ps`, { signal: timeout(2000) });
    if (ps.ok) {
      const rows = ((await ps.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> }).models ?? [];
      const row = rows.find((entry) => entry.name === model || entry.model === model);
      if (row && Number.isSafeInteger(row.context_length) && Number(row.context_length) > 0) value.loaded = Number(row.context_length);
    }
  } catch { /* not loaded or unreachable */ }
  // A fresh reading of the real loaded window below the remembered choice means the model was reloaded smaller.
  const remembered = chosenWindow.get(key);
  if (options.fresh && value.loaded !== undefined && remembered !== undefined && value.loaded < remembered) {
    chosenWindow.delete(key); chosenBasis.delete(key);
  }
  limitsCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * G32: after a context failure, drop what was cached and measure again. Returns the smallest window the server now
 * reports for the model (loaded or trained maximum), or undefined when it reports neither (unknown, never 0).
 */
export async function remeasureOllamaWindow(
  host: string,
  model: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ limits: OllamaContextLimits; window: number | undefined }> {
  invalidateOllamaContext(host, model);
  const limits = await probeOllamaContextLimits(host, model, signal, fetchImpl, { fresh: true });
  const known = [limits.loaded, limits.modelMax].filter((value): value is number => typeof value === "number" && value > 0);
  return { limits, window: known.length ? Math.min(...known) : undefined };
}

// ── OpenAI chat request -> native /api/chat ─────────────────────────────

type OpenAiMessage = { role: string; content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>; tool_call_id?: string };

function textAndImages(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? "" : String(content), images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      const match = /^data:[^;,]+;base64,(.*)$/s.exec(part.image_url.url);
      if (match) images.push(match[1]);
    }
  }
  return { text: texts.join("\n"), images };
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function openAiToOllamaChatBody(body: Record<string, unknown>, numCtx: number | undefined, thinkingByCallId?: ReadonlyMap<string, string>): Record<string, unknown> {
  const toolNameById = new Map<string, string>();
  const messages = (body.messages as OpenAiMessage[]).map((message) => {
    const { text, images } = textAndImages(message.content);
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) if (call.id && call.function?.name) toolNameById.set(call.id, call.function.name);
      const thinking = message.tool_calls[0]?.id ? thinkingByCallId?.get(message.tool_calls[0].id) : undefined;
      return { role: "assistant", content: text, ...(thinking ? { thinking } : {}),
        tool_calls: message.tool_calls.map((call) => ({ function: { name: call.function?.name ?? "", arguments: parseArguments(call.function?.arguments) } })) };
    }
    if (message.role === "tool") {
      const name = message.tool_call_id ? toolNameById.get(message.tool_call_id) : undefined;
      return { role: "tool", content: text, ...(name ? { tool_name: name } : {}) };
    }
    return { role: message.role, content: text, ...(images.length ? { images } : {}) };
  });
  const options: Record<string, unknown> = {};
  if (numCtx) options.num_ctx = numCtx;
  if (typeof body.max_tokens === "number") options.num_predict = body.max_tokens;
  if (typeof body.temperature === "number") options.temperature = body.temperature;
  if (typeof body.seed === "number") options.seed = body.seed;
  const responseFormat = body.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  return {
    model: body.model,
    messages,
    stream: true,
    // Never let the server cut the prompt to fit (it keeps the first 4 tokens and drops the rest, measured 2026-10-24 on
    // 0.31.1: 9297 -> 2050 tokens, wrong answer). With this it answers 400 exceed_context_size_error instead, which the
    // loop reports as local_context_limit_exceeded. A server that predates the field ignores it; num_ctx still sizes it.
    truncate: false,
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
    ...(typeof body.keep_alive === "string" ? { keep_alive: body.keep_alive } : {}),
    ...(responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema ? { format: responseFormat.json_schema.schema } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

// ── native NDJSON -> OpenAI SSE ──────────────────────────────────────────

export function ollamaNdjsonToOpenAiSse(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolIndex = 0;
  let sawToolCall = false;
  let finished = false;
  const sse = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
  const handle = (line: string, out: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!line.trim()) return;
    let event: {
      message?: { content?: string; thinking?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
      done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string;
    };
    try { event = JSON.parse(line); } catch { return; }
    if (event.error) { out.error(new Error(event.error)); return; }
    const message = event.message;
    if (message?.thinking) out.enqueue(chunk({ reasoning: message.thinking }, null));
    if (message?.content) out.enqueue(chunk({ content: message.content }, null));
    for (const call of message?.tool_calls ?? []) {
      sawToolCall = true;
      const args = call.function?.arguments;
      out.enqueue(chunk({ tool_calls: [{ index: toolIndex, id: call.id ?? `call_${toolIndex}`, type: "function",
        function: { name: call.function?.name ?? "", arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }] }, null));
      toolIndex += 1;
    }
    if (event.done && !finished) {
      finished = true;
      const finish = sawToolCall ? "tool_calls" : event.done_reason === "length" ? "length" : "stop";
      out.enqueue(chunk({}, finish));
      if (Number.isSafeInteger(event.prompt_eval_count) && Number.isSafeInteger(event.eval_count)) {
        out.enqueue(sse({ object: "chat.completion.chunk", choices: [],
          usage: { prompt_tokens: event.prompt_eval_count, completion_tokens: event.eval_count } }));
      }
      out.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
  };
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer) handle(buffer, controller);
          buffer = "";
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, newline), controller);
          buffer = buffer.slice(newline + 1);
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/**
 * A fetch that accepts the loop's OpenAI Chat Completions request for `${host}/v1/chat/completions` and serves
 * it from `${host}/api/chat` with the requested window. `onRequest` sees the translated body (num_ctx included)
 * so callers can record exactly what was sent.
 */
export function ollamaNativeFetch(host: string, numCtx: number | undefined, options: {
  fetchImpl?: typeof fetch;
  onRequest?: (nativeBody: Record<string, unknown>) => void;
  /** Reasoning text keyed by the id of the first tool call of the assistant message that followed it. */
  thinkingByCallId?: ReadonlyMap<string, string>;
} = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const nativeBody = openAiToOllamaChatBody(body, numCtx, options.thinkingByCallId);
    options.onRequest?.(nativeBody);
    const response = await fetchImpl(`${host}/api/chat`, { ...init, method: "POST", body: JSON.stringify(nativeBody),
      headers: { "content-type": "application/json" } });
    // A server or proxy without the native route still serves the OpenAI-compatible one (window not requestable there).
    if (response.status === 404) return fetchImpl(_input, init);
    if (!response.ok || !response.body) return response;
    return new Response(ollamaNdjsonToOpenAiSse(response.body), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

/** Estimated prompt tokens of an OpenAI-style request body (system + history + tools + current prompt). */
export function estimateRequestPromptTokens(body: unknown): number {
  return estimateAdmissionTokens(JSON.stringify(body));
}
