import { createHash, randomUUID } from "node:crypto";
import type { OpenAiToolDef, ResolvedTool } from "./local-tool-loop";

// The shared taxonomy already classifies the canonical read* family as an
// observation, so reading retained evidence cannot count as outward progress.
export const TOOL_RESULT_READ = "read_tool_result";
const INLINE_BYTES = 8_192;
const PAGE_WIRE_BYTES = 16_384;
const STORE_BYTES = 32 * 1024 * 1024;

interface Scope {
  runtimeKind: string;
  sessionKey: string;
  cwd?: string;
  chatId?: string;
  agentId?: string;
}
interface Entry { ref: string; text: string; sha256: string; bytes: number; firstCallId: string | null }
interface Store { scope: Scope; bytes: number; entries: Map<string, Entry>; byDigest: Map<string, Entry> }
const stores = new WeakMap<Map<string, ResolvedTool>, Store>();

/** Main memory only: no files, database reads, cross-run handles or extra grants.
 * The original tool event still carries the full observed result. This changes
 * only the provider projection after execution, not dispatch or its outcome. */
export function installToolResultContext(
  tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>, scope: Scope, enabled: boolean, shareWith?: Map<string, ResolvedTool>,
): OpenAiToolDef[] {
  if (!enabled || !tools.length || tools.some(tool => tool.function.name === TOOL_RESULT_READ)
    || byName.has(TOOL_RESULT_READ)) return tools;
  const shared = shareWith ? storeFor(shareWith, scope) : undefined;
  stores.set(byName, shared ?? { scope: { ...scope }, bytes: 0, entries: new Map(), byDigest: new Map() });
  return [...tools, { type: "function", function: {
    name: TOOL_RESULT_READ,
    description: "Read exact text from a tool-result reference returned in this invocation. Large or repeated results retain their full original text in Main memory. Use ref and offset (UTF-16 string units, initially 0); nextOffset pages without splitting Unicode characters. Optional search locates a literal substring at or after offset. References are not restored in another invocation or after restart and may expire earlier at the bounded storage limit. Copy sha256 as expected_sha256 when pinning a read. This reader cannot read workspace files.",
    parameters: { type: "object", properties: {
      ref: { type: "string" }, expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, maximum: 8_000 }, search: { type: "string", minLength: 1, maxLength: 512 },
    }, required: ["ref"], additionalProperties: false },
  } }];
}

export function hasToolResultContext(byName: Map<string, ResolvedTool>): boolean { return stores.has(byName); }

function storeFor(byName: Map<string, ResolvedTool>, scope: Scope): Store {
  const store = stores.get(byName);
  if (!store || ["runtimeKind", "sessionKey", "cwd", "chatId", "agentId"].some(
    key => store.scope[key as keyof Scope] !== scope[key as keyof Scope],
  )) throw new Error("tool_result_context_scope_mismatch");
  return store;
}
function boundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00
    && text.charCodeAt(offset) <= 0xdfff && text.charCodeAt(offset - 1) >= 0xd800
    && text.charCodeAt(offset - 1) <= 0xdbff);
}
function page(entry: Entry, offset: number, length: number): string {
  let end = Math.min(entry.text.length, offset + length);
  if (!boundary(entry.text, end)) end--;
  const encode = () => JSON.stringify({ schema: "agentlas.tool-result-page.v1", ref: entry.ref,
    sha256: entry.sha256, utf8Bytes: entry.bytes, characters: entry.text.length,
    offset, nextOffset: end < entry.text.length ? end : null, text: entry.text.slice(offset, end) });
  while (Buffer.byteLength(encode(), "utf8") > PAGE_WIRE_BYTES && end > offset) {
    end = offset + Math.floor((end - offset) / 2);
    if (!boundary(entry.text, end)) end--;
  }
  return encode();
}

/** Capture before any legacy adapter cap. Equal bytes share storage but never
 * skip the new tool execution, approval, error result or image delivery. */
