import dns from "node:dns";
import net from "node:net";
import { WebToolError } from "./errors";

// basis: the tool schema (shared/builtin-tools.ts web_read.url maxLength) and the common 2,000-character URL limit of browsers and CDNs.
export const WEB_ADDRESS_MAX_CHARS = 2000;

function ipv4Private(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254)           // link-local (cloud metadata lives here)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

/** True for loopback, private, link-local and unspecified addresses (IPv4, IPv6 and IPv4-mapped IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/gu, "").split("%")[0].toLowerCase();
  if (net.isIPv4(bare)) {
    const [a, b] = bare.split(".").map(Number);
    return ipv4Private(a, b);
  }
  if (net.isIPv6(bare)) {
    if (bare === "::" || bare === "::1") return true;
    const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(bare);
    if (mapped) return ipv4Private(Number(mapped[1]), Number(mapped[2]));
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(bare);
    if (hex) { const hi = parseInt(hex[1], 16); return ipv4Private(hi >> 8, hi & 255); }
    const first = parseInt(bare.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 unique-local, fe80::/10 link-local
  }
  return false;
}

/** The host names that are the person's own machine or LAN without being an IP literal. */
function localName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
    || host.endsWith(".lan") || host.endsWith(".home.arpa")
    || !host.includes("."); // a single-label name resolves through the LAN's search domain
}

/** Parse and check an address the model gave: http(s) only, no credentials, not the person's own machine or network. */
export function checkWebAddress(input: unknown): URL {
  if (typeof input !== "string" || !input.trim() || input.length > WEB_ADDRESS_MAX_CHARS) throw new WebToolError("address_refused", "not a usable address");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new WebToolError("address_refused", "not a valid address"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebToolError("address_refused", "only http and https addresses are read");
  if (url.username || url.password) throw new WebToolError("address_refused", "addresses with credentials are not read");
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (net.isIP(host) ? isPrivateAddress(host) : localName(host)) throw new WebToolError("address_refused", "local and private network addresses are not read");
  return url;
}

/** The same rule after a DNS lookup: a public-looking name that resolves to a private address is refused. */
export async function hostResolvesPublic(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/gu, "");
  if (net.isIP(bare)) return !isPrivateAddress(bare);
  try {
    const found = await dns.promises.lookup(bare, { all: true });
    return found.length > 0 && found.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return true; // unresolvable here: the browser's own lookup fails the same way and reports page_failed
  }
}
