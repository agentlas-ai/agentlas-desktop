import type { NativeBrowserCookieImportResult } from "../../shared/types";

/** Keep unrelated Connect sites and their diagnostics inside Main. */
export function nativeSessionForUrl(
  receipts: ReadonlyMap<string, NativeBrowserCookieImportResult> | undefined,
  url: string,
): NativeBrowserCookieImportResult | undefined {
  if (!receipts) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const domain = [...receipts.keys()].filter((candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`))
    .sort((a, b) => b.length - a.length)[0];
  return domain ? receipts.get(domain) : undefined;
}
