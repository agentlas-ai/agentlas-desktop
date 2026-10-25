// Which bind failures of the phone's remembered port can be waited out, which
// mean "this port is not ours to use", and the start/rebind loop that falls
// back to a fresh port instead of losing the whole bridge (and its relay).
//
// Windows: Hyper-V, WSL and Docker reserve parts of the dynamic port range at
// boot ("excluded port range", `netsh int ipv4 show excludedportrange`). A
// bind inside a reserved range fails with EACCES (WSAEACCES), and another
// process holding the port with SO_EXCLUSIVEADDRUSE fails the same way. Only
// EADDRINUSE used to fall back, so a reserved remembered port failed every
// launch: no listener, no relay, the same port tried again next time.

export type MobileBridgePortFailure = "busy" | "forbidden" | null;

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * "busy": someone holds the port now and may release it (update restart,
 * TIME_WAIT) — worth waiting. "forbidden": the OS refuses this port to us
 * (reserved range, exclusive owner, permission) — waiting will not help.
 * null: not a port problem (TLS, host address, …) — the caller's error stands.
 */
export function classifyMobileBridgePortFailure(error: unknown): MobileBridgePortFailure {
  const code = errorCode(error);
  if (code === "EADDRINUSE") return "busy";
  if (code === "EACCES" || code === "EPERM") return "forbidden";
  if (code) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|address already in use/i.test(message)) return "busy";
  if (/\b(?:EACCES|EPERM)\b|permission denied|access permissions/i.test(message)) return "forbidden";
  return null;
}

export interface RetainedPortStartOptions<T> {
  /** The phone's remembered port, or undefined when there is none (or an explicit override owns the port). */
  readonly retainedPort: number | undefined;
  /** Start on a given port; `undefined` means "use the configured default". */
  readonly start: (port: number | undefined) => Promise<T>;
  /** Waits between "busy" retries; exhausted → fresh port. */
  readonly busyRetryDelaysMs: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onFallback?: (retainedPort: number, failure: Exclude<MobileBridgePortFailure, null>) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Start on the remembered port; wait out a busy port, and fall back to an
 * ephemeral port (0) when it stays busy or is forbidden. Without a remembered
 * port every error is the caller's.
 */
export async function startWithRetainedMobileBridgePort<T>(options: RetainedPortStartOptions<T>): Promise<T> {
  const { retainedPort } = options;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await options.start(retainedPort);
    } catch (error) {
      if (!retainedPort) throw error;
      const failure = classifyMobileBridgePortFailure(error);
      if (!failure) throw error;
      const delayMs = failure === "busy" ? options.busyRetryDelaysMs[attempt] : undefined;
      if (delayMs === undefined) {
        options.onFallback?.(retainedPort, failure);
        return options.start(0);
      }
      await sleep(delayMs);
    }
  }
}
