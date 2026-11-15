import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Host-side GET of a URL that a model or a remote payload named.
 *
 * Main fetches outside any CLI sandbox, so such a URL must reach only the public
 * internet: every hop is resolved, every resolved address is checked against the
 * private, loopback, link-local and reserved ranges below, and the connection is
 * pinned to the checked address (no resolve/check/connect rebinding gap).
 * - https only; no credentials in the URL
 * - redirects are followed by hand, at most `maxRedirects`, each hop re-checked
 * - the body is streamed and refused past `maxBytes`
 *
 * The ranges are a copy of the publish verifier's list (site/agent-app-publish.ts,
 * `unsafeDeploymentAddresses`), which keeps its own copy for now.
 * No Electron import: the daemon loads this too.
 */

export type PublicFetchRefusalCode =
  | "blocked_private_address"
  | "blocked_insecure_url"
  | "too_many_redirects"
  | "response_too_large";

export class PublicFetchRefusal extends Error {
  readonly code: PublicFetchRefusalCode;
  constructor(code: PublicFetchRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PublicFetchRefusal";
    this.code = code;
  }
}

const blockedAddresses = (() => {
  const block = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) block.addSubnet(network, prefix, "ipv4");
  block.addAddress("::", "ipv6");
  block.addAddress("::1", "ipv6");
  // Node's BlockList maps IPv4 checks through IPv4-mapped IPv6 internally.
  // Blocking the entire ::ffff:0:0/96 range would therefore reject every
  // public IPv4 address too; the IPv4 ranges above still match mapped private
  // addresses such as ::ffff:127.0.0.1.
  block.addSubnet("fc00::", 7, "ipv6");
  block.addSubnet("fe80::", 10, "ipv6");
  block.addSubnet("ff00::", 8, "ipv6");
  block.addSubnet("2001:db8::", 32, "ipv6");
  // VD: forms that embed or tunnel to an IPv4 address (a private one included) are not public hosts either. basis: RFC 6052 NAT64 (64:ff9b::/96, 64:ff9b:1::/48),
  // RFC 3056 6to4 (2002::/16), RFC 4380 Teredo (2001::/32), RFC 3879 site-local (fec0::/10), RFC 6666 discard (100::/64). A host reachable only through them is refused (blocked_private_address).
  block.addSubnet("64:ff9b::", 96, "ipv6");
  block.addSubnet("64:ff9b:1::", 48, "ipv6");
  block.addSubnet("2002::", 16, "ipv6");
  block.addSubnet("2001::", 32, "ipv6");
  block.addSubnet("fec0::", 10, "ipv6");
  block.addSubnet("100::", 64, "ipv6");
  return block;
})();

export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * VD: a NAME that is private by its form, refused before any lookup (the resolved addresses are checked as well - this rule only saves the lookup and names the cases a resolver may answer
 * oddly): `localhost`, a name with one label (an intranet short name), and the suffixes that RFC 6761 / RFC 8375 / common practice reserve for private networks.
 */
const PRIVATE_NAME_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "home.arpa", "intranet", "corp", "private"] as const;
export function isBlockedHostName(hostname: string): boolean {
  const name = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
  if (name === "" || isIP(name)) return false;     // an IP literal is judged by address, not by name
  if (!name.includes(".")) return true;
  return PRIVATE_NAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

async function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows
    .filter((row): row is { address: string; family: 4 | 6 } => row.family === 4 || row.family === 6)
    .map((row) => ({ address: row.address, family: row.family }));
}

/** Checks one hop and returns the address to pin. Throws PublicFetchRefusal. */
export async function checkPublicHttpsTarget(url: URL, resolveHost: ResolveHost = defaultResolveHost): Promise<ResolvedAddress> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PublicFetchRefusal("blocked_insecure_url", `${url.protocol} is not fetched`);
  }
  if (url.username || url.password) throw new PublicFetchRefusal("blocked_insecure_url", "credentials in the URL");
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(hostname);
  if (isBlockedHostName(hostname)) throw new PublicFetchRefusal("blocked_private_address", "a private name");
  const addresses = literal ? [{ address: hostname, family: literal as 4 | 6 }] : await resolveHost(hostname);
  if (!addresses.length) throw new Error(`No address for ${hostname}.`);
  // Checked before the scheme, so a private target is named as such whatever its scheme.
  if (addresses.some((entry) => isBlockedAddress(entry.address, entry.family))) {
    throw new PublicFetchRefusal("blocked_private_address", hostname);
  }
  if (url.protocol !== "https:") throw new PublicFetchRefusal("blocked_insecure_url", "only https is fetched");
  return addresses[0];
}

export interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer | string> & { destroy(error?: Error): void };
}

