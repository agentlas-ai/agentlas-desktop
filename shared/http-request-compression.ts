// Lossless request transport only. No fetch, retry, prompt rewriting, or Electron dependency.
import { gzip } from "node:zlib";

export interface RequestCompressionNetworkState {
  readonly ready: boolean;
  readonly proxyConfigured: boolean;
  readonly additionalCaCertificates: boolean;
}

export interface RequestCompressionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly network?: RequestCompressionNetworkState;
}

export const REQUEST_GZIP_MIN_BYTES = 32 * 1024;

/** Only the endpoint with verified request-gzip support; compatible APIs are not assumed to accept it. */
export function supportsRequestGzip(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "https:" && url.hostname === "api.anthropic.com" && !url.port
      && !url.username && !url.password
      && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens");
  } catch { return false; }
}

function environmentAllowsGzip(env: Readonly<Record<string, string | undefined>>): boolean {
  for (const [name, value] of Object.entries(env)) {
    if (!value?.trim()) continue;
    const key = name.toUpperCase();
    if (key === "AGENTLAS_GZIP_REQUEST_BODIES" && /^(?:0|false|no|off)$/i.test(value.trim())) return false;
    if (key === "NODE_OPTIONS" && /(?:^|\s)--openssl-config(?:[=\s]|$)/.test(value)) return false;
    // Be conservative even when NO_PROXY would bypass a configured corporate proxy.
    if (/^(?:HTTPS?_PROXY|ALL_PROXY|GLOBAL_AGENT_HTTPS?_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|CLAUDE_CODE_CLIENT_(?:CERT|KEY|KEY_PASSPHRASE)|TLS_CLIENT_(?:CERT|KEY))$/.test(key)) return false;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function gzipAsync(input: Buffer, signal: AbortSignal | null | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    throwIfAborted(signal);
    signal?.addEventListener("abort", onAbort, { once: true });
    gzip(input, { level: 1 }, (error, output) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();
      else if (error) reject(error);
      else resolve(output);
    });
  });
}

/**
 * Compress large direct Anthropic JSON requests off the event loop. Unknown
 * network state, proxies, extra trust roots, existing encodings and other
 * providers keep their original bytes. Callers still own the single dispatch.
 */
export async function prepareCompressedJsonRequest(
  target: string,
  init: RequestInit,
  options: RequestCompressionOptions = {},
): Promise<RequestInit> {
  throwIfAborted(init.signal);
  const network = options.network;
  if (!network?.ready || network.proxyConfigured || network.additionalCaCertificates
    || !supportsRequestGzip(target) || (init.method ?? "GET").toUpperCase() !== "POST"
    || typeof init.body !== "string" || !environmentAllowsGzip(options.env ?? process.env)) return init;
  const headers = new Headers(init.headers);
  if (headers.has("content-encoding") || !/^application\/json(?:\s*;|\s*$)/i.test(headers.get("content-type") ?? "")) return init;
  if (Buffer.byteLength(init.body, "utf8") < REQUEST_GZIP_MIN_BYTES) return init;
  const input = Buffer.from(init.body, "utf8");
  let compressed: Buffer;
  try {
    compressed = await gzipAsync(input, init.signal);
  } catch (error) {
    throwIfAborted(init.signal);
    // Optional transport optimization: a compression failure never changes the model request.
    return init;
  }
  throwIfAborted(init.signal);
  // A laptop can move between networks while compression is in flight. Re-read env
  // in this module; callers check their host network snapshot again before dispatch.
  if (!environmentAllowsGzip(options.env ?? process.env) || compressed.length >= input.length) return init;
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  return { ...init, headers, body: new Uint8Array(compressed) };
}
