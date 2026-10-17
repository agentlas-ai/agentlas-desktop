import { KEYED_ADAPTERS } from "./keyed-provider";

/**
 * The keyed host route that serves the same provider as an installed connector.
 * The route counts only when the owner's saved key for it is present.
 *
 * Production 2026-10-17, Yotube room. ElevenLabs was installed as its remote
 * MCP (api.us.elevenlabs.io, OAuth only, no declared env keys). The owner's
 * ElevenLabs key was in the Vault, and every run already received it. Even so,
 * auth.ensure saw only the missing OAuth sign-in and pointed to auth.login, so
 * the room asked the owner to re-authenticate a service their key already
 * served.
 *
 * Matching is by registrable domain: the connector host equals the provider
 * domain or is a subdomain of it, never a look-alike name.
 */
export async function keyedRouteForConnectorUrl(
  url: string | null | undefined,
  hasKey: (envKey: string) => Promise<boolean>,
): Promise<string | null> {
  let host: string;
  try { host = new URL(String(url ?? "")).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  for (const adapter of Object.values(KEYED_ADAPTERS)) {
    const domain = new URL(adapter.base).hostname.toLowerCase().split(".").slice(-2).join(".");
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (await hasKey(adapter.envKey).catch(() => false)) return adapter.routeId;
  }
  return null;
}