export function projectToolResult(
  byName: Map<string, ResolvedTool>, scope: Scope, text: string, callId: string | null, isError: boolean, boundedRetention = false,
): string {
  if (!stores.has(byName)) return text;
  const store = storeFor(byName, scope);
  // Short errors keep their exact cause inline, even when repeated. Large
  // errors retain their original bytes and status through the same read API.
  const digest = createHash("sha256").update(text).digest("hex");
  const key = `${isError ? "error" : "result"}:${digest}`;
  let entry = store.byDigest.get(key);
  const repeated = entry?.text === text;
  if (!entry || !repeated) {
    const bytes = Buffer.byteLength(text, "utf8");
    // Projection cannot turn an already completed operation into a failure.
    // When memory is full, retain the exact ordinary inline result. Transport
    // admission may still refuse its size, but the actual tool outcome stays
    // successful and is never replaced with a cache-capacity error.
    if (boundedRetention) {
      if (bytes > STORE_BYTES) return JSON.stringify({ schema: "agentlas.tool-result-retention-unavailable.v1",
        code: "tool_result_retention_capacity", sha256: digest, utf8Bytes: bytes, isError,
        retained: false, completeTextInline: false, limitBytes: STORE_BYTES,
        nextAction: "The result was received but exceeds this invocation's retention limit. Do not repeat external effects to recover it; use any producer-owned canonical artifact reference or record the delivery limitation." });
      while (store.entries.size >= 128 || store.bytes + bytes > STORE_BYTES) {
        const oldest = store.entries.values().next().value!;
        store.entries.delete(oldest.ref); store.byDigest.delete([...store.byDigest].find(([, value]) => value === oldest)![0]); store.bytes -= oldest.bytes;
      }
    } else if (store.bytes + bytes > STORE_BYTES) return text;
    entry = { ref: randomUUID(), text, sha256: digest, bytes, firstCallId: callId };
    store.entries.set(entry.ref, entry); store.byDigest.set(key, entry); store.bytes += bytes;
  }
  if (entry.bytes <= INLINE_BYTES && (!repeated || isError)) return text;
  const reference = JSON.stringify({ schema: "agentlas.tool-result-reference.v1", ref: entry.ref,
    sha256: entry.sha256, utf8Bytes: entry.bytes, characters: text.length, isError,
    ...(repeated ? { identicalToToolCallId: entry.firstCallId } : { preview: JSON.parse(page(entry, 0, 2_000)) }),
    completeTextInline: false, readTool: TOOL_RESULT_READ, scope: "this invocation only" });
  // Provider adapters transmit either representation as a JSON string. A
  // reference must save actual wire bytes, including escaped quotes/control
  // characters. The lower bound avoids serializing a large original twice.
  const referenceWireBytes = Buffer.byteLength(JSON.stringify(reference), "utf8");
  return referenceWireBytes < entry.bytes + 2
    || referenceWireBytes < Buffer.byteLength(JSON.stringify(text), "utf8") ? reference : text;
}

/** Validate the exact range before approval, without returning its text. */
export function toolResultReadRequest(byName: Map<string, ResolvedTool>, scope: Scope, input: string): {
  ref: string; offset: number; length: number; search?: string; searchFound?: boolean;
} {
  const store = storeFor(byName, scope);
  let args: unknown;
  try { args = JSON.parse(input); } catch { throw new Error("tool_result_read_arguments_invalid"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool_result_read_arguments_invalid");
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => !["ref", "expected_sha256", "offset", "length", "search"].includes(key))) throw new Error("tool_result_read_arguments_invalid");
  const entry = typeof value.ref === "string" ? store.entries.get(value.ref) : undefined;
  if (!entry) throw new Error("tool_result_reference_unknown");
  if (value.expected_sha256 !== undefined && value.expected_sha256 !== entry.sha256) throw new Error("tool_result_reference_pin_mismatch");
  const offset = value.offset ?? 0, length = value.length ?? 4_000;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > entry.text.length
    || !boundary(entry.text, Number(offset)) || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 8_000
    || (value.search !== undefined && (typeof value.search !== "string" || !value.search.length || value.search.length > 512))) {
    throw new Error("tool_result_read_arguments_invalid");
  }
  // Resolve a search before consent: approval must name the actual range,
  // not the starting search cursor. The retained original is immutable.
  const resolved = typeof value.search === "string"
    ? entry.text.indexOf(value.search, Number(offset)) : Number(offset);
  if (resolved >= 0 && !boundary(entry.text, resolved)) throw new Error("tool_result_read_arguments_invalid");
  // A one-unit limit cannot contain a surrogate pair. Refuse instead of
  // returning an empty non-advancing page or reading past the approved range.
  const end = Math.min(entry.text.length, resolved + Number(length));
  if (resolved >= 0 && end > resolved && end - 1 === resolved && !boundary(entry.text, end)) {
    throw new Error("tool_result_read_arguments_invalid");
  }
  return { ref: entry.ref, offset: resolved < 0 ? Number(offset) : resolved, length: Number(length),
    ...(typeof value.search === "string" ? { search: value.search, searchFound: resolved >= 0 } : {}) };
}

export function readToolResult(byName: Map<string, ResolvedTool>, scope: Scope,
  request: ReturnType<typeof toolResultReadRequest>): string {
  const entry = storeFor(byName, scope).entries.get(request.ref);
  if (!entry) throw new Error("tool_result_reference_unknown");
  if (request.search !== undefined && request.searchFound === undefined) throw new Error("tool_result_read_arguments_invalid");
  if (request.searchFound === false) return JSON.stringify({ schema: "agentlas.tool-result-search.v1", ref: entry.ref, found: false });
  const offset = request.offset;
  if (!boundary(entry.text, offset)) throw new Error("tool_result_read_arguments_invalid");
  return page(entry, offset, request.length);
}

/** End an invocation without retaining its private result bytes. */
export function clearToolResultContext(byName: Map<string, ResolvedTool>): void {
  const store = stores.get(byName); if (store) { store.entries.clear(); store.byDigest.clear(); store.bytes = 0; }
  stores.delete(byName);
}
