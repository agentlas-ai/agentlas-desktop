import type { RunnerFailure } from "./runner";
import { ollamaModelNamesEqual } from "../../shared/runtime-connect";

/*
 * A model server that answers 5xx is a typed failure, never a prose throw (native-harness 07 G24). The cause is read from
 * machine evidence only: the HTTP status, and for a local server whether the model is still loaded afterwards (Ollama
 * /api/ps, LM Studio /api/v1/models). The error bodies of Ollama, LM Studio and MLX are prose (Ollama 0.31.1: "server busy,
 * please try again. maximum pending requests exceeded", "model runner has unexpectedly stopped, this may be due to resource
 * limitations ...") and are carried in the message only, never parsed for the cause.
 *
 * One resend per invocation, after a short wait, and only while nothing streamed and no tool ran in this invocation: the
 * resend is then the same request the provider never answered. After any output or tool effect the typed failure returns.
 */

/** 503 / 529 (Anthropic "overloaded") / 502 / 504 (a gateway in front of the server): the server is busy right now. */
export const RUNTIME_OVERLOADED_CODE = "runtime_overloaded";
/** A local server answered 5xx and no longer has the model loaded (it crashed or could not keep it in memory). */
export const LOCAL_MODEL_UNLOADED_CODE = "local_model_unloaded";
/** Any other 5xx. Not resent: nothing says a second identical request would be answered. */
export const RUNTIME_SERVER_ERROR_CODE = "runtime_server_error";
export type ServerFailureCode = typeof RUNTIME_OVERLOADED_CODE | typeof LOCAL_MODEL_UNLOADED_CODE | typeof RUNTIME_SERVER_ERROR_CODE;

export const SERVER_FAILURE_RESENDS = 1;
const DEFAULT_RESEND_DELAY_MS = 1_500;
const MAX_RESEND_DELAY_MS = 10_000;

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

export function serverFailureResendable(code: ServerFailureCode): boolean {
  return code === RUNTIME_OVERLOADED_CODE || code === LOCAL_MODEL_UNLOADED_CODE;
}

/** The provider's Retry-After (seconds or an HTTP date), bounded; otherwise a short fixed wait. */
export function serverFailureResendDelayMs(retryAfter: string | null | undefined, now = Date.now()): number {
  const text = String(retryAfter ?? "").trim();
  let ms = DEFAULT_RESEND_DELAY_MS;
  if (/^\d{1,7}$/.test(text)) ms = Number(text) * 1_000;
  else if (text && Number.isFinite(Date.parse(text))) ms = Date.parse(text) - now;
  return Math.max(0, Math.min(MAX_RESEND_DELAY_MS, Number.isFinite(ms) ? ms : DEFAULT_RESEND_DELAY_MS));
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
  code: ServerFailureCode; status: number; runtime: string; providerLabel: string; locale?: string; body?: string; retryAfter?: string | null;
}): RunnerFailure {
  const ko = input.locale === "ko";
  const sentence = input.code === RUNTIME_OVERLOADED_CODE
    ? ko ? `${input.providerLabel} 서버가 지금 요청을 받을 수 없다고 답했습니다(HTTP ${input.status}). 잠시 뒤 다시 시도해 주세요.`
      : `${input.providerLabel} said it cannot take the request right now (HTTP ${input.status}). Try again shortly.`
    : input.code === LOCAL_MODEL_UNLOADED_CODE
      ? ko ? `${input.providerLabel} 서버가 오류(HTTP ${input.status}) 뒤 모델을 메모리에 두지 못했습니다. 메모리가 부족할 수 있으니 다른 모델을 내리거나 더 작은 모델을 고르세요.`
        : `${input.providerLabel} lost the model from memory after an error (HTTP ${input.status}). It may need more memory than is free: unload other models or choose a smaller one.`
      : ko ? `${input.providerLabel} 서버 오류(HTTP ${input.status})로 답을 받지 못했습니다.`
        : `${input.providerLabel} returned a server error (HTTP ${input.status}).`;
  const detail = String(input.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const retryAfterHint = input.code === RUNTIME_OVERLOADED_CODE ? retryAfterIso(input.retryAfter) : undefined;
  return { kind: "unavailable", runtime: input.runtime, source: "marker", providerCode: input.code,
    message: detail ? `${sentence} ${detail}` : sentence, ...(retryAfterHint ? { retryAfterHint } : {}) };
}

function retryAfterIso(value: string | null | undefined, now = Date.now()): string | undefined {
  const text = String(value ?? "").trim();
  if (/^\d{1,7}$/.test(text)) return new Date(now + Number(text) * 1_000).toISOString();
  const at = Date.parse(text);
  return text && Number.isFinite(at) ? new Date(at).toISOString() : undefined;
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
