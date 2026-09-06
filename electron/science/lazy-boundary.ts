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
        // Electron IPC/log serialization drops Error.cause. Preserve a bounded
        // diagnostic without exposing module search paths or user data.
        const code = cause && typeof cause === "object" && "code" in cause
          ? String(cause.code).replace(/[^A-Z0-9_]/g, "").slice(0, 80) : "LOAD_ERROR";
        const missingModule = cause instanceof Error && code === "MODULE_NOT_FOUND"
          ? /^Cannot find module '([@a-zA-Z0-9._/-]+)'/.exec(cause.message)?.[1] : undefined;
        const safeModule = missingModule && !missingModule.startsWith("/") && !missingModule.startsWith(".")
          ? missingModule.slice(0, 160) : undefined;
        console.error(`[science-runtime] service load failed code=${code || "LOAD_ERROR"}${safeModule ? ` module=${safeModule}` : ""}`);
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
