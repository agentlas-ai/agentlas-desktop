import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../../shared/secret-patterns";
import { userDataPath } from "../runtime-paths";

/*
 * Durable, secret-free tool result store (docs/2026-10-13-native-harness/07 G03 + G10, owner decision D13).
 *
 * Two jobs, shared by the Main tool loop (runtime/tool-result-context.ts) and the harness ports (tool-dispatch.ts):
 *
 * 1. Redaction semantics. A secret must never reach model-visible text, a preview, a log or the general result store.
 *    Every stored text therefore goes through redactSecrets first and carries three facts:
 *      redacted        true when the stored bytes differ from what the tool returned
 *      originalSha256  hash of the UNREDACTED bytes, computed in memory; it identifies "what the tool said" and is the
 *                      only trace of the original -- the original text itself is never written anywhere here
 *      storedSha256    hash of the bytes that were stored (what every reader, page and pin sees)
 *    When redacted is false the two hashes are equal. A redacted result is the canonical safe return; the original
 *    is not recoverable from this store by design (custody of a needed secret belongs to the vault, not to a result).
 *
 * 2. Durability. A stored result is a file keyed by scope + sha256, committed with temp+rename, and is NEVER deleted
 *    automatically: no TTL, no LRU. Memory caches built on top may evict; eviction only drops the cache. Reading is
 *    scoped (a scope directory is only reachable with that scope's id). Two distinct actions exist:
 *      revoke  (revokeToolResultAccess)  -- closes model/reader access, keeps the bytes
 *      delete  (deleteToolResultByOwner) -- owner action only, removes the bytes; never called from a model path
 *
 * No electron import: the daemon loads this module (userData comes from runtime-paths).
 */

export const TOOL_RESULT_ENTRY_SCHEMA = "agentlas.tool-result-entry.v1";

export const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface RedactedText { text: string; redacted: boolean; originalSha256: string; storedSha256: string }

/** Mask credential shapes in a text. Hashes both sides; the original is only ever held in memory. */
export function redactToolText(original: string): RedactedText {
  const text = redactSecrets(original);
  const originalSha256 = sha256Hex(original);
  return { text, redacted: text !== original, originalSha256, storedSha256: text === original ? originalSha256 : sha256Hex(text) };
}

/** Redact every string inside a JSON-like value (keys untouched). Base64 holders of binary content parts
 * (`data` / `resource.blob` beside a mimeType) are owner artifacts and are kept as-is. */
export function redactToolJson<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactSecrets(node);
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    const binary = typeof source.mimeType === "string";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      out[key] = binary && (key === "data" || key === "blob") && typeof child === "string" ? child : walk(child);
    }
    return out;
  };
  return walk(value) as T;
}

// ── scope + disk layout ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultScope { runtimeKind: string; sessionKey: string; cwd?: string; chatId?: string; agentId?: string }

/** The durable identity of "the same chat/run scope". The runtime kind and session fingerprint are deliberately not
 * part of it when a chat id exists: a restart or a generation switch changes them but not the chat that owns the
 * handle. Without a chat id the session key is the only identity there is. */
export function durableScopeId(scope: ResultScope): string {
  return sha256Hex(JSON.stringify(scope.chatId
    ? ["chat", scope.chatId, scope.agentId ?? null, scope.cwd ?? null]
    : ["session", scope.runtimeKind, scope.sessionKey, scope.agentId ?? null, scope.cwd ?? null])).slice(0, 32);
}

const REF = /^tr-([re])-([a-f0-9]{64})$/;
export const toolResultRef = (isError: boolean, storedSha256: string): string => `tr-${isError ? "e" : "r"}-${storedSha256}`;
export const isToolResultRef = (ref: unknown): ref is string => typeof ref === "string" && REF.test(ref);

function scopeDir(scopeId: string): string {
  return userDataPath("harness", "tool-results", "ctx", scopeId);
}
const entryFile = (scopeId: string, ref: string): string => path.join(scopeDir(scopeId), `${ref}.json`);
const revokedFile = (scopeId: string, ref: string): string => `${entryFile(scopeId, ref)}.revoked`;

export interface StoredToolResult {
  schema: typeof TOOL_RESULT_ENTRY_SCHEMA;
  ref: string;
  scopeId: string;
  isError: boolean;
  text: string;
  bytes: number;
  firstCallId: string | null;
  redacted: boolean;
  originalSha256: string;
  storedSha256: string;
  createdAt: string;
}

/** Commit (idempotent): the same scope + stored text is one file. Returns the entry, or null if the disk refused. */
export function writeToolResult(scope: ResultScope, redacted: RedactedText, isError: boolean, firstCallId: string | null): StoredToolResult | null {
  const scopeId = durableScopeId(scope);
  const ref = toolResultRef(isError, redacted.storedSha256);
  const entry: StoredToolResult = {
    schema: TOOL_RESULT_ENTRY_SCHEMA, ref, scopeId, isError, text: redacted.text,
    bytes: Buffer.byteLength(redacted.text, "utf8"), firstCallId, redacted: redacted.redacted,
    originalSha256: redacted.originalSha256, storedSha256: redacted.storedSha256, createdAt: new Date().toISOString(),
  };
  try {
    const file = entryFile(scopeId, ref);
    if (fs.existsSync(file)) { const existing = readToolResult(scope, ref); if (existing) return existing; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(entry)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return entry;
  } catch {
    return null;
  }
}

export type ToolResultLookup = StoredToolResult | "revoked" | null;

/** Scoped read. A ref from another scope is simply absent (its file lives in another scope directory), and a stored
 * file whose hash no longer matches its text is refused rather than served. */
export function lookupToolResult(scope: ResultScope, ref: string): ToolResultLookup {
  const match = REF.exec(ref);
  if (!match) return null;
  const scopeId = durableScopeId(scope);
  try {
    if (fs.existsSync(revokedFile(scopeId, ref))) return "revoked";
    const entry = JSON.parse(fs.readFileSync(entryFile(scopeId, ref), "utf8")) as StoredToolResult;
    if (entry.schema !== TOOL_RESULT_ENTRY_SCHEMA || entry.scopeId !== scopeId || entry.ref !== ref
      || entry.storedSha256 !== match[2] || sha256Hex(entry.text) !== entry.storedSha256) return null;
    return entry;
  } catch {
    return null;
  }
}
export function readToolResult(scope: ResultScope, ref: string): StoredToolResult | null {
  const found = lookupToolResult(scope, ref);
  return found && found !== "revoked" ? found : null;
}

/** Access revoke: the reader stops serving this ref; the bytes stay. Reversible by removing the marker. */
export function revokeToolResultAccess(scope: ResultScope, ref: string): boolean {
  if (!isToolResultRef(ref)) return false;
  const scopeId = durableScopeId(scope);
  try {
    if (!fs.existsSync(entryFile(scopeId, ref))) return false;
    fs.writeFileSync(revokedFile(scopeId, ref), new Date().toISOString(), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Owner action only (never reachable from a model tool): removes the stored bytes and any revoke marker. */
export function deleteToolResultByOwner(scope: ResultScope, ref: string): boolean {
  if (!isToolResultRef(ref)) return false;
  const scopeId = durableScopeId(scope);
  let removed = false;
  try { fs.rmSync(entryFile(scopeId, ref)); removed = true; } catch { /* absent */ }
  try { fs.rmSync(revokedFile(scopeId, ref)); } catch { /* absent */ }
  return removed;
}