export type PinnedTransport = (input: {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<PinnedResponse>;

const defaultTransport: PinnedTransport = (input) => new Promise((resolve, reject) => {
  // Node calls lookup with `{ all: true }` and then expects an array; answer both forms
  // (see the 2026-08-23 note in site/agent-app-publish.ts).
  const pinnedLookup: LookupFunction = ((_hostname: string, options: unknown, callback: unknown) => {
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: input.address, family: input.family }],
      );
      return;
    }
    (callback as (err: null, address: string, family: number) => void)(null, input.address, input.family);
  }) as never;
  const hostname = input.url.hostname.replace(/^\[(.*)\]$/, "$1");
  const request = httpsRequest({
    protocol: "https:",
    hostname,
    port: input.url.port ? Number(input.url.port) : 443,
    method: "GET",
    path: `${input.url.pathname}${input.url.search}`,
    ...(isIP(hostname) ? {} : { servername: hostname }),
    lookup: pinnedLookup,
    headers: input.headers,
    agent: false,
    signal: input.signal,
  }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
  request.once("error", reject);
  request.end();
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPublicHttps(url: string, options: {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Called with the final response's status and headers before its body is read; throw to refuse. */
  acceptResponse?: (status: number, headers: IncomingHttpHeaders) => void;
  resolveHost?: ResolveHost;
  transport?: PinnedTransport;
}): Promise<{ url: string; status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const maxRedirects = options.maxRedirects ?? 3;
  const transport = options.transport ?? defaultTransport;
  let current: URL;
  try { current = new URL(url); } catch { throw new PublicFetchRefusal("blocked_insecure_url", "not a URL"); }
  for (let hop = 0; ; hop += 1) {
    const target = await checkPublicHttpsTarget(current, options.resolveHost);
    const response = await transport({ url: current, ...target, headers: options.headers ?? {}, signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      response.body.destroy();
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location) throw new Error(`HTTP ${response.status} redirect without a location.`);
      if (hop >= maxRedirects) throw new PublicFetchRefusal("too_many_redirects", `more than ${maxRedirects}`);
      try { current = new URL(location, current); } catch { throw new PublicFetchRefusal("blocked_insecure_url", "redirect location is not a URL"); }
      continue;
    }
    try {
      options.acceptResponse?.(response.status, response.headers);
    } catch (error) {
      response.body.destroy();
      throw error;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        response.body.destroy();
        throw new PublicFetchRefusal("response_too_large", `over ${options.maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return { url: current.toString(), status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
  }
}

/**
 * VD: the same hop-by-hop check and pinned connection as `fetchPublicHttps`, but the body is NOT read: the caller streams it (a 190 MiB file must not sit in memory). Redirects are followed by hand with
 * every hop re-checked and re-pinned. The caller's `signal` ends the body; `headerTimeoutMs` bounds only the wait for the answer's headers (a stalled body is the caller's idle rule).
 * Returns the final response; its `body` must be consumed or destroyed by the caller. Throws PublicFetchRefusal / Error (a refusal names no address of the caller's data).
 */
export async function openPublicHttps(url: string, options: {
  signal: AbortSignal;
  headerTimeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  resolveHost?: ResolveHost;
  transport?: PinnedTransport;
  /** VD: the only port a hop may name (443 for a file taken from outside); a hop - the first or after a redirect - on another port is refused before any connection. */
  onlyPort?: number;
}): Promise<{ url: string; status: number; headers: IncomingHttpHeaders; body: PinnedResponse["body"] }> {
  const maxRedirects = options.maxRedirects ?? 3;
  const transport = options.transport ?? defaultTransport;
  let current: URL;
  try { current = new URL(url); } catch { throw new PublicFetchRefusal("blocked_insecure_url", "not a URL"); }
  for (let hop = 0; ; hop += 1) {
    if (options.onlyPort !== undefined && Number(current.port || 443) !== options.onlyPort) throw new PublicFetchRefusal("blocked_insecure_url", "a port that is not allowed");
    const target = await checkPublicHttpsTarget(current, options.resolveHost);
    const controller = new AbortController();
    const relay = (): void => controller.abort();
    if (options.signal.aborted) controller.abort(); else options.signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(relay, options.headerTimeoutMs);
    let response: PinnedResponse;
    try {
      response = await transport({ url: current, ...target, headers: options.headers ?? {}, signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (REDIRECT_STATUSES.has(response.status)) {
      options.signal.removeEventListener("abort", relay);
      response.body.destroy();
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location) throw new Error(`HTTP ${response.status} redirect without a location.`);
      if (hop >= maxRedirects) throw new PublicFetchRefusal("too_many_redirects", `more than ${maxRedirects}`);
      try { current = new URL(location, current); } catch { throw new PublicFetchRefusal("blocked_insecure_url", "redirect location is not a URL"); }
      continue;
    }
    return { url: current.toString(), status: response.status, headers: response.headers, body: response.body };
  }
}
