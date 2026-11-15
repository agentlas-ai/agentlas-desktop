import { webBaseUrl } from "../auth";
import { isIP } from "node:net";
import { isBlockedAddress } from "../net/public-address-guard";
import type { ChunkReply, DeliveryReply } from "./companion-work-delivery";

const DISCOVERY = "/api/mobile-pair/v1/companion/work-delivery-origin";
const RECEIPT = "/v2/work/desktop-receipt";
const FULL_CHUNK = "/v2/work/full-chunk";
const origin = (value: string, allowLoopback: boolean): URL | null => {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ""), loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
    const ip = isIP(host);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")) ||
        (!(allowLoopback && loopback) && (loopback || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
          (!ip && !host.includes(".")) || (ip !== 0 && isBlockedAddress(host, ip as 4 | 6))))) return null;
    return url;
  } catch { return null; }
};
async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2048) return null; chunks.push(part.value); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; } finally { await reader.cancel().catch(() => undefined); }
}

/** Discovery is bound to the installed web origin, never a phone value. Both
 * requests forbid redirects; only signed receipts go to the discovered host. */
export function createCompanionWorkDeliveryClient(options: { baseUrl?: string; fetchImpl?: typeof fetch; allowLoopback?: boolean } = {}) {
  const web = origin(options.baseUrl ?? webBaseUrl(), options.allowLoopback === true && process.env.AGENTLAS_E2E === "1");
  if (!web) throw new Error("companion_delivery_origin_invalid");
  const fetcher = options.fetchImpl ?? fetch;
  let cached: { origin: URL; until: number } | null = null;
  async function discover(): Promise<URL | null> {
    if (cached && cached.until > Date.now()) return cached.origin;
    const response = await fetcher(new URL(DISCOVERY, web!), { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok || new URL(response.url).origin !== web!.origin) return null;
    const body = await boundedJson(response);
    if (!body || Object.keys(body).sort().join(",") !== "origin,schema" || body.schema !== "agentlas.companion.work-delivery-origin.v1" || typeof body.origin !== "string") return null;
    const target = origin(body.origin, options.allowLoopback === true && process.env.AGENTLAS_E2E === "1");
    if (!target) return null;
    cached = { origin: target, until: Date.now() + 60_000 };
    return target;
  }
  /** What came back, as a status and a closed body - never read as text. `unreached` = no usable answer (offline, timeout, a redirect, a bad shape). */
  type Answer = { http: number; body: Record<string, unknown> | null; retryAfterMs?: number } | { http: 0; body: null };
  const UNREACHED: Answer = { http: 0, body: null };
  /** Retry-After in seconds or an HTTP date, as the intake clients read it (companion-direct-intake-client.ts); none when absent. */
  function retryAfter(response: Response): number | undefined {
    const value = response.headers.get("retry-after")?.trim();
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER - Date.now(), Math.max(1_000, Number(value) * 1_000));
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : undefined;
  }
  async function post(path: string, value: unknown): Promise<Answer> {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return UNREACHED;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body, "utf8") > 16 * 1024) return UNREACHED;
      const target = await discover(); if (!target) return UNREACHED;
      const response = await fetcher(new URL(path, target), { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" }, body });
      if (new URL(response.url).origin !== target.origin) { cached = null; await response.body?.cancel().catch(() => undefined); return UNREACHED; }
      if (!response.ok) { const wait = retryAfter(response); await response.body?.cancel().catch(() => undefined); if (response.status >= 500) cached = null; return { http: response.status, body: null, ...(wait !== undefined ? { retryAfterMs: wait } : {}) }; }
      return { http: response.status, body: await boundedJson(response) };
    } catch { cached = null; return UNREACHED; }
  }
  /** direct-work-capacity R8. 200 `recorded`/`existing`/`settled` = the server has it; 403 = it cannot verify these bytes, ever (`closed`);
   * 429, 5xx, no answer, and anything not named here = not taken: retry (the worker bounds it). */
  function classify<S extends string>(answer: Answer, statuses: readonly S[]): { kind: "ok"; status: S } | { kind: "closed" } | { kind: "retry"; afterMs?: number } {
    if (answer.http === 403) return { kind: "closed" };
    if (answer.http === 200 && answer.body?.ok === true && (statuses as readonly string[]).includes(String(answer.body.status))) return { kind: "ok", status: answer.body.status as S };
    return { kind: "retry", ...(answer.http !== 0 && "retryAfterMs" in answer && answer.retryAfterMs !== undefined ? { afterMs: answer.retryAfterMs } : {}) };
  }
  async function send(value: unknown): Promise<DeliveryReply> {
    const row = value as { receipt?: unknown; signature?: unknown } | null;
    if (!row || typeof row !== "object" || Array.isArray(row) || !row.receipt || typeof row.receipt !== "object" || typeof row.signature !== "string") return { kind: "skip" };
    const reply = classify(await post(RECEIPT, { receipt: row.receipt, signature: row.signature }), ["recorded", "existing", "settled"] as const);
    return reply.kind === "ok" ? { kind: "ok", settled: reply.status === "settled" } : reply;
  }
  async function sendFullChunk(value: unknown): Promise<ChunkReply> {
    const row = value as { chunk?: unknown; signature?: unknown } | null;
    if (!row || typeof row !== "object" || Array.isArray(row) || !row.chunk || typeof row.chunk !== "object" || typeof row.signature !== "string") return { kind: "retry" };
    return classify(await post(FULL_CHUNK, { chunk: row.chunk, signature: row.signature }), ["recorded", "existing", "complete", "settled"] as const);
  }
  return Object.freeze({ send, sendFullChunk });
}
