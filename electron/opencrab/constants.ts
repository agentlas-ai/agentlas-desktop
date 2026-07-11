/** OpenCrab is an optional, Desktop-internal MCP knowledge source. */
export const OPENCRAB_CATALOG_ID = "opencrab";
export const OPENCRAB_MCP_URL_KEY = "OPENCRAB_MCP_URL";
export const OPENCRAB_MCP_URL_SENTINEL = `vault://${OPENCRAB_MCP_URL_KEY}`;
export const OPENCRAB_QUERY_TOOL = "ontology_query";

const VAULT_URL_PREFIX = "vault://";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const OPENCRAB_CREDENTIAL_PATTERN = /ocm_[A-Za-z0-9_-]{12,}/;

/** Detect both official OpenCrab URLs and token-shaped malformed values before
 *  URL parsing. Every persistence/config/runtime boundary uses this predicate. */
export function isOpenCrabCredentialUrl(value: string | null | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw) return false;
  OPENCRAB_CREDENTIAL_PATTERN.lastIndex = 0;
  if (OPENCRAB_CREDENTIAL_PATTERN.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "opencrab.sh" || hostname.endsWith(".opencrab.sh");
  } catch {
    return false;
  }
}

/**
 * Return the Keychain env-vault key referenced by a remote MCP URL sentinel.
 * A sentinel is safe to persist; the URL it points to is not.
 */
export function vaultUrlKey(value: string | null | undefined): string | null {
  if (!value?.startsWith(VAULT_URL_PREFIX)) return null;
  const key = value.slice(VAULT_URL_PREFIX.length);
  return ENV_KEY_RE.test(key) ? key : null;
}

export function isVaultBackedRemoteUrl(value: string | null | undefined): boolean {
  return vaultUrlKey(value) !== null;
}

/**
 * OpenCrab's primary public source names opencrab.sh as the hosted ecosystem.
 * Keep the path-credential endpoint on that exact trust boundary: HTTPS only,
 * no alternate port, userinfo, query, or fragment. The token may live only in
 * the path and is intentionally never returned from this helper's errors.
 */
export function validateOpenCrabMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenCrab MCP endpoint is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const officialHost = hostname === "opencrab.sh" || hostname.endsWith(".opencrab.sh");
  if (
    url.protocol !== "https:" ||
    !officialHost ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new Error("OpenCrab MCP endpoint is invalid");
  }
  return url;
}
