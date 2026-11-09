import type { RunnerFailure } from "./runner";
import { ollamaModelNamesEqual } from "../../shared/runtime-connect";
import { httpRetryAfterIso, httpRetryAfterTimestamp } from "./http-retry-after";

/*
 * A model server that answers 5xx is a typed failure, never a prose throw (native-harness 07 G24). The cause is read from
 * machine evidence only: the HTTP status, and for a local server whether the model is still loaded afterwards (Ollama
 * /api/ps, LM Studio /api/v1/models). The error bodies of Ollama, LM Studio and MLX are prose (Ollama 0.31.1: "server busy,
 * please try again. maximum pending requests exceeded", "model runner has unexpectedly stopped, this may be due to resource
 * limitations ...") and are carried in the message only, never parsed for the cause.
 *
 * A 5xx arrives at the response header, so nothing of THIS response streamed: sending the same request again repeats no
 * output and no tool effect, whatever earlier turns of the run did (their results are already in the messages). A busy
 * server (RUNTIME_OVERLOADED_CODE) is resent on consecutive failures up to SERVER_FAILURE_CONSECUTIVE_RESENDS times with an
 * exponential wait, and the count restarts once a response opens. A model that dropped out of memory
 * (LOCAL_MODEL_UNLOADED_CODE) is resent once: the resend makes the server load it again. A Retry-After longer than
 * MAX_RESEND_DELAY_MS is never shortened: the typed failure returns.
 */

/** 503 / 529 (Anthropic "overloaded") / 502 / 504 (a gateway in front of the server): the server is busy right now. */
export const RUNTIME_OVERLOADED_CODE = "runtime_overloaded";
/** A local server answered 5xx and no longer has the model loaded (it crashed or could not keep it in memory). */
export const LOCAL_MODEL_UNLOADED_CODE = "local_model_unloaded";
/** Any other 5xx. Not resent: nothing says a second identical request would be answered. */
export const RUNTIME_SERVER_ERROR_CODE = "runtime_server_error";
export type ServerFailureCode = typeof RUNTIME_OVERLOADED_CODE | typeof LOCAL_MODEL_UNLOADED_CODE | typeof RUNTIME_SERVER_ERROR_CODE;

/** Consecutive resends of a busy server (the counter restarts when a response opens). */
export const SERVER_FAILURE_CONSECUTIVE_RESENDS = 3;
/** A model dropped from memory is resent once: the resend reloads it, which is itself a memory load. */
export const LOCAL_MODEL_UNLOADED_RESENDS = 1;
const DEFAULT_RESEND_DELAY_MS = 1_500;
const MAX_RESEND_DELAY_MS = 10_000;

/** How many consecutive resends this class of server failure gets. */
export function serverFailureResendLimit(code: ServerFailureCode): number {
  if (code === RUNTIME_OVERLOADED_CODE) return SERVER_FAILURE_CONSECUTIVE_RESENDS;
  return code === LOCAL_MODEL_UNLOADED_CODE ? LOCAL_MODEL_UNLOADED_RESENDS : 0;
}

/** The server-failure class of an HTTP status, or null when the status is not a server failure. */
export function serverFailureCodeForStatus(status: number): ServerFailureCode | null {
  if (status === 502 || status === 503 || status === 504 || status === 529) return RUNTIME_OVERLOADED_CODE;
  if (status >= 500 && status <= 599) return RUNTIME_SERVER_ERROR_CODE;
  return null;
}

/** A plain 5xx becomes "model unloaded" only on a definite probe answer (false); unknown keeps the plain class. */
export function refineServerFailureCode(code: ServerFailureCode, modelResident: boolean | null): ServerFailureCode {
  return code === RUNTIME_SERVER_ERROR_CODE && modelResident === false ? LOCAL_MODEL_UNLOADED_CODE : code;
}

/**
 * The server-failure class of an error frame INSIDE a stream that already opened (HTTP 200): the same outage as a 5xx at the
 * header, arriving after it. Anthropic sends {"type":"error","error":{"type":"overloaded_error"|"api_error"}}; Gemini sends
 * {"error":{"code":503,"status":"UNAVAILABLE"}}; OpenAI-compatible servers (llama.cpp, Ollama /v1) send {"error":{"code":500 or
 * "type":"server_error"|"api_error"}}. Read from these typed fields only, never from the message. Null for a request error, a
 * frame whose error is prose only, or any other frame: the stream's own end decides those, as before.
 */
export function streamErrorFrameCode(frame: unknown): ServerFailureCode | null {
  if (!record(frame) || !record(frame.error) || (frame.type !== undefined && frame.type !== "error")) return null;
  const error = frame.error;
  // A status may come as a number or as its digits ("503", some OpenAI-compatible local servers).
  const status = [error.code, error.status]
    .map((value) => typeof value === "string" && /^[1-5]\d\d$/.test(value) ? Number(value) : value)
    .find((value): value is number => typeof value === "number" && Number.isInteger(value));
  if (status !== undefined) return serverFailureCodeForStatus(status);
  const names = [error.type, error.status, error.code].filter((value): value is string => typeof value === "string");
  if (names.some((name) => STREAM_OVERLOADED_NAMES.has(name))) return RUNTIME_OVERLOADED_CODE;
  if (names.some((name) => STREAM_SERVER_ERROR_NAMES.has(name))) return RUNTIME_SERVER_ERROR_CODE;
  return null;
}
const STREAM_OVERLOADED_NAMES = new Set(["overloaded_error", "UNAVAILABLE", "DEADLINE_EXCEEDED", "server_is_overloaded"]);
const STREAM_SERVER_ERROR_NAMES = new Set(["api_error", "INTERNAL", "server_error"]);

