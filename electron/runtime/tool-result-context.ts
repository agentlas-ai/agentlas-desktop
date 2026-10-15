import { redactToolText, lookupToolResult, writeToolResult, type RedactedText } from "../harness/tool-result-store";
import type { OpenAiToolDef, ResolvedTool } from "./local-tool-loop";
import type { ToolResultTrust } from "../../shared/types";

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
/** `sha256` is the STORED hash (of `text`, after redaction); `originalSha256` is of the unredacted tool output and equals
 * it exactly when `redacted` is false. See harness/tool-result-store.ts for the full meaning. */
interface Entry {
  ref: string; text: string; sha256: string; bytes: number; firstCallId: string | null;
  redacted: boolean; originalSha256: string; durable: boolean;
}
interface Store { scope: Scope; bytes: number; entries: Map<string, Entry>; byDigest: Map<string, Entry> }
const stores = new WeakMap<Map<string, ResolvedTool>, Store>();

/** Handles are durable (G10): every retained result is committed to the harness result store under this chat scope, so
 * `read_tool_result` still works after a restart or a generation switch. The maps below are only a bounded cache;
 * evicting from them never deletes the disk copy. A handle is readable only from the scope that created it. Text is
 * redacted (G03) before it is cached, previewed, projected or written. This changes only the provider projection
 * after execution, not dispatch or its outcome. */
