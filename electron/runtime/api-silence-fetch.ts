import { cliSilenceWindowMs, RUNTIME_SILENT_TIMEOUT_CODE } from "./runner";

/*
 * The one silence rule of the API runners (BYOK Anthropic / Google / DeepSeek, Agentlas serving, the OpenAI-compatible local
 * tool loop: ollama, lmstudio, mlx, agentlas-local). Every model request goes through fetchWithReconnect, which calls this.
 *
 * Before this module the wait was nobody's choice: Node's fetch (undici) ends a request after 300 s without response headers
 * and after 300 s between two body chunks (headersTimeout / bodyTimeout defaults), measured (290 s passes, 310 s
 * dies with UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT). Nothing in the app declared it, and the owner saw "fetch failed".
 *
 * Now the window is the subscription CLIs' own (cliSilenceWindowMs: CLI_SILENCE_WINDOW_MS = 20 min, the same test hook
 * AGENTLAS_CLI_SILENCE_WINDOW_MS) and it counts the same thing: time with no byte from the other side. It restarts at every
 * body chunk. Undici's two 300 s timers are switched off for these requests (dispatcher below), so this is the only clock.
 * When it runs out the attempt ends with the CLIs' closed word (RUNTIME_SILENT_TIMEOUT_CODE) and the CLIs' sentence
 * (runnerFailureFromError -> runtimeSilentTimeoutFailure). Not a new word, not a new sentence.
 *
 * Why 20 minutes is enough for a local model that digests a large input before its first token: it is four times the old
 * 300 s, and the first-response distribution of the CLIs (median 14.7 s, p90 27.3 s, 30-day measurement) is 44 times smaller.
 * No local first-token distribution was measured (audit set-values-audit/desktop, section 4: "to measure"), so this is a
 * borrowed window, not a measured one; AGENTLAS_CLI_SILENCE_WINDOW_MS raises or lowers it.
 *
 * A connection that is never made is not silence: undici's connect timeout (10 s, left on) and the socket codes stay with
 * network_unreachable / endpoint_unreachable and reconnecting-fetch.ts.
 */

/** Typed end of a silent model request. Carries the closed word as its `code` so every typed-code reader sees it. */
export class ApiSilenceError extends Error {
  readonly code = RUNTIME_SILENT_TIMEOUT_CODE;
  readonly windowMs: number;
  constructor(windowMs: number) {
    super(`no data from the model server for ${Math.round(windowMs / 1000)}s; the host ended the attempt`);
    this.name = "ApiSilenceError";
    this.windowMs = windowMs;
  }
}

/** The silence error in a thrown value (directly or as a cause), or null. Typed fields only, never prose. */
export function apiSilenceError(error: unknown): ApiSilenceError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (current instanceof ApiSilenceError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Undici's own two timers, in case a request still reaches them (the dispatcher could not be built). Both are 300 s there. */
const UNDICI_SILENCE_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const UNDICI_DEFAULT_SILENCE_MS = 300_000;

function undiciSilence(error: unknown): ApiSilenceError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNDICI_SILENCE_CODES.has(code)) return new ApiSilenceError(UNDICI_DEFAULT_SILENCE_MS);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Node's own fetch dispatcher class, built with undici's headers/body timers off. Taken from the running global dispatcher so it is
 * the same undici the fetch uses (a second copy of undici could not be handed to it safely). Only a plain Agent / EnvHttpAgent is
 * rebuilt: any other global dispatcher (a ProxyAgent set by someone) is left alone, so a proxy is never bypassed.
 */
let dispatcher: object | null | undefined;
function untimedDispatcher(): object | null {
  if (dispatcher !== undefined) return dispatcher;
  dispatcher = null;
  try {
    void Response; // loads Node's lazy undici, which installs the global dispatcher
    const current = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] as { constructor?: { name?: string } } | undefined;
    const Class = current?.constructor as (new (options: object) => object) | undefined;
    if (typeof Class === "function" && (Class.name === "Agent" || Class.name === "EnvHttpAgent")) {
      dispatcher = new Class({ headersTimeout: 0, bodyTimeout: 0 });
    }
  } catch { dispatcher = null; }
  return dispatcher;
}

export interface SilenceGuardOptions {
  /** Test seam; default cliSilenceWindowMs() (20 min, AGENTLAS_CLI_SILENCE_WINDOW_MS). */
  windowMs?: number;
}

/**
 * fetch, ended with ApiSilenceError when the other side sends nothing for the window: before the response headers, or between
 * two body chunks. The caller's own signal (Stop) still wins and keeps its reason.
 */
export async function silenceGuardedFetch(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: SilenceGuardOptions = {},
): Promise<Response> {
  const userSignal = init?.signal ?? null;
  if (userSignal?.aborted) return fetchImpl(input, init);
  const windowMs = options.windowMs ?? cliSilenceWindowMs();
  const own = new AbortController();
  const silence = new ApiSilenceError(windowMs);
  let tripped = false;
  let onTrip: (() => void) | null = null;
  let rejectHeaders: ((error: Error) => void) | null = null;
  const timer = setTimeout(() => {
    tripped = true;
    own.abort(silence);
    onTrip?.();
    rejectHeaders?.(silence);
  }, windowMs);
  timer.unref?.();
  let finished = false;
  const onUserAbort = (): void => clear();
  // Every way out ends the clock and drops the listener, so a long turn's one Stop signal never collects one listener per request.
  const clear = (): void => { finished = true; clearTimeout(timer); userSignal?.removeEventListener("abort", onUserAbort); };
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  const signal = userSignal ? AbortSignal.any([userSignal, own.signal]) : own.signal;
  const withDispatcher = untimedDispatcher();
  const guardedInit = { ...init, signal, ...(withDispatcher && !(init as { dispatcher?: unknown } | undefined)?.dispatcher ? { dispatcher: withDispatcher } : {}) } as RequestInit;
  let response: Response;
  try {
    response = await Promise.race([
      fetchImpl(input, guardedInit),
      new Promise<never>((_, reject) => { rejectHeaders = reject; }),
    ]);
  } catch (error) {
    clear();
    if (tripped) throw silence;
    throw undiciSilence(error) ?? error;
  }
  rejectHeaders = null;
  if (!response.body) { clear(); return response; }
  timer.refresh();
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onTrip = () => {
        try { controller.error(silence); } catch { /* already closed */ }
        reader.cancel(silence).catch(() => {});
      };
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { clear(); controller.close(); return; }
        if (!finished) timer.refresh();
        controller.enqueue(value);
      } catch (error) {
        clear();
        controller.error(tripped ? silence : undiciSilence(error) ?? error);
      }
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
