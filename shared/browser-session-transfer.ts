/** Google account sessions must be minted independently in each browser surface. */
export function isProtectedBrowserSessionHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let host = value.toLowerCase().replace(/^\./u, "").replace(/\.$/u, "");
  try { if (host.includes("://")) host = new URL(host).hostname; } catch { return true; }
  return /(?:^|\.)youtube\.com$/u.test(host)
    || /(?:^|\.)google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/u.test(host);
}

export const PROTECTED_BROWSER_SESSION_TRANSFER = "protected-session-transfer";
