import { isStoreBusyError } from "../../shared/transient-send-refusal";

/**
 * The run's tool table is built by one call (mcp-tools/mcp-config.ts buildMcpConfigFile). A throw there means the table is not
 * ready; nothing has reached the model. Most throws are the app's own host not being ready yet: the tool gate that is bound on
 * demand, the OS host a Hope turn needs, a store lock, a Goal usage ledger caught between two writes. Those clear in seconds, so
 * the build is tried again inside the run (about a minute at most) instead of ending the run with "send it again" (production 8 runs, 3
 * reasons, each fixed one by one, the catch-all stayed).
 *
 * Only codes named here are tried again. A credential the owner has to give, a server definition that is wrong, the Goal changing
 * under the run, the run ending and the browser host being signed out are not "not ready yet": they end the run as before.
 */
export const MCP_CONFIG_HOST_NOT_READY_CODES: ReadonlySet<string> = new Set([
  // The tool gate / proxy child that carries every tool call is bound on demand and may not be listening yet.
  "mcp_proxy_gate_unavailable",
  "mcp_proxy_child_unavailable",
  "plan_mode_mcp_gate_unavailable",
  "plan_mode_mcp_proxy_unavailable",
  "one_mcp_scoped_proxy_unavailable",
  "computer-use-tool-gate-unavailable",
  "browser-read-only-gate-unavailable",
  "browser-main-gate-unavailable",
  // The OS host that Hope's device tools need is restarting (daemon restart, update).
  "supervisor_os_host_unavailable",
  "one-os-lease-host-unavailable",
  // A Goal's usage ledger caught between two writes (system-agents/accounting-best-effort.ts).
  "long_run_usage_start_source_mismatch",
  // Main's browser broker answering late or not yet listening (the run's native browser grant; native-browser-broker-timeout).
  "native-browser-broker-timeout",
  "native-browser-host-unavailable",
  "store_busy",
]);

/**
 * Waits before the 2nd to 8th build, about a minute in all. Every message the composer, the phone or the mail intake started directly
 * is waited for here (only a message held in the send queue is started again afterwards), so the wait has to cover the app's own
 * host coming back: the OS host and the tool gate take 5-30 s after a background-service restart or an update. Stop ends it at once.
 */
export const MCP_CONFIG_BUILD_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000, 6_000, 10_000, 15_000, 25_000];

export function mcpConfigBuildHostNotReady(code: string | null, error: unknown): boolean {
  return (code !== null && MCP_CONFIG_HOST_NOT_READY_CODES.has(code)) || isStoreBusyError(error);
}

/**
 * Whether a run that failed with "mcp-runtime-config-unavailable" / "mcp-goal-tool-scope-changed" failed for a cause that clears by itself.
 * mcp/client.ts folds every thrown build error into the first code, so the code alone cannot say; the run's own mcp_config_failure event
 * carries the reason (MCP_CONFIG_HOST_NOT_READY_CODES). A Goal that moved under the run always clears. No event, an unreadable ledger or any
 * other reason is NOT a waiting cause: the message keeps the bounded tries and host-recovery takes it over.
 */
export function hostNotReadyRunCause(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, runId: string | null | undefined, code: string | null | undefined): boolean {
  if (code === "mcp-goal-tool-scope-changed") return true;
  if (code !== "mcp-runtime-config-unavailable" || !runId) return false;
  try {
    const row = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_config_failure' ORDER BY rowid DESC LIMIT 1")
      .get(runId) as { payload_json?: string | null } | undefined;
    if (!row?.payload_json) return false;
    const reason = (JSON.parse(row.payload_json) as { reasonCode?: unknown }).reasonCode;
    // A locked store clears too: the build's own wait (mcpConfigBuildHostNotReady) counts isStoreBusyError, which also matches these codes.
    return typeof reason === "string" && (MCP_CONFIG_HOST_NOT_READY_CODES.has(reason) || /^sqlite_(busy|locked)/i.test(reason));
  } catch { return false; }
}

function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = (): void => { clearTimeout(timer); resolve(); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Build the run's tool table, trying again while the cause is the host not being ready. `build` must be safe to call again (it makes
 * a fresh sealed config each time). Rethrows the last error once the bounded waits are used up, or at once for any other cause,
 * an aborted run or a Goal/run scope that has ended.
 */
export async function retryMcpConfigBuild<T>(build: () => Promise<T>, input: {
  /** Bounded machine code of a thrown value (client.ts mcpConfigFailureCode). */
  code(error: unknown): string | null;
  signal?: AbortSignal;
  /** False once the run or its Goal scope has ended: no more tries. */
  current(): boolean;
  delaysMs?: readonly number[];
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  onRetry?(info: { attempt: number; delayMs: number; code: string | null }): void;
}): Promise<T> {
  const delays = input.delaysMs ?? MCP_CONFIG_BUILD_RETRY_DELAYS_MS;
  const wait = input.wait ?? waitUnlessAborted;
  for (let attempt = 0; ; attempt += 1) {
    try { return await build(); }
    catch (error) {
      if (input.signal?.aborted || !input.current()) throw error;
      const code = input.code(error);
      if (attempt >= delays.length || !mcpConfigBuildHostNotReady(code, error)) throw error;
      const delayMs = delays[attempt]!;
      input.onRetry?.({ attempt: attempt + 1, delayMs, code });
      await wait(delayMs, input.signal);
      if (input.signal?.aborted || !input.current()) throw error;
    }
  }
}
