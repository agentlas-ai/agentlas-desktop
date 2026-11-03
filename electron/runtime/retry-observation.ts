import { AsyncLocalStorage } from "node:async_hooks";

// Host-local transport observation only. No request/model data can mint this scope.
const observation = new AsyncLocalStorage<(status: number, retryAfter: string | null | undefined) => void>();
export function withRuntimeRetryObservation<T>(observe: (status: number, retryAfter: string | null | undefined) => void,
  invoke: () => T): T {
  return observation.run(observe, invoke);
}
/** Called at the actual HTTP header boundary, before an abortable error body. */
export function observeRuntimeRetryAfter(status: number, retryAfter?: string | null): void {
  if (status === 429 || status >= 500 && status <= 599) observation.getStore()?.(status, retryAfter);
}
