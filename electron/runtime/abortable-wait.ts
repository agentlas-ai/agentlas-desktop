/** Stop waiting when the owning run ends; the underlying operation keeps its own cleanup contract. */
export async function waitForAbort<T>(signal: AbortSignal | undefined, pending: Promise<T>): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([pending, stopped]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
