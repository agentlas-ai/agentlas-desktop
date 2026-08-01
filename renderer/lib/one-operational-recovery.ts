import { redactSecrets } from "@shared/secret-patterns";

export const ONE_OPERATIONAL_RECOVERY_EVENT = "agentlas:one-operational-recovery";

export type OneOperationalRecoveryDetail = {
  scope: string;
  evidence: string;
};

let recoveryDispatchSuppressionDepth = 0;

/**
 * Recovery uses the same IPC bridge as ordinary product work. Suppress event
 * emission while that controller turn is being accepted or receipt-checked,
 * otherwise a temporarily unavailable controller would recursively create a
 * second recovery incident for its own transport failure.
 */
export async function withOneOperationalRecoveryDispatchSuppressed<T>(
  operation: () => Promise<T>,
): Promise<T> {
  recoveryDispatchSuppressionDepth += 1;
  try {
    return await operation();
  } finally {
    recoveryDispatchSuppressionDepth = Math.max(0, recoveryDispatchSuppressionDepth - 1);
  }
}

/** Send private operational evidence to the mounted One controller. */
export function requestOneOperationalRecovery(scope: string, cause: unknown): void {
  if (typeof window === "undefined" || recoveryDispatchSuppressionDepth > 0) return;
  let rawEvidence: string;
  if (cause instanceof Error) {
    rawEvidence = [cause.name, cause.message, cause.stack].filter(Boolean).join("\n");
  } else if (cause && typeof cause === "object") {
    try { rawEvidence = JSON.stringify(cause); }
    catch { rawEvidence = Object.prototype.toString.call(cause); }
  } else {
    rawEvidence = String(cause ?? "");
  }
  const evidence = redactSecrets(rawEvidence, "[private value removed]")
    .replace(/\s+/g, " ")
    .trim();
  window.dispatchEvent(new CustomEvent<OneOperationalRecoveryDetail>(
    ONE_OPERATIONAL_RECOVERY_EVENT,
    { detail: { scope: scope.slice(0, 120), evidence: evidence.slice(0, 4_000) } },
  ));
}
