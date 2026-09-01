import type { ScienceLongRunProjectionSink } from "./long-run-bridge";
import {
  closeScienceRuntimeAdmission,
  installScienceLongRunBridge,
  recoverScienceRuntimeAtStartup,
  scienceRuntimeSettled,
  shutdownScienceRuntimeForAppClose,
} from "./runtime";

export interface ScienceDesktopLongRunAdapter {
  recoverAndProjectAtStartup(): ReturnType<typeof recoverScienceRuntimeAtStartup>;
  closeAdmission(): void;
  interrupt(): Promise<void>;
  isSettled(): boolean;
}

/**
 * App-bundled, in-process lifecycle boundary for the unified Desktop build.
 * The composition root injects the common read-only projection sink; Science
 * never imports or writes the common Desktop database directly.
 */
export function createScienceDesktopLongRunAdapter(
  sink: ScienceLongRunProjectionSink,
  options: { shutdownTimeoutMs?: number } = {},
): ScienceDesktopLongRunAdapter {
  let installed = false;
  return {
    async recoverAndProjectAtStartup() {
      if (!installed) {
        // Subscribe while admission is closed, but defer reconciliation until
        // recoverScienceRuntimeAtStartup has paused crash-interrupted loops.
        await installScienceLongRunBridge(sink, { reconcile: false });
        installed = true;
      }
      return recoverScienceRuntimeAtStartup();
    },
    closeAdmission: closeScienceRuntimeAdmission,
    async interrupt() {
      const report = await shutdownScienceRuntimeForAppClose(options.shutdownTimeoutMs);
      if (report.timedOut) throw new Error("science_runtime_shutdown_timed_out");
    },
    isSettled: scienceRuntimeSettled,
  };
}
