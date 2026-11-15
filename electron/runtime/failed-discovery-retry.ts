/**
 * When a FAILED model listing may be asked again by itself.
 *
 * A listing fails for a reason a timer does not fix (signed out, a denied account, an offline machine), and every retry
 * starts a CLI process (`agy models`, `grok models`, `npx -y @github/copilot --acp`). It used to be retried every minute
 * (agy, grok) or every 30 minutes (ACP) for as long as the app ran. Now it is retried after 1, 2, 4, 8 and 16 minutes and
 * then no more until something changes: a sign-in, a CLI update, the owner's "check again" or an app start. Each of those
 * already clears these caches (detect.ts invalidateRuntimeDetection, forgetSignedOutAcpModelProbes,
 * forgetFailedAcpModelProbes), which resets the count.
 *
 * The first wait stays 60 s, the value the old fixed retry used. Returns Infinity when no timed retry is left.
 */
export const FAILED_DISCOVERY_RETRY_WAITS_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 960_000];

export function failedDiscoveryRetryWaitMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return FAILED_DISCOVERY_RETRY_WAITS_MS[consecutiveFailures - 1] ?? Number.POSITIVE_INFINITY;
}
