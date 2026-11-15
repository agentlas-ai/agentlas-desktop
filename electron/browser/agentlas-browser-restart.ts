/**
 * Restarts the dedicated Agentlas browser (the browser fallback ladder's restart step calls it). Allowed without asking: close the dedicated browser only when no other
 * run holds a lease, then make sure the host is up and its CDP port answers. Never throws; false means "not ready".
 */
export async function restartAgentlasBrowser(): Promise<boolean> {
  const launcher = await import("../mcp-tools/browser-cdp-launcher");
  const closed = await launcher.closeBrowserCdpIfIdle(0).catch(() => ({ closed: false, reason: "close-failed" as const, pid: null }));
  // Another run holds a lease: do not pull the browser out from under it; only make sure a host answers.
  if (!closed.closed && closed.reason === "active-leases") {
    try {
      const ownership = await launcher.reconcileBrowserCdpOwnerWithRetry();
      return ownership.state === "owned" && await launcher.browserCdpPortReady();
    } catch { return false; }
  }
  try { await launcher.ensureBrowserCdpHost(); } catch { return false; }
  return launcher.browserCdpPortReady();
}
