import { KEYED_ADAPTERS } from "./keyed-provider";

/**












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
