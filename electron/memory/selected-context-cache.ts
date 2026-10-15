// Disposable host cache only. SQL recall and its source fingerprint establish
// eligibility before lookup; a cached string never grants another scope.
import { createHash } from "node:crypto";

export interface SelectedMemoryCacheIdentity {
  ownerNamespace: string;
  revision: number;
  revocationEpoch: number;
  actorId: string | null;
  visibilityDomain: string;
  projectId: string | null;
  projectPath: string | null;
  sourceDigest: string;
  queryDigest: string;
}

export function createSelectedMemoryContextCache(options: {
  maxEntries?: number; maxBytes?: number; maxAgeMs?: number; now?: () => number;
} = {}) {
  const maxEntries = options.maxEntries ?? 80, maxBytes = options.maxBytes ?? 512 * 1024;
  const maxAge = options.maxAgeMs ?? 60_000, now = options.now ?? Date.now;
  const entries = new Map<string, { text: string; sourceIds: string[]; bytes: number; expires: number }>();
  let bytes = 0, custody = "";
  function clear(): void { entries.clear(); bytes = 0; custody = ""; }
  function key(identity: SelectedMemoryCacheIdentity): string {
    const currentCustody = JSON.stringify([identity.ownerNamespace, identity.revocationEpoch]);
    if (custody !== currentCustody) { clear(); custody = currentCustody; }
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }
  function remove(id: string): void {
    const row = entries.get(id); if (row) bytes -= row.bytes; entries.delete(id);
  }
  function getSelection(identity: SelectedMemoryCacheIdentity): { text: string; sourceIds: string[] } | null {
    const id = key(identity), row = entries.get(id);
    if (!row) return null;
    if (row.expires <= now()) { remove(id); return null; }
    entries.delete(id); entries.set(id, row);
    return { text: row.text, sourceIds: [...row.sourceIds] };
  }
  function get(identity: SelectedMemoryCacheIdentity): string | null { return getSelection(identity)?.text ?? null; }
  function set(identity: SelectedMemoryCacheIdentity, text: string, sourceIds: readonly string[] = []): void {
    const ids = [...new Set(sourceIds)];
    const id = key(identity), size = Buffer.byteLength(text) + (ids.length ? Buffer.byteLength(JSON.stringify(ids)) : 0);
    if (size > maxBytes || maxEntries < 1) return;
    remove(id); entries.set(id, { text, sourceIds: ids, bytes: size, expires: now() + maxAge }); bytes += size;
    while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!);
  }
  return { get, getSelection, set, clear, stats: () => ({ entries: entries.size, bytes }) };
}

export const selectedMemoryContextCache = createSelectedMemoryContextCache();
const invalidators = new Set<() => void>();
/** Host-only disposable-cache observers, never model/provider callbacks. */
export function registerMemoryRecallCacheInvalidator(clear: () => void): () => void {
  invalidators.add(clear); return () => invalidators.delete(clear);
}
export function clearSelectedMemoryContextCache(): void {
  selectedMemoryContextCache.clear();
  for (const clear of invalidators) try { clear(); } catch { /* Durable forget already committed. */ }
}

/** Bounded disposable generation slots. Identity keys come from an opaque
 * host generation; source dependencies are validated by the pack reader. */
export function createMemoryGenerationCache<T extends { byteSize: number }>(maxEntries = 32, maxBytes = 512 * 1024) {
  const rows = new Map<string, { value: T; bytes: number }>();
  let bytes = 0;
  function clear() { rows.clear(); bytes = 0; }
  registerMemoryRecallCacheInvalidator(clear);
  return {
    get(key: string): T | null { const row = rows.get(key); if (!row) return null; rows.delete(key); rows.set(key, row); return row.value; },
    set(key: string, value: T) { const old = rows.get(key); if (old) bytes -= old.bytes; rows.delete(key);
      if (value.byteSize > maxBytes) return; rows.set(key, { value, bytes: value.byteSize }); bytes += value.byteSize;
      while (rows.size > maxEntries || bytes > maxBytes) { const id = rows.keys().next().value!; bytes -= rows.get(id)!.bytes; rows.delete(id); } },
    clear, stats: () => ({ entries: rows.size, bytes }),
  };
}
