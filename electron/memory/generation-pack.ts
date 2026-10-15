// A disposable selected prefix plus bounded original-source delta. SQLite
// authority and original IDs remain authoritative; cached prose is never input
// to a summarizer or a substitute for a missing/deleted source.
import { createHash } from "node:crypto";
import path from "node:path";
import { getDb } from "../store/db";
import { getMemoryDb } from "./database";
import { listMemoryForContext, type MemoryEntry } from "./store";
import { nativeRecallFor, ensureNativeTextTables } from "./native-text";
import { memoryGenerationState, type MemoryContextGeneration } from "./context-generation";
import { localEmbeddingTokens } from "./local-embedding";
import { createMemoryGenerationCache, registerMemoryRecallCacheInvalidator } from "./selected-context-cache";
import { currentMemorySourceCustody, type MemorySourceCustody } from "./source-custody";
import { getCredentialStateRevision, getEnvConfigurationRevision } from "../secrets/vault";
import type { AgentContextIdentity } from "../store/agent-context";
import type { RunnerRequest } from "../runtime/runner";
import type { SessionTaskBoundary } from "./session-checkpoints";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const CHANGE_LIMIT = 256, DELTA_SOURCE_LIMIT = 32;
interface Pack {
  text: string; baseIds: string[]; eligibleIds: string[]; deltaIds: string[];
  dependencyDigest: string; dependencyIds: string[]; probeTerms: string[]; seenSeq: number; watch: string; byteSize: number;
}
const cache = createMemoryGenerationCache<Pack>();
let cacheCustody = "";
const coverageReasons: Record<string, number> = {};
export function recordMemoryGenerationFallback(reason: string) { coverageReasons[reason] = (coverageReasons[reason] ?? 0) + 1; }
const counts = { fullScans: 0, fullRankings: 0, queryShiftScans: 0, queryShiftRankings: 0, deltaRankings: 0, dependencyReads: 0, prefixReuse: 0, fallbacks: 0, inputBytes: 0 };
export function memoryGenerationPackStats() { return { ...counts, coverageReasons: { ...coverageReasons }, cache: cache.stats() }; }
export function resetMemoryGenerationPackStats() { for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0; }
export function clearMemoryGenerationPacks() { cache.clear(); }
const journalReady = new WeakMap<object, { signature: string; complete: boolean; lastPruned: number }>();
function changes() {
  const db = getMemoryDb();
  ensureNativeTextTables();
  const schemaSignature = () => sha(db.prepare(`SELECT name,sql FROM sqlite_master WHERE name GLOB 'memory_recall_*'
    OR name IN ('memory_entries','memory_entry_native','memory_identity_bindings','memory_project_links','memory_origin_links')
    ORDER BY name`).all());
  const before = schemaSignature(), prior = journalReady.get(db);
  if (!prior || prior.signature !== before) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_recall_changes(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, dependency TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_recall_clock(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL,nonce TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_recall_clock SELECT 1,COALESCE(MAX(seq),0),lower(hex(randomblob(16))) FROM memory_recall_changes;
      CREATE TRIGGER IF NOT EXISTS memory_recall_clock_advance AFTER INSERT ON memory_recall_changes
        BEGIN UPDATE memory_recall_clock SET nonce=CASE WHEN NEW.seq<=seq THEN lower(hex(randomblob(16))) ELSE nonce END,seq=NEW.seq WHERE id=1; END;
      CREATE INDEX IF NOT EXISTS idx_memory_recall_changes_source ON memory_recall_changes(source_id,seq);`);
    const watches = [
      ["memory_entries", "id"], ["memory_entry_native", "entry_id"],
      ["memory_identity_bindings", "memory_id"], ["memory_project_links", "memory_id"],
      ["memory_origin_links", "memory_id"],
    ] as const;
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    // Names are compile-time identifiers; trigger bodies store no source text.
    let complete = true;
    for (const [table, id] of watches) {
      if (!present.has(table)) { complete = false; continue; }
      for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
        const ref = event === "DELETE" ? "OLD" : "NEW";
        db.exec(`CREATE TRIGGER IF NOT EXISTS memory_recall_watch_${table}_${event.toLowerCase()}
          AFTER ${event} ON ${table} BEGIN INSERT INTO memory_recall_changes(source_id,dependency)
          VALUES(${ref}.${id},'${table}'); END;`);
      }
    }
    // Missing/replaced triggers create a coverage hole. Repairing their names
    // must rotate the derived instance even when the resulting SQL is identical.
    if (prior) db.prepare("UPDATE memory_recall_clock SET nonce=lower(hex(randomblob(16))) WHERE id=1").run();
    journalReady.set(db, { signature: schemaSignature(), complete, lastPruned: 0 });
  }
  const readiness = journalReady.get(db)!;
  const clock = db.prepare("SELECT seq,nonce FROM memory_recall_clock WHERE id=1").get() as { seq: number; nonce: string };
  const maximum = Number(clock.seq);
  if (maximum > 2048 && maximum !== readiness.lastPruned) {
    db.prepare("DELETE FROM memory_recall_changes WHERE seq<?").run(maximum - 2048); readiness.lastPruned = maximum;
  }
  return { db, complete: readiness.complete, watch: sha([readiness.signature, clock.nonce]), max: maximum };
}
export interface GenerationPackResult { text: string; eligibleIds: string[]; selectedIds: string[]; prefix: string; }
export function readGenerationMemoryPack(token: MemoryContextGeneration, input: {
  query: string; maxApproxTokens: number;
  select(entries: MemoryEntry[], query: string, tokenBudget: number): MemoryEntry[];
  render(entries: MemoryEntry[]): string;
}): GenerationPackResult | null {
  try {
    const identity = memoryGenerationState(token), journal = changes();
    const custody = JSON.stringify([identity.ownerNamespace, identity.revocationEpoch]);
    if (cacheCustody !== custody) { cache.clear(); cacheCustody = custody; }
    if (!journal.complete) { counts.fallbacks++; return null; }
    const scope = { projectId: identity.projectId, projectPath: identity.projectPath, agentId: identity.actorId, chatId: identity.chatId, visibilityDomain: identity.visibilityDomain };
    const dependencies = (ids: string[]) => {
      counts.dependencyReads++;
      const entries = listMemoryForContext(scope, -1, ids);
      const native = nativeRecallFor("memory_entry", ids);
      const linked = ids.length ? journal.db.prepare(`SELECT memory_id,revision,owner_namespace,actor_id,applicability_json,origin_refs_json
        FROM memory_identity_bindings WHERE memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY memory_id`).all(...ids) : [];
      const projects = ids.length ? journal.db.prepare(`SELECT * FROM memory_project_links WHERE memory_id IN (${ids.map(() => "?").join(",")})
        ORDER BY memory_id,project_id,relation,source_ref`).all(...ids) : [];
      const origins = ids.length ? journal.db.prepare(`SELECT * FROM memory_origin_links WHERE memory_id IN (${ids.map(() => "?").join(",")})
        ORDER BY memory_id,source_kind,source_id,source_revision`).all(...ids) : [];
      return { entries, digest: sha([entries, [...native], linked, projects, origins, input.render(entries)]) };
    };
    let pack = cache.get(identity.key);
    let updateIds: string[] = [];
    if (pack) {
      const rows = journal.db.prepare("SELECT seq,source_id FROM memory_recall_changes WHERE seq>? ORDER BY seq LIMIT ?")
        .all(pack.seenSeq, CHANGE_LIMIT + 1) as Array<{ seq: number; source_id: string }>;
      const gap = journal.max < pack.seenSeq || (journal.max > pack.seenSeq && rows.length === 0)
        || (rows.length > 0 && rows[rows.length - 1].seq !== journal.max)
        || rows.length > CHANGE_LIMIT || rows.some((row, index) => row.seq !== pack!.seenSeq + index + 1);
      const source = dependencies(pack.dependencyIds);
      if (gap || pack.watch !== journal.watch || source.digest !== pack.dependencyDigest) pack = null;
      else updateIds = [...new Set(rows.map(row => row.source_id))];
    }
    if (!pack) {
      counts.fullScans++;
      const entries = listMemoryForContext(scope, -1);
      // Host task objective anchors the generation; the fresh current request
      // remains separate and overrides prior learning at the actual caller.
      const query = identity.task ? [identity.task.goal, ...identity.task.constraints, input.query].join("\n") : input.query;
      counts.fullRankings++;
      const base = input.select(entries, query, input.maxApproxTokens);
      const text = input.render(base);
      pack = { text, baseIds: base.map(entry => entry.id), eligibleIds: entries.map(entry => entry.id), deltaIds: [],
        dependencyDigest: dependencies(base.map(entry => entry.id)).digest, dependencyIds: base.map(entry => entry.id),
        probeTerms: [...new Set(localEmbeddingTokens(input.query))].sort(),
        seenSeq: journal.max, watch: journal.watch, byteSize: 0 };
    } else counts.prefixReuse++;
    if (updateIds.length) {
      const eligible = new Set(pack.eligibleIds);
      for (const id of updateIds) eligible.delete(id);
      const changed = listMemoryForContext(scope, -1, updateIds);
      for (const row of changed) eligible.add(row.id);
      pack.eligibleIds = [...eligible];
      const base = new Set(pack.baseIds);
      pack.deltaIds = [...new Set([...changed.map(entry => entry.id).filter(id => !base.has(id)), ...pack.deltaIds.filter(id => !updateIds.includes(id))])].slice(0, DELTA_SOURCE_LIMIT);
    }
    const queryTerms = [...new Set(localEmbeddingTokens(input.query))].sort();
    if (sha(queryTerms) !== sha(pack.probeTerms)) {
      // Query terms are a retrieval-probe trigger, never generation identity
      // or task authority. Existing relevant sources must not be excluded for
      // an entire task simply because no new write occurred.
      counts.fullScans++; counts.queryShiftScans++; counts.queryShiftRankings++;
      const candidates = listMemoryForContext(scope, -1);
      const probe = input.select(candidates, input.query, 200);
      const base = new Set(pack.baseIds);
      pack.deltaIds = [...new Set([...probe.map(entry => entry.id).filter(id => !base.has(id)), ...pack.deltaIds])].slice(0, DELTA_SOURCE_LIMIT);
      pack.probeTerms = queryTerms;
    }
    const deltaSources = listMemoryForContext(scope, -1, pack.deltaIds);
    const remaining = Math.max(0, input.maxApproxTokens - Math.ceil(Buffer.byteLength(pack.text) / 3));
    let delta: MemoryEntry[] = [];
    if (deltaSources.length && remaining > 0) {
      counts.deltaRankings++;
      // The current request gets its own bounded relevance pass. A new source
      // relevant only to an obsolete request cannot displace the pinned prefix.
      delta = input.select(deltaSources, input.query, Math.min(200, Math.max(0, remaining - 32))).slice(0, 3);
    }
    const deltaText = delta.length ? `### Recent governed memory changes\n${input.render(delta)}` : "";
    const text = [pack.text, deltaText].filter(Boolean).join("\n\n");
    const selectedIds = [...pack.baseIds, ...delta.map(entry => entry.id)];
    // Only injected originals invalidate the pinned selection. Non-injected
    // candidate changes remain bounded delta and cannot churn this prefix.
    pack.dependencyIds = selectedIds;
    pack.dependencyDigest = dependencies(selectedIds).digest;
    pack.seenSeq = journal.max;
    pack.byteSize = Buffer.byteLength(JSON.stringify(pack));
    memoryGenerationState(token);
    cache.set(identity.key, pack);
    const sourceScope = currentMemorySourceCustody();
    if (sourceScope && pack.text) {
      const baseDigest = dependencies(pack.baseIds).digest;
      const capturedIdentity = { ...identity };
      const grants = sourcePacks.get(sourceScope) ?? new Map<string, PackGrant>();
      const channel = sha([identity.actorId, identity.visibilityDomain, identity.projectId, identity.projectPath]);
      grants.set(channel, { prefix: pack.text, generation: token, identity: capturedIdentity, baseDigest,
        credentialRevision: getCredentialStateRevision(), envRevision: getEnvConfigurationRevision(),
        assertCurrent() { memoryGenerationState(token); if (dependencies(pack!.baseIds).digest !== baseDigest)
          throw new Error("memory_pack_dependency_changed"); } });
      while (grants.size > 32) grants.delete(grants.keys().next().value!);
      sourcePacks.set(sourceScope, grants);
    }
    counts.inputBytes += Buffer.byteLength(text);
    return { text, prefix: pack.text, eligibleIds: [...pack.eligibleIds], selectedIds };
  } catch { counts.fallbacks++; return null; }
}


interface PackGrant {
  prefix: string; generation: MemoryContextGeneration;
  identity: ReturnType<typeof memoryGenerationState>; baseDigest: string;
  credentialRevision: number; envRevision: number; assertCurrent(): void;
}
const sourcePacks = new WeakMap<MemorySourceCustody, Map<string, PackGrant>>();
export interface MemoryPackWireBinding { readonly schema: "agentlas.memory-pack-wire.v1" }
const wireBindings = new WeakMap<MemoryPackWireBinding, { grant: PackGrant; scope: MemorySourceCustody }>();
const wireAcks = new Set<string>();
registerMemoryRecallCacheInvalidator(() => wireAcks.clear());
/** Called only beside the actual private AgentContext capability. A marker,
 * request hash, renderer DTO or a copied binding can never register a pack. */
export function prepareMemoryPackWire(req: RunnerRequest, identity: AgentContextIdentity,
  task: SessionTaskBoundary | null): MemoryPackWireBinding | null {
  const scope = currentMemorySourceCustody(), grants = scope && sourcePacks.get(scope);
  if (!scope || !grants) { recordMemoryGenerationFallback("wire-source-pack-unavailable"); return null; }
  for (const grant of grants.values()) {
    const state = grant.identity;
    if (state.ownerScope !== identity.ownerScope || state.serviceIdentity !== identity.serviceIdentity
      || state.actorId !== identity.agentId || state.visibilityDomain !== identity.visibilityDomain
      || state.chatId !== req.chatId || sha(state.task) !== sha(task)) continue;
    // Project applicability is separate from provenance. An unchanged body
    // cannot bind the old folder after the actual host request moves folders.
    if (state.projectPath && (!req.cwd || path.resolve(state.projectPath) !== path.resolve(req.cwd))) continue;
    if (!state.projectPath && state.projectId) {
      const chat = getDb().prepare("SELECT project_id FROM chats WHERE id=?").get(state.chatId) as { project_id: string | null } | undefined;
      if (chat?.project_id !== state.projectId) continue;
    }
    const text = req.turnContext ?? "", at = text.indexOf(grant.prefix);
    if (at < 0 || text.indexOf(grant.prefix, at + grant.prefix.length) >= 0) continue;
    try {
      grant.assertCurrent();
      if (grant.credentialRevision !== getCredentialStateRevision() || grant.envRevision !== getEnvConfigurationRevision()) continue;
      const token: MemoryPackWireBinding = Object.freeze({ schema: "agentlas.memory-pack-wire.v1" });
      wireBindings.set(token, { grant, scope }); return token;
    } catch { /* Keep the original context if any custody or source changed. */ }
  }
  recordMemoryGenerationFallback("wire-identity-or-current-source-mismatch"); return null;
}
export function memoryPackWireBlocks(binding: MemoryPackWireBinding | null): readonly string[] {
  const value = binding && wireBindings.get(binding); return value ? [value.grant.prefix] : [];
}
function wireFence(binding: MemoryPackWireBinding | null, bindingKey: string, generation: number): string | null {
  const value = binding && wireBindings.get(binding); if (!value || value.scope !== currentMemorySourceCustody()) return null;
  const grant = value.grant;
  try { grant.assertCurrent(); } catch { return null; }
  if (grant.credentialRevision !== getCredentialStateRevision() || grant.envRevision !== getEnvConfigurationRevision()) return null;
  return sha([grant.identity.key, grant.baseDigest, bindingKey, generation, grant.credentialRevision, grant.envRevision]);
}
export function memoryPackWireCanReuse(binding: MemoryPackWireBinding | null, bindingKey: string, generation: number): boolean {
  const fence = wireFence(binding, bindingKey, generation); return Boolean(fence && wireAcks.has(fence));
}
export function settleMemoryPackWire(binding: MemoryPackWireBinding | null, bindingKey: string, generation: number, acknowledged: boolean): void {
  const value = binding && wireBindings.get(binding); if (!value) return;
  const rawFence = sha([value.grant.identity.key, value.grant.baseDigest, bindingKey, generation,
    value.grant.credentialRevision, value.grant.envRevision]);
  const fence = acknowledged ? wireFence(binding, bindingKey, generation) : null;
  if (!fence) { wireAcks.delete(rawFence); return; }
  wireAcks.add(fence); while (wireAcks.size > 128) wireAcks.delete(wireAcks.values().next().value!);
}
