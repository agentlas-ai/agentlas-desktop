/**
 * One log line for a phone read that failed, hung, or was slow (diagnostics only; the answer is unchanged).
 *
 * Why (2026-10-28): the phone's Hope screen stayed blank while `one.supervisor.snapshot` failed or hung, and main.log had
 * nothing — the bridge only logged a generic "authority request timed out" (no method, no stage, no time). The line names
 * the method, the stage that was running, a machine code, the elapsed time and the request time. Never the payload,
 * conversation text or error prose (prose may carry user text or paths): a code is logged only when it looks like one.
 */
export const MOBILE_REQUEST_SLOW_MS = 5_000;
export const MOBILE_REQUEST_WATCH_MS = 10_000;

const MACHINE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

export function mobileRequestFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && MACHINE_CODE.test(code)) return code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (MACHINE_CODE.test(message)) return message;
  const name = error instanceof Error ? error.constructor?.name : typeof error;
  return `unclassified:${typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "unknown"}`;
}

export interface MobileRequestTimingOptions {
  now?: () => number;
  log?: (line: string) => void;
  slowMs?: number;
  watchMs?: number;
}

/** Runs `work`, logging failure (code, stage, elapsed), a still-running mark at `watchMs`, and success slower than `slowMs`. */
export async function withMobileRequestTiming<T>(
  method: string,
  work: (stage: (name: string) => void) => Promise<T>,
  options: MobileRequestTimingOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const startedAt = now();
  const requestedAt = new Date(startedAt).toISOString();
  let stage = "start";
  const elapsed = () => Math.max(0, now() - startedAt);
  const watch = setTimeout(() => {
    log(`[mobile-bridge] ${method} still running stage=${stage} elapsedMs=${elapsed()} requestedAt=${requestedAt}`);
  }, options.watchMs ?? MOBILE_REQUEST_WATCH_MS);
  watch.unref?.();
  try {
    const result = await work((name) => { stage = name; });
    const took = elapsed();
    if (took >= (options.slowMs ?? MOBILE_REQUEST_SLOW_MS)) {
      log(`[mobile-bridge] ${method} slow ok elapsedMs=${took} lastStage=${stage} requestedAt=${requestedAt}`);
    }
    return result;
  } catch (error) {
    log(`[mobile-bridge] ${method} failed code=${mobileRequestFailureCode(error)} stage=${stage} elapsedMs=${elapsed()} requestedAt=${requestedAt}`);
    throw error;
  } finally {
    clearTimeout(watch);
  }
}
