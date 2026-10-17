import { createHash } from "node:crypto";
import type { OneMemoryAsset, OneMemoryState, OneMemoryInvocationScope } from "../../shared/one-memory";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { getDb as getProductDb } from "../store/db";
import { oneScopedMetaKey } from "../store/one-profile";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { insertMemoryEntry } from "./store";
import { assertMemoryWriteAllowed, revokeOneMemoryEntry } from "./revocations";
import { clearSelectedMemoryContextCache } from "./selected-context-cache";
import { recordAutomaticMemoryTurn } from "./automatic-curator";
import { observeProductSource } from "./source-catalogue";
import { captureTrustedMemoryIntake, withMemorySourceCustody } from "./source-custody";
import { nativeTextsFor } from "./native-text";

const BASE = "agentlas.one.memory.v1";
const archiveParsers = new Map<string, (raw: string) => OneMemoryState>();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function source() {
  const product = getProductDb();
  const legacyKey = oneScopedMetaKey(BASE);
  const sourceKey = digest(JSON.stringify([product.name, legacyKey]));
  return { product, legacyKey, sourceKey, stateKey: `one-legacy-state:${sourceKey}` };
}
/** The product shadow this module writes after the central commit (never a state). */
function isCutoverPointer(raw: string, sourceKey: string): boolean {
  try {
    const value = JSON.parse(raw) as { schemaVersion?: unknown; sourceKey?: unknown };
    return value?.schemaVersion === "agentlas.one-memory-cutover.v1" && value.sourceKey === sourceKey;
  } catch { return false; }
}
const mapKey = (sourceKey: string, id: string) => `one-legacy-asset:${sourceKey}:${id}`;
const sourceId = (sourceKey: string, id: string) => `one-legacy:${sourceKey}:${id}`;

function mappedId(sourceKey: string, assetId: string): string | null {
  return (getMemoryDb().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(mapKey(sourceKey, assetId)) as { value: string } | undefined)?.value ?? null;
}

function projection(id: string) {
  const owner = getMemoryStoreInfo().ownerNamespace;
  return getMemoryDb().prepare(`SELECT e.id,e.content,e.superseded_at,b.applicability_json,b.revision
    FROM memory_entries e JOIN memory_identity_bindings b ON b.memory_id=e.id
    WHERE e.id=? AND e.agent_id=? AND b.owner_namespace=?`).get(id, BUILTIN_ONE_AGENT_ID, owner) as
    { id: string; content: string; superseded_at: string | null; applicability_json: string; revision: number } | undefined;
}

function markProjection(id: string, asset: OneMemoryAsset, previous?: OneMemoryAsset): void {
  const db = getMemoryDb(), row = projection(id);
  if (!row || row.superseded_at) throw new Error("one_legacy_memory_revoked");
  const applicability = JSON.parse(row.applicability_json) as Record<string, unknown>;
  if (applicability.recallChannel !== "legacy_one_overlay"
    || (previous && Number(applicability.legacyAssetVersion) !== previous.version)) throw new Error("one_legacy_source_changed");
  // The legacy archive no longer edits learned content, including after translation.
  if (asset.enabled && applicability.enabled === false) {
    assertMemoryWriteAllowed({ scope: "agent_repo", kind: "hypothesis", content: asset.content, agentId: BUILTIN_ONE_AGENT_ID,
      intakeEpoch: getMemoryStoreInfo().revocationEpoch });
  }

  const next = { ...applicability, recallChannel: "legacy_one_overlay", enabled: asset.enabled,
    compatibilityScope: { scope: asset.scope, scopeRef: asset.scopeRef },
    legacyAssetId: asset.id, legacyAssetVersion: asset.version,
    approvalSource: asset.approvalSource, approvedAt: asset.approvedAt, provenanceStatus: asset.provenanceStatus };
  const bound = db.prepare("UPDATE memory_identity_bindings SET applicability_json=?,revision=revision+1 WHERE memory_id=? AND revision=?")
    .run(JSON.stringify(next), id, row.revision);
  if (bound.changes !== 1) throw new Error("one_legacy_source_changed");
  db.prepare("DELETE FROM memory_project_links WHERE memory_id=? AND relation='applies_to'").run(id);
  if (asset.scope === "project" && asset.scopeRef) db.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) VALUES(?,?,'applies_to','')").run(id, asset.scopeRef);
  // Scope/enable metadata is authority even when the content is unchanged.
  db.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
  const store = getMemoryStoreInfo(), now = new Date().toISOString();
  const key = source().sourceKey;
  db.prepare(`INSERT OR IGNORE INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation)
    VALUES(?,'one-legacy-asset',?,?,'origin')`).run(id, sourceId(key, asset.id), String(asset.version));
  db.prepare(`INSERT OR IGNORE INTO memory_projection_outbox(outbox_id,memory_id,authority_revision,state,payload_json,created_at,updated_at)
    VALUES(?,?,?,'queued','{}',?,?)`).run(`one-legacy:${id}:${store.revision}`, id, store.revision, now, now);
}

