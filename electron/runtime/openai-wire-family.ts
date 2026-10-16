// Which Chat Completions dialect a request goes to, decided from typed facts only (runtime kind, BYOK backend, and the
// parsed endpoint host), never from model-name or error prose (A4 gap 4, 2026-10-16).
//
// OpenAI's own API spec (github.com/openai/openai-openapi, CreateChatCompletionRequest):
//   max_tokens            "deprecated in favor of max_completion_tokens, and is not compatible with o-series models"
//                         (deprecated: true)
//   max_completion_tokens "An upper bound for the number of tokens that can be generated for a completion, including
//                         visible output tokens and reasoning tokens"
//   reasoning_effort      ReasoningEffort: none | minimal | low | medium | high | xhigh | max; "Not all reasoning models
//                         support every value"
// The OpenAI-compatible servers this loop also drives keep `max_tokens`: Ollama's OpenAI compatibility and native
// translation (ollama-native.ts num_predict), LM Studio and mlx_lm.server document `max_tokens`, and the other BYOK
// providers (DeepSeek, Kimi, MiniMax, xAI, OpenRouter, Upstage, a custom non-OpenAI base URL) document `max_tokens`.
//
// No electron import: the daemon runs the same loop.

export type OpenAiChatWireFamily = "openai-platform" | "openai-compatible";

/** The one host whose wire is OpenAI's own platform API. */
const OPENAI_PLATFORM_HOST = "api.openai.com";

export function openAiChatWireFamily(input: { runtimeKind: string; backend?: string | null; endpoint: string }): OpenAiChatWireFamily {
  if (input.runtimeKind !== "byok") return "openai-compatible";
  if (input.backend !== "openai" && input.backend !== "custom") return "openai-compatible";
  try {
    return new URL(input.endpoint).hostname.toLowerCase() === OPENAI_PLATFORM_HOST ? "openai-platform" : "openai-compatible";
  } catch {
    return "openai-compatible";
  }
}

/** The request field that carries the output cap for this dialect. */
export function outputLimitField(family: OpenAiChatWireFamily): "max_completion_tokens" | "max_tokens" {
  return family === "openai-platform" ? "max_completion_tokens" : "max_tokens";
}

/** The output cap of an OpenAI-style request body, whichever dialect field carries it. */
export function requestOutputLimit(body: Record<string, unknown>): number | undefined {
  const value = typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : body.max_tokens;
  return typeof value === "number" ? value : undefined;
}

const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The reasoning_effort value to send, or why none: only OpenAI's platform takes the field, and only a spec value. */
export function openAiReasoningEffort(family: OpenAiChatWireFamily, requested: string | null | undefined):
  { send: string } | { skip: "not_requested" | "endpoint_family_has_no_effort_control" | "effort_value_not_in_provider_enum" } {
  if (!requested) return { skip: "not_requested" };
  if (family !== "openai-platform") return { skip: "endpoint_family_has_no_effort_control" };
  return OPENAI_REASONING_EFFORTS.has(requested) ? { send: requested } : { skip: "effort_value_not_in_provider_enum" };
}

/**
 * A structured OpenAI validation refusal of one optional request parameter (before any generation): HTTP 400/422 with
 * error.type invalid_request_error, error.param equal to the field, and an unsupported_* code. Prose is never read.
 */
export function rejectsOptionalParameter(status: number, text: string, params: readonly string[]): string | null {
  if (status !== 400 && status !== 422) return null;
  try {
    const value = JSON.parse(text) as { error?: { type?: unknown; code?: unknown; param?: unknown } };
    const error = value?.error;
    if (error?.type !== "invalid_request_error") return null;
    if (error.code !== "unsupported_parameter" && error.code !== "unsupported_value") return null;
    return typeof error.param === "string" && params.includes(error.param) ? error.param : null;
  } catch {
    return null;
  }
}