export function installToolResultContext(
  tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>, scope: Scope, enabled: boolean, shareWith?: Map<string, ResolvedTool>,
): OpenAiToolDef[] {
  if (!enabled || !tools.length || tools.some(tool => tool.function.name === TOOL_RESULT_READ)
    || byName.has(TOOL_RESULT_READ)) return tools;
  const shared = shareWith ? storeFor(shareWith, scope) : undefined;
  stores.set(byName, shared ?? { scope: { ...scope }, bytes: 0, entries: new Map(), byDigest: new Map() });
  return [...tools, { type: "function", function: {
    name: TOOL_RESULT_READ,
    description: "Read tool-result ref (this chat scope; survives restart; no workspace files). offset: UTF-16 units from 0, page by nextOffset. search: literal substring. expected_sha256: pin.",
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
/** Memory cache first, then the durable store (scoped). A revoked handle is refused, not reported unknown. */
function lookup(store: Store, ref: string): Entry | undefined {
  const cached = store.entries.get(ref);
  if (cached) return cached;
  const stored = lookupToolResult(store.scope, ref);
  if (stored === "revoked") throw new Error("tool_result_reference_revoked");
  if (!stored) return undefined;
  const entry: Entry = { ref: stored.ref, text: stored.text, sha256: stored.storedSha256, bytes: stored.bytes, firstCallId: stored.firstCallId,
    redacted: stored.redacted, originalSha256: stored.originalSha256, durable: true };
  if (entry.bytes <= STORE_BYTES) cacheEntry(store, `${stored.isError ? "error" : "result"}:${entry.sha256}`, entry, true);
  return entry;
}
/** Cache only. Eviction here never touches the disk copy. */
function cacheEntry(store: Store, key: string, entry: Entry, evict: boolean): void {
  if (evict) {
    while (store.entries.size >= 128 || store.bytes + entry.bytes > STORE_BYTES) {
      const oldest = store.entries.values().next().value;
      if (!oldest) break;
      store.entries.delete(oldest.ref); store.bytes -= oldest.bytes;
      for (const [k, v] of store.byDigest) if (v === oldest) store.byDigest.delete(k);
    }
  }
  store.entries.set(entry.ref, entry); store.byDigest.set(key, entry); store.bytes += entry.bytes;
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
    sha256: entry.sha256, storedSha256: entry.sha256, originalSha256: entry.originalSha256, redacted: entry.redacted,
    utf8Bytes: entry.bytes, characters: entry.text.length, offset, nextOffset: end < entry.text.length ? end : null, text: entry.text.slice(offset, end) });
  while (Buffer.byteLength(encode(), "utf8") > PAGE_WIRE_BYTES && end > offset) {
    end = offset + Math.floor((end - offset) / 2);
    if (!boundary(entry.text, end)) end--;
  }
  return encode();
}

/** Capture before any legacy adapter cap. Equal bytes share storage but never
 * skip the new tool execution, approval, error result or image delivery. */
export function projectToolResult(
  byName: Map<string, ResolvedTool>, scope: Scope, rawText: string, callId: string | null, isError: boolean, boundedRetention = false,
): string {
  // G03: nothing below ever sees the unredacted text. Without a context the projection is still masked.
  const redacted: RedactedText = redactToolText(rawText);
  const text = redacted.text;
  if (!stores.has(byName)) return text;
  const store = storeFor(byName, scope);
  // Short errors keep their exact cause inline, even when repeated. Large
  // errors retain their original bytes and status through the same read API.
  const digest = redacted.storedSha256;
  const key = `${isError ? "error" : "result"}:${digest}`;
  let entry = store.byDigest.get(key);
  const repeated = entry?.text === text;
  if (!entry || !repeated) {
    const bytes = Buffer.byteLength(text, "utf8");
    // Durable first: the disk copy is the canonical one and is never evicted. Memory is only a cache of it.
    const written = writeToolResult(store.scope, redacted, isError, callId);
    if (written) {
      entry = { ref: written.ref, text, sha256: digest, bytes, firstCallId: written.firstCallId, redacted: redacted.redacted,
        originalSha256: redacted.originalSha256, durable: true };
      if (bytes <= STORE_BYTES) cacheEntry(store, key, entry, true);
    } else {
      // Disk refused (read-only, full). Fall back to the old bounded in-memory retention; the tool outcome stays successful.
      if (boundedRetention && bytes > STORE_BYTES) return JSON.stringify({ schema: "agentlas.tool-result-retention-unavailable.v1",
        code: "tool_result_retention_capacity", sha256: digest, utf8Bytes: bytes, isError,
        retained: false, completeTextInline: false, limitBytes: STORE_BYTES,
        nextAction: "received, over retention limit; do not repeat external effects; use the producer artifact reference or record the limitation" });
      if (!boundedRetention && store.bytes + bytes > STORE_BYTES) return text;
      entry = { ref: `tr-${isError ? "e" : "r"}-${digest}`, text, sha256: digest, bytes, firstCallId: callId, redacted: redacted.redacted,
        originalSha256: redacted.originalSha256, durable: false };
      cacheEntry(store, key, entry, boundedRetention);
    }
  }
  if (entry.bytes <= INLINE_BYTES && (!repeated || isError)) return text;
  const reference = JSON.stringify({ schema: "agentlas.tool-result-reference.v1", trust: "tool-result" satisfies ToolResultTrust, ref: entry.ref,
    sha256: entry.sha256, storedSha256: entry.sha256, originalSha256: entry.originalSha256, redacted: entry.redacted,
    utf8Bytes: entry.bytes, characters: text.length, isError,
    ...(repeated ? { identicalToToolCallId: entry.firstCallId } : { preview: JSON.parse(page(entry, 0, 2_000)) }),
    completeTextInline: false, readTool: TOOL_RESULT_READ, scope: entry.durable ? "this chat scope; survives restart" : "this invocation only" });
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
  const entry = typeof value.ref === "string" ? lookup(store, value.ref) : undefined;
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
  const entry = lookup(storeFor(byName, scope), request.ref);
  if (!entry) throw new Error("tool_result_reference_unknown");
  if (request.search !== undefined && request.searchFound === undefined) throw new Error("tool_result_read_arguments_invalid");
  if (request.searchFound === false) return JSON.stringify({ schema: "agentlas.tool-result-search.v1", ref: entry.ref, found: false });
  const offset = request.offset;
  if (!boundary(entry.text, offset)) throw new Error("tool_result_read_arguments_invalid");
  return page(entry, offset, request.length);
}

/** End an invocation: drops the in-memory cache only. The durable copies stay (D13: no automatic deletion). */
export function clearToolResultContext(byName: Map<string, ResolvedTool>): void {
  const store = stores.get(byName); if (store) { store.entries.clear(); store.byDigest.clear(); store.bytes = 0; }
  stores.delete(byName);
}
