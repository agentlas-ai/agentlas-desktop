/*
 * One transport rule for the API runners (BYOK Anthropic and Google, the OpenAI-compatible local tool loop, Agentlas serving):
 * a request that provably never reached the server is sent again, but only after the run has already done work.
 *
 * "Never reached the server" is read from socket error codes (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH,
 * ENETUNREACH), never from prose: no connection was made, so the same request cannot repeat anything the server did. The
 * request body is resent as is, so it must be a string or bytes (a stream cannot be replayed).
 *
 * The first request of a run is refused at once, as before: a local server that is switched off must not hold the owner for
 * two minutes while another runtime could answer. Once work started (a tool ran, a later turn), the server going away for a
 * moment (a model server restarting, a laptop changing networks) is waited out for at most RECONNECT_MAX_MS, then the last
 * error is thrown unchanged, which is the behaviour before this wrapper. Stop ends the wait at once.
 */

/** Socket-level codes that prove the request never reached the server (no TCP connection, no name). Typed, not prose. */
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function fetchNeverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NOT_CONNECTED_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Longest total time spent reconnecting one request. */
export const RECONNECT_MAX_MS = 120_000;
const RECONNECT_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export interface ReconnectOptions {
  /** True once the run did work a refusal would otherwise throw away (a later turn, a tool call). False: fail at once. */
  workStarted: () => boolean;
  signal?: AbortSignal | null;
  /** Called before each wait with the time spent reconnecting so far (the owner's status line). */
  onWait?: (waitedMs: number) => void;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
}

function replayableBody(body: unknown): boolean {
  return body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function fetchWithReconnect(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: ReconnectOptions,
): Promise<Response> {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const now = options.now ?? Date.now;
  let startedAt: number | null = null;
  let step = 0;
  for (;;) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (options.signal?.aborted || !fetchNeverConnected(error) || !options.workStarted() || !replayableBody(init?.body)) throw error;
      const current = now();
      startedAt ??= current;
      const waited = current - startedAt;
      const wait = RECONNECT_STEPS_MS[Math.min(step, RECONNECT_STEPS_MS.length - 1)]!;
      // A wait that would end past the limit (or a clock that jumped far ahead) is the end of reconnecting: the last error stands.
      if (waited < 0 || waited + wait > RECONNECT_MAX_MS) throw error;
      step += 1;
      options.onWait?.(waited);
      await sleep(wait, options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
}