function admitAsset(sourceKey: string, asset: OneMemoryAsset): void {
  const db = getMemoryDb();
  // A durable mapping survives forget. A reader cannot re-import a deleted row.
  if (mappedId(sourceKey, asset.id)) return;
  try {
    const row = insertMemoryEntry({ scope: "agent_repo", kind: "hypothesis", content: asset.content,
      agentId: BUILTIN_ONE_AGENT_ID, projectId: asset.scope === "project" ? asset.scopeRef : null, evidence: asset.evidenceRefs,
      originRefs: [{ kind: "source", id: sourceId(sourceKey, asset.id), revision: String(asset.version) }],
      curationActor: "legacy", recallChannel: "legacy_one_overlay",
      compatibilityScope: { scope: asset.scope, scopeRef: asset.scopeRef }, enabled: asset.enabled, policyVersion: "agentlas.one-legacy.v1",
      intakeEpoch: getMemoryStoreInfo().revocationEpoch });
    markProjection(row.id, asset);
    db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(mapKey(sourceKey, asset.id), row.id);
  } catch (error) {
    // Preserve the legacy UI record without resurrecting a canonical tombstone.
    if (!(error instanceof Error) || error.name !== "MemoryRevokedError") throw error;
    db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(mapKey(sourceKey, asset.id), "revoked");
  }
}

