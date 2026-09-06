/** Synchronous loading preserves existing IPC transaction/receipt ordering. */
export function createScienceLazyBoundary<T>(available: () => boolean, factory: () => T) {
  let state: "unloaded" | "loading" | "loaded" | "failed" = "unloaded";
  let value: T | undefined;
  let failure: Error | undefined;
  return {
    get(): T {
      if (!available()) throw new Error("science-extension-not-active");
      if (state === "loaded") return value!;
      if (state === "failed") throw failure;
      if (state === "loading") throw new Error("science-runtime-load-reentrant");
      state = "loading";
      try {
        value = factory();
        state = "loaded";
        return value;
      } catch (cause) {
        failure = new Error("science-runtime-load-failed", { cause });
        state = "failed";
        throw failure;
      }
    },
    peek(): T | undefined { return state === "loaded" ? value : undefined; },
    retryFailed(): void {
      if (state !== "failed") return;
      failure = undefined;
      state = "unloaded";
    },
  };
}