/** The error object of an in-stream error frame, bounded, for the failure message (never parsed for the cause). */
export function streamErrorFrameBody(frame: unknown): string {
  try { return JSON.stringify(record(frame) ? frame.error : frame).slice(0, 300); } catch { return ""; }
}

export function serverFailureResendable(code: ServerFailureCode): boolean {
  return code === RUNTIME_OVERLOADED_CODE || code === LOCAL_MODEL_UNLOADED_CODE;
}

/**
 * A bounded inline resend wait, or null when the provider requires a longer one. Never shorten Retry-After. `attempt` is how
 * many resends this run already spent in a row: without a Retry-After the wait doubles from DEFAULT_RESEND_DELAY_MS
 * (1.5s, 3s, 6s); with one it is the larger of the two.
 */
export function serverFailureResendDelayMs(retryAfter: string | null | undefined, attempt = 0, now = Date.now()): number | null {
  const at = httpRetryAfterTimestamp(retryAfter, now);
  const backoff = DEFAULT_RESEND_DELAY_MS * 2 ** Math.max(0, Math.min(6, attempt));
  const hinted = at === null ? 0 : Math.max(0, at - now);
  if (hinted > MAX_RESEND_DELAY_MS) return null;
  return Math.max(backoff, hinted);
}

/** Waits, or ends early on Stop (the caller then reads the abort reason). */
export function waitForServerResend(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function serverFailure(input: {
  /** Null for an error frame inside a stream that opened (no HTTP status of its own). */
  code: ServerFailureCode; status: number | null; runtime: string; providerLabel: string; locale?: string; body?: string; retryAfter?: string | null;
}): RunnerFailure {
  const ko = input.locale === "ko";
  const http = input.status === null ? "" : `(HTTP ${input.status})`;
  const sentence = input.code === RUNTIME_OVERLOADED_CODE
    ? ko ? `${input.providerLabel} 서버가 지금 요청을 받을 수 없다고 답했습니다${http}. 잠시 뒤 다시 시도해 주세요.`
      : `${input.providerLabel} said it cannot take the request right now${http ? ` ${http}` : ""}. Try again shortly.`
    : input.code === LOCAL_MODEL_UNLOADED_CODE
      ? ko ? `${input.providerLabel} 서버가 오류${http} 뒤 모델을 메모리에 두지 못했습니다. 메모리가 부족할 수 있으니 다른 모델을 내리거나 더 작은 모델을 고르세요.`
        : `${input.providerLabel} lost the model from memory after an error${http ? ` ${http}` : ""}. It may need more memory than is free: unload other models or choose a smaller one.`
      : ko ? `${input.providerLabel} 서버 오류${http}로 답을 받지 못했습니다.`
        : `${input.providerLabel} returned a server error${http ? ` ${http}` : ""}.`;
  const detail = String(input.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const retryAfterHint = httpRetryAfterIso(input.retryAfter);
  return { kind: "unavailable", runtime: input.runtime, source: "marker", providerCode: input.code,
    message: detail ? `${sentence} ${detail}` : sentence, ...(retryAfterHint ? { retryAfterHint } : {}) };
}

type Fetch = typeof fetch;
const PROBE_TIMEOUT_MS = 2_000;

async function probeJson(url: string, signal: AbortSignal | undefined, fetchImpl: Fetch): Promise<unknown | null> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: bounded, redirect: "error" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Whether the local server still has `model` loaded: true / false on a definite answer of its own listing, null when the
 * runtime has no such listing (MLX, agentlas-local, BYOK) or the listing could not be read.
 */
export async function localModelResident(input: {
  runtimeKind: string; host: string; model: string; signal?: AbortSignal; fetchImpl?: Fetch;
}): Promise<boolean | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const model = input.model.trim();
  if (!model) return null;
  if (input.runtimeKind === "ollama") {
    const value = await probeJson(`${input.host}/api/ps`, input.signal, fetchImpl);
    if (!record(value) || !Array.isArray(value.models)) return null;
    return value.models.some((row) => record(row) && [row.name, row.model]
      .some(name => typeof name === "string" && ollamaModelNamesEqual(model, name)));
  }
  if (input.runtimeKind === "lmstudio") {
    const value = await probeJson(`${input.host}/api/v1/models`, input.signal, fetchImpl);
    if (!record(value) || !Array.isArray(value.models)) return null;
    return value.models.some((row) => record(row) && Array.isArray(row.loaded_instances) && row.loaded_instances.length > 0
      && (row.key === model || row.loaded_instances.some((instance) => record(instance) && instance.id === model)));
  }
  return null;
}
