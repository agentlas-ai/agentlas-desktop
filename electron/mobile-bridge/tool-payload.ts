import { createHash } from "node:crypto";
import type { MobileBridgeToolBodyDto, MobileBridgeToolPayloadPageDto } from "../../shared/mobile-bridge";
import { sanitizeMobileBridgeText, truncateMobileBridgeUtf8 } from "./sanitize";

export const MOBILE_TOOL_BODY_INLINE_BYTES = 512 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 512;
const CACHE_TTL_MS = 10 * 60_000;
const PRIVATE_KEY = /^(?:env(?:ironment)?(?:variables)?|systemprompt|developerprompt|provider(?:session|config|credentials)?|session(?:id|token|cookie)?|cookies?|authorization|credentials?|headers|privatekey|apikey|accesstoken|refreshtoken|password|passwd|pwd|secret|token|bearer)$|(?:apikey|accesskey(?:id)?|secretkey|secretaccesskey|clientsecret|privatekey|signingkey|accesstoken|refreshtoken|authtoken|sessiontoken|sessionid|password)$/i;

function safeText(raw: string): string {
  const safe = raw.replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted-secret]@")
    .replace(/\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:](?!\/\/)\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/g,
      (match, key: string) => PRIVATE_KEY.test(key.replace(/[^a-z0-9]/gi, "")) ? `${key}=[redacted-private-value]` : match);
  return sanitizeMobileBridgeText(safe, Number.MAX_SAFE_INTEGER);
}

function safeJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return safeText(value);
  if (depth > 64) return "[redacted-nested-value]";
  if (Array.isArray(value)) return value.map(item => safeJson(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    sanitizeMobileBridgeText(key, Number.MAX_SAFE_INTEGER),
    PRIVATE_KEY.test(key.replace(/[^a-z0-9]/gi, "")) ? "[redacted-private-value]" : safeJson(item, depth + 1),
  ]));
  return value;
}

/** Only caller-selected tool args/result strings enter here; no event metadata. */
export function sanitizeMobileToolBody(raw: string): { text: string; format: "json" | "text" } {
  try { return { text: JSON.stringify(safeJson(JSON.parse(raw)), null, 2), format: "json" }; } catch {
    // Quoted credential keys also occur in malformed/partial JSON. Mask them
    // before the existing text/path sanitizer handles the remaining prose.
    const safe = raw.replace(/(["'])([^"'\r\n]+)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]\r\n]+)/g,
      (match, quote: string, key: string) => PRIVATE_KEY.test(key.replace(/[^a-z0-9]/gi, ""))
        ? `${quote}${key}${quote}: "[redacted-private-value]"` : match);
    return { text: safeText(safe), format: "text" };
  }
}

interface CachedBody { text: string; format: "json" | "text" }
interface Entry { chatId: string; runId: string; input?: CachedBody; output?: CachedBody; bytes: number; touchedAt: number }

/** Bounded session-only sanitized retention; eviction never pretends to be full history. */
export class MobileToolPayloadStore {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly now = Date.now) {}

  project(input: { chatId: string; runId: string; args?: string; result?: string; inlineBytes?: number }): {
    inputBody?: MobileBridgeToolBodyDto; outputBody?: MobileBridgeToolBodyDto;
  } {
    this.prune();
    const bodyInput = typeof input.args === "string" ? sanitizeMobileToolBody(input.args) : undefined;
    const bodyOutput = typeof input.result === "string" ? sanitizeMobileToolBody(input.result) : undefined;
    const bytes = Buffer.byteLength(bodyInput?.text ?? "") + Buffer.byteLength(bodyOutput?.text ?? "");
    const ref = createHash("sha256").update(JSON.stringify([input.chatId, input.runId, bodyInput, bodyOutput])).digest("hex");
    // Bodies above the whole cache budget are shown with explicit truncation.
    // Keep no raw data, filesystem pointers or provider/session handles.
    const retain = bytes <= CACHE_BYTES;
    if (retain) {
      const old = this.entries.get(ref);
      if (old) this.bytes -= old.bytes;
      this.entries.delete(ref);
      this.entries.set(ref, { chatId: input.chatId, runId: input.runId, input: bodyInput, output: bodyOutput, bytes, touchedAt: this.now() });
      this.bytes += bytes;
      this.prune();
    }
    const budget = Math.max(0, Math.min(MOBILE_TOOL_BODY_INLINE_BYTES, input.inlineBytes ?? MOBILE_TOOL_BODY_INLINE_BYTES));
    const project = (body: CachedBody | undefined): MobileBridgeToolBodyDto | undefined => {
      if (!body) return undefined;
      const originalBytes = Buffer.byteLength(body.text);
      return { format: body.format, text: truncateMobileBridgeUtf8(body.text, budget), originalBytes,
        truncated: originalBytes > budget, source: "retained", ...(retain && this.entries.has(ref) ? { payloadRef: ref } : {}) };
    };
    return { ...(bodyInput ? { inputBody: project(bodyInput) } : {}), ...(bodyOutput ? { outputBody: project(bodyOutput) } : {}) };
  }

  read(input: { chatId: string; runId: string; payloadRef: string; section: "input" | "output"; offset: number }): MobileBridgeToolPayloadPageDto {
    this.prune();
    const entry = this.entries.get(input.payloadRef);
    if (!entry || entry.chatId !== input.chatId || entry.runId !== input.runId) throw new Error("tool_payload_unavailable");
    const body = entry[input.section];
    if (!body || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > body.text.length
      || input.offset > 0 && /[\uDC00-\uDFFF]/.test(body.text[input.offset] ?? "") && /[\uD800-\uDBFF]/.test(body.text[input.offset - 1])) {
      throw new Error("tool_payload_offset_invalid");
    }
    entry.touchedAt = this.now();
    // Chunking must not insert the preview's ellipsis inside a complete JSON body.
    let end = Math.min(body.text.length, input.offset + MOBILE_TOOL_BODY_INLINE_BYTES);
    while (Buffer.byteLength(body.text.slice(input.offset, end)) > MOBILE_TOOL_BODY_INLINE_BYTES) {
      end = input.offset + Math.floor((end - input.offset) * 0.8);
    }
    if (end < body.text.length && /[\uD800-\uDBFF]/.test(body.text[end - 1] ?? "")) end -= 1;
    return { chatId: input.chatId, runId: input.runId, payloadRef: input.payloadRef, section: input.section,
      format: body.format, text: body.text.slice(input.offset, end), originalBytes: Buffer.byteLength(body.text),
      nextOffset: end < body.text.length ? end : null };
  }

  private prune(): void {
    for (const [ref, entry] of this.entries) if (this.now() - entry.touchedAt > CACHE_TTL_MS) {
      this.bytes -= entry.bytes; this.entries.delete(ref);
    }
    while (this.bytes > CACHE_BYTES || this.entries.size > CACHE_ENTRIES) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.bytes -= first[1].bytes; this.entries.delete(first[0]);
    }
  }
}