/** Closed legacy payload remains intact; canonical SQL owns all new mutations. */
export function readLegacyOneState(parse: (raw: string) => OneMemoryState, initial: () => OneMemoryState): { raw: string; state: OneMemoryState } {
  const binding = source(), db = getMemoryDb();
  archiveParsers.set(binding.stateKey, parse);
  const load = db.transaction(() => {
    let row = db.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(binding.stateKey) as { value: string } | undefined;
    if (!row) {
      const shadow = binding.product.prepare("SELECT value FROM meta WHERE key=?").get(binding.legacyKey) as { value: string } | undefined;
      // A cutover pointer says the state already moved to a central store; it is not a state. This store having no row
      // (another memory root or owner namespace: a fresh ~/.agentlas, a regenerated registry, a copied app database)
      // means this store has no legacy state. Parsing the pointer failed every read for good — dev 2026-10-17: 1326
      // oneMemory:getState errors in one hour, production 2026-10-14 for 8 minutes.
      const old = shadow && !isCutoverPointer(shadow.value, binding.sourceKey) ? shadow : undefined;
      if (shadow && !old) console.warn("[one-memory] one_memory_cutover_central_missing: this store starts empty");
      const state = old ? parse(old.value) : initial();
      const raw = old?.value ?? JSON.stringify(state);
      for (const asset of state.memories) admitAsset(binding.sourceKey, asset);
      db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?)").run(binding.stateKey, raw);
      row = { value: raw };
    }
    const state = parse(row.value);
    queuePending(binding.sourceKey, state);
    return { raw: row.value, state };
  });
  const result = load.immediate();
  observeProductSource(binding.product, { actorId: BUILTIN_ONE_AGENT_ID,
    visibilityDomain: "legacy-one-overlay", logicalKey: binding.stateKey, sourceKind: "legacy-one-state",
    readerContract: "desktop.one-legacy-state.v1", writerContract: "desktop.one-legacy-adapter",
    schemaVersion: "agentlas.one-memory.v1", sourceRevision: digest(result.raw),
    address: { path: getMemoryStoreInfo().path, metaKey: binding.stateKey }, rangeUnit: "utf8",
    rangeEnd: Buffer.byteLength(result.raw, "utf8"), contentDigest: digest(result.raw) });
  binding.product.transaction(() => {
    // Central commit precedes pointer/fence installation. ATTACH databases in
    // WAL mode do not promise cross-file power-loss atomicity; retry never
    // replaces the committed central authority from a product shadow.
    const trigger = `one_legacy_fence_${binding.sourceKey}`;
    const literal = binding.legacyKey.replace(/'/g, "''");
    const pointer = JSON.stringify({ schemaVersion: "agentlas.one-memory-cutover.v1", sourceKey: binding.sourceKey });
    const shadow = binding.product.prepare("SELECT value FROM meta WHERE key=?").get(binding.legacyKey) as { value: string } | undefined;
    if (shadow?.value !== pointer) {
      binding.product.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(binding.legacyKey, pointer);
    }
    binding.product.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}_update BEFORE UPDATE ON meta
      WHEN OLD.key='${literal}' BEGIN SELECT RAISE(ABORT,'one_memory_store_upgrade_required'); END;
      CREATE TRIGGER IF NOT EXISTS ${trigger}_insert BEFORE INSERT ON meta
      WHEN NEW.key='${literal}' BEGIN SELECT RAISE(ABORT,'one_memory_store_upgrade_required'); END;
      CREATE TRIGGER IF NOT EXISTS ${trigger}_delete BEFORE DELETE ON meta
      WHEN OLD.key='${literal}' BEGIN SELECT RAISE(ABORT,'one_memory_store_upgrade_required'); END;`);
  }).immediate();
  retryDeletes(binding.sourceKey);
  return result;
}

/** Keep historical approval/source metadata without retaining forgotten prose. */
function archiveRemovedAsset(sourceKey: string, state: OneMemoryState, asset: OneMemoryAsset, canonicalId: string | null): Set<string> {
  const candidates = state.candidates.filter(candidate => candidate.id === asset.sourceCandidateId || candidate.memoryId === asset.id);
  const { content: _content, ...assetAudit } = asset;
  const candidateAudit = candidates.map(candidate => {
    const { normalizedPreview: _preview, ...audit } = candidate;
    return audit;
  });
  const key = `one-legacy-forgotten:${sourceKey}:${asset.id}`;
  getMemoryDb().prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)").run(key, JSON.stringify({
    schemaVersion: "agentlas.one-legacy-forget-audit.v1", sourceKey, canonicalMemoryId: canonicalId,
    archiveRevision: state.version, forgotten: true, forgottenAt: new Date().toISOString(),
    asset: assetAudit, candidates: candidateAudit,
  }));
  return new Set(candidates.map(candidate => candidate.id));
}

/** Exact canonical source mappings only, inside the original owner forget transaction. */
export function purgeLegacyOneArchivedBodies(memoryIds: readonly string[]): void {
  if (!getProductDb().inTransaction) throw new Error("one_legacy_purge_requires_transaction");
  if (memoryIds.length === 0) return;
  const db = getMemoryDb(), placeholders = memoryIds.map(() => "?").join(",");
  // A supplied ID is not authority: the original revocation must already bind it.
  const mappings = db.prepare(`SELECT m.key,m.value FROM memory_store_meta m
    JOIN memory_revocation_sources r ON r.source_memory_id=m.value
    WHERE m.key LIKE 'one-legacy-asset:%' AND m.value IN (${placeholders})`).all(...memoryIds) as Array<{ key: string; value: string }>;
  for (const mapping of mappings) {
    const match = /^one-legacy-asset:([a-f0-9]{64}):(.+)$/.exec(mapping.key);
    if (!match) throw new Error("one_legacy_mapping_invalid");
    const [, sourceKey, assetId] = match, stateKey = `one-legacy-state:${sourceKey}`;
    const stored = db.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(stateKey) as { value: string } | undefined;
    if (!stored) continue;
    const state = JSON.parse(stored.value) as OneMemoryState;
    if (!Array.isArray(state.memories) || !Array.isArray(state.candidates) || !Number.isSafeInteger(state.version)) {
      throw new Error("one_legacy_archive_invalid");
    }
    const asset = state.memories.find(row => row.id === assetId);
    if (!asset) continue; // A prior manual forget may already have removed it.
    const candidateIds = archiveRemovedAsset(sourceKey, state, asset, mapping.value);
    state.memories = state.memories.filter(row => row.id !== assetId);
    state.candidates = state.candidates.filter(row => !candidateIds.has(row.id));
    state.version = Math.max(Date.now(), state.version + 1);
    state.updatedAt = new Date(state.version).toISOString();
    const updated = db.prepare("UPDATE memory_store_meta SET value=? WHERE key=? AND value=?")
      .run(JSON.stringify(state), stateKey, stored.value);
    if (updated.changes !== 1) throw new Error("one_legacy_source_changed");
  }
}

export function replaceLegacyOneState(raw: string, previous: OneMemoryState, next: OneMemoryState): void {
  const binding = source(), db = getMemoryDb();
  const parse = archiveParsers.get(binding.stateKey);
  if (!parse || JSON.stringify(parse(raw)) !== JSON.stringify(previous)) throw new Error("one_legacy_source_changed");
  // Only historical rejection, disable and forget controls remain. Neither an
  // old preload nor an internal caller can reopen the legacy content writer.
  if (next.memories.some(asset => {
    const old = previous.memories.find(item => item.id === asset.id);
    const stable = (value: OneMemoryAsset) => Object.fromEntries(Object.entries(value).filter(([key]) =>
      !["version","enabled","updatedAt","disabledAt"].includes(key)));
    return !old || JSON.stringify(stable(asset)) !== JSON.stringify(stable(old));
  }) || next.candidates.some(candidate => {
    const old = previous.candidates.find(item => item.id === candidate.id);
    return !old || JSON.stringify([candidate.normalizedPreview,candidate.scope,candidate.scopeRef,candidate.source,candidate.memoryId])
      !== JSON.stringify([old.normalizedPreview,old.scope,old.scopeRef,old.source,old.memoryId])
      || (candidate.status !== old.status && candidate.status !== "rejected");
  })) throw new Error("one_memory_approval_retired");
  db.transaction(() => {
    // Old manual forget removes the asset before its deferred canonical cleanup.
    // Retain its audit and erase only the linked candidate's prose here as well.
    for (const asset of previous.memories) if (!next.memories.some(row => row.id === asset.id)) {
      const candidateIds = archiveRemovedAsset(binding.sourceKey, previous, asset, mappedId(binding.sourceKey, asset.id));
      next.candidates = next.candidates.filter(candidate => !candidateIds.has(candidate.id));
    }
    const updated = db.prepare("UPDATE memory_store_meta SET value=? WHERE key=? AND value=?")
      .run(JSON.stringify(next), binding.stateKey, raw);
    if (updated.changes !== 1) throw new Error("One Memory state changed concurrently; reload and try again");
    for (const asset of next.memories) {
      const old = previous.memories.find(item => item.id === asset.id);
      if (!old) admitAsset(binding.sourceKey, asset);
      else if (old.version !== asset.version) {
        const id = mappedId(binding.sourceKey, asset.id);
        if (!id || id === "revoked") throw new Error("one_legacy_memory_revoked");
        markProjection(id, asset, old);
      }
    }
    cancelResolvedCandidates(binding.sourceKey, previous, next);
    queuePending(binding.sourceKey, next);
    for (const old of previous.memories) if (!next.memories.some(item => item.id === old.id)) {
      const id = mappedId(binding.sourceKey, old.id);
      if (id && id !== "revoked") {
        // Hide immediately; physical forget has a durable retry marker.
        markProjection(id, { ...old, enabled: false });
        db.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)")
          .run(`one-legacy-delete:${binding.sourceKey}:${old.id}`, id);
      }
    }
  }).immediate();
  clearSelectedMemoryContextCache();
  retryDeletes(binding.sourceKey);
}

function retryDeletes(sourceKey: string): void {
  const db = getMemoryDb();
  const rows = db.prepare("SELECT key,value FROM memory_store_meta WHERE key LIKE ?").all(`one-legacy-delete:${sourceKey}:%`) as Array<{ key: string; value: string }>;
  for (const row of rows) {
    revokeOneMemoryEntry(row.value, BUILTIN_ONE_AGENT_ID);
    db.prepare("DELETE FROM memory_store_meta WHERE key=?").run(row.key);
  }
}

/** Generic recall excludes this channel; the existing One overlay owns scope. */
export function isLegacyOneAssetActive(asset: OneMemoryAsset): boolean {
  const id = mappedId(source().sourceKey, asset.id);
  if (!id || id === "revoked") return false;
  const row = projection(id);
  if (!row || row.superseded_at) return false;
  const metadata = JSON.parse(row.applicability_json) as Record<string, unknown>;
  return metadata.recallChannel === "legacy_one_overlay" && metadata.enabled !== false
    && metadata.legacyAssetId === asset.id && metadata.legacyAssetVersion === asset.version;
}

const candidateKey = (sourceKey: string, candidateId: string, version: number) => `one-legacy-candidate:${sourceKey}:${candidateId}:${version}`;

function queuePending(sourceKey: string, state: OneMemoryState): void {
  const db = getMemoryDb();
  let enqueued = 0;
  for (const candidate of state.candidates) {
    if (enqueued >= 16) break;
    if (candidate.status !== "pending" || state.suppressions.some(item => item.suppressionKey === candidate.suppressionKey
      && item.scope === candidate.scope && item.scopeRef === candidate.scopeRef && Date.parse(item.until) > Date.now())) continue;
    const key = candidateKey(sourceKey, candidate.id, candidate.version);
    if (db.prepare("SELECT 1 FROM memory_store_meta WHERE key=?").get(key)) continue;
    // A fresh migration observation cannot erase the age of its source.
    if (db.prepare("SELECT 1 FROM memory_revocations WHERE revoked_at>=? LIMIT 1").get(candidate.createdAt)) continue;
    const turnId = `one-legacy-observation:${sourceKey}:${candidate.id}:${candidate.version}`;
    const observation = `Unapproved legacy candidate observation (${candidate.source.provenanceStatus}); scope ${candidate.scope}. ${candidate.normalizedPreview}`;
    const context = { turnId, agentId: BUILTIN_ONE_AGENT_ID, chatId: null,
      projectId: candidate.scope === "project" ? candidate.scopeRef : null, projectPath: null,
      hostOutcome: "unknown" as const, memoryChannel: "legacy_one_overlay",
      memoryCompatibilityScope: { scope: candidate.scope, scopeRef: candidate.scopeRef } };
    const receipt = withMemorySourceCustody(captureTrustedMemoryIntake(context), () => recordAutomaticMemoryTurn({
      context: { turnId, agentId: BUILTIN_ONE_AGENT_ID, chatId: null,
        projectId: candidate.scope === "project" ? candidate.scopeRef : null, projectPath: null,
        hostOutcome: "unknown", memoryChannel: "legacy_one_overlay",
        memoryCompatibilityScope: { scope: candidate.scope, scopeRef: candidate.scopeRef } },
      turnSummary: observation.slice(0, 360), replyText: observation,
    }));
    // No selected runtime is invented; the configured host curator pool owns
    // any later model call. An unavailable pool leaves a durable retry job.
    db.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)").run(key, receipt.ticketId);
    enqueued++;
  }
}

function cancelResolvedCandidates(sourceKey: string, previous: OneMemoryState, next: OneMemoryState): void {
  const db = getMemoryDb();
  for (const old of previous.candidates) {
    const candidate = next.candidates.find(item => item.id === old.id);
    if (old.status !== "pending" || (candidate?.status === "pending" && candidate.version === old.version)) continue;
    const receipt = db.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(candidateKey(sourceKey, old.id, old.version)) as { value: string } | undefined;
    if (!receipt) continue;
    db.prepare(`UPDATE memory_curation_jobs SET state='revoked',payload_json='{}',lease_token=NULL,lease_expires_at=NULL
      WHERE ticket_id=? AND state IN ('queued','retry','deferred','processing')`).run(receipt.value);
    // Rejection/deletion also hides already-admitted derivatives of this
    // exact source; saving/using once retains its separate user action.
    if (candidate && candidate.status !== "rejected") continue;
    const rows = db.prepare(`SELECT DISTINCT e.id,b.applicability_json FROM memory_entries e
      JOIN memory_identity_bindings b ON b.memory_id=e.id JOIN memory_origin_links o ON o.memory_id=e.id
      WHERE o.source_kind='ticket' AND o.source_id=? AND e.agent_id=? AND e.superseded_at IS NULL`).all(receipt.value, BUILTIN_ONE_AGENT_ID) as Array<{ id: string; applicability_json: string }>;
    for (const row of rows) {
      const metadata = JSON.parse(row.applicability_json) as Record<string, unknown>;
      if (metadata.recallChannel !== "legacy_one_overlay") continue;
      db.prepare("UPDATE memory_identity_bindings SET applicability_json=?,revision=revision+1 WHERE memory_id=?")
        .run(JSON.stringify({ ...metadata, enabled: false }), row.id);
      db.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
      db.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)")
        .run(`one-legacy-delete:${sourceKey}:candidate:${old.id}:${row.id}`, row.id);
    }
  }
}

/** Model-curated rows never masquerade as closed explicit-user legacy assets. */
export function buildLegacyOneAutomaticContext(scope: OneMemoryInvocationScope): string {
  const rows = getMemoryDb().prepare(`SELECT e.content,e.evidence_json,b.applicability_json FROM memory_entries e
    JOIN memory_identity_bindings b ON b.memory_id=e.id WHERE e.agent_id=? AND e.superseded_at IS NULL
    AND b.owner_namespace=? AND b.curation_actor='model_curated'
    AND json_extract(b.applicability_json,'$.recallChannel')='legacy_one_overlay'
    AND COALESCE(json_extract(b.applicability_json,'$.enabled'),1)!=0 ORDER BY e.created_at DESC LIMIT 40`)
    .all(BUILTIN_ONE_AGENT_ID, getMemoryStoreInfo().ownerNamespace) as Array<{ content: string; evidence_json: string; applicability_json: string }>;
  const applicable = rows.filter(row => {
    const metadata = JSON.parse(row.applicability_json) as { compatibilityScope?: { scope: string; scopeRef: string | null } };
    const boundary = metadata.compatibilityScope;
    if (!boundary) return false;
    if (boundary.scope === "personal") return boundary.scopeRef === null;
    if (boundary.scope === "project") return Boolean(scope.projectId) && boundary.scopeRef === scope.projectId;
    if (boundary.scope === "agent") return Boolean(scope.agentId) && boundary.scopeRef === scope.agentId;
    return boundary.scope === "team" && Boolean(scope.teamId) && boundary.scopeRef === scope.teamId;
  });
  if (!applicable.length) return "";
  return ["[One Memory — automatically curated]", ...applicable.map(row => `- ${row.content}`)].join("\n");
}

/** Canonical content lookup only; no new prompt, approval or write authority. */
export function legacyOneMemoryText(asset: OneMemoryAsset): string {
  if (!isLegacyOneAssetActive(asset)) return "";
  const id = mappedId(source().sourceKey, asset.id), row = id && projection(id);
  if (!id || !row) return "";
  return nativeTextsFor("memory_entry", [id]).get(id) ?? row.content;
}
