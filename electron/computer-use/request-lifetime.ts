/** One rule for both generated clients. Queueing remains bounded by the client;
 * disconnect revokes the server request instead of allowing a late effect. */
export const COMPUTER_USE_REQUEST_BUDGET_SOURCE = String.raw`function computerUseRequestBudget(route, body, readBudgetMs = 8000) {
  if (route.endsWith('/action') && body.action !== 'listApps') return body.action === 'drag' ? 45000 : 40000;
  if (route.endsWith('/observe')) return 20000;
  return Math.max(500, Math.min(readBudgetMs, 12000));
}`;

export function assertRequestCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("computer-use-request-aborted"), { code: "computer-use-request-aborted" });
}

/** Explicit disposal works on every supported Electron/Node runtime; no
 * AbortSignal.any dependency or listeners retained after an operation ends. */
export function linkedAbortSignals(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const inputs = [...new Set(signals.filter((value): value is AbortSignal => !!value))];
  const abort = () => controller.abort();
  const dispose = () => { for (const signal of inputs) signal.removeEventListener("abort", abort); };
  for (const signal of inputs) signal.addEventListener("abort", abort, { once: true });
  if (inputs.some(signal => signal.aborted)) abort();
  controller.signal.addEventListener("abort", dispose, { once: true });
  return { signal: controller.signal, dispose: () => { dispose(); controller.signal.removeEventListener("abort", dispose); } };
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  assertRequestCurrent(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); try { assertRequestCurrent(signal); } catch (error) { reject(error); } };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
